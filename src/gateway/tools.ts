// gateway/tools.ts — 工具注册表（AI 只能"请求"，本地引擎执行）
// make_check 是判定本地化的核心：skill 由引擎从角色卡取值，AI 无法传伪造值

import type { RulePack } from '../rules.ts';
import type { Character } from '../chargen.ts';
import type { World } from '../world.ts';
import type { RNG } from '../rng.ts';
import { makeRng } from '../rng.ts';
import { roll } from '../dice.ts';
import { adjudicate } from '../adjudicate.ts';
import type { ToolCall } from './provider.ts';

export interface ToolContext {
  pack: RulePack;
  character?: Character;      // 当前 PC（make_check 从这里取技能值）
  world: World;
  seed: string;               // 审计种子
  extraFields?: Record<string, number>;
}

export interface ToolResult {
  content: string;            // 回填给 LLM 的内容（JSON 字符串）
  diceIds?: string[];         // 本工具调用产生的掷骰记录 id（供输出校验）
  entityChanged?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolError extends Error {}

// 技能值查找：技能 → 角色卡 skills；属性 → attributes；未命中回退 extraFields
function resolveSkillValue(ctx: ToolContext, skill: string): number | undefined {
  const c = ctx.character;
  if (!c) return ctx.extraFields?.[skill];
  if (skill in c.skills) return c.skills[skill];
  if (skill in c.attributes) return c.attributes[skill];
  return ctx.extraFields?.[skill];
}

const makeCheck: ToolDef = {
  name: 'make_check',
  description: '进行一次技能/属性检定。判定由本地引擎执行（骰子与成败都不可由 AI 控制）。返回骰值与结论。',
  parameters: {
    type: 'object',
    properties: {
      skill: { type: 'string', description: '技能或属性名，如 侦查 / STR' },
      mode: { type: 'string', enum: ['normal', 'reward', 'penalty'], description: '奖励骰(取低)/惩罚骰(取高)' },
      reason: { type: 'string', description: '检定理由（写进审计）' },
    },
    required: ['skill'],
  },
  async run(args, ctx) {
    const skill = String(args.skill ?? '');
    const value = resolveSkillValue(ctx, skill);
    if (value === undefined) throw new ToolError(`未知技能或属性: ${skill}（角色卡无此字段）`);
    const a = adjudicate({
      rulePack: ctx.pack,
      skill,
      value,
      mode: (args.mode as 'normal' | 'reward' | 'penalty' | undefined) ?? 'normal',
      seed: ctx.seed,
      extraFields: { ...ctx.extraFields, SKILL: value },
    });
    const rec = ctx.world.addDice('d100', a.takenRoll, a.diceRolls, String(args.reason ?? skill), 'ai', ctx.seed);
    return {
      content: JSON.stringify({ dice: rec.id, taken: a.takenRoll, rolls: a.diceRolls, verdict: a.label, detail: a.detail }),
      diceIds: [rec.id],
    };
  },
};

const rollDice: ToolDef = {
  name: 'roll_dice',
  description: '自由掷骰（如伤害、随机事件）。只产生数值，不做判定。需要判定用 make_check。',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: '骰子表达式，如 2d6+3 / 1d100 / 5d10t8' },
      reason: { type: 'string' },
    },
    required: ['expression'],
  },
  async run(args, ctx) {
    const expr = String(args.expression ?? '');
    const r = roll(expr, makeRng(ctx.seed));
    const rec = ctx.world.addDice(expr, r.total, r.rolls, String(args.reason ?? expr), 'ai', ctx.seed);
    return {
      content: JSON.stringify({ dice: rec.id, total: r.total, rolls: r.rolls, expr }),
      diceIds: [rec.id],
    };
  },
};

const queryWorld: ToolDef = {
  name: 'query_world',
  description: '查询世界档案（NPC/地点/物品/组织）。禁止编造不存在的实体，不确定时先查这里。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '实体名称/别名/关键词' },
      entity_type: { type: 'string', enum: ['npc', 'pc', 'location', 'item', 'org'] },
    },
    required: ['query'],
  },
  async run(args, ctx) {
    const found = ctx.world.search(String(args.query ?? ''), args.entity_type as never);
    return {
      content: JSON.stringify(found.length > 0
        ? found.map((e) => ({ id: e.id, type: e.type, name: e.name, aliases: e.aliases ?? [], data: e.data }))
        : { note: '无匹配实体' }),
    };
  },
};

const updateEntity: ToolDef = {
  name: 'update_entity',
  description: '更新世界状态（NPC 好感、地点状态、道具易手等）。所有变更自动进审计日志。',
  parameters: {
    type: 'object',
    properties: {
      entity_id: { type: 'string', description: '实体 id（先 query_world 查）' },
      delta: { type: 'object', description: '要更新的字段' },
    },
    required: ['entity_id', 'delta'],
  },
  async run(args, ctx) {
    const e = ctx.world.updateEntity(String(args.entity_id ?? ''), (args.delta as Record<string, unknown>) ?? {});
    if (!e) throw new ToolError(`实体不存在: ${args.entity_id}`);
    return { content: JSON.stringify({ ok: true, entity: e.name, updated: e.data }), entityChanged: true };
  },
};

const remember: ToolDef = {
  name: 'remember',
  description: '记录一条长期记忆事实（如"埃德加欠赌债"）。结构化状态变更用 update_entity。',
  parameters: {
    type: 'object',
    properties: {
      fact: { type: 'string' },
      entity_refs: { type: 'array', items: { type: 'string' }, description: '关联实体 id 列表' },
      importance: { type: 'string', enum: ['high', 'normal', 'low'] },
    },
    required: ['fact'],
  },
  async run(args, ctx) {
    const fact = String(args.fact ?? '').trim();
    if (!fact) throw new ToolError('remember: fact 不能为空');
    const refs = (args.entity_refs as string[]) ?? [];
    // §11.4 一致性校验：与既有记录冲突时挂起/丢弃（以既有为权威），防止事实被反复改写
    // 冲突判定：同实体 + 新事实覆盖旧 high 事实 ≥50% 核心字（去掉虚词）→ 视为改写冲突
    const stopSet = new Set('的了在是有和与及或就都而但是也很被把将'.split(''));
    const coreChars = (s: string): string[] => [...new Set([...s])].filter((c) => !stopSet.has(c) && !/[0-9\s]/.test(c));
    const conflict = ctx.world.facts.find((f) => {
      if (f.importance !== 'high') return false;
      if (refs.length > 0 && !refs.some((r) => f.entity_refs.includes(r))) return false;
      const core = coreChars(f.fact);
      if (core.length < 4) return false;
      const shared = core.filter((c) => fact.includes(c)).length;
      return shared / core.length >= 0.5;
    });
    if (conflict) {
      return { content: JSON.stringify({ ok: false, rejected: true, reason: `与既有记录冲突，已保留原记录：「${conflict.fact}」。若确实要修改，请用 update_entity 更新实体状态。` }) };
    }
    const f = ctx.world.addFact(fact, refs, (args.importance as never) ?? 'normal');
    return { content: JSON.stringify({ ok: true, fact_id: f.id }) };
  },
};

const checkRule: ToolDef = {
  name: 'check_rule',
  description: '查询当前规则包的规则参考文本（裁决依据）。',
  parameters: {
    type: 'object',
    properties: { question: { type: 'string' } },
    required: ['question'],
  },
  async run(args, ctx) {
    const ref = ctx.pack.rules_reference ?? '';
    const q = String(args.question ?? '');
    // v1：关键词段落粗检索（取包含关键词的句子前后）
    const sentences = ref.split(/[。！？\n]/).map((s) => s.trim()).filter(Boolean);
    const hit = sentences.find((s) => s.includes(q)) ?? sentences.find((s) => [...q].some((ch) => s.includes(ch)));
    return { content: JSON.stringify({ reference: hit ?? ref.slice(0, 500) }) };
  },
};

const drawTable: ToolDef = {
  name: 'draw_table',
  description: '从规则包随机表抽取一项（本地随机）。',
  parameters: {
    type: 'object',
    properties: {
      table_id: { type: 'string' },
    },
    required: ['table_id'],
  },
  async run(args, ctx) {
    const t = ctx.pack.tables?.[String(args.table_id ?? '')];
    if (!t || t.length === 0) throw new ToolError(`随机表不存在: ${args.table_id}`);
    const item = t[Math.floor(Math.random() * t.length)];
    return { content: JSON.stringify({ table: args.table_id, item }) };
  },
};

export const TOOLS: ToolDef[] = [makeCheck, rollDice, queryWorld, updateEntity, remember, checkRule, drawTable];
export const TOOL_SCHEMAS = TOOLS.map((t) => ({
  type: 'function' as const,
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

export async function executeTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const def = TOOLS.find((t) => t.name === call.name);
  if (!def) throw new ToolError(`未知工具: ${call.name}`);
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    throw new ToolError(`工具 ${call.name} 参数不是合法 JSON: ${call.arguments}`);
  }
  return def.run(args, ctx);
}

export { makeCheck, rollDice };
