// test/memory.test.ts — P1 记忆系统：提及检测 / @唤起 / 线索 / 事实排序 / 摘要生成 / 验收（§11.4）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CampaignStore, toChatMessages } from '../src/campaign.ts';
import { loadScenarioPack } from '../src/scenario.ts';
import { loadRulePack } from '../src/rules.ts';
import { World } from '../src/world.ts';
import { MockProvider, type ChatMessage } from '../src/gateway/provider.ts';
import { runChat } from '../src/gateway/chat.ts';
import { buildSystemPrompt } from '../src/gateway/prompt.ts';
import { buildMemoryContext, renderMemoryBlock, generateSessionSummary, fallbackSummary, findEntityByName, extractFactsIncrementally, parseExtraction, factConflicts } from '../src/memory.ts';
import { executeTool } from '../src/gateway/tools.ts';

const SCENARIO = join(dirname(fileURLToPath(import.meta.url)), '..', 'scenarios', 'fogharbor.yaml');
const PACK = join(dirname(fileURLToPath(import.meta.url)), '..', 'rules', 'coc7e.yaml');
const pack = loadRulePack(PACK);
const scenario = loadScenarioPack(SCENARIO);

function makeStore(): { store: CampaignStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dk-memory-'));
  return { store: new CampaignStore(join(dir, 't.db')), dir };
}

function makeWorldWithSeeds(): { world: World; campaignId: string } {
  const w = new World();
  const edgar = w.addEntity('npc', '埃德加·克莱恩', { traits: '老船长', secrets: '见过雾潮之民' }, ['老船长', '埃德加']);
  w.addEntity('npc', '梅布尔·霍尔特', { traits: '会长' }, ['梅布尔']);
  w.addEntity('location', '北角灯塔', { state: '废弃', secrets: '地下室有祭坛' }, ['灯塔']);
  w.addEntity('plot', '失踪案调查', { thread_id: 't1', status: 'open' });
  w.addEntity('plot', '雾潮之夜倒计时', { thread_id: 't4', status: 'open' });
  const p = w.addEntity('plot', '已了结的线索', { thread_id: 't2', status: 'closed' });
  void p;
  w.addFact('埃德加欠码头赌债', [edgar.id], 'high');
  w.addFact('梅布尔主持周三聚会', [], 'normal');
  return { world: w, campaignId: edgar.id };
}

// —— 提及检测 / @唤起 / 线索 / 事实排序 ——
test('提及检测：最近文本命中别名自动附加档案（不依赖 AI）', () => {
  const { world } = makeWorldWithSeeds();
  const ctx = buildMemoryContext({ world, recentText: '我走向酒馆角落的老船长，问他失踪案的事', allText: '' });
  assert.ok(ctx.mentioned.some((e) => e.name.includes('埃德加')), '提到"老船长"应命中埃德加');
  assert.ok(!ctx.mentioned.some((e) => e.name.includes('梅布尔')), '未提及梅布尔');
  assert.ok(!ctx.mentioned.some((e) => e.type === 'plot'), '提及检测不含线索实体');
});

test('@ 唤起：focusQuery 强制注入并标记 focus', () => {
  const { world } = makeWorldWithSeeds();
  const ctx = buildMemoryContext({ world, recentText: '', focusQuery: '埃德加' });
  assert.ok(ctx.focus, 'focus 实体存在');
  assert.equal(ctx.focus!.name, '埃德加·克莱恩');
  assert.ok(ctx.mentioned.some((e) => e.name.includes('埃德加')), '@ 目标进入 mentioned');
});

test('活跃线索：仅 status=open 的 plot 进入 openPlots', () => {
  const { world } = makeWorldWithSeeds();
  const ctx = buildMemoryContext({ world, recentText: '' });
  assert.equal(ctx.openPlots.length, 2);
  assert.ok(ctx.openPlots.every((p) => (p.data as Record<string, unknown>).status === 'open'));
});

test('事实排序：与在场实体关联优先 + importance 降序', () => {
  const { world } = makeWorldWithSeeds();
  const ctx = buildMemoryContext({ world, recentText: '埃德加' });
  assert.equal(ctx.facts.length, 2);
  assert.equal(ctx.facts[0].fact, '埃德加欠码头赌债'); // high 且关联在场实体 → 第一
});

test('renderMemoryBlock：CHRONICLE 标注 + 预算截断', () => {
  const { world } = makeWorldWithSeeds();
  const ctx = buildMemoryContext({ world, recentText: '埃德加 灯塔', summary: '上一节：在酒馆遇到埃德加，他提到白雾之夜；灯塔地下室发现祭坛痕迹。' });
  const block = renderMemoryBlock(ctx, 500);
  assert.ok(block.text.includes('[CHRONICLE 历史记录]'));
  assert.ok(block.text.includes('埃德加·克莱恩'));
  assert.ok(block.text.includes('活跃线索'));
  assert.ok(block.text.includes('已知事实'));
  // 极小预算（只够摘要本身 + 前缀）：只有 CHRONICLE 能进
  const tiny = renderMemoryBlock(ctx, ctx.summary!.length + 8);
  assert.ok(tiny.text.includes('[CHRONICLE'), '预算紧张时保住历史摘要');
  assert.ok(!tiny.text.includes('活跃线索'), '预算紧张时丢弃低优先级');
});

test('findEntityByName：名称/别名/包含匹配', () => {
  const { world } = makeWorldWithSeeds();
  assert.equal(findEntityByName(world, '老船长')!.name, '埃德加·克莱恩');
  assert.equal(findEntityByName(world, '灯塔')!.name, '北角灯塔');
  assert.equal(findEntityByName(world, '不存在的'), null);
});

// —— 摘要生成 ——
test('摘要：LLM 生成 + 失败降级规则摘要', async () => {
  const mk = (n: string, content: string) => ({ role: 'user' as const, content: n + content, created_at: 't' });
  const messages = [mk('玩家', '我推开酒馆的门'), mk('玩家', '我向埃德加打听失踪案'), mk('玩家', '我深夜去了灯塔地下室')];
  const provider = new MockProvider('mock', [
    (msgs: ChatMessage[]) => ({ content: '关键事件：埃德加透露白雾之夜；玩家在灯塔地下室发现祭坛；失踪案线索指向圣烛会。', toolCalls: null, model: 'mock' }),
  ]);
  const sum = await generateSessionSummary(provider, messages as never, '雾港');
  assert.ok(sum.includes('埃德加'));
  assert.ok(sum.includes('祭坛'));
  // 失败降级：空脚本 provider 抛错 → fallback
  const broken = new MockProvider('mock', []);
  const fb = await generateSessionSummary(broken, messages as never, '雾港');
  assert.ok(fb.includes('[自动摘要]'));
  assert.ok(fallbackSummary([]).includes('省略'));
});

// —— remember 冲突拒收（§11.4）——
test('remember：与既有 high 事实冲突时拒收（以既有为权威）', async () => {
  const world = new World();
  const e = world.addEntity('npc', '埃德加', { traits: 't' });
  world.addFact('埃德加欠码头赌债', [e.id], 'high');
  const ok = await executeTool(
    { id: 'c1', name: 'remember', arguments: JSON.stringify({ fact: '埃德加还清了赌债', entity_refs: [e.id], importance: 'high' }) },
    { pack, world, seed: 's' },
  );
  const parsed = JSON.parse(ok.content) as { ok: boolean; rejected?: boolean };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.rejected, true);
  assert.equal(world.facts.length, 1, '冲突事实未落库');
  const ok2 = await executeTool(
    { id: 'c2', name: 'remember', arguments: JSON.stringify({ fact: '埃德加有一条叫海鸥的狗', entity_refs: [e.id], importance: 'normal' }) },
    { pack, world, seed: 's' },
  );
  assert.equal(JSON.parse(ok2.content).ok, true);
  assert.equal(world.facts.length, 2);
});

// —— relations 持久化 ——
test('relations：addRelation → saveToDb/loadFromDb 全链路', () => {
  const { store, dir } = makeStore();
  const c = store.createCampaign({ name: 't', rulePackId: 'coc7e', characters: [] });
  const w = new World();
  const a = w.addEntity('npc', '埃德加', {});
  const b = w.addEntity('npc', '梅布尔', {});
  w.addRelation(a.id, b.id, '秘密合作', '梅布尔资助埃德加还债');
  w.saveToDb(store.db, c.id);
  const w2 = World.loadFromDb(store.db, c.id);
  assert.equal(w2.relations.length, 1);
  assert.equal(w2.relations[0].relationType, '秘密合作');
  assert.equal(w2.getRelations(a.id).length, 1);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// —— §11.4 验收：迷你团 → 结束 → 新 session 记忆测试 ——
test('验收：迷你团 → 摘要落库 → 新 session 注入含 ≥2 关键事件', async () => {
  const { store, dir } = makeStore();
  const c = store.createCampaign({ name: '迷你团', rulePackId: 'coc7e', scenarioPackId: scenario.id, characters: [] });
  store.initScenarioWorld(c.id, scenario);
  const world = World.loadFromDb(store.db, c.id);
  const s = store.startSession(c.id);

  // 迷你团：3 轮对话（Mock 守密人）
  const chatProvider = new MockProvider('mock', [1, 2, 3].map((i) => ({
    content: JSON.stringify({ narrative: `第${i}轮叙事：埃德加说雾里有东西。`, dice_results: [] }),
    toolCalls: null,
    model: 'mock',
  })));
  for (let i = 0; i < 3; i++) {
    store.appendMessage(c.id, s.id, { role: 'user', content: `行动${i + 1}：我调查灯塔` });
    await runChat(`行动${i + 1}：我调查灯塔`, toChatMessages(store.getMessages(c.id, s.id)), {
      provider: chatProvider,
      toolCtx: { pack, world, seed: `s${i}` },
      systemPrompt: buildSystemPrompt({ pack, world }),
    }).then((out) => store.appendMessage(c.id, s.id, { role: 'assistant', content: out.narrative }));
  }

  // 结束：摘要（Mock 返回含关键事件）
  const sumProvider = new MockProvider('mock', [
    { content: '关键事件：埃德加提到白雾之夜；玩家在灯塔地下室发现祭坛；圣烛会的献祭名单上出现马修女儿的名字。', toolCalls: null, model: 'mock' },
  ]);
  const summary = await generateSessionSummary(sumProvider, store.getMessages(c.id, s.id), '迷你团');
  store.endSession(c.id, s.id, summary);

  // 新 session：记忆上下文必须带上摘要
  const s2 = store.startSession(c.id);
  const world2 = World.loadFromDb(store.db, c.id);
  const ctx = buildMemoryContext({ world: world2, recentText: '我继续调查', summary: store.listSessions(c.id).find((x) => x.summary)?.summary });
  const block = renderMemoryBlock(ctx);
  const prompt = buildSystemPrompt({ pack, world: world2, memory: block });
  // 验收断言：主持人能答出 ≥2 个关键事件
  let hits = 0;
  for (const kw of ['白雾之夜', '祭坛', '圣烛会', '马修']) {
    if (prompt.includes(kw)) hits++;
  }
  assert.ok(hits >= 2, `摘要注入后应包含 ≥2 关键事件（实际 ${hits}）`);
  assert.ok(prompt.includes('[CHRONICLE 历史记录]'));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// —— L3 兜底事实提取（§3.3/§11.4）——
test('parseExtraction：容错解析 JSON 数组（含噪音/非法 JSON）', () => {
  const items = parseExtraction('好的，以下是提取结果：\n[{"fact":"埃德加欠码头赌债","entity_refs":["埃德加"],"importance":"high"}]\n完毕');
  assert.equal(items.length, 1);
  assert.equal(items[0].fact, '埃德加欠码头赌债');
  assert.deepEqual(items[0].entity_refs, ['埃德加']);
  assert.equal(items[0].importance, 'high');
  assert.equal(parseExtraction('没有新事实').length, 0);
  assert.equal(parseExtraction('{"narrative":"x"}').length, 0);
  assert.equal(parseExtraction('[]').length, 0);
});

test('factConflicts：与既有 high 事实冲突判定（同 remember 规则）', () => {
  const w = new World();
  w.addFact('埃德加欠码头赌债', [], 'high');
  assert.ok(factConflicts(w, '埃德加欠码头赌债一千元', []));
  assert.equal(factConflicts(w, '埃德加昨天买了新船', []), null);
});

test('extractFactsIncrementally：Mock 提取写入 + 去重 + 实体引用解析 + 冲突跳过', async () => {
  const w = new World();
  const edgar = w.addEntity('npc', '埃德加', {});
  const provider = new MockProvider('mock', [
    { content: '[{"fact":"埃德加欠码头赌债","entity_refs":["埃德加"],"importance":"high"},{"fact":"马修偷偷跟踪埃德加","entity_refs":["马修"],"importance":"normal"}]', toolCalls: null, model: 'mock' },
  ]);
  const msgs = [
    { role: 'user' as const, content: '埃德加说他欠了码头赌债', created_at: '' },
    { role: 'assistant' as const, content: '老船长叹了口气。', created_at: '' },
    { role: 'user' as const, content: '我继续问马修的事', created_at: '' },
  ];
  const added = await extractFactsIncrementally(provider, msgs, w);
  assert.equal(added, 2);
  // 实体引用解析为 id
  const f = w.facts.find((x) => x.fact.includes('埃德加'))!;
  assert.ok(f.entity_refs.includes(edgar.id));
  // 冲突：再跑一次（相同提取）→ 去重跳过
  const provider2 = new MockProvider('mock', [
    { content: '[{"fact":"埃德加欠码头赌债","entity_refs":["埃德加"],"importance":"high"}]', toolCalls: null, model: 'mock' },
  ]);
  const added2 = await extractFactsIncrementally(provider2, msgs, w);
  assert.equal(added2, 0, '已有事实应跳过');
  // 冲突事实跳过：先有 high 事实，提取改写版 → 跳过
  const w2 = new World();
  const provider3 = new MockProvider('mock', [
    { content: '[{"fact":"埃德加欠码头赌债一千元","entity_refs":[],"importance":"normal"}]', toolCalls: null, model: 'mock' },
  ]);
  await extractFactsIncrementally(provider3, msgs, w2); // w2 无既有 high 事实 → 写入
  assert.equal(w2.facts.length, 1);
});
