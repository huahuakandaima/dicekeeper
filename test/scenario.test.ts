// test/scenario.test.ts — 剧本包（P2）：加载校验 / 世界初始化 / 世界书命中 / prompt 注入
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml, loadRulePack } from '../src/rules.ts';
import { loadScenarioPack, validateScenarioPack, ScenarioPackError } from '../src/scenario.ts';
import { CampaignStore, type StoredLoreEntry } from '../src/campaign.ts';
import { matchLore, renderLoreBlock } from '../src/lore.ts';
import { buildSystemPrompt } from '../src/gateway/prompt.ts';
import { World } from '../src/world.ts';

const SCENARIO = join(dirname(fileURLToPath(import.meta.url)), '..', 'scenarios', 'fogharbor.yaml');
const PACK = join(dirname(fileURLToPath(import.meta.url)), '..', 'rules', 'coc7e.yaml');

// —— 1. mini YAML 展开 map 语法（parseList 增强）——
test('YAML：list 项展开 map + 块标量 + 嵌套数组', () => {
  const yaml = [
    'npc_seeds:',
    '  - name: 埃德加',
    '    aliases: [老船长, 埃德加船长]',
    '    traits: |',
    '      倔强',
    '      欠赌债',
    '  - name: 马修',
    '    traits: 壮实',
    'empty_list:',
    '  - 纯标量1',
    '  - 纯标量2',
  ].join('\n');
  const raw = parseYaml(yaml) as Record<string, unknown>;
  const seeds = raw.npc_seeds as Record<string, unknown>[];
  assert.equal(seeds.length, 2);
  assert.equal(seeds[0].name, '埃德加');
  assert.deepEqual(seeds[0].aliases, ['老船长', '埃德加船长']);
  assert.equal(seeds[0].traits, '倔强\n欠赌债'); // 块标量保留换行
  assert.equal(seeds[1].name, '马修');
  assert.deepEqual(raw.empty_list, ['纯标量1', '纯标量2']); // 纯标量 list 不受影响
});

// —— 2. 加载与校验 ——
test('加载：内置剧本包 fogharbor.yaml 完整通过', () => {
  const s = loadScenarioPack(SCENARIO);
  assert.equal(s.id, 'fog_harbor');
  assert.equal(s.requires, 'coc7e');
  assert.ok(s.npc_seeds.length >= 6, 'NPC 种子不少于 6 个');
  assert.ok(s.locations.length >= 5, '地点不少于 5 个');
  assert.ok(s.plot_threads.length >= 3, '线索不少于 3 条');
  assert.ok(s.hooks.length >= 1);
  const lore = s.lore_entries;
  assert.ok(lore.some((e) => e.activation === 'blue'), '必须有蓝灯常驻条目');
  assert.ok(lore.some((e) => e.activation === 'green'), '必须有绿灯近期条目');
  assert.ok(lore.some((e) => e.activation === 'yellow'), '必须有黄灯历史条目');
  for (const e of lore) assert.ok(e.key_terms.length >= 1);
});

test('校验：缺 requires / 空 npc_seeds / 非法 activation / 空 key_terms 均拒载', () => {
  const base = () => ({
    id: 'x', name: 'X', version: '1.0', requires: 'coc7e',
    world: { summary: '世界观' },
    npc_seeds: [{ name: 'A', traits: 't' }],
    locations: [{ name: 'L' }],
    plot_threads: [{ id: 'p1', name: '线索' }],
    hooks: ['开场'],
    lore_entries: [{ id: 'l1', key_terms: ['A'], activation: 'green', content: 'c' }],
  });
  assert.throws(() => validateScenarioPack({ ...base(), requires: '' }), ScenarioPackError);
  assert.throws(() => validateScenarioPack({ ...base(), npc_seeds: [] }), ScenarioPackError);
  assert.throws(() => validateScenarioPack({ ...base(), lore_entries: [{ id: 'l1', key_terms: ['A'], activation: 'red', content: 'c' }] }), ScenarioPackError);
  assert.throws(() => validateScenarioPack({ ...base(), lore_entries: [{ id: 'l1', key_terms: [], activation: 'green', content: 'c' }] }), ScenarioPackError);
  assert.throws(() => validateScenarioPack({ ...base(), world: { summary: '' } }), ScenarioPackError);
  // 合法包不抛
  assert.doesNotThrow(() => validateScenarioPack(base()));
});

// —— 3. 建团初始化 ——
function makeStore(): { store: CampaignStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dk-scenario-'));
  return { store: new CampaignStore(join(dir, 't.db')), dir };
}

test('初始化：建团 + initScenarioWorld → 种子实体与 lore_entries 落库', () => {
  const { store, dir } = makeStore();
  const scenario = loadScenarioPack(SCENARIO);
  const c = store.createCampaign({ name: '雾港', rulePackId: 'coc7e', scenarioPackId: scenario.id, characters: [] });
  store.initScenarioWorld(c.id, scenario);

  const w = World.loadFromDb(store.db, c.id);
  const worldEnt = w.entities.get('world');
  assert.ok(worldEnt, 'world 实体必须存在（固定 id）');
  assert.equal(worldEnt.type, 'world');
  assert.ok((worldEnt.data.hooks as string[]).length >= 1);
  const npcs = [...w.entities.values()].filter((e) => e.type === 'npc');
  assert.equal(npcs.length, scenario.npc_seeds.length);
  assert.equal(npcs[0].name, scenario.npc_seeds[0].name);
  assert.deepEqual(npcs[0].aliases, scenario.npc_seeds[0].aliases);
  assert.equal([...w.entities.values()].filter((e) => e.type === 'location').length, scenario.locations.length);
  assert.equal([...w.entities.values()].filter((e) => e.type === 'plot').length, scenario.plot_threads.length);

  const lore = store.getLoreEntries(scenario.id);
  assert.equal(lore.length, scenario.lore_entries.length);
  assert.equal(lore[0].keyTerms.length, scenario.lore_entries[0].key_terms.length);
  assert.equal(lore[0].activation, scenario.lore_entries[0].activation);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('初始化：重复 initScenarioWorld 幂等（不产生重复条目）', () => {
  const { store, dir } = makeStore();
  const scenario = loadScenarioPack(SCENARIO);
  const c = store.createCampaign({ name: '雾港2', rulePackId: 'coc7e', scenarioPackId: scenario.id, characters: [] });
  store.initScenarioWorld(c.id, scenario);
  store.initScenarioWorld(c.id, scenario);
  const w = World.loadFromDb(store.db, c.id);
  assert.equal(w.entities.size, 1 + scenario.npc_seeds.length + scenario.locations.length + scenario.plot_threads.length + (scenario.encounters?.length ?? 0));
  assert.equal(store.getLoreEntries(scenario.id).length, scenario.lore_entries.length);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// —— 4. 世界书命中检测 ——
function mkEntries(): StoredLoreEntry[] {
  return [
    { id: 'blue', scenarioPackId: 's', keyTerms: ['雾港镇'], activation: 'blue', content: '蓝灯常驻', tokenBudget: 10, priority: 100 },
    { id: 'green1', scenarioPackId: 's', keyTerms: ['埃德加'], activation: 'green', content: '埃德加档案', tokenBudget: 10, priority: 60 },
    { id: 'green2', scenarioPackId: 's', keyTerms: ['灯塔'], activation: 'green', content: '灯塔档案', tokenBudget: 10, priority: 50 },
    { id: 'yellow1', scenarioPackId: 's', keyTerms: ['白雾之夜'], activation: 'yellow', content: '1895 事件', tokenBudget: 10, priority: 70 },
  ];
}

test('世界书：蓝灯常驻；绿灯近期命中；黄灯仅全史命中', () => {
  const entries = mkEntries();
  const hits = matchLore(entries, {
    recentText: '我走进酒馆，向埃德加打听消息',
    allText: '我走进酒馆，向埃德加打听消息\n有人说起了白雾之夜',
  });
  const byId = Object.fromEntries(hits.map((h) => [h.entry.id, h.activatedBy]));
  assert.equal(byId.blue, 'blue');          // 常驻
  assert.equal(byId.green1, 'green');       // 近期命中
  assert.equal(byId.green2, undefined);     // 近期未命中
  assert.equal(byId.yellow1, 'yellow');     // 全史命中
});

test('世界书：绿灯在近期未命中时即使全史命中也不激活', () => {
  const entries = mkEntries();
  const hits = matchLore(entries, { recentText: '灯塔', allText: '灯塔\n埃德加' });
  const ids = hits.map((h) => h.entry.id);
  assert.ok(ids.includes('blue'));
  assert.ok(ids.includes('green2'));
  assert.ok(!ids.includes('green1'), '绿灯必须近期命中才激活');
  assert.ok(!ids.includes('yellow1'));
});

test('世界书：priority 降序 + token 预算截断', () => {
  const entries = mkEntries();
  const hits = matchLore(entries, { recentText: '埃德加 灯塔', allText: '埃德加 灯塔\n白雾之夜', budget: 30 });
  // 预算 30：blue(8) + yellow1(9) + green1(9) = 26 可进，green2(9) 超预算被跳过
  const ids = hits.map((h) => h.entry.id);
  assert.deepEqual(ids, ['blue', 'yellow1', 'green1']); // priority: blue 100 > yellow 70 > green1 60
});

test('世界书：renderLoreBlock 输出带激活档位标记', () => {
  const entries = mkEntries();
  const hits = matchLore(entries, { recentText: '埃德加', allText: '埃德加' });
  const block = renderLoreBlock(hits);
  assert.ok(block.includes('世界档案'));
  assert.ok(block.includes('常驻'));
  assert.ok(block.includes('近期'));
  assert.ok(block.includes('埃德加档案'));
});

// —— 5. prompt 注入 ——
test('prompt：loreHits 注入 system prompt', () => {
  const pack = loadRulePack(PACK);
  const w = new World();
  const entries = mkEntries();
  const hits = matchLore(entries, { recentText: '埃德加', allText: '埃德加' });
  const prompt = buildSystemPrompt({ pack, world: w, loreHits: hits });
  assert.ok(prompt.includes('世界档案'));
  assert.ok(prompt.includes('埃德加档案'));
  const prompt2 = buildSystemPrompt({ pack, world: w });
  assert.ok(!prompt2.includes('世界档案'), '无命中条目时不注入');
});

test('prompt：对话对象红线（禁止脑补 NPC / 称呼匹配别名）', () => {
  const pack = loadRulePack(PACK);
  const w = new World();
  const prompt = buildSystemPrompt({ pack, world: w });
  assert.ok(prompt.includes('禁止凭空创造新人物来承接对话'), '禁止脑补 NPC 承接对话');
  assert.ok(prompt.includes('按 NPC 的别名表匹配'), '称呼优先匹配别名');
  assert.ok(prompt.includes('先 update_entity 落库建档再让其登场'), '新 NPC 必须先落库');
});
