// test/net.test.ts — P5 局域网联机：WS 协议帧 + 房间状态机 + 端到端往返
// 双端全链路用 Node ≥21 内置全局 WebSocket 连本地 WsServer（零依赖闭环验证）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, decodeFrame, wsAccept, WsServer } from '../src/ws-server.ts';
import { Room } from '../src/room.ts';

// —— 握手 ——
test('wsAccept：RFC 6455 标准向量', () => {
  assert.equal(
    wsAccept('dGhlIHNhbXBsZSBub25jZQ=='),
    's3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
  );
});

// —— 帧编解码 ——
test('encodeFrame/decodeFrame：短文本往返（masked 客户端帧）', () => {
  const payload = Buffer.from('{"type":"join","name":"张三"}', 'utf-8');
  // 模拟客户端帧：FIN|text + masked
  const masked = Buffer.from(payload);
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  const frame = Buffer.concat([Buffer.from([0x81, 0x80 | masked.length]), mask, masked]);
  const dec = decodeFrame(frame);
  assert.ok(dec);
  assert.equal(dec!.opcode, 0x1);
  assert.equal(dec!.payload.toString('utf-8'), '{"type":"join","name":"张三"}');
  assert.equal(dec!.consumed, frame.length);
});

test('decodeFrame：126/127 扩展长度 + 数据不足返回 null', () => {
  // 300 字节 payload（126 扩展长度）
  const big = Buffer.alloc(300, 0x41);
  const frame = encodeFrame(0x1, big);
  // 服务端帧（无 mask）也能被解码器识别（掩码位=0）
  const dec = decodeFrame(frame);
  assert.ok(dec);
  assert.equal(dec!.payload.length, 300);
  assert.equal(dec!.consumed, frame.length);
  // 数据不足
  assert.equal(decodeFrame(Buffer.from([0x81])), null);
  assert.equal(decodeFrame(frame.subarray(0, 5)), null);
});

test('encodeFrame：长度边界（125/126/65535/65536）', () => {
  for (const n of [0, 1, 125, 126, 65535, 65536, 100_000]) {
    const f = encodeFrame(0x1, Buffer.alloc(n, 0x42));
    const dec = decodeFrame(f);
    assert.ok(dec, `len=${n} 可解码`);
    assert.equal(dec!.payload.length, n, `len=${n} 载荷一致`);
    assert.equal(dec!.consumed, f.length);
  }
});

test('decodeFrame：未 mask 的客户端帧仍按原样解析（协议宽松但本实现不强制）', () => {
  const f = encodeFrame(0x1, 'hello');
  const dec = decodeFrame(f);
  assert.equal(dec!.payload.toString('utf-8'), 'hello');
});

// —— 房间：多玩家加入/离开/广播 ——
function connectTo(port: number, name: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}`);
}

test('Room：join 广播 + chat 回调 + 离开清理', async () => {
  const room = new Room({
    onPlayerJoined: (p) => events.push(`join:${p.name}`),
    onPlayerLeft: (p) => events.push(`left:${p.name}`),
    onPlayerChat: (p, text) => events.push(`chat:${p.name}:${text}`),
  });
  const srv = new WsServer((conn) => room.attach(conn));
  const port = await srv.listen(0, '127.0.0.1');
  const events: string[] = [];
  try {
    const ws = connectTo(port, '阿尔法');
    await new Promise<void>((r, j) => {
      ws.onopen = () => ws.send(JSON.stringify({ type: 'join', name: '阿尔法' }));
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data)) as { type: string; id?: string; players?: unknown[] };
        if (m.type === 'joined') {
          assert.ok(m.id);
          assert.equal((m.players ?? []).length, 1);
          r();
        }
      };
      ws.onerror = () => j(new Error('连接失败'));
    });
    assert.deepEqual(events, ['join:阿尔法']);

    // 第二玩家加入 → 新玩家收到 players=[2]，房主收到 join 事件
    const ws2 = connectTo(port, '贝塔');
    await new Promise<void>((r, j) => {
      ws2.onopen = () => ws2.send(JSON.stringify({ type: 'join', name: '贝塔' }));
      ws2.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data)) as { type: string; players?: unknown[] };
        if (m.type === 'joined') {
          assert.equal((m.players ?? []).length, 2);
          r();
        }
      };
      ws2.onerror = () => j(new Error('连接失败'));
    });
    assert.deepEqual(events, ['join:阿尔法', 'join:贝塔']);

    // 阿尔法发 chat → 房主回调
    const chatP = new Promise<void>((r) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        if (events.some((e) => e.startsWith('chat:'))) { clearInterval(timer); r(); }
        if (Date.now() - t0 > 3000) { clearInterval(timer); r(); }
      }, 20);
    });
    ws.send(JSON.stringify({ type: 'chat', text: '我去码头看看' }));
    await chatP;
    assert.ok(events.includes('chat:阿尔法:我去码头看看'));

    // 广播 → 两个玩家都收到 narrative
    const recvP = new Promise<void>((r) => {
      let got = 0;
      const check = (ev: MessageEvent): void => {
        const m = JSON.parse(String(ev.data)) as { type: string };
        if (m.type === 'narrative') {
          got++;
          if (got === 2) r();
        }
      };
      ws.onmessage = check;
      ws2.onmessage = check;
      setTimeout(() => r(), 3000);
    });
    room.broadcast('narrative', { text: '海雾漫过码头。', dice: ['侦查 检定 d100=42，普通成功'] });
    await recvP;

    // 玩家断开 → left 事件 + 广播 system
    const leftP = new Promise<void>((r) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        if (events.some((e) => e.startsWith('left:'))) { clearInterval(timer); r(); }
        if (Date.now() - t0 > 3000) { clearInterval(timer); r(); }
      }, 20);
    });
    ws.close();
    await leftP;
    assert.ok(events.includes('left:阿尔法'));
    assert.equal(room.playerCount, 1);
    ws2.close();
  } finally {
    room.closeAll();
    await srv.close();
  }
});

test('Room：空昵称拒绝 + join 前 chat 被拒', async () => {
  const room = new Room();
  const srv = new WsServer((conn) => room.attach(conn));
  const port = await srv.listen(0, '127.0.0.1');
  try {
    const ws = connectTo(port, 'x');
    const msgs: string[] = [];
    await new Promise<void>((r, j) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'chat', text: '先说话' }));
        ws.send(JSON.stringify({ type: 'join', name: '  ' }));
      };
      ws.onmessage = (ev) => {
        msgs.push(String(ev.data));
        if (msgs.length === 2) r();
      };
      ws.onerror = () => j(new Error('连接失败'));
    });
    assert.ok(msgs.some((m) => m.includes('请先发送 join')));
    assert.ok(msgs.some((m) => m.includes('昵称不能为空')));
    assert.equal(room.playerCount, 0);
    ws.close();
  } finally {
    room.closeAll();
    await srv.close();
  }
});
