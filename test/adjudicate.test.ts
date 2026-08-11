// test/adjudicate.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRulePack } from '../src/rules.ts';
import { adjudicate } from '../src/adjudicate.ts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pack = loadRulePack(join(dirname(fileURLToPath(import.meta.url)), '..', 'rules', 'coc7e.yaml'));
const fixed = (x: number) => () => x;

test('普通成功：d100=51，技能 60 → normal', () => {
  const a = adjudicate({ rulePack: pack, skill: '侦查', value: 60, rng: fixed(0.5) });
  assert.equal(a.outcome, 'normal');
  assert.equal(a.label, '普通成功');
  assert.equal(a.takenRoll, 51);
  assert.deepEqual(a.diceRolls, [51]);
});

test('困难成功：d100=21 → hard', () => {
  const a = adjudicate({ rulePack: pack, skill: '侦查', value: 60, rng: fixed(0.2) });
  assert.equal(a.outcome, 'hard');
  assert.equal(a.label, '困难成功');
});

test('极限成功：d100=11 → extreme', () => {
  const a = adjudicate({ rulePack: pack, skill: '侦查', value: 60, rng: fixed(0.1) });
  assert.equal(a.outcome, 'extreme');
});

test('失败：d100=81 → fail', () => {
  const a = adjudicate({ rulePack: pack, skill: '侦查', value: 60, rng: fixed(0.8) });
  assert.equal(a.outcome, 'fail');
});

test('大失败优先于成功：d100=97 → crit_fail（即使 97 也在 normal 范围内需注意技能 60<97）', () => {
  const a = adjudicate({ rulePack: pack, skill: '侦查', value: 60, rng: fixed(0.96) });
  assert.equal(a.outcome, 'crit_fail');
  assert.equal(a.label, '大失败');
});

test('奖励骰：掷两颗取低', () => {
  // rng 序列：0.5 → 51, 0.2 → 21；取低 = 21
  const seq = [0.5, 0.2];
  const a = adjudicate({ rulePack: pack, skill: '侦查', value: 60, mode: 'reward', rng: () => seq.shift()! });
  assert.equal(a.diceRolls.length, 2);
  assert.equal(a.takenRoll, 21);
  assert.equal(a.outcome, 'hard');
});

test('惩罚骰：掷两颗取高', () => {
  const seq = [0.5, 0.2];
  const a = adjudicate({ rulePack: pack, skill: '侦查', value: 60, mode: 'penalty', rng: () => seq.shift()! });
  assert.equal(a.diceRolls.length, 2);
  assert.equal(a.takenRoll, 51);
  assert.equal(a.outcome, 'normal');
});

test('tiers 记录每级判定', () => {
  const a = adjudicate({ rulePack: pack, skill: '侦查', value: 60, rng: fixed(0.5) });
  assert.deepEqual(a.tiers.map((t) => t.tier), ['crit_fail', 'extreme', 'hard', 'normal']);
  assert.deepEqual(a.tiers.map((t) => t.ok), [false, false, false, true]);
});

test('确定性：同 seed 同结果', () => {
  const a = adjudicate({ rulePack: pack, skill: '侦查', value: 60, seed: 'fixed-seed' });
  const b = adjudicate({ rulePack: pack, skill: '侦查', value: 60, seed: 'fixed-seed' });
  assert.deepEqual(a, b);
});

test('detail 含人话描述与技能名', () => {
  const a = adjudicate({ rulePack: pack, skill: '侦查', value: 60, rng: fixed(0.5) });
  assert.match(a.detail, /侦查 检定 d100=51/);
  assert.match(a.detail, /普通成功/);
});
