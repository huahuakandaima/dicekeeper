// packs.ts — 内容包导入导出（方案 §3.7，抄 Foundry VTT 范式但单文件 .dk）
// .dk = 注释头 manifest（# format: dicekeeper/scenario-pack v1 等，parseYaml 自动忽略）+ YAML 正文
// 导入：类型识别 → schema 校验（非法拒载）→ 依赖检查（剧本包 requires 的规则包必须已安装）
// 存储：内置包在项目 rules/ 与 scenarios/；导入包在 userData/packs/{type}/{id}.yaml

import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml, validateRulePack, type RulePack } from './rules.ts';

// AI 生成 YAML 清洗（自研解析器严格：恰好 2 空格缩进、禁 tab）：
// tab→2 空格、去行尾空白、统一换行、压缩多余空行——降低"缩进异常"解析失败率
export function sanitizeAiYaml(src: string): string {
  return src
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\t/g, '  ').replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

// AI 生成输出智能解析（修复"按规则包生成后应用全是模板占位"）：
// LLM 偶尔输出 JSON（DeepSeek 注入规则包摘要后尤其容易），自研 YAML 解析器会把 JSON 解析成怪异结构
// → 先试 JSON（整段/定位第一个 {/尾部截断），再试 YAML；两者都失败或结果无识别字段 → 返回 null（触发重试）
const AI_PACK_KEYS = ['id', 'name', 'version', 'requires', 'world', 'npc_seeds', 'locations', 'plot_threads', 'hooks', 'lore_entries', 'encounters', 'character_sheet', 'check_rules', 'dice_schema'];
function tryJson(s: string): Record<string, unknown> | null {
  const t = s.trim();
  if (!/^[{[]/.test(t)) return null;
  try {
    const obj = JSON.parse(t) as unknown;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj as Record<string, unknown>;
  } catch {
    // 尾部可能带解释文字/截断（LLM 输出 `{...}\n解释` 常见）：从最后一个 } 截断重试
    const end = t.lastIndexOf('}');
    if (end > 0) {
      try {
        const obj = JSON.parse(t.slice(0, end + 1)) as unknown;
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj as Record<string, unknown>;
      } catch { /* 继续 */ }
    }
  }
  return null;
}
export function parseAiOutput(text: string): Record<string, unknown> | null {
  const clean = sanitizeAiYaml(text).trim();
  if (!clean) return null;
  // JSON：整段是 JSON，或定位第一个 {（文字 + JSON 混排）
  const whole = tryJson(clean);
  if (whole) return whole;
  const brace = clean.indexOf('{');
  if (brace > 0) {
    const fromBrace = tryJson(clean.slice(brace));
    if (fromBrace) return fromBrace;
  }
  // YAML
  try {
    const obj = parseYaml(clean) as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0 || !keys.some((k) => AI_PACK_KEYS.includes(k))) return null;
    return obj;
  } catch {
    return null;
  }
}
import { validateScenarioPack, type ScenarioPack } from './scenario.ts';
import { serializeYaml } from './yaml-write.ts';
import { adjudicate } from './adjudicate.ts';
import { matchLore } from './lore.ts';
import type { StoredLoreEntry } from './campaign.ts';

export type PackType = 'rule' | 'scenario';

export interface PackMeta {
  id: string;
  name: string;
  version: string;
  type: PackType;
  isBuiltin: boolean;
  requires?: string; // 剧本包依赖的规则包 id
}

export interface ImportResult {
  ok: boolean;
  type?: PackType;
  meta?: PackMeta;
  error?: string;
}

// —— .dk 文件格式 ——
export function dkContent(type: PackType, body: string): string {
  const format = type === 'rule' ? 'dicekeeper/rule-pack v1' : 'dicekeeper/scenario-pack v1';
  return `# format: ${format}\n# 由 DiceKeeper 导出，可重新导入\n# ---\n${body.replace(/^\uFEFF/, '')}`;
}

export function parseDk(content: string): { manifest: Record<string, string>; body: string } {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  const manifest: Record<string, string> = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith('#')) break;
    const m = /^#\s*([^:]+):\s*(.*)$/.exec(t);
    if (m) manifest[m[1].trim()] = m[2].trim();
  }
  return { manifest, body: lines.slice(i).join('\n') };
}

// —— 类型识别与校验 ——
export function detectPackType(raw: Record<string, unknown>): PackType | null {
  if (raw.character_sheet && raw.check_rules) return 'rule';
  if (raw.npc_seeds && raw.world && raw.lore_entries) return 'scenario';
  return null;
}

// 校验内容并返回 meta（不落盘）。installedRuleIds：已安装规则包 id 集合（依赖检查）
export function validatePackContent(content: string, installedRuleIds: string[]): ImportResult {
  const { manifest, body } = parseDk(content);
  let raw: Record<string, unknown>;
  try {
    raw = parseYaml(body) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, error: `YAML 解析失败: ${(e as Error).message}` };
  }
  const fmtType = manifest.format?.includes('scenario-pack') ? 'scenario' : manifest.format?.includes('rule-pack') ? 'rule' : null;
  const type = fmtType ?? detectPackType(raw);
  if (!type) return { ok: false, error: '无法识别的包类型：既不是规则包（character_sheet/check_rules），也不是剧本包（npc_seeds/world/lore_entries）' };
  try {
    if (type === 'rule') {
      const p = validateRulePack(raw);
      return { ok: true, type, meta: { id: p.id, name: p.name, version: String(p.version), type, isBuiltin: false } };
    }
    const p = validateScenarioPack(raw);
    if (!installedRuleIds.includes(p.requires)) {
      return { ok: false, error: `依赖检查失败：本剧本包需要规则包「${p.requires}」，当前未安装。请先导入该规则包。` };
    }
    return { ok: true, type, meta: { id: p.id, name: p.name, version: String(p.version), type, isBuiltin: false, requires: p.requires } };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// 内容摘要（导入预览用，§3.7）：解析对象后统计关键条目数
export interface PackSummary {
  npcCount?: number;
  locationCount?: number;
  plotCount?: number;
  loreCount?: number;
  skillCount?: number;
  attributeCount?: number;
  requires?: string;
}
export function summarizePackContent(content: string): PackSummary | null {
  try {
    const { body } = parseDk(content);
    const raw = parseYaml(body) as Record<string, unknown>;
    if (raw.npc_seeds && Array.isArray(raw.npc_seeds)) {
      // 剧本包
      return {
        npcCount: raw.npc_seeds.length,
        locationCount: Array.isArray(raw.locations) ? raw.locations.length : 0,
        plotCount: Array.isArray(raw.plot_threads) ? raw.plot_threads.length : 0,
        loreCount: Array.isArray(raw.lore_entries) ? raw.lore_entries.length : 0,
        requires: typeof raw.requires === 'string' ? raw.requires : undefined,
      };
    }
    if (raw.character_sheet && typeof raw.character_sheet === 'object') {
      const cs = raw.character_sheet as Record<string, unknown>;
      return {
        skillCount: Array.isArray(cs.skills) ? cs.skills.length : 0,
        attributeCount: Array.isArray(cs.attributes) ? cs.attributes.length : 0,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// —— 存储（userData/packs/）——
export class PackStore {
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(join(dir, 'rule'), { recursive: true });
    mkdirSync(join(dir, 'scenario'), { recursive: true });
  }

  // 扫描导入包（读 manifest 头，不完整解析）
  listImported(): PackMeta[] {
    const out: PackMeta[] = [];
    for (const type of ['rule', 'scenario'] as PackType[]) {
      const d = join(this.dir, type);
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d).filter((x) => x.endsWith('.yaml'))) {
        try {
          const text = readFileSync(join(d, f), 'utf-8');
          const raw = parseYaml(parseDk(text).body || text) as Record<string, unknown>;
          const meta: PackMeta = {
            id: String(raw.id ?? f.replace(/\.yaml$/, '')),
            name: String(raw.name ?? f),
            version: String(raw.version ?? '?'),
            type,
            isBuiltin: false,
            requires: typeof raw.requires === 'string' ? raw.requires : undefined,
          };
          out.push(meta);
        } catch { /* 坏文件跳过（列表容错） */ }
      }
    }
    return out;
  }

  save(type: PackType, meta: PackMeta, body: string): void {
    writeFileSync(join(this.dir, type, `${meta.id}.yaml`), body, 'utf-8');
  }

  load(type: PackType, id: string): string | null {
    const p = join(this.dir, type, `${id}.yaml`);
    return existsSync(p) ? readFileSync(p, 'utf-8') : null;
  }

  remove(type: PackType, id: string): void {
    const dir = join(this.dir, type);
    const p = join(dir, `${id}.yaml`);
    if (existsSync(p)) {
      rmSync(p, { force: true });
      return;
    }
    // 兜底：文件名与内容 id 脱节的旧数据（AI 草稿改过 id 时代产生）——按内容 id 扫描匹配删除
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.yaml'))) {
      try {
        const raw = parseYaml(parseDk(readFileSync(join(dir, f), 'utf-8')).body || '') as Record<string, unknown>;
        if (String(raw.id ?? '') === id) {
          rmSync(join(dir, f), { force: true });
          return;
        }
      } catch { /* 坏文件跳过 */ }
    }
  }
}

// 辅助：加载并校验导入的剧本包（供建团使用）
export function loadImportedScenario(store: PackStore, id: string): ScenarioPack | null {
  const text = store.load('scenario', id);
  if (!text) return null;
  try {
    const raw = parseYaml(parseDk(text).body || text) as Record<string, unknown>;
    return validateScenarioPack(raw);
  } catch {
    return null;
  }
}

export function loadImportedRulePack(store: PackStore, id: string): RulePack | null {
  const text = store.load('rule', id);
  if (!text) return null;
  try {
    const raw = parseYaml(parseDk(text).body || text) as Record<string, unknown>;
    return validateRulePack(raw);
  } catch {
    return null;
  }
}

// 规则包摘要（P3b 增强：AI「按规则包生成剧本包」用——把属性/技能/检定体系注入生成 prompt，
// 让 AI 产出的 NPC/线索/世界书贴合该规则体系，而非自由发挥）
export function summarizeRulePackForPrompt(rulePack: RulePack): string {
  const cs = (rulePack.character_sheet ?? {}) as Record<string, unknown>;
  const attributes = Array.isArray(cs.attributes) ? (cs.attributes as string[]).join('、') : '';
  const derived = Array.isArray(cs.derived) ? (cs.derived as string[]).join('、') : '';
  const skills = Array.isArray(cs.skills)
    ? (cs.skills as { name?: string; base?: number; category?: string }[])
        .map((s) => `${s.name ?? '?'}${typeof s.base === 'number' ? `(${s.base})` : ''}`)
        .join('、')
    : '';
  const cr = (rulePack.check_rules ?? {}) as Record<string, unknown>;
  const checkDesc = Object.entries(cr).map(([k, v]) => `${k}: ${String(v)}`).join('；');
  return [
    `规则包「${rulePack.name}」（id: ${rulePack.id}）`,
    `骰子体系: ${rulePack.dice_schema ?? 'd100'}`,
    `属性: ${attributes || '（未定义）'}`,
    `衍生值: ${derived || '（未定义）'}`,
    `技能: ${skills || '（未定义）'}`,
    `检定规则: ${checkDesc || '（未定义）'}`,
    '要求：剧本包必须贴合以上规则体系——NPC 秘密/地点线索/世界书里的行动建议与检定，使用该规则包的技能名与属性。',
  ].join('\n');
}

// 从零新建包模板（P3b 增强：内容包 tab「＋ 新建」入口）：生成可过校验的最小合法骨架，用户再编辑
// 规则包：CoC 风格 attributes/skills + check_rules（extreme/hard/normal/crit_fail，同 DSL 函数）
// 剧本包：world/npc_seeds/locations/plot_threads/hooks/lore_entries 各给 1 条占位示例（校验要求非空）
export function buildNewPackTemplate(type: PackType, name: string, id: string): RulePack | ScenarioPack {
  const base = { id, name, version: '1.0' };
  if (type === 'rule') {
    return {
      ...base,
      dice_schema: 'd100',
      character_sheet: {
        attributes: ['STR', 'CON', 'DEX', 'APP', 'INT', 'POW', 'EDU', 'SIZ'],
        derived: ['HP', 'MP', 'SAN'],
        skills: [{ name: '示例技能', base: 50, category: '调查' }],
      },
      check_rules: {
        extreme: 'd100 <= fifth(SKILL)',
        hard: 'd100 <= half(SKILL)',
        normal: 'd100 <= SKILL',
        crit_fail: 'd100 >= 96',
      },
    } as RulePack;
  }
  return {
    ...base,
    requires: 'coc7e',
    world: { summary: '（在此填写世界观设定：时代、地点、氛围、势力）' },
    npc_seeds: [{ name: '示例 NPC', traits: '（在此填写性格特征）' }],
    locations: [{ name: '示例地点' }],
    plot_threads: [{ id: 't1', name: '示例线索', status: 'open' }],
    hooks: ['（在此填写开场钩子，玩家由此入场）'],
    lore_entries: [{ id: 'l1', key_terms: ['示例关键词'], activation: 'blue', content: '（在此填写世界书内容：命中关键词时给守密人的提示）' }],
  } as ScenarioPack;
}

// AI 生成整包兜底（修复"AI 生成失败: 剧本包缺少 id"等）：AI 输出不可控，缺字段/空数组/空串
// 用合法模板占位补全，保证生成的骨架一定能过完整校验；AI 给到的内容优先保留。
export function normalizeGeneratedPack(type: PackType, raw: Record<string, unknown>, prompt: string): Record<string, unknown> {
  const tpl = buildNewPackTemplate(type, '未命名', '') as Record<string, unknown>;
  const merged: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(tpl)) {
    merged[k] = v; // 先铺模板
  }
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null) continue;
    // 数组字段：AI 输出非数组（对象/字符串）→ 忽略，保留模板数组（校验要求数组）
    if (['npc_seeds', 'locations', 'plot_threads', 'hooks', 'lore_entries', 'encounters'].includes(k) && !Array.isArray(v)) continue;
    // check_rules：AI 给的档位保留，模板缺的档位补全（合并而非覆盖）
    if (k === 'check_rules' && typeof v === 'object') {
      merged[k] = { ...((merged.check_rules ?? {}) as object), ...(v as object) };
      continue;
    }
    // character_sheet：合并（attributes 空数组/空元素 → 模板补；skills 条目缺 name 补占位）
    if (k === 'character_sheet' && typeof v === 'object') {
      const tplCs = (merged.character_sheet ?? {}) as Record<string, unknown>;
      const aiCs = v as Record<string, unknown>;
      const mergedCs: Record<string, unknown> = { ...tplCs, ...aiCs };
      const cleanArr = (arr: unknown): string[] | null => {
        if (!Array.isArray(arr)) return null;
        return (arr as unknown[]).map((x) => (typeof x === 'string' ? x.trim() : typeof x === 'number' ? String(x) : '')).filter((s) => s !== '');
      };
      const aiAttr = cleanArr(aiCs.attributes);
      mergedCs.attributes = aiAttr && aiAttr.length > 0 ? aiAttr : (tplCs.attributes ?? []);
      const aiDerived = cleanArr(aiCs.derived);
      mergedCs.derived = aiDerived && aiDerived.length > 0 ? aiDerived : (tplCs.derived ?? []);
      if (Array.isArray(aiCs.skills)) {
        mergedCs.skills = (aiCs.skills as unknown[]).map((s) =>
          s && typeof s === 'object' ? { name: '未命名技能', base: 50, category: '通用', ...(s as object) } : s,
        );
      }
      merged[k] = mergedCs;
      continue;
    }
    if (Array.isArray(v)) {
      if (v.length > 0) merged[k] = v; // AI 空数组不覆盖模板（校验要求非空）
      continue;
    }
    if (typeof v === 'object' && Object.keys(v as object).length === 0) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    merged[k] = v;
  }
  // 必填标量兜底：id / name 只认 AI 输出（模板占位不顶替），缺失时生成/从需求提取；version / requires 兜底
  merged.id = typeof raw.id === 'string' && raw.id.trim() ? raw.id : `${type === 'rule' ? 'rule' : 'scen'}-gen-${Date.now().toString(36)}`;
  merged.name = typeof raw.name === 'string' && raw.name.trim() ? raw.name : (prompt.trim().slice(0, 20) || (type === 'rule' ? '未命名规则' : '未命名剧本'));
  if (raw.version === undefined || raw.version === null || raw.version === '') merged.version = '1.0';
  if (type === 'scenario' && (typeof raw.requires !== 'string' || !raw.requires.trim())) merged.requires = 'coc7e';
  // world.summary 非空兜底（嵌套对象空 summary 不会走顶层空值过滤）
  if (type === 'scenario') {
    const tplWorld = (tpl.world ?? {}) as Record<string, unknown>;
    const aiWorld = (raw.world ?? {}) as Record<string, unknown>;
    const summary = typeof aiWorld.summary === 'string' && aiWorld.summary.trim() ? aiWorld.summary : tplWorld.summary;
    merged.world = { ...tplWorld, ...aiWorld, summary };
  }
  // 条目级兜底：AI 生成的条目缺必填字段/空串 → 补占位（AI 有有效值则保留）
  // 注意：占位必须放 ...n 之后（AI 空串会覆盖占位导致校验失败）；数组用 Array.isArray 保护（AI 可能输出对象）
  if (type === 'scenario') {
    if (Array.isArray(merged.npc_seeds)) {
      merged.npc_seeds = (merged.npc_seeds as Record<string, unknown>[]).map((n) => ({
        ...n,
        name: typeof n.name === 'string' && n.name.trim() ? n.name : '未命名 NPC',
        traits: typeof n.traits === 'string' && n.traits.trim() ? n.traits : '（AI 未生成性格，请补充）',
      }));
    }
    if (Array.isArray(merged.locations)) {
      merged.locations = (merged.locations as Record<string, unknown>[]).map((l, i) => ({ ...l, name: typeof l.name === 'string' && l.name.trim() ? l.name : `地点${i + 1}` }));
    }
    if (Array.isArray(merged.plot_threads)) {
      merged.plot_threads = (merged.plot_threads as Record<string, unknown>[]).map((t, i) => ({ ...t, id: typeof t.id === 'string' && t.id.trim() ? t.id : `t${i + 1}`, name: typeof t.name === 'string' && t.name.trim() ? t.name : '未命名线索' }));
    }
    if (Array.isArray(merged.lore_entries)) {
      merged.lore_entries = (merged.lore_entries as Record<string, unknown>[]).map((e, i) => ({
        ...e,
        id: typeof e.id === 'string' && e.id.trim() ? e.id : `l${i + 1}`,
        key_terms: Array.isArray(e.key_terms) && (e.key_terms as unknown[]).length > 0 ? (e.key_terms as unknown[]) : ['未分类'],
        activation: typeof e.activation === 'string' && ['blue', 'green', 'yellow'].includes(e.activation) ? e.activation : 'blue',
        content: typeof e.content === 'string' && e.content.trim() ? e.content : '（AI 未生成内容，请补充）',
      }));
    }
  }
  return merged;
}

// —— P3b 内容编辑器：对象解析/序列化/保存/试跑 ——

// 解析包文本（.dk 头或纯 YAML）为对象并校验
export function parsePackObject(type: PackType, text: string): RulePack | ScenarioPack {
  const { body } = parseDk(text);
  const raw = parseYaml(body || text) as Record<string, unknown>;
  return type === 'rule' ? validateRulePack(raw) : validateScenarioPack(raw);
}

// 序列化对象为 .dk 文本（供编辑器保存 / 源码视图）
export function serializePackObject(type: PackType, obj: RulePack | ScenarioPack): string {
  return dkContent(type, serializeYaml(obj));
}

// 编辑器保存：校验 → 序列化 → 落盘。内置包自动另存副本（id 加 -custom，防破坏内置包）
export function savePackObject(opts: {
  type: PackType;
  id: string;
  isBuiltin: boolean; // 调用方明确告知（列表 PackMeta.isBuiltin；不靠 id 比对，导入包可能同 id）
  obj: RulePack | ScenarioPack;
  store: PackStore;
}): { ok: boolean; meta?: PackMeta; savedAs?: string; error?: string } {
  const { type, id, obj, store } = opts;
  try {
    if (type === 'rule') validateRulePack(obj as unknown as Record<string, unknown>);
    else validateScenarioPack(obj as unknown as Record<string, unknown>);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const saveId = opts.isBuiltin ? `${id}-custom` : id;
  const meta: PackMeta = {
    id: saveId,
    name: obj.name,
    version: String(obj.version),
    type,
    isBuiltin: false,
    requires: type === 'scenario' ? (obj as ScenarioPack).requires : undefined,
  };
  try {
    // 内容 id 恒等于文件名 id（列表/加载/删除按内容 id 识别，脱节会导致"删除提示成功但文件还在"）
    // 非内置包同样强制同步：AI 草稿/用户改过 id 也不允许与文件名脱节
    const saveObj = { ...(obj as object), id: saveId };
    store.save(type, meta, serializePackObject(type, saveObj as RulePack & ScenarioPack));
  } catch (e) {
    return { ok: false, error: `保存失败: ${(e as Error).message}` };
  }
  return { ok: true, meta, savedAs: opts.isBuiltin ? saveId : undefined };
}

// 试跑：规则包检定模拟（复用判定引擎，判定本地化同款逻辑）
export function testPackCheck(
  ruleObj: RulePack,
  skill: string,
  value: number,
  mode: 'normal' | 'reward' | 'penalty',
  seed?: string,
) {
  return adjudicate({ rulePack: ruleObj, skill, value, mode, seed: seed ?? `test-${Date.now()}` });
}

// 试跑：成功率分布（§11.3：跑 N 次看各档位占比，供规则作者调 check_rules）
export function testPackDistribution(
  ruleObj: RulePack,
  skill: string,
  value: number,
  mode: 'normal' | 'reward' | 'penalty',
  trials = 1000,
) {
  const counts: Record<string, number> = { crit_fail: 0, extreme: 0, hard: 0, normal: 0, fail: 0 };
  for (let i = 0; i < trials; i++) {
    counts[adjudicate({ rulePack: ruleObj, skill, value, mode, seed: `dist-${i}` }).outcome]++;
  }
  return { trials, counts };
}

// 试跑：剧本包世界书命中模拟（蓝/绿/黄 + priority + token 预算截断，与建团后行为一致）
export function testPackLore(scenarioObj: ScenarioPack, text: string, budget = 3000) {
  const entries: StoredLoreEntry[] = scenarioObj.lore_entries.map((e) => ({
    id: e.id,
    scenarioPackId: scenarioObj.id,
    keyTerms: e.key_terms.map(String),
    activation: e.activation,
    content: e.content,
    tokenBudget: e.token_budget ?? 0,
    priority: e.priority ?? 0,
  }));
  const hits = matchLore(entries, { recentText: text, allText: text, budget });
  return {
    budget,
    used: hits.reduce((s, h) => s + h.entry.content.length + 4, 0),
    hits: hits.map((h) => ({
      id: h.entry.id,
      activation: h.activatedBy,
      content: h.entry.content,
      priority: h.entry.priority,
      cost: h.entry.content.length + 4,
    })),
  };
}

export type { RulePack, ScenarioPack };
