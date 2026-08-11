// test/tension.test.ts — 张力仪表（戏剧引擎 §11.7）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.ts';
import { computeTension, hasCountdownPlot, buildTensionPrompt, DEFAULT_TENSION } from '../src/tension.ts';

test('computeTension：基础=玩家强度滑杆，倒计时+15，失败上浮封顶+20', () => {
  // 默认中档 50
  const base = computeTension({ ...DEFAULT_TENSION }, {});
  assert.equal(base.level, 50);
  // 倒计时线索 → +15
  const cd = computeTension({ ...DEFAULT_TENSION }, { hasCountdown: true });
  assert.equal(cd.level, 65);
  // 失败 3 次 → +15
  const fails = computeTension({ ...DEFAULT_TENSION }, { recentCheckFails: 3 });
  assert.equal(fails.level, 65);
  // 倒计时 + 失败 4 次 = 50+15+20 = 85
  const both = computeTension({ ...DEFAULT_TENSION }, { hasCountdown: true, recentCheckFails: 4 });
  assert.equal(both.level, 85);
  // 上限 100（强度 100 + 倒计时 + 失败）
  const max = computeTension({ intensity: 100, surprise: 50, consequence: 50 }, { hasCountdown: true, recentCheckFails: 10 });
  assert.equal(max.level, 100);
  // 下限 0
  const min = computeTension({ intensity: 0, surprise: 0, consequence: 0 }, { recentCheckFails: 0 });
  assert.equal(min.level, 0);
});

test('hasCountdownPlot：plot 实体 open 且名含倒计时/期限', () => {
  const w = new World();
  assert.equal(hasCountdownPlot(w), false);
  w.addEntity('plot', '失踪案调查', { thread_id: 't1', status: 'open' });
  assert.equal(hasCountdownPlot(w), false);
  w.addEntity('plot', '雾潮之夜倒计时', { thread_id: 't4', status: 'open' });
  assert.equal(hasCountdownPlot(w), true);
  // 已关闭的倒计时不算
  w.addEntity('plot', '最后期限', { thread_id: 't5', status: 'closed' });
  assert.equal(hasCountdownPlot(w), true); // t4 仍 open
});

test('buildTensionPrompt：包含红线三件套与滑杆档位描述', () => {
  const p = buildTensionPrompt({ settings: { ...DEFAULT_TENSION }, level: 65, hasCountdown: true });
  assert.ok(p.includes('当前张力 65/100'));
  assert.ok(p.includes('两难抉择'));
  assert.ok(p.includes('时限事件'));
  assert.ok(p.includes('检定失败不许"无事发生"'));
  assert.ok(p.includes('NPC 有独立动机'));
  assert.ok(p.includes('倒计时线索'));
  // 滑杆档位描述
  const high = buildTensionPrompt({ settings: { intensity: 90, surprise: 90, consequence: 90 }, level: 90, hasCountdown: false });
  assert.ok(high.includes('严苛'));
  assert.ok(high.includes('高频'));
  const low = buildTensionPrompt({ settings: { intensity: 10, surprise: 10, consequence: 10 }, level: 10, hasCountdown: false });
  assert.ok(low.includes('宽容'));
  assert.ok(low.includes('低频'));
});
