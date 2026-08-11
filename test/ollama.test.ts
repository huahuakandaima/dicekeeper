// test/ollama.test.ts — P6 本地模式：模型推荐 / Ollama API 解析 / 下载进度 / 硬件解析
// 网络原语用 node:http 本地假服务验证（不碰真实网络）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recommendModel, parsePullLine, checkOllama, listOllamaModels, pullOllamaModel, downloadFile, MODEL_CARDS,
} from '../src/ollama.ts';
import { parseHwInfo } from '../src/hwinfo.ts';

// —— 模型推荐（抄 Jan：GPU VRAM <6GB 阈值 → 回退 CPU 按内存档）——
test('recommendModel：显存档位（≥20GB→32b / 10-12→14b / 6-8→7b）', () => {
  assert.equal(recommendModel({ totalRamGB: 16, vramGB: 24 }), 'qwen2.5:32b');
  assert.equal(recommendModel({ totalRamGB: 16, vramGB: 20 }), 'qwen2.5:32b');
  assert.equal(recommendModel({ totalRamGB: 16, vramGB: 12 }), 'qwen2.5:14b');
  assert.equal(recommendModel({ totalRamGB: 16, vramGB: 10 }), 'qwen2.5:14b');
  assert.equal(recommendModel({ totalRamGB: 16, vramGB: 8 }), 'qwen2.5:7b');
  assert.equal(recommendModel({ totalRamGB: 16, vramGB: 6 }), 'qwen2.5:7b');
});

test('recommendModel：显存 <6GB 或无独显回退 CPU（按内存档）', () => {
  assert.equal(recommendModel({ totalRamGB: 64, vramGB: 4 }), 'qwen2.5:14b');
  assert.equal(recommendModel({ totalRamGB: 32, vramGB: null }), 'qwen2.5:14b');
  assert.equal(recommendModel({ totalRamGB: 16, vramGB: null }), 'qwen2.5:7b');
  assert.equal(recommendModel({ totalRamGB: 8, vramGB: 0 }), 'qwen2.5:3b');
  // 全未知 → 最低档兜底
  assert.equal(recommendModel({ totalRamGB: null, vramGB: null }), 'qwen2.5:3b');
});

test('MODEL_CARDS：默认推荐落在卡内，卡信息完整', () => {
  const names = MODEL_CARDS.map((m) => m.name);
  assert.ok(names.includes('qwen2.5:7b'));
  for (const c of MODEL_CARDS) {
    assert.ok(c.sizeLabel.length > 0 && c.ram.length > 0 && c.note.length > 0);
  }
});

// —— /api/pull 行解析（NDJSON 与 SSE data: 前缀兼容）——
test('parsePullLine：progress/status/success/垃圾行', () => {
  const p = parsePullLine('{"status":"downloading","name":"qwen2.5:7b","digest":"d1","completed":1048576,"total":10485760}');
  assert.equal(p?.kind, 'progress');
  if (p?.kind === 'progress') {
    assert.equal(p.pct, 10);
    assert.equal(p.name, 'qwen2.5:7b');
  }
  const s = parsePullLine('{"status":"verifying sha256 digest"}');
  assert.equal(s?.kind, 'status');
  const done = parsePullLine('{"status":"success"}');
  assert.equal(done?.kind, 'done');
  // SSE 形态（data: 前缀）
  const sse = parsePullLine('data: {"status":"downloading","completed":500,"total":1000}');
  assert.equal(sse?.kind, 'progress');
  // 垃圾行/空行 → null
  assert.equal(parsePullLine(''), null);
  assert.equal(parsePullLine('data: [DONE]'), null);
  assert.equal(parsePullLine('not-json'), null);
});

// —— 本地假 Ollama 服务（/api/version /api/tags /api/pull）——
// 注意：必须 close，否则 node:test 进程因残留 handle 永不退出
function fakeOllama(handler: (url: string, body: string) => { status?: number; body: string | string[] }): Promise<{ base: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let buf = '';
      req.on('data', (c) => { buf += c; });
      req.on('end', () => {
        const r = handler(req.url ?? '/', buf);
        res.writeHead(r.status ?? 200, { 'Content-Type': 'application/x-ndjson' });
        const chunks = Array.isArray(r.body) ? r.body : [r.body];
        for (const c of chunks) res.write(c);
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

test('checkOllama：/api/version 返回版本；连不上返回 null', async () => {
  const srv = await fakeOllama((url) => (url === '/api/version' ? { body: '{"version":"0.6.0"}' } : { status: 404, body: '' }));
  try {
    const v = await checkOllama(2000, srv.base);
    assert.ok(v && v.version === '0.6.0');
  } finally {
    await srv.close();
  }
  // 未监听端口 → null（连接拒绝立即返回）
  const t0 = Date.now();
  const none = await checkOllama(1000, 'http://127.0.0.1:1');
  assert.equal(none, null);
  assert.ok(Date.now() - t0 < 3000);
});

test('listOllamaModels：解析 /api/tags', async () => {
  const srv = await fakeOllama((url) =>
    url === '/api/tags'
      ? { body: '{"models":[{"name":"qwen2.5:7b","size":5000000000,"digest":"abc","modified_at":"2026-01-01T00:00:00Z"},{"name":"llama3.2:3b","size":2000000000}]}' }
      : { status: 404, body: '' },
  );
  try {
    const ms = await listOllamaModels(srv.base);
    assert.equal(ms.length, 2);
    assert.equal(ms[0].name, 'qwen2.5:7b');
    assert.equal(ms[0].size, 5000000000);
  } finally {
    await srv.close();
  }
  // 404 → 空数组
  const bad = await listOllamaModels('http://127.0.0.1:1');
  assert.deepEqual(bad, []);
});

test('pullOllamaModel：流式进度回调 + success 收尾', async () => {
  const srv = await fakeOllama((url, body) => {
    if (url !== '/api/pull') return { status: 404, body: '' };
    assert.ok(body.includes('"stream":true'));
    return {
      body: [
        '{"status":"downloading","name":"qwen2.5:7b","completed":0,"total":1000}\n',
        '{"status":"downloading","name":"qwen2.5:7b","completed":400,"total":1000}\n',
        '{"status":"verifying sha256 digest"}\n',
        '{"status":"success"}\n',
      ],
    };
  });
  try {
    const pcts: number[] = [];
    const r = await pullOllamaModel('qwen2.5:7b', { onProgress: (pct) => pcts.push(pct) }, srv.base);
    assert.equal(r.ok, true);
    assert.deepEqual(pcts, [0, 40, 0, 100]);
  } finally {
    await srv.close();
  }
});

test('pullOllamaModel：HTTP 错误与流中断报错', async () => {
  const srv = await fakeOllama(() => ({ status: 500, body: 'boom' }));
  try {
    const r = await pullOllamaModel('x', {}, srv.base);
    assert.equal(r.ok, false);
    assert.ok((r.error ?? '').includes('500'));
  } finally {
    await srv.close();
  }
  // 流未收 success 就结束
  const srv2 = await fakeOllama((url) => (url === '/api/pull' ? { body: '{"status":"downloading","completed":1,"total":2}\n' } : { status: 404, body: '' }));
  try {
    const r2 = await pullOllamaModel('x', {}, srv2.base);
    assert.equal(r2.ok, false);
  } finally {
    await srv2.close();
  }
});

// —— downloadFile：Content-Length 进度 + 落盘内容 ——
test('downloadFile：进度 0→100，文件内容一致', async () => {
  const payload = 'x'.repeat(100_000);
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Length': String(payload.length) });
    res.end(payload);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const dir = mkdtempSync(join(tmpdir(), 'dk-ollama-test-'));
  const dest = join(dir, 'out.bin');
  const pcts: number[] = [];
  try {
    await downloadFile(`http://127.0.0.1:${port}/x.bin`, dest, (p) => pcts.push(p));
    assert.equal(readFileSync(dest, 'utf-8'), payload);
    assert.ok(pcts.length >= 1, '进度回调至少一次');
    assert.equal(pcts[pcts.length - 1], 100, '末次回调 100%');
    assert.ok(pcts.every((p) => p >= 0 && p <= 100), '进度始终在 0-100');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// —— hwinfo 解析 ——
test('parseHwInfo：正常输出 / 空 / 垃圾', () => {
  const ok = parseHwInfo('{"totalRamGB":15.9,"gpus":[{"name":"NVIDIA GeForce RTX 3060","vram":12.0},{"name":"Intel UHD","vram":0.5}]}');
  assert.equal(ok.totalRamGB, 15.9);
  assert.equal(ok.vramGB, 12); // 取最大显存
  assert.equal(ok.gpuName, 'NVIDIA GeForce RTX 3060');
  const empty = parseHwInfo('{"totalRamGB":0,"gpus":[]}');
  assert.deepEqual(empty, { totalRamGB: null, vramGB: null, gpuName: null });
  assert.deepEqual(parseHwInfo(null), { totalRamGB: null, vramGB: null, gpuName: null });
  assert.deepEqual(parseHwInfo('not-json'), { totalRamGB: null, vramGB: null, gpuName: null });
});
