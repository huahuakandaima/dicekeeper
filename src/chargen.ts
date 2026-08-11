// chargen.ts — 随机车卡执行器（由规则包 chargen 段驱动，引擎零硬编码）
// 流程：属性生成(attribute_methods 公式) → 衍生值(derived_formulas 用 DSL 求值) → 职业/技能点分配

import type { RulePack } from './rules.ts';
import { makeRng, rollInt } from './rng.ts';
import { roll } from './dice.ts';
import { evaluate } from './dsl.ts';
import type { RNG } from './rng.ts';

export interface Character {
  name: string;
  gender?: string;          // 男 / 女 / 其他（v1 自由文本，UI 提供选项）
  age: number;
  occupation: string;
  attributes: Record<string, number>; // STR..SIZ 等
  derived: Record<string, number>;    // HP/MP/SAN/幸运/DB/Build/MOV
  skills: Record<string, number>;     // 技能名 → 当前值（base + 加点）
  sheet_version: string;
  created_seed: string;
}

export class ChargenError extends Error {}

export interface ChargenOptions {
  seed?: string | number;
  rng?: RNG;
  name?: string;
  gender?: string;
  age?: number;
  occupation?: string;
  loaded?: boolean; // 灌铅模式（§11.10）：属性骰重复投一次取更高总值，降低低属性概率
}

// 手动车卡规格（§11.10 微调：随机打底后手填属性/技能）
export interface CharacterSpec {
  name: string;
  gender?: string;
  age: number;
  occupation: string;
  attributes: Record<string, number>;
  skills: Record<string, number>;
}

// 衍生值计算（generateCharacter 与 buildCharacter 共用；规则包 derived_formulas 驱动）
export function computeDerived(pack: RulePack, attributes: Record<string, number>, seed: string | number, age: number, rng?: RNG): Record<string, number> {
  const cg = pack.chargen;
  if (!cg) throw new ChargenError(`规则包 ${pack.id} 缺少 chargen 段`);
  const r = rng ?? makeRng(seed);
  const baseFields: Record<string, number> = { ...attributes };
  const derived: Record<string, number> = {};
  if (cg.derived_formulas) {
    for (const [name, formula] of Object.entries(cg.derived_formulas)) {
      try {
        derived[name] = Math.floor(evaluate(formula, { fields: baseFields, rng: r }).value as number);
      } catch {
        // 公式引用字段与属性名不匹配（英文公式 + 中文属性名，模板兜底/AI 输出常见）→ 回退首属性值，不炸车卡
        const first = pack.character_sheet.attributes[0];
        derived[name] = Math.max(1, Math.min(99, Math.round(Number(baseFields[first]) || 50)));
      }
    }
  }
  const { db, build } = cocDbBuild(attributes.STR + attributes.SIZ);
  derived.DB = parseDbAvg(db, r);
  derived.Build = build;
  derived.MOV = 9; // 20-39 基础移动力（v1 固定）
  return derived;
}

// 手动车卡：校验输入（属性 1-99 / 技能 0-99 / 职业非空），衍生值自动计算
// derivedOverrides：允许覆盖个别衍生值（如重掷幸运后保持 UI 显示值，修复保存时被重新随机覆盖）
export function buildCharacter(pack: RulePack, spec: CharacterSpec, seed: string | number = 'manual', derivedOverrides?: Record<string, number>): Character {
  const cg = pack.chargen;
  if (!cg) throw new ChargenError(`规则包 ${pack.id} 缺少 chargen 段`);
  const err = (msg: string) => { throw new ChargenError(msg); };
  if (!spec.name || typeof spec.name !== 'string') err('角色名不能为空');
  if (spec.gender !== undefined && !['男', '女', '其他'].includes(spec.gender)) err('性别须为 男/女/其他');
  if (!Number.isInteger(spec.age) || spec.age < 15 || spec.age > 89) err('年龄须为 15-89 的整数');
  for (const [k, v] of Object.entries(spec.attributes)) {
    if (!Number.isInteger(v) || v < 1 || v > 99) err(`属性 ${k} 须为 1-99 的整数（当前 ${v}）`);
  }
  if (!spec.occupation || typeof spec.occupation !== 'string') err('职业不能为空（可选内置职业或自由输入自定义职业）');
  for (const [k, v] of Object.entries(spec.skills)) {
    if (!Number.isInteger(v) || v < 0 || v > 99) err(`技能 ${k} 须为 0-99 的整数（当前 ${v}）`);
  }
  const derived = { ...computeDerived(pack, spec.attributes, seed, spec.age), ...(derivedOverrides ?? {}) };
  return {
    name: spec.name,
    gender: spec.gender,
    age: spec.age,
    occupation: spec.occupation,
    attributes: { ...spec.attributes },
    derived,
    skills: { ...spec.skills },
    sheet_version: pack.version,
    created_seed: String(seed),
  };
}

// CoC 7e DB/Build 查表（STR+SIZ 决定）——规则包可覆盖（v2 提供 tables 化）
export function cocDbBuild(sum: number): { db: string; build: number } {
  if (sum <= 64) return { db: '-2', build: -2 };
  if (sum <= 84) return { db: '-1', build: -1 };
  if (sum <= 124) return { db: '0', build: 0 };
  if (sum <= 164) return { db: '+1d4', build: 1 };
  if (sum <= 204) return { db: '+1d6', build: 2 };
  return { db: '+2d6', build: 3 };
}

export function generateCharacter(pack: RulePack, opts: ChargenOptions = {}): Character {
  const cg = pack.chargen;
  if (!cg) throw new ChargenError(`规则包 ${pack.id} 缺少 chargen 段`);
  const rng = opts.rng ?? makeRng(opts.seed ?? 'chargen');
  const seed = opts.seed ?? 'chargen';

  // ① 属性生成：以 character_sheet.attributes 为驱动（用户定义的属性即车卡输出），
  // 公式按字段名从 attribute_methods 匹配、缺省 3d6*5——修"改了属性名车卡还是旧字段"（模板/AI 包字段脱节）
  // 灌铅模式（§11.10）：每个属性重复投一次，取总值更高的一次（不改变分布形状，整体右移）
  const methodByField = new Map<string, string>();
  for (const m of cg.attribute_methods ?? []) {
    for (const f of m.fields) methodByField.set(f, m.formula);
  }
  const attributes: Record<string, number> = {};
  for (const field of pack.character_sheet.attributes) {
    const formula = methodByField.get(field) ?? '3d6*5';
    let r = roll(formula, rng);
    if (opts.loaded) {
      const r2 = roll(formula, rng);
      if (r2.total > r.total) r = r2;
    }
    attributes[field] = r.total;
  }

  // ② 年龄（v1：20-39 档无修正；年龄修正结构化 v2）
  const age = opts.age ?? 20 + rollInt(rng, 0, 19);

  const derived = computeDerived(pack, attributes, seed, age, rng);
  const gender = opts.gender ?? (rollInt(rng, 0, 1) === 0 ? '男' : '女');

  // ④ 职业与技能点
  const occupations = cg.occupations ?? [];
  if (occupations.length === 0) throw new ChargenError(`规则包 ${pack.id} 无职业定义`);
  const occupation = opts.occupation && occupations.some((o) => o.name === opts.occupation)
    ? opts.occupation
    : occupations[rollInt(rng, 0, occupations.length - 1)].name;
  const occ = occupations.find((o) => o.name === occupation)!;

  // 职业点：occupation.points 公式（如 EDU*2+INT*2）。公式字段引用与属性名可能不匹配
  // （英文公式 + 中文属性名，AI/用户改属性后常见）——求值失败回退固定点数，不炸车卡
  let occPoints: number;
  try {
    occPoints = Math.floor(evaluate(occ.points, { fields: { ...attributes }, rng }).value as number);
  } catch {
    occPoints = Math.max(30, pack.character_sheet.attributes.length * 20);
  }
  const interestPoints = (attributes.INT ?? 0) * 2;

  // 技能初始化：base 值
  const skills: Record<string, number> = {};
  for (const s of pack.character_sheet.skills) skills[s.name] = s.base;

  // 职业点分配到职业技能（v1 策略：均分，余数随机补）
  const occSkillNames = occ.skills.filter((s) => s in skills);
  if (occSkillNames.length > 0) {
    const per = Math.floor(occPoints / occSkillNames.length);
    let rest = occPoints - per * occSkillNames.length;
    for (const s of occSkillNames) skills[s] += per;
    // 余数随机加给职业内技能（每 +5 一次，CoC 习惯 5 为步长）
    while (rest >= 5) {
      const s = occSkillNames[rollInt(rng, 0, occSkillNames.length - 1)];
      skills[s] += 5;
      rest -= 5;
    }
  }

  // 兴趣点：随机挑选兴趣技能投入（v1 策略：每次 10 点，随机技能）
  let remaining = interestPoints;
  const skillNames = pack.character_sheet.skills.map((s) => s.name);
  let guard = 0;
  while (remaining >= 10 && guard++ < 200) {
    const s = skillNames[rollInt(rng, 0, skillNames.length - 1)];
    if (skills[s] < 95) { skills[s] += 10; remaining -= 10; }
  }

  return {
    name: opts.name ?? `调查员-${seed.slice(0, 6)}`,
    gender,
    age,
    occupation,
    attributes,
    derived,
    skills,
    sheet_version: pack.version,
    created_seed: String(seed),
  };
}

// 单项重骰（§11.10：一键随机 + 单项重骰 + 微调——规格要求，此前只实现了幸运重掷）：
// 重掷单个属性——按 chargen.attribute_methods 匹配该字段公式（缺省 3d6*5），灌铅模式同样生效
export function rerollAttribute(pack: RulePack, field: string, seed: string | number, loaded = false): number {
  const cg = pack.chargen;
  if (!cg) throw new ChargenError(`规则包 ${pack.id} 缺少 chargen 段`);
  const formula = cg.attribute_methods?.find((m) => m.fields.includes(field))?.formula ?? '3d6*5';
  const rng = makeRng(seed);
  let r = roll(formula, rng);
  if (loaded) {
    const r2 = roll(formula, rng);
    if (r2.total > r.total) r = r2;
  }
  return r.total;
}

// DB 表达式均值（v1：字符串形式 "+1d4" 掷一次取总值；纯数值直接返回）
function parseDbAvg(db: string, rng: RNG): number {
  const m = /^([+-])(\d*)d(\d+)$/.exec(db);
  if (!m) return parseInt(db, 10);
  const sign = m[1] === '-' ? -1 : 1;
  const count = m[2] ? parseInt(m[2], 10) : 1;
  const sides = parseInt(m[3], 10);
  const r = roll(`${count}d${sides}`, rng);
  return sign * r.total;
}

// 角色卡 → 检定上下文（把"侦查 60"接进 adjudicate）
export function characterFields(c: Character): Record<string, number> {
  return { ...c.attributes, ...c.skills };
}
