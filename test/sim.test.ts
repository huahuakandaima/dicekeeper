// test/sim.test.ts — NPC 幕后推演（世界活着：移动 + 状态；与在场对话联动）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world.ts';
import { MockProvider } from '../src/gateway/provider.ts';
import { simulateNpcActions, parseNpcActions, metNpcs } from '../src/sim.ts';
import { buildMemoryContext, renderMemoryBlock } from '../src/memory.ts';

test('parseNpcActions：容错解析（噪音/非法 JSON/原地）', () => {
  const items = parseNpcActions('好的，以下是推演：\n[{"name":"埃德加","location":"渔市码头","state":"在打听失踪者"}] 完毕');
  assert.equal(items.length, 1);
  assert.equal(items[0].name, '埃德加');
  assert.equal(items[0].location, '渔市码头');
  assert.equal(parseNpcActions('没有特殊行动').length, 0);
  assert.equal(parseNpcActions('{"narrative":"x"}').length, 0);
  assert.equal(parseNpcActions('[]').length, 0);
});

test('simulateNpcActions：Mock 推演更新 NPC 位置与状态（走审计）', async () => {
  const w = new World();
  const edgar = w.addEntity('npc', '埃德加', { traits: '倔强嗜酒', secrets: '见过雾潮之民' });
  const matthew = w.addEntity('npc', '马修', { traits: '魂不守舍' });
  w.addEntity('location', '雾港酒馆', {}); // 非 NPC 不推演
  const provider = new MockProvider('mock', [
    {
      content: '[{"name":"埃德加","location":"渔市码头","state":"在打听失踪者"},{"name":"马修","location":"原地","state":"躲在酒馆后巷发抖"}]',
      toolCalls: null, model: 'mock',
    },
  ]);
  const msgs = [
    { role: 'user' as const, content: '我走进酒馆', created_at: '' },
    { role: 'assistant' as const, content: '雾气裹着烟味。', created_at: '' },
  ];
  const n = await simulateNpcActions(provider, w, msgs, '测试战役');
  assert.equal(n, 2);
  assert.equal((w.entities.get(edgar.id)!.data as Record<string, unknown>).location, '渔市码头');
  assert.equal((w.entities.get(edgar.id)!.data as Record<string, unknown>).state, '在打听失踪者');
  assert.equal((w.entities.get(matthew.id)!.data as Record<string, unknown>).location, undefined, '原地不动不写 location');
  assert.equal((w.entities.get(matthew.id)!.data as Record<string, unknown>).state, '躲在酒馆后巷发抖');
  // 更新走 updateEntity → changes 审计可回滚
  assert.ok(w.changes.some((c) => c.kind === 'entity_update' && c.target === edgar.id));
  // 未知 NPC 名忽略
  const w2 = new World();
  const provider2 = new MockProvider('mock', [
    { content: '[{"name":"不存在的NPC","location":"某处","state":"x"}]', toolCalls: null, model: 'mock' },
  ]);
  assert.equal(await simulateNpcActions(provider2, w2, msgs, 't'), 0);
});

test('simulateNpcActions：别名匹配 + 无 NPC 时跳过', async () => {
  const w = new World();
  w.addEntity('npc', '埃德加·克莱恩', { traits: 'x' }, ['老船长']);
  const provider = new MockProvider('mock', [
    { content: '[{"name":"老船长","location":"北角灯塔","state":"在灯塔守夜"}]', toolCalls: null, model: 'mock' },
  ]);
  const n = await simulateNpcActions(provider, w, [], 't');
  assert.equal(n, 1);
  const w2 = new World(); // 无 NPC
  const n2 = await simulateNpcActions(provider, w2, [], 't');
  assert.equal(n2, 0);
});

test('renderEntity 联动：NPC 档案含位置与死亡标记', () => {
  const w = new World();
  w.addEntity('npc', '埃德加', { traits: '倔强', location: '渔市码头' });
  w.addEntity('npc', '马修', { traits: 'x', alive: false });
  const ctx = buildMemoryContext({ world: w, recentText: '埃德加 马修' });
  const block = renderMemoryBlock(ctx);
  assert.ok(block.text.includes('位于渔市码头'), block.text);
  assert.ok(block.text.includes('已死亡'), block.text);
});

test('metNpcs：@候选只列出见过的人（met:true 且未死亡）', () => {
  const w = new World();
  w.addEntity('npc', '埃德加', { traits: 'x', met: true });              // 见过 → 出现
  w.addEntity('npc', '马修', { traits: 'x' });                            // 未见（无 met）→ 不出现
  w.addEntity('npc', '梅布尔', { traits: 'x', met: true, alive: false }); // 见过但已死亡 → 不出现
  w.addEntity('location', '雾港酒馆', {});                                 // 非 NPC → 不算
  const names = metNpcs(w).map((e) => e.name);
  assert.deepEqual(names, ['埃德加']);
  // 标记 met 后出现
  const matthew = [...w.entities.values()].find((e) => e.name === '马修')!;
  w.updateEntity(matthew.id, { met: true });
  assert.ok(metNpcs(w).some((e) => e.name === '马修'));
});
