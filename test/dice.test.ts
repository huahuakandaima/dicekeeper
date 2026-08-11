// test/dice.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roll, DiceSyntaxError } from '../src/dice.ts';
import { makeRng, rollInt } from '../src/rng.ts';

test('基础 d20 在 1-20 范围', () => {
  const rng = makeRng(42);
  const r = roll('d20', rng);
  assert.ok(r.total >= 1 && r.total <= 20);
  assert.equal(r.rolls.length, 1);
});

test('2d6+3 与算术', () => {
  const rng = makeRng(7);
  const r = roll('2d6+3', rng);
  assert.equal(r.rolls.length, 2);
  assert.ok(r.total >= 5 && r.total <= 15);
  assert.equal(r.total, r.rolls[0] + r.rolls[1] + 3);
});

test('括号与乘除', () => {
  const rng = makeRng(1);
  assert.ok(roll('(1d6+2)*2', rng).total >= 6 && roll('(1d6+2)*2', rng).total <= 16);
  assert.equal(roll('10/3', makeRng(1)).total, 3); // 整数除法向下取整
});

test('4d6kh3 只保留最高 3 颗，rolls 含全部 4 颗', () => {
  const rng = makeRng(99);
  const r = roll('4d6kh3', rng);
  assert.equal(r.rolls.length, 4);
  assert.equal(r.kept!.length, 3);
  const sorted = [...r.rolls].sort((a, b) => b - a);
  assert.equal(r.total, sorted[0] + sorted[1] + sorted[2]);
});

test('2d20kh1 等价优势，dis 等价劣势', () => {
  const rng = makeRng(123);
  const adv = roll('2d20kh1', rng);
  const dis = roll('2d20kl1', rng);
  assert.equal(adv.total, Math.max(adv.rolls[0], adv.rolls[1]));
  assert.equal(dis.total, Math.min(dis.rolls[0], dis.rolls[1]));
});

test('骰池 5d10t8 成功数正确', () => {
  const rng = makeRng(555);
  const r = roll('5d10t8', rng);
  assert.equal(r.rolls.length, 5);
  assert.equal(r.successes, r.rolls.filter((x) => x >= 8).length);
  assert.equal(r.total, r.successes);
});

test('确定性：同 seed 同结果', () => {
  const a = roll('4d6kh3', makeRng('campaign-1-round-3'));
  const b = roll('4d6kh3', makeRng('campaign-1-round-3'));
  assert.deepEqual(a, b);
});

test('非法输入报错', () => {
  assert.throws(() => roll('1d7', makeRng(1)), DiceSyntaxError);   // 非法骰面
  assert.throws(() => roll('d20+', makeRng(1)), DiceSyntaxError);  // 悬空运算符
  assert.throws(() => roll('2d6kh5', makeRng(1)), DiceSyntaxError); // keep 越界
  assert.throws(() => roll('1d6/0', makeRng(1)), DiceSyntaxError); // 除 0
  assert.throws(() => roll('abc', makeRng(1)), DiceSyntaxError);   // 垃圾字符
  assert.throws(() => roll('0d6', makeRng(1)), DiceSyntaxError);   // 数量越界
});
