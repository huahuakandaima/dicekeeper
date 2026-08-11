// src/ws-server.ts — 最小 WebSocket 服务器（RFC 6455，零 npm 依赖，P5 局域网联机）
// 主进程零依赖铁律：不引入 ws 库，自实现握手 + 帧编解码 + 连接封装。
// 支持：text 帧收发、ping/pong、close；客户端→服务端必须 masked（协议强制），分片(FIN=0)按协议错误断开。
// 客户端侧用 Node ≥21 内置全局 WebSocket（Electron 43 内置 Node 24），无需实现。

import { createServer, type Server as HttpServer, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { createHash } from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OP_TEXT = 0x1;
export const OP_BINARY = 0x2;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

/** 握手应答：base64(sha1(Sec-WebSocket-Key + GUID)) */
export function wsAccept(key: string): string {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

export interface DecodedFrame {
  opcode: number;
  payload: Buffer;
  consumed: number; // 本帧消耗的字节数（调用方从 buffer 头部切掉）
  fin: boolean;
}

/** 解码一帧（客户端→服务端，要求 masked）。数据不足返回 null（等更多字节）。 */
export function decodeFrame(buf: Buffer): DecodedFrame | null {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const hi = buf.readUInt32BE(2);
    const lo = buf.readUInt32BE(6);
    len = hi * 2 ** 32 + lo;
    off = 10;
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < off + maskLen + len) return null;
  const mask = masked ? buf.subarray(off, off + 4) : null;
  off += maskLen;
  let payload = buf.subarray(off, off + len);
  if (mask) {
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }
  return { opcode, payload, consumed: off + len, fin };
}

/** 编码一帧（服务端→客户端，不 mask） */
export function encodeFrame(opcode: number, payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf-8') : payload;
  const len = data.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

/** 单条 WebSocket 连接：缓冲 + 帧解析 + 事件回调 + 发送 */
export class WsConnection {
  onMessage?: (text: string) => void;
  onClose?: (code: number) => void;
  onError?: (err: Error) => void;
  private socket: Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private closed = false;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (e) => this.onError?.(e));
    socket.on('close', () => this.handleClose());
    socket.on('end', () => this.handleClose());
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = decodeFrame(this.buffer);
      if (!frame) return; // 等更多数据
      this.buffer = this.buffer.subarray(frame.consumed);
      if (!frame.fin) {
        // 分片帧：协议简化不支持，按协议错误断开
        this.sendClose(1002);
        this.socket.end();
        return;
      }
      switch (frame.opcode) {
        case OP_TEXT:
          this.onMessage?.(frame.payload.toString('utf-8'));
          break;
        case OP_BINARY:
          this.onMessage?.(frame.payload.toString('utf-8'));
          break;
        case OP_PING:
          this.socket.write(encodeFrame(OP_PONG, frame.payload));
          break;
        case OP_PONG:
          break;
        case OP_CLOSE: {
          const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1000;
          this.sendClose(code);
          this.socket.end();
          return;
        }
        default:
          this.sendClose(1002);
          this.socket.end();
          return;
      }
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.(1006);
  }

  sendText(text: string): void {
    if (this.closed) return;
    try {
      this.socket.write(encodeFrame(OP_TEXT, text));
    } catch { /* 连接已断 */ }
  }

  sendClose(code = 1000): void {
    if (this.closed) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    try {
      this.socket.write(encodeFrame(OP_CLOSE, payload));
    } catch { /* 忽略 */ }
  }

  destroy(): void {
    this.closed = true;
    this.socket.destroy();
  }
}

/** WebSocket 服务器：HTTP upgrade → 101 握手 → WsConnection */
export class WsServer {
  private http: HttpServer;

  constructor(onConnection: (conn: WsConnection, req: IncomingMessage) => void) {
    this.http = createServer((_req, res) => {
      res.writeHead(400);
      res.end('WebSocket only');
    });
    this.http.on('upgrade', (req, socket) => {
      const key = req.headers['sec-websocket-key'];
      const upgrade = req.headers.upgrade;
      if (typeof key !== 'string' || typeof upgrade !== 'string' || upgrade.toLowerCase() !== 'websocket') {
        socket.destroy();
        return;
      }
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`,
      );
      onConnection(new WsConnection(socket), req);
    });
    this.http.on('error', () => { /* listen 失败由 listen() 抛 */ });
  }

  /** 监听；port=0 自动分配（返回实际端口）。host 默认 0.0.0.0（局域网可达）。 */
  listen(port = 0, host = '0.0.0.0'): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (e: Error): void => {
        this.http.off('listening', onListening);
        reject(e);
      };
      const onListening = (): void => {
        this.http.off('error', onError);
        const addr = this.http.address();
        resolve(typeof addr === 'object' && addr ? addr.port : port);
      };
      this.http.once('error', onError);
      this.http.once('listening', onListening);
      this.http.listen(port, host);
    });
  }

  port(): number {
    const addr = this.http.address();
    return typeof addr === 'object' && addr ? addr.port : 0;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.http.close(() => resolve());
    });
  }
}
