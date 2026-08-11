// test/ai-gen.test.ts — AI 生成目标单表（code-review 重构：一处维护，新增目标不散落四处）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AI_TARGETS, SCENARIO_TARGET_ORDER, isWholeTarget } from '../src/ai-gen.ts';

test('AI_TARGETS：每个目标都有 label 与 system prompt', () => {
  for (const [k, def] of Object.entries(AI_TARGETS)) {
    assert.ok(typeof def.label === 'string' && def.label.length > 0, `${k} 缺 label`);
    assert.ok(typeof def.system === 'string' && def.system.length > 100, `${k} 缺 system prompt`);
    assert.ok(def.type === 'rule' || def.type === 'scenario' || def.type === 'both', `${k} type 非法`);
  }
});

test('SCENARIO_TARGET_ORDER：引用都存在且覆盖单点+整包', () => {
  for (const t of SCENARIO_TARGET_ORDER) {
    assert.ok(AI_TARGETS[t], `下拉引用不存在的目标 ${t}`);
  }
  // 覆盖规格 §11.8 目标：整包 + 单点（含剧情线索/随机表）
  assert.ok(SCENARIO_TARGET_ORDER.includes('pack'));
  assert.ok(SCENARIO_TARGET_ORDER.includes('scenario-from-rule'));
  assert.ok(SCENARIO_TARGET_ORDER.includes('npc'));
  assert.ok(SCENARIO_TARGET_ORDER.includes('plot_threads'), '剧情线索目标缺失');
  assert.ok(SCENARIO_TARGET_ORDER.includes('tables'), '随机表目标缺失');
});

test('isWholeTarget：有 field 的是单点，无 field 的是整包', () => {
  assert.equal(isWholeTarget('pack'), true);
  assert.equal(isWholeTarget('rule-pack'), true);
  assert.equal(isWholeTarget('scenario-from-rule'), true);
  assert.equal(isWholeTarget('adjust'), true);
  assert.equal(isWholeTarget('npc'), false);
  assert.equal(isWholeTarget('plot_threads'), false);
  assert.equal(isWholeTarget('tables'), false);
  // 单点目标的 field 与场景包字段对应
  assert.equal(AI_TARGETS.plot_threads.field, 'plot_threads');
  assert.equal(AI_TARGETS.tables.field, 'tables');
});
