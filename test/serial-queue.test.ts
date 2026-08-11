// test/serial-queue.test.ts — 串行队列（曾内嵌 main.ts 不可测，code-review 补强）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SerialQueue } from '../src/serial-queue.ts';

test('串行：一次只处理一条，严格按入队顺序', async () => {
  const order: number[] = [];
  let inflight = 0;
  let maxInflight = 0;
  const q = new SerialQueue<number, number>(async (n) => {
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    await new Promise((r) => setTimeout(r, 5));
    order.push(n);
    inflight--;
    return n * 2;
  });
  const results = await Promise.all([q.enqueue(1), q.enqueue(2), q.enqueue(3), q.enqueue(4)]);
  assert.deepEqual(order, [1, 2, 3, 4]);
  assert.equal(maxInflight, 1, '任何时刻最多一条在处理');
  assert.deepEqual(results, [2, 4, 6, 8]);
});

test('并发入队结果与顺序一致（防并发写库场景）', async () => {
  const q = new SerialQueue<number, number>(async (n) => n + 10);
  const [a, b, c] = await Promise.all([q.enqueue(1), q.enqueue(2), q.enqueue(3)]);
  assert.deepEqual([a, b, c], [11, 12, 13]);
});

test('handler 抛错 → 对应 Promise reject，队列继续处理后续项', async () => {
  const q = new SerialQueue<number, number>(async (n) => {
    if (n === 2) throw new Error('bad-2');
    return n;
  });
  const results: (number | string)[] = [];
  await Promise.all([
    q.enqueue(1).then((v) => results.push(v)).catch(() => results.push('E1')),
    q.enqueue(2).then((v) => results.push(v)).catch(() => results.push('E2')),
    q.enqueue(3).then((v) => results.push(v)).catch(() => results.push('E3')),
  ]);
  assert.deepEqual(results, [1, 'E2', 3]);
});

test('clear：reject 排队未决项（关房场景），正在处理的不打断，之后新入队照常', async () => {
  let release: (() => void) | undefined;
  const q = new SerialQueue<number, number>(async (n) => {
    if (n === 1) await new Promise<void>((r) => { release = r; }); // 阻塞第一个，模拟处理中
    return n;
  });
  const p1 = q.enqueue(1).then(() => 'ok').catch((e: Error) => `rej:${e.message}`); // 开始处理（阻塞中）
  const p2 = q.enqueue(2).then(() => 'ok').catch((e: Error) => `rej:${e.message}`); // 排队未开始
  setTimeout(() => q.clear(new Error('房间已关闭')), 5);
  assert.equal(await p2, 'rej:房间已关闭'); // 排队项被 reject
  release?.();                              // 释放第一个
  assert.equal(await p1, 'ok');             // 正在处理的正常完成
  assert.equal(q.pending, 0);
  assert.equal(await q.enqueue(9), 9);      // 清空后照常
});
