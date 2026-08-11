// src/room.ts — 联机房间（P5 局域网，房主中心化）
// 拓扑：玩家(WS client) ──→ 房主(WsServer) ──→ 本地引擎判定/AI 叙事 ──→ 广播
// 判定本地化铁律：玩家是瘦客户端，只发输入、收叙事/骰面；判定全在房主本地执行，AI 无权改。
// 协议（JSON 文本帧）：
//   C→S join  {type:'join', name}
//   S→C joined {type:'joined', id, players:[{id,name}]}      （仅发给新玩家）
//   C→S chat  {type:'chat', text}                            （玩家行动输入）
//   S→C narrative {type:'narrative', text, dice?, prompt?}   （房主叙事/骰面/可点选项广播）
//   S→C check {type:'check', skill, label, detail, takenRoll}
//   S→C system {type:'system', text}                         （加入/离开/错误等系统提示）
//   C→S ping / S→C pong                                     （保活）

import { WsConnection, type IncomingMessage } from './ws-server.ts';

export interface RoomPlayerInfo {
  id: string;
  name: string;
  joinedAt: number;
}

export interface RoomEvents {
  onPlayerJoined?: (p: RoomPlayerInfo) => void;
  onPlayerLeft?: (p: RoomPlayerInfo) => void;
  onPlayerChat?: (p: RoomPlayerInfo, text: string) => void;
}

export interface RoomMessage {
  type: string;
  [key: string]: unknown;
}

let idSeq = 0;

export class Room {
  players = new Map<string, RoomPlayerInfo>();
  private conns = new Map<string, WsConnection>();
  private events: RoomEvents;

  constructor(events: RoomEvents = {}) {
    this.events = events;
  }

  get playerCount(): number {
    return this.players.size;
  }

  listPlayers(): RoomPlayerInfo[] {
    return [...this.players.values()];
  }

  /** WsServer 的 onConnection 回调：连接建立后等 join 消息 */
  attach(conn: WsConnection, _req?: IncomingMessage): void {
    let joined = false;
    conn.onMessage = (raw) => {
      let msg: RoomMessage;
      try {
        msg = JSON.parse(raw) as RoomMessage;
      } catch {
        this.sendTo(conn, 'system', { text: '消息格式错误（需 JSON）' });
        return;
      }
      if (msg.type === 'join') {
        if (joined) return;
        const name = String(msg.name ?? '').trim().slice(0, 16);
        if (!name) {
          this.sendTo(conn, 'system', { text: '昵称不能为空' });
          return;
        }
        const p: RoomPlayerInfo = { id: `p${++idSeq}-${Date.now().toString(36)}`, name, joinedAt: Date.now() };
        this.players.set(p.id, p);
        this.conns.set(p.id, conn);
        joined = true;
        this.sendTo(conn, 'joined', { id: p.id, players: this.listPlayers() });
        this.events.onPlayerJoined?.(p);
        return;
      }
      if (!joined) {
        this.sendTo(conn, 'system', { text: '请先发送 join 消息' });
        return;
      }
      if (msg.type === 'chat') {
        const text = String(msg.text ?? '').trim();
        if (!text) return;
        const p = this.playerOf(conn);
        if (p) this.events.onPlayerChat?.(p, text);
        return;
      }
      if (msg.type === 'ping') {
        this.sendTo(conn, 'pong', {});
        return;
      }
    };
    conn.onClose = () => {
      const p = this.playerOf(conn);
      if (p) this.removePlayer(p.id);
    };
    conn.onError = () => {
      const p = this.playerOf(conn);
      if (p) this.removePlayer(p.id);
    };
  }

  private playerOf(conn: WsConnection): RoomPlayerInfo | null {
    for (const [id, c] of this.conns) {
      if (c === conn) return this.players.get(id) ?? null;
    }
    return null;
  }

  /** 广播给所有玩家 */
  broadcast(type: string, payload: Record<string, unknown> = {}): void {
    const msg = JSON.stringify({ type, ...payload });
    for (const conn of this.conns.values()) conn.sendText(msg);
  }

  private sendTo(conn: WsConnection, type: string, payload: Record<string, unknown> = {}): void {
    conn.sendText(JSON.stringify({ type, ...payload }));
  }

  /** 玩家离开（断线/主动退出）：清理 + 通知 */
  removePlayer(id: string): void {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.conns.delete(id);
    this.events.onPlayerLeft?.(p);
    this.broadcast('system', { text: `${p.name} 离开了房间` });
  }

  /** 关闭房间：通知所有玩家并断开 */
  closeAll(code = 1001): void {
    for (const conn of this.conns.values()) {
      conn.sendText(JSON.stringify({ type: 'system', text: '房主已关闭房间' }));
      conn.sendClose(code);
      conn.destroy();
    }
    this.players.clear();
    this.conns.clear();
  }
}
