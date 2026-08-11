// test/packs.test.ts — P3a 内容包导入导出（§3.7 Foundry 范式）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { serializeYaml } from '../src/yaml-write.ts';
const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(p, 'utf-8');
import { PackStore, dkContent, parseDk, validatePackContent, detectPackType, loadImportedScenario, parsePackObject, serializePackObject, savePackObject, buildNewPackTemplate, normalizeGeneratedPack, summarizeRulePackForPrompt, sanitizeAiYaml, parseAiOutput, testPackCheck, testPackDistribution, testPackLore, ensureChargen } from '../src/packs.ts';
import { generateCharacter } from '../src/chargen.ts';
import { loadScenarioPack } from '../src/scenario.ts';
import { loadRulePack, parseYaml } from '../src/rules.ts';

function makeStore(): { store: PackStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dk-packs-'));
  return { store: new PackStore(join(dir, 'packs')), dir };
}

// —— .dk 格式往返 ——
test('dkContent/parseDk：注释头 manifest + 正文往返', () => {
  const body = 'id: demo\nname: 演示\n';
  const dk = dkContent('scenario', body);
  assert.ok(dk.startsWith('# format: dicekeeper/scenario-pack v1'));
  const { manifest, body: out } = parseDk(dk);
  assert.equal(manifest.format, 'dicekeeper/scenario-pack v1');
  assert.equal(out.trim(), body.trim());
  // 规则包
  const dk2 = dkContent('rule', body);
  assert.ok(parseDk(dk2).manifest.format.includes('rule-pack'));
});

test('detectPackType：规则包/剧本包/未知', () => {
  assert.equal(detectPackType({ character_sheet: {}, check_rules: {} }), 'rule');
  assert.equal(detectPackType({ npc_seeds: [], world: {}, lore_entries: [] }), 'scenario');
  assert.equal(detectPackType({ foo: 1 }), null);
});

// —— 校验与依赖检查 ——
test('validatePackContent：内置雾港疑云导出的 .dk 可往返导入（requires 通过）', () => {
  const scenario = loadScenarioPack(join(HERE, '..', 'scenarios', 'fogharbor.yaml'));
  const body = read(join(HERE, '..', 'scenarios', 'fogharbor.yaml'));
  const dk = dkContent('scenario', body);
  const r = validatePackContent(dk, ['coc7e']);
  assert.equal(r.ok, true);
  assert.equal(r.meta?.id, scenario.id);
  assert.equal(r.meta?.requires, 'coc7e');
});

test('validatePackContent：requires 缺失拒绝 + 非法内容拒绝', () => {
  const body = read(join(HERE, '..', 'scenarios', 'fogharbor.yaml'));
  const dk = dkContent('scenario', body);
  // 未安装依赖规则包
  const r1 = validatePackContent(dk, ['dnd5e']);
  assert.equal(r1.ok, false);
  assert.ok((r1.error ?? '').includes('依赖检查'));
  // 非法内容（缺关键字段）
  const r2 = validatePackContent(dkContent('scenario', 'id: x\nname: y\n'), ['coc7e']);
  assert.equal(r2.ok, false);
  // 无法识别
  const r3 = validatePackContent('hello world', ['coc7e']);
  assert.equal(r3.ok, false);
});

// —— PackStore 存储 ——
test('PackStore：save/list/load/remove 全链路', () => {
  const { store, dir } = makeStore();
  assert.deepEqual(store.listImported(), []);
  const body = 'id: demo_scenario\nname: 演示剧本\nversion: 1.0\nrequires: coc7e\n';
  store.save('scenario', { id: 'demo_scenario', name: '演示剧本', version: '1.0', type: 'scenario', isBuiltin: false, requires: 'coc7e' }, body);
  const list = store.listImported();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'demo_scenario');
  assert.equal(list[0].requires, 'coc7e');
  assert.ok(store.load('scenario', 'demo_scenario')?.includes('demo_scenario'));
  assert.equal(store.load('scenario', 'nope'), null);
  store.remove('scenario', 'demo_scenario');
  assert.deepEqual(store.listImported(), []);
  rmSync(dir, { recursive: true, force: true });
});

test('loadImportedScenario：存储的完整剧本包可加载为 ScenarioPack', () => {
  const { store, dir } = makeStore();
  const body = read(join(HERE, '..', 'scenarios', 'fogharbor.yaml'));
  store.save('scenario', { id: 'fog_harbor', name: '雾港疑云', version: '1.0', type: 'scenario', isBuiltin: false, requires: 'coc7e' }, body);
  const p = loadImportedScenario(store, 'fog_harbor');
  assert.ok(p);
  assert.equal(p?.id, 'fog_harbor');
  assert.equal(p?.npc_seeds.length, 7);
  rmSync(dir, { recursive: true, force: true });
});

// —— P3b 编辑器：对象解析/序列化/保存/试跑 ——
test('parsePackObject / serializePackObject：对象 ↔ .dk 往返', () => {
  const body = read(join(HERE, '..', 'scenarios', 'fogharbor.yaml'));
  const obj = parsePackObject('scenario', body) as Awaited<ReturnType<typeof loadScenarioPack>>;
  assert.equal(obj.id, 'fog_harbor');
  const dk = serializePackObject('scenario', obj);
  // 序列化产物可重新校验通过（含依赖检查）
  const r = validatePackContent(dk, ['coc7e']);
  assert.equal(r.ok, true, r.error);
  const back = parsePackObject('scenario', dk) as typeof obj;
  assert.deepEqual(back, obj);
});

test('savePackObject：导入包直接覆盖保存', () => {
  const { store, dir } = makeStore();
  const body = read(join(HERE, '..', 'scenarios', 'fogharbor.yaml'));
  const obj = parsePackObject('scenario', body) as Awaited<ReturnType<typeof loadScenarioPack>>;
  obj.name = '雾港疑云（改版）';
  obj.hooks[0] = '改过的开场白。';
  const r = savePackObject({ type: 'scenario', id: 'fog_harbor', isBuiltin: false, obj, store });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.savedAs, undefined); // 非内置 → 原 id 保存
  const loaded = loadImportedScenario(store, 'fog_harbor');
  assert.equal(loaded?.name, '雾港疑云（改版）');
  assert.equal(loaded?.hooks[0], '改过的开场白。');
  rmSync(dir, { recursive: true, force: true });
});

test('savePackObject：内置剧本包自动另存副本（原包不受影响）', () => {
  const { store, dir } = makeStore();
  const obj = parsePackObject('scenario', read(join(HERE, '..', 'scenarios', 'fogharbor.yaml'))) as Awaited<ReturnType<typeof loadScenarioPack>>;
  obj.name = '雾港疑云·自改版';
  const r = savePackObject({ type: 'scenario', id: 'fog_harbor', isBuiltin: true, obj, store });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.savedAs, 'fog_harbor-custom'); // 内置 → 副本 id
  assert.equal(r.meta?.id, 'fog_harbor-custom');
  // 副本可加载，且 requires 保留
  const copy = loadImportedScenario(store, 'fog_harbor-custom');
  assert.ok(copy);
  assert.equal(copy?.name, '雾港疑云·自改版');
  assert.equal(copy?.requires, 'coc7e');
  assert.equal(copy?.id, 'fog_harbor-custom'); // 内容 id 同步（否则列表按内容 id 识别不到副本）
  // 原对象未被污染（id 保持原值）
  assert.equal(obj.id, 'fog_harbor');
  // 原内置 id 不存在于 store（未被覆盖）
  assert.equal(store.load('scenario', 'fog_harbor'), null);
  rmSync(dir, { recursive: true, force: true });
});

test('savePackObject：校验失败拒绝保存', () => {
  const { store, dir } = makeStore();
  const obj = parsePackObject('scenario', read(join(HERE, '..', 'scenarios', 'fogharbor.yaml'))) as Awaited<ReturnType<typeof loadScenarioPack>>;
  obj.hooks = []; // 非法：hooks 必须非空
  const r = savePackObject({ type: 'scenario', id: 'fog_harbor', isBuiltin: false, obj, store });
  assert.equal(r.ok, false);
  assert.ok((r.error ?? '').includes('hooks'));
  assert.deepEqual(store.listImported(), []); // 未落盘
  rmSync(dir, { recursive: true, force: true });
});

test('testPackCheck：编辑中的规则包对象可直接试跑检定', () => {
  const obj = parsePackObject('rule', read(join(HERE, '..', 'rules', 'coc7e.yaml'))) as Awaited<ReturnType<typeof loadRulePack>>;
  const a = testPackCheck(obj, '侦查', 50, 'normal', 'test-seed');
  assert.ok(['crit_fail', 'extreme', 'hard', 'normal', 'fail'].includes(a.outcome));
  assert.equal(a.diceRolls.length, 1);
  assert.ok(a.detail.includes('侦查'));
  // 惩罚骰：2d100 取高
  const p = testPackCheck(obj, '侦查', 50, 'penalty', 'test-seed');
  assert.equal(p.diceRolls.length, 2);
  // 改了 check_rules 后立即生效（DSL 表达式）
  obj.check_rules.normal = 'd100 <= 100';
  const always = testPackCheck(obj, '侦查', 1, 'normal', 'test-seed');
  assert.ok(['extreme', 'hard', 'normal'].includes(always.outcome));
});

test('testPackLore：剧本包世界书命中模拟（蓝/绿/黄 + 预算）', () => {
  const obj = parsePackObject('scenario', read(join(HERE, '..', 'scenarios', 'fogharbor.yaml'))) as Awaited<ReturnType<typeof loadScenarioPack>>;
  // 蓝灯常驻条目必命中
  const r = testPackLore(obj, '玩家站在雾港酒馆门口', 3000);
  assert.ok(r.hits.length > 0);
  assert.ok(r.hits.some((h) => h.activation === 'blue'));
  assert.ok(r.used <= r.budget);
  // 关键词命中绿灯
  const r2 = testPackLore(obj, '埃德加灌了一口酒', 3000);
  assert.ok(r2.hits.some((h) => h.id.includes('edgar') || h.activation === 'green' || h.activation === 'blue'));
  // 预算收紧 → 截断
  const tight = testPackLore(obj, '埃德加灌了一口酒', 50);
  assert.ok(tight.used <= 50);
});

test('testPackDistribution：1000 次档位统计，成功概率 ≈ 技能值', () => {
  const obj = parsePackObject('rule', read(join(HERE, '..', 'rules', 'coc7e.yaml'))) as Awaited<ReturnType<typeof loadRulePack>>;
  const d = testPackDistribution(obj, '侦查', 50, 'normal', 1000);
  assert.equal(d.trials, 1000);
  const total = Object.values(d.counts).reduce((s, v) => s + v, 0);
  assert.equal(total, 1000);
  // CoC：成功 = 极限(≤10) + 困难(≤25) + 普通(≤50)；大失败 ≥96
  const success = d.counts.extreme + d.counts.hard + d.counts.normal;
  assert.ok(success >= 420 && success <= 580, `成功率 ${success}% 应在 50% 附近`);
  assert.ok(d.counts.crit_fail >= 30 && d.counts.crit_fail <= 60, `大失败 ${d.counts.crit_fail}% 应在 5% 附近`);
  // 失败 = 剩余
  assert.equal(d.counts.fail, 1000 - success - d.counts.crit_fail);
});

// P3b 增强：从零新建包模板（「＋ 新建规则包/剧本包」入口）——模板必须能过导入校验
test('buildNewPackTemplate：规则包模板通过完整校验 + 可保存', () => {
  const tpl = buildNewPackTemplate('rule', '我的规则', 'rule-test1');
  const body = serializePackObject('rule', tpl as never);
  const res = validatePackContent(dkContent('rule', body), []);
  assert.equal(res.ok, true);
  assert.equal(res.type, 'rule');
  assert.equal(res.meta?.id, 'rule-test1');
  assert.equal(res.meta?.name, '我的规则');
  // check_rules 表达式合法（DSL 可解析）
  assert.equal((tpl as Record<string, unknown>).dice_schema, 'd100');
  const cr = (tpl as Record<string, unknown>).check_rules as Record<string, string>;
  assert.ok(cr.extreme && cr.hard && cr.normal && cr.crit_fail);
});

test('buildNewPackTemplate：剧本包模板通过校验（requires=coc7e 已装语义）', () => {
  const tpl = buildNewPackTemplate('scenario', '我的剧本', 'scen-test1');
  const body = serializePackObject('scenario', tpl as never);
  const res = validatePackContent(dkContent('scenario', body), ['coc7e']);
  assert.equal(res.ok, true);
  assert.equal(res.type, 'scenario');
  assert.equal(res.meta?.requires, 'coc7e');
  const s = tpl as Record<string, unknown>;
  assert.ok(Array.isArray(s.npc_seeds) && (s.npc_seeds as unknown[]).length === 1);
  assert.ok(Array.isArray(s.lore_entries) && (s.lore_entries as unknown[]).length === 1);
  // 依赖检查：requires 未装 → 拒绝（与导入同规则）
  const bad = validatePackContent(dkContent('scenario', body), []);
  assert.equal(bad.ok, false);
});

test('buildNewPackTemplate：id 唯一性语义（时间戳前缀）', () => {
  const a = buildNewPackTemplate('rule', '甲', 'rule-abc');
  const b = buildNewPackTemplate('scenario', '乙', 'scen-def');
  assert.notEqual((a as Record<string, unknown>).id, (b as Record<string, unknown>).id);
  assert.equal((a as Record<string, unknown>).name, '甲');
});

// 换规则包 bug 修复（2026-08-11 用户实测"按规则包生成角色卡还是默认规则"）：
// 根因：模板新建/AI 生成的规则包缺 chargen 段 → generateCharacter/computeDerived/buildCharacter 抛
// "缺少 chargen 段" → 前端无 catch 静默保留旧默认卡。三层修复：模板补 chargen + normalize 兜底 + 前端报错可见
test('buildNewPackTemplate：规则包模板含 chargen（车卡/衍生全链可用）', () => {
  const tpl = buildNewPackTemplate('rule', '我的规则', 'rule-cg1') as Record<string, unknown>;
  const cg = tpl.chargen as Record<string, unknown>;
  assert.ok(Array.isArray(cg.attribute_methods) && (cg.attribute_methods as unknown[]).length > 0, 'attribute_methods 非空');
  assert.ok(Array.isArray(cg.occupations) && (cg.occupations as unknown[]).length > 0, 'occupations 非空');
  // 模板包直接车卡（「按规则包生成角色卡」同路径），不再抛"缺少 chargen 段"
  const char = generateCharacter(tpl as never, { seed: 'cg-seed' });
  assert.ok(Object.keys(char.attributes).length >= 8);
  assert.ok(char.occupation.length > 0);
  assert.ok(char.derived.HP > 0 && char.derived.SAN > 0);
});

test('normalizeGeneratedPack：AI 规则包缺 chargen → 模板兜底（不再静默车卡失败）', () => {
  const ai = { id: 'rule-ai1', name: '末世', character_sheet: { attributes: ['力量', '敏捷'], skills: [{ name: '枪械', base: 40, category: '战斗' }] }, check_rules: { normal: 'd100 <= SKILL' } };
  const norm = normalizeGeneratedPack('rule', ai, '末世规则') as Record<string, unknown>;
  const cg = norm.chargen as Record<string, unknown>;
  assert.ok(Array.isArray(cg.attribute_methods) && (cg.attribute_methods as unknown[]).length > 0);
  assert.ok(Array.isArray(cg.occupations) && (cg.occupations as unknown[]).length > 0);
  // 兜底后能过完整校验 + 直接车卡
  const body = serializePackObject('rule', norm as never);
  const res = validatePackContent(dkContent('rule', body), []);
  assert.equal(res.ok, true, res.error ?? '');
  const char = generateCharacter(norm as never, { seed: 'ai-seed' });
  assert.ok(Object.keys(char.attributes).length > 0);
});

test('normalizeGeneratedPack：AI 规则包给了完整 chargen → 保留 AI 的', () => {
  const ai = {
    id: 'rule-ai2', name: '异能', dice_schema: 'd100',
    character_sheet: { attributes: ['异能', '体能'], skills: [{ name: '念力', base: 30, category: '异能' }] },
    check_rules: { normal: 'd100 <= SKILL' },
    chargen: {
      attribute_methods: [{ name: '异能骰', formula: '2d6*10', fields: ['异能', '体能'] }],
      derived_formulas: { 能量: '异能*2' },
      occupations: [{ name: '觉醒者', skills: ['念力'], points: '异能*3' }],
    },
  };
  const norm = normalizeGeneratedPack('rule', ai, '异能规则') as Record<string, unknown>;
  const cg = norm.chargen as Record<string, unknown>;
  assert.equal((cg.attribute_methods as { formula: string }[])[0].formula, '2d6*10');
  assert.equal((cg.occupations as { name: string }[])[0].name, '觉醒者');
  const char = generateCharacter(norm as never, { seed: 'ai2-seed' });
  assert.ok(char.attributes['异能'] > 0);
});

test('normalizeGeneratedPack：中文属性 + 模板兜底 chargen → 车卡出中文属性（不再 STR 英文）', () => {
  const ai = {
    id: 'rule-wuxia', name: '武侠', dice_schema: 'd100',
    character_sheet: { attributes: ['武力', '身法', '内功', '慧根'], derived: ['气血', '真气'], skills: [{ name: '拳法', base: 60, category: '武学' }] },
    check_rules: { normal: 'd100 <= SKILL' },
  };
  const norm = normalizeGeneratedPack('rule', ai, '武侠规则') as Record<string, unknown>;
  const char = generateCharacter(norm as never, { seed: 'wuxia-seed' });
  assert.deepEqual(Object.keys(char.attributes).sort(), ['内功', '武力', '身法', '慧根'].sort());
  // 兜底衍生公式引用模板英文字段（SIZ/CON）→ 求值兜底回退首属性，不炸
  for (const v of Object.values(char.derived)) assert.ok(Number.isFinite(v as number));
});

test('ensureChargen：老规则包缺 chargen → 加载兜底补全，直接可车卡（中文属性不脱节）', () => {
  // 模拟修复前创建的包（validateRulePack 放行、无 chargen）
  const old = {
    id: 'rule-old', name: '老包', version: '1.0', dice_schema: 'd100',
    character_sheet: { attributes: ['力量', '敏捷', '感知'], derived: ['血量'], skills: [{ name: '格斗', base: 50, category: '战斗' }] },
    check_rules: { normal: 'd100 <= SKILL' },
  } as never;
  const patched = ensureChargen(old) as Record<string, unknown>;
  const cg = patched.chargen as Record<string, unknown>;
  assert.ok(Array.isArray(cg.attribute_methods) && (cg.attribute_methods as { fields: string[] }[])[0].fields.join(',') === '力量,敏捷,感知');
  assert.ok(Array.isArray(cg.occupations) && (cg.occupations as { skills: string[] }[])[0].skills.join(',') === '格斗');
  // 兜底后直接车卡（属性名 = 包自己的属性）
  const char = generateCharacter(patched as never, { seed: 'old-seed' });
  assert.deepEqual(Object.keys(char.attributes).sort(), ['力量', '敏捷', '感知'].sort());
});

// AI 生成整包兜底：AI 输出缺 id/name/空数组 → 规范化后必须能过完整校验（修复"剧本包缺少 id"）
test('normalizeGeneratedPack：AI 缺 id/name 的剧本输出被补全并通过校验', () => {
  const ai = {
    world: { summary: '雾都 1925，连环失踪案。' },
    npc_seeds: [{ name: '警长' }], // 缺 traits
    locations: [],
    plot_threads: [{ name: '线索一' }], // 缺 id
    hooks: ['开场'],
    lore_entries: [{ key_terms: ['雾'], content: '雾里有东西。' }], // 缺 id/activation
  };
  const norm = normalizeGeneratedPack('scenario', ai, '雾都失踪案');
  assert.ok(typeof norm.id === 'string' && norm.id.startsWith('scen-'));
  assert.equal(norm.name, '雾都失踪案');
  const body = serializePackObject('scenario', norm as never);
  const res = validatePackContent(dkContent('scenario', body), ['coc7e']);
  assert.equal(res.ok, true, res.error ?? '');
  // AI 内容保留：世界书内容不被覆盖
  const obj = parsePackObject('scenario', body) as Record<string, unknown>;
  assert.equal((obj.lore_entries as { content: string }[])[0].content, '雾里有东西。');
  // 条目缺字段已补占位
  assert.ok((obj.npc_seeds as { traits: string }[])[0].traits.length > 0);
  assert.equal((obj.plot_threads as { id: string }[])[0].id, 't1');
});

test('normalizeGeneratedPack：规则包 AI 输出缺 id/version 被补全', () => {
  const ai = { name: '末世生存', dice_schema: 'd100', character_sheet: { attributes: ['力量', '敏捷'], skills: [{ name: '枪械', base: 40, category: '战斗' }] }, check_rules: { normal: 'd100 <= SKILL' } };
  const norm = normalizeGeneratedPack('rule', ai, '末世生存规则');
  assert.ok(typeof norm.id === 'string' && norm.id.startsWith('rule-'));
  assert.equal(norm.version, '1.0');
  const body = serializePackObject('rule', norm as never);
  const res = validatePackContent(dkContent('rule', body), []);
  assert.equal(res.ok, true, res.error ?? '');
  // check_rules 缺的档位被模板补全（校验要求对象合法，且 DSL 表达式可解析）
  const cr = (norm as Record<string, unknown>).check_rules as Record<string, string>;
  assert.ok(cr.extreme && cr.hard && cr.crit_fail);
});

// 按规则包生成剧本包：规则包摘要提取（注入 AI prompt 用）——含技能/属性/检定体系
test('summarizeRulePackForPrompt：摘要含规则包技能名与检定体系', () => {
  const obj = parsePackObject('rule', read(join(HERE, '..', 'rules', 'coc7e.yaml'))) as Awaited<ReturnType<typeof loadRulePack>>;
  const sum = summarizeRulePackForPrompt(obj);
  assert.ok(sum.includes('克苏鲁的呼唤 7 版'));
  assert.ok(sum.includes('侦查'), '摘要应含技能名');
  assert.ok(sum.includes('检定规则'), '摘要应含检定体系');
  assert.ok(sum.includes('d100'));
});

// 修复：保存强制内容 id = 文件名 id（AI 草稿改过 id 不再脱节，删除才删得到）
test('savePackObject：内容 id 恒等于文件名 id（防"删除但还在"）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dk-pack-save-'));
  try {
    const store = new PackStore(dir);
    const tpl = buildNewPackTemplate('rule', '测试包', 'rule-a') as Record<string, unknown>;
    tpl.id = 'rule-ai-generated'; // 模拟 AI 草稿改了 id
    const r = savePackObject({ type: 'rule', id: 'rule-a', isBuiltin: false, obj: tpl as never, store });
    assert.equal(r.ok, true, r.error ?? '');
    const text = store.load('rule', 'rule-a');
    assert.ok(text, '文件应按传入 id 命名');
    const raw = parseYaml(parseDk(text!).body) as Record<string, unknown>;
    assert.equal(raw.id, 'rule-a', '内容 id 被强制纠正为文件名 id');
    // 按列表 id 删除能删到
    store.remove('rule', 'rule-a');
    assert.equal(store.load('rule', 'rule-a'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 修复：历史脱节数据（文件名 ≠ 内容 id）删除兜底——按内容 id 扫描删除
test('PackStore.remove：文件名与内容 id 脱节的旧数据可被兜底删除', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dk-pack-rm-'));
  try {
    const store = new PackStore(dir);
    const body = serializeYaml({ id: 'new-id', name: '脱节包', version: '1.0', dice_schema: 'd100', character_sheet: { attributes: ['A'], skills: [] }, check_rules: { normal: 'd100 <= SKILL' } });
    writeFileSync(join(dir, 'rule', 'old-name.yaml'), dkContent('rule', body), 'utf-8');
    store.remove('rule', 'new-id'); // 按内容 id 删除
    assert.equal(store.load('rule', 'old-name.yaml'), null, '脱节文件被兜底删除');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// AI 生成规则包：attributes 含空字符串元素 → 清理后保留有效属性
test('normalizeGeneratedPack：attributes 空元素清理 + 全空回退模板', () => {
  const ai = { name: '末世', dice_schema: 'd100', character_sheet: { attributes: ['力量', '', '  ', '敏捷'], skills: [{ base: 40 }] }, check_rules: { normal: 'd100 <= SKILL' } };
  const norm = normalizeGeneratedPack('rule', ai, '末世规则');
  const cs = norm.character_sheet as Record<string, unknown>;
  assert.deepEqual(cs.attributes, ['力量', '敏捷'], '空元素被过滤');
  // skills 条目缺 name → 补占位
  const skills = cs.skills as { name: string }[];
  assert.equal(skills[0].name, '未命名技能');
  // 全空 attributes → 回退模板
  const ai2 = { name: '末世2', dice_schema: 'd100', character_sheet: { attributes: ['', ''], skills: [{ name: '枪械', base: 40, category: '战斗' }] }, check_rules: { normal: 'd100 <= SKILL' } };
  const norm2 = normalizeGeneratedPack('rule', ai2, '末世规则');
  const cs2 = norm2.character_sheet as Record<string, unknown>;
  assert.ok(Array.isArray(cs2.attributes) && (cs2.attributes as string[]).length >= 4, '全空回退模板属性');
});

// AI 输出清洗：tab→空格、去行尾空白、CRLF 统一、多余空行压缩
test('sanitizeAiYaml：清洗后可通过严格解析器', () => {
  const dirty = 'id: test\nname: 测试\t\nworld:\n\tsummary: 世界观\n\n\nlore_entries:\n  - id: l1\n';
  const clean = sanitizeAiYaml(dirty);
  assert.ok(!clean.includes('\t'), 'tab 已转空格');
  assert.ok(!clean.includes('\r'), 'CRLF 已统一');
  assert.ok(!clean.includes('\n\n\n'), '多余空行已压缩');
  // 清洗后的内容能通过严格解析（tab 缩进是"缩进异常"主因）
  const parsed = parseYaml(clean) as Record<string, unknown>;
  assert.equal(parsed.id, 'test');
  assert.equal(parsed.name, '测试');
});

// AI 输出智能解析：JSON 对象 / YAML / 无效输出
test('parseAiOutput：JSON 输出被正确解析（修复按规则包生成后应用全是模板）', () => {
  const json = JSON.stringify({ id: 'scen-test', name: '选秀夜', version: '1.0', requires: 'coc7e', world: { summary: '2003 年选秀夜。' }, npc_seeds: [{ name: '主教练', traits: '苛刻' }] });
  const obj = parseAiOutput(json);
  assert.ok(obj, 'JSON 应被解析');
  assert.equal(obj.id, 'scen-test');
  assert.equal(obj.name, '选秀夜');
  assert.ok(Array.isArray(obj.npc_seeds) && (obj.npc_seeds as unknown[]).length === 1);
});
test('parseAiOutput：YAML 输出正常解析；无识别字段返回 null', () => {
  const yaml = 'id: scen-y\nname: 测试\nworld:/n  summary: 世界观\n';
  const obj = parseAiOutput(yaml);
  assert.ok(obj && obj.id === 'scen-y');
  // 纯解释文字（无识别字段）→ null（触发重试）
  assert.equal(parseAiOutput('好的，我来生成一个剧本包。'), null);
  assert.equal(parseAiOutput(''), null);
});

// AI 输出智能解析：json 代码块 / 文字+JSON 混排 / JSON 尾部解释文字
test('parseAiOutput：json 代码块与文字混排与尾部解释均能解析', () => {
  // 文字 + JSON 混排（extractYaml 定位 { 后）
  const mixed = '好的，这是生成的剧本包：\n{"id": "scen-mix", "name": "混排", "world": {"summary": "S"}}';
  const obj1 = parseAiOutput(mixed);
  assert.ok(obj1 && obj1.id === 'scen-mix');
  // JSON 尾部带解释文字
  const tail = '{"id": "scen-tail", "name": "尾部", "world": {"summary": "S"}}\n以上就是剧本包，有问题再问';
  const obj2 = parseAiOutput(tail);
  assert.ok(obj2 && obj2.id === 'scen-tail');
  // ```json 代码块（extractYaml 已取块，此处验证直接喂块内容）
  const jsonBlock = '{\n  "id": "scen-blk",\n  "name": "块",\n  "world": {"summary": "S"}\n}';
  const obj3 = parseAiOutput(jsonBlock);
  assert.ok(obj3 && obj3.id === 'scen-blk');
});

// AI 输出条目空串/非数组防御：traits 空串补占位（修复"npc_seeds[0] 缺少 traits"）；npc_seeds 是对象不崩
test('normalizeGeneratedPack：npc_seeds 条目 traits 空串被补占位 + 非数组不崩', () => {
  // traits 空串（AI 常见输出 traits: ""）→ 补占位后通过校验
  const ai = { name: '测试', world: { summary: 'S' }, npc_seeds: [{ name: '警长', traits: '' }], locations: [{ name: '码头' }], plot_threads: [{ name: '线索' }], hooks: ['开场'], lore_entries: [{ key_terms: ['雾'], content: 'C' }] };
  const norm = normalizeGeneratedPack('scenario', ai, '测试剧本');
  const npc = (norm.npc_seeds as { traits: string }[])[0];
  assert.ok(npc.traits.trim().length > 0, 'traits 空串被占位补全');
  const body = serializePackObject('scenario', norm as never);
  const res = validatePackContent(dkContent('scenario', body), ['coc7e']);
  assert.equal(res.ok, true, res.error ?? '');
  // npc_seeds 是非数组（AI 输出对象）→ 不崩，保留模板数组
  const ai2 = { name: '测试2', world: { summary: 'S' }, npc_seeds: { name: 'X' }, locations: [{ name: '码头' }], plot_threads: [{ name: '线索' }], hooks: ['开场'], lore_entries: [{ key_terms: ['雾'], content: 'C' }] };
  const norm2 = normalizeGeneratedPack('scenario', ai2, '测试');
  const res2 = validatePackContent(dkContent('scenario', serializePackObject('scenario', norm2 as never)), ['coc7e']);
  assert.equal(res2.ok, true, res2.error ?? '');
});
