// test/dsl.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, DslError } from '../src/dsl.ts';
import { makeRng } from '../src/rng.ts';

function ctx(fields: Record<string, number>, seed: number | string = 1) {
  return { fields, rng: makeRng(seed) };
}

test('CoC 普通检定：d100 <= SKILL', () => {
  const r = evaluate('d100 <= 60', ctx({ SKILL: 60 }, 'coc-normal'));
  assert.equal(typeof r.ok, 'boolean');
  assert.equal(r.rolls.length, 1);
  assert.equal(r.ok, r.rolls[0] <= 60);
});

test('困难成功：d100 <= floor(SKILL/2)', () => {
  const r = evaluate('d100 <= floor(60/2)', ctx({}, 'hard'));
  assert.equal(r.ok, r.rolls[0] <= 30);
});

test('极限成功：d100 <= fifth(SKILL)', () => {
  const r = evaluate('d100 <= fifth(60)', ctx({}, 'extreme'));
  assert.equal(r.ok, r.rolls[0] <= 12);
});

test('奖励骰：min(d100, d100) 两次掷骰取有利值', () => {
  const r = evaluate('min(d100, d100) <= 60', ctx({}, 'adv'));
  assert.equal(r.rolls.length, 2);
  assert.equal(r.ok, Math.min(r.rolls[0], r.rolls[1]) <= 60);
});

test('惩罚骰：max(d100, d100) 两次掷骰取不利值', () => {
  const r = evaluate('max(d100, d100) <= 60', ctx({}, 'dis'));
  assert.equal(r.rolls.length, 2);
  assert.equal(r.ok, Math.max(r.rolls[0], r.rolls[1]) <= 60);
});

test('骰池：5d10t8 >= 3', () => {
  const r = evaluate('5d10t8 >= 3', ctx({}, 'pool'));
  assert.equal(r.rolls.length, 5);
  const succ = r.rolls.filter((x) => x >= 8).length;
  assert.equal(r.ok, succ >= 3);
});

test('字段引用与 DC：d20 + STR >= DC', () => {
  const r = evaluate('d20 + 14 >= 15', ctx({ STR: 14, DC: 15 }, 'combat'));
  assert.equal(r.ok, r.rolls[0] + 14 >= 15);
});

test('逻辑组合：not (d6 > 4)', () => {
  const r = evaluate('not (d6 > 4)', ctx({}, 'logic'));
  assert.equal(typeof r.ok, 'boolean');
  assert.equal(r.ok, !(r.rolls[0] > 4));
});

test('确定性：同 seed 同结果', () => {
  const a = evaluate('d100 <= floor(60/2)', ctx({}, 'seed-abc'));
  const b = evaluate('d100 <= floor(60/2)', ctx({}, 'seed-abc'));
  assert.deepEqual(a, b);
});

test('未知字段人话报错，列出可用字段', () => {
  try {
    evaluate('d100 <= 灵能', ctx({ STR: 10, 侦查: 60 }, 'err'));
    assert.fail('应抛错');
  } catch (e) {
    assert.ok(e instanceof DslError);
    assert.match((e as Error).message, /未知字段: 灵能/);
    assert.match((e as Error).message, /侦查/);
  }
});

test('未知函数拒绝', () => {
  assert.throws(() => evaluate('sqrt(9) < 5', ctx({}, 'fn')), /未知函数/);
});

test('非法语法拒绝', () => {
  assert.throws(() => evaluate('d100 <', ctx({}, 'syn')), DslError);
  assert.throws(() => evaluate('', ctx({}, 'empty')), DslError);
  assert.throws(() => evaluate('1/0', ctx({}, 'div0')), /除数为 0/);
});

test('advantage(d100)：两次掷骰取低（语法糖，同 min）', () => {
  const r = evaluate('advantage(d100) <= 60', ctx({}, 'adv-fn'));
  assert.equal(r.rolls.length, 2);
  assert.equal(r.ok, Math.min(r.rolls[0], r.rolls[1]) <= 60);
});

test('disadvantage(d100)：两次掷骰取高（语法糖，同 max）', () => {
  const r = evaluate('disadvantage(d100) <= 60', ctx({}, 'dis-fn'));
  assert.equal(r.rolls.length, 2);
  assert.equal(r.ok, Math.max(r.rolls[0], r.rolls[1]) <= 60);
});

test('successes(5d10, 8)：骰池计数逐面统计', () => {
  const r = evaluate('successes(5d10, 8) >= 3', ctx({}, 'succ-fn'));
  assert.equal(r.rolls.length, 5);
  const succ = r.rolls.filter((x) => x >= 8).length;
  assert.equal(r.ok, succ >= 3);
  // 与 t8 后缀等价
  const r2 = evaluate('5d10t8 >= 3', ctx({}, 'succ-fn'));
  assert.equal(r.ok, r2.ok);
});

test('successes 返回值可直接参与算术', () => {
  const r = evaluate('successes(3d6, 4) * 2 >= 4', ctx({}, 'succ-arith'));
  assert.equal(typeof r.ok, 'boolean');
  assert.equal(r.rolls.length, 3);
});

test('非图灵完备：赋值/循环语法天然无法解析', () => {
  assert.throws(() => evaluate('x = 1', ctx({}, 'assign')), DslError);
  assert.throws(() => evaluate('while(x) { }', ctx({}, 'while')), DslError);
  assert.throws(() => evaluate('def f(): 1', ctx({}, 'def')), DslError);
});
