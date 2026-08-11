// adjudicate.ts — 判定引擎（判定本地化的核心）
// 流程：本地统一掷骰 → 按规则包 check_rules 级联判定（共享同一骰值）→ 输出结论
// AI/叙事者只接收 {结果, 结论}，不参与任何随机与比较

import type { RulePack } from './rules.ts';
import { evaluate } from './dsl.ts';
import type { RNG } from './rng.ts';
import { makeRng } from './rng.ts';
import { roll } from './dice.ts';

export type Outcome = 'crit_fail' | 'extreme' | 'hard' | 'normal' | 'fail';

export interface AdjudicateOptions {
  rulePack: RulePack;
  skill: string;                 // 检定的技能/属性名（check_rules 用 SKILL 占位）
  value: number;                 // 技能/属性值
  mode?: 'normal' | 'reward' | 'penalty'; // 奖励骰(取低)/惩罚骰(取高)
  seed?: string | number;
  rng?: RNG;
  extraFields?: Record<string, number>;
}

export interface TierResult { tier: string; ok: boolean }

export interface Adjudication {
  outcome: Outcome;
  label: string;          // 中文结论
  diceRolls: number[];    // 审计：全部掷出的骰面
  takenRoll: number;      // 采纳的骰值
  tiers: TierResult[];    // 每级判定记录
  detail: string;         // 人话描述（给玩家/叙事者的完整说明）
}

// 级联顺序（规则包缺失的键自动跳过）；crit_fail 优先：大失败优先于任何成功档位
const TIER_ORDER: Outcome[] = ['crit_fail', 'extreme', 'hard', 'normal'];
const LABELS: Record<Outcome, string> = {
  crit_fail: '大失败',
  extreme: '极限成功',
  hard: '困难成功',
  normal: '普通成功',
  fail: '失败',
};

export function adjudicate(opts: AdjudicateOptions): Adjudication {
  const { rulePack, skill, value } = opts;
  const rng = opts.rng ?? makeRng(opts.seed ?? 'adjudicate');

  // ① 本地统一掷骰（判定本地化：随机性只发生在此处）
  const double = opts.mode === 'reward' || opts.mode === 'penalty';
  const raw = roll(double ? '2d100' : 'd100', rng, [100]);
  const diceRolls = raw.rolls;
  const taken = opts.mode === 'reward'
    ? Math.min(...diceRolls)
    : opts.mode === 'penalty'
      ? Math.max(...diceRolls)
      : diceRolls[0];

  // ② DSL 级联判定：每级共享同一颗骰（deck 单值），DSL 只做比较
  const fields: Record<string, number> = { SKILL: value, ...(opts.extraFields ?? {}) };
  const tiers: TierResult[] = [];
  let outcome: Outcome = 'fail';

  for (const tier of TIER_ORDER) {
    const expr = rulePack.check_rules[tier];
    if (!expr) continue;
    const r = evaluate(expr, { fields, rng, sides: [100], deck: { d100: [taken] } });
    tiers.push({ tier, ok: r.ok });
    if (r.ok) { outcome = tier; break; }
  }

  const modeNote = opts.mode === 'reward'
    ? `（奖励骰 ${diceRolls.join(',')} 取低）`
    : opts.mode === 'penalty'
      ? `（惩罚骰 ${diceRolls.join(',')} 取高）`
      : '';
  const detail = `${skill} 检定 d100=${taken}${modeNote}，${LABELS[outcome]}`;

  return {
    outcome,
    label: LABELS[outcome],
    diceRolls,
    takenRoll: taken,
    tiers,
    detail,
  };
}
