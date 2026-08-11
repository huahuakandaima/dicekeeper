// scenario.ts — 剧本包（Scenario Pack）加载与校验（方案 §3.5）
// 复用 rules.ts 的 mini YAML；结构：world / npc_seeds / locations / plot_threads / encounters / hooks / lore_entries
// 关键设计：NPC 是种子不是成品；剧情是线索网络不是关卡脚本；世界书条目按关键词触发注入

import { readFileSync } from 'node:fs';
import { parseYaml } from './rules.ts';

export class ScenarioPackError extends Error {}

export type Activation = 'blue' | 'green' | 'yellow'; // 蓝灯常驻 / 绿灯近期 / 黄灯历史（抄 SillyTavern Lorebook）

export interface LoreEntry {
  id: string;
  key_terms: string[];
  activation: Activation;
  content: string;
  token_budget?: number;
  priority?: number;
}

export interface NpcSeed {
  name: string;
  aliases?: string[];
  traits: string;
  secrets?: string;
  relation_hint?: string;
}

export interface LocationSeed {
  name: string;
  aliases?: string[];
  state?: string;
  secrets?: string;
}

export interface PlotThread {
  id: string;
  name: string;
  status: 'open' | 'closed';
  branches?: string[];
}

export interface EncounterTemplate {
  name: string;
  type: 'social' | 'combat' | 'exploration';
  skill?: string;
  note?: string;
}

export interface ScenarioPack {
  id: string;
  name: string;
  version: string;
  requires: string; // 依赖的规则包 id（方案 §3.5）
  world: {
    summary: string;
    cosmology?: string;
    factions?: { name: string; stance: string }[];
  };
  npc_seeds: NpcSeed[];
  locations: LocationSeed[];
  plot_threads: PlotThread[];
  encounters?: EncounterTemplate[];
  hooks: string[];
  lore_entries: LoreEntry[];
}

const VALID_ACTIVATIONS = new Set(['blue', 'green', 'yellow']);

export function loadScenarioPack(filePath: string): ScenarioPack {
  const text = readFileSync(filePath, 'utf-8');
  const raw = parseYaml(text) as Record<string, unknown>;
  return validateScenarioPack(raw);
}

export function validateScenarioPack(raw: Record<string, unknown>): ScenarioPack {
  const err = (msg: string) => { throw new ScenarioPackError(msg); };
  if (!raw.id || typeof raw.id !== 'string') err('剧本包缺少 id');
  if (!raw.name || typeof raw.name !== 'string') err('剧本包缺少 name');
  if (raw.version === undefined || raw.version === null) err('剧本包缺少 version');
  if (!raw.requires || typeof raw.requires !== 'string') err('剧本包缺少 requires（依赖的规则包 id）');

  const w = raw.world as Record<string, unknown> | undefined;
  if (!w || typeof w !== 'object') err('剧本包缺少 world');
  if (!w.summary || typeof w.summary !== 'string' || w.summary.trim() === '') err('world.summary 必须是非空字符串');

  if (!Array.isArray(raw.npc_seeds) || (raw.npc_seeds as unknown[]).length === 0) err('npc_seeds 必须是非空数组');
  if (!Array.isArray(raw.locations) || (raw.locations as unknown[]).length === 0) err('locations 必须是非空数组');
  if (!Array.isArray(raw.plot_threads) || (raw.plot_threads as unknown[]).length === 0) err('plot_threads 必须是非空数组');
  if (!Array.isArray(raw.hooks) || (raw.hooks as unknown[]).length === 0) err('hooks 必须是非空数组');

  for (const [i, s] of (raw.npc_seeds as unknown[]).entries()) {
    const npc = s as Record<string, unknown>;
    if (!npc.name || typeof npc.name !== 'string') err(`npc_seeds[${i}] 缺少 name`);
    if (!npc.traits || typeof npc.traits !== 'string') err(`npc_seeds[${i}] 缺少 traits`);
  }
  for (const [i, l] of (raw.locations as unknown[]).entries()) {
    const loc = l as Record<string, unknown>;
    if (!loc.name || typeof loc.name !== 'string') err(`locations[${i}] 缺少 name`);
  }
  for (const [i, t] of (raw.plot_threads as unknown[]).entries()) {
    const p = t as Record<string, unknown>;
    if (!p.id || typeof p.id !== 'string') err(`plot_threads[${i}] 缺少 id`);
    if (!p.name || typeof p.name !== 'string') err(`plot_threads[${i}] 缺少 name`);
    if (p.status !== undefined && p.status !== 'open' && p.status !== 'closed') err(`plot_threads[${i}].status 必须为 open/closed`);
  }

  const lore = raw.lore_entries;
  if (!Array.isArray(lore) || lore.length === 0) err('lore_entries 必须是非空数组（世界书条目）');
  for (const [i, e] of lore.entries()) {
    const le = e as Record<string, unknown>;
    if (!le.id || typeof le.id !== 'string') err(`lore_entries[${i}] 缺少 id`);
    if (!Array.isArray(le.key_terms) || (le.key_terms as unknown[]).length === 0) err(`lore_entries[${i}] 缺少 key_terms（至少 1 个关键词）`);
    // 规范化：关键词统一为字符串（YAML 数字如 1895 也会被 parseScalar 解析为 number）
    le.key_terms = (le.key_terms as unknown[]).map((t) => String(t));
    if (typeof le.activation !== 'string' || !VALID_ACTIVATIONS.has(le.activation)) err(`lore_entries[${i}].activation 必须为 blue/green/yellow`);
    if (!le.content || typeof le.content !== 'string' || le.content.trim() === '') err(`lore_entries[${i}] 缺少 content`);
  }

  return raw as unknown as ScenarioPack;
}
