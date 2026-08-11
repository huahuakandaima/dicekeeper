// test/move.test.ts — 移动意图本地识别（方案 C：移动也本地化）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, parseMoveIntent } from '../src/world.ts';

function makeWorld(): World {
  const w = new World();
  w.addEntity('pc', '无名调查员', { location: '雾港酒馆' });
  w.addEntity('location', '雾港酒馆', {}, ['酒馆', '码头酒馆']);
  w.addEntity('location', '渔市码头', {}, ['码头', '渔市']);
  w.addEntity('location', '北角灯塔', {}, ['灯塔', '北角']);
  w.addEntity('location', '圣烛堂', {}, ['会堂', '老教堂']);
  w.addEntity('location', '鹈鹕号', {}, ['埃德加的船']);
  w.addEntity('location', '芬利诊所', {}, ['诊所', '医生诊所']);
  return w;
}

test('parseMoveIntent：去/前往/回 + 地点名 → 解析目标地点', () => {
  const w = makeWorld();
  assert.equal(parseMoveIntent('我去码头看看', w)?.name, '渔市码头');
  assert.equal(parseMoveIntent('前往灯塔调查', w)?.name, '北角灯塔');
  assert.equal(parseMoveIntent('回到酒馆', w)?.name, '雾港酒馆');
  assert.equal(parseMoveIntent('去圣烛堂参加聚会', w)?.name, '圣烛堂');
  assert.equal(parseMoveIntent('动身去诊所', w)?.name, '芬利诊所');
  assert.equal(parseMoveIntent('走去鹈鹕号', w)?.name, '鹈鹕号');
});

test('parseMoveIntent：别名匹配 + 无地点时返回 null', () => {
  const w = makeWorld();
  assert.equal(parseMoveIntent('去码头', w)?.name, '渔市码头'); // 别名"码头"
  assert.equal(parseMoveIntent('去灯塔', w)?.name, '北角灯塔'); // 别名"灯塔"
  assert.equal(parseMoveIntent('我和埃德加聊聊天', w), null);   // 无移动动词
  assert.equal(parseMoveIntent('我喝了一口酒', w), null);       // 动词不接地点
  assert.equal(parseMoveIntent('', w), null);
});

test('parseMoveIntent：多次移动取最后一个（先去码头再回酒馆→酒馆）', () => {
  const w = makeWorld();
  assert.equal(parseMoveIntent('我先去码头看看，然后回酒馆', w)?.name, '雾港酒馆');
});

test('parseMoveIntent：贪心捕获不吞后续动词（离开酒馆去码头→码头）', () => {
  const w = makeWorld();
  assert.equal(parseMoveIntent('我离开酒馆去码头看看', w)?.name, '渔市码头');
  assert.equal(parseMoveIntent('离开雾港酒馆前往灯塔', w)?.name, '北角灯塔');
  // 无地点时推进游标保留后续搜索（"看到"不吞"去码头"）
  assert.equal(parseMoveIntent('我看到他去了码头', w)?.name, '渔市码头');
});
