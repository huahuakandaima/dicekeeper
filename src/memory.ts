// memory.ts — 记忆管理层（方案 §3.3 + §11.4/§11.6）
// 三层记忆：L1 最近 N 轮（messages 表，chat 组装）｜L2 session 摘要（sessions.summary，结束全量重生成）
//           L3 世界层（entities/relations/memory_facts，事件驱动 + 提及检测）
// 注入组装：角色卡 + 世界书命中（matchLore）+ 提及实体档案 + 活跃线索 + 关联事实 + 上一 session 摘要（CHRONICLE）

import type { Provider, ChatMessage } from './gateway/provider.ts';
import type { World, Entity, Fact, Relation } from './world.ts';
import type { StoredMessage } from './campaign.ts';

export const MEMORY_TOKEN_BUDGET = 3000; // 注入预算 [PLACEHOLDER]（方案附参数清单）

export interface MemoryContext {
  summary?: string;               // 上一 session 摘要（[CHRONICLE 历史记录]）
  mentioned: Entity[];            // 本地提及检测命中的实体（§11.6，不依赖 AI）
  focus?: Entity;                 // @ 唤起目标（强制注入 + 本轮优先）
  openPlots: Entity[];            // 活跃线索（plot status=open）
  facts: Fact[];                  // 与在场/提及实体关联的事实（importance 降序）
}

export interface MemoryArgs {
  world: World;
  recentText: string;             // 最近 N 轮消息拼接（§11.6 提及窗口 [PLACEHOLDER 5 轮]）
  allText?: string;
  focusQuery?: string;            // @ 解析出的实体名/别名
  summary?: string;               // 上一 session 摘要
  maxFacts?: number;
}

const IMPORTANCE_ORDER: Record<Fact['importance'], number> = { high: 0, normal: 1, low: 2 };

// 实体名/别名匹配（@ 唤起与提及检测共用）
export function findEntityByName(world: World, query: string): Entity | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  for (const e of world.entities.values()) {
    if (e.name.toLowerCase() === q) return e;
    if (e.aliases?.some((a) => a.toLowerCase() === q)) return e;
  }
  // 包含匹配（@埃德加船长 → 埃德加）
  for (const e of world.entities.values()) {
    if (e.name.toLowerCase().includes(q) || q.includes(e.name.toLowerCase())) return e;
    if (e.aliases?.some((a) => q.includes(a.toLowerCase()) || a.toLowerCase().includes(q))) return e;
  }
  return null;
}

export function buildMemoryContext(args: MemoryArgs): MemoryContext {
  const { world, recentText } = args;
  const mentioned: Entity[] = [];
  const seen = new Set<string>();

  const maybeAdd = (e: Entity | null) => {
    if (e && !seen.has(e.id)) { seen.add(e.id); mentioned.push(e); }
  };

  // ① @ 唤起：强制注入（§11.6）
  if (args.focusQuery) maybeAdd(findEntityByName(world, args.focusQuery));

  // ② 本地提及检测：扫描最近文本，命中 name/别名 自动附加档案（不依赖 AI）
  if (recentText) {
    for (const e of world.entities.values()) {
      if (e.type === 'pc' || e.type === 'world' || e.type === 'plot' || e.type === 'encounter') continue;
      const names = [e.name, ...(e.aliases ?? [])];
      if (names.some((n) => n.length >= 2 && recentText.includes(n))) maybeAdd(e);
    }
  }

  // ③ 活跃线索：plot 实体 status=open
  const openPlots = [...world.entities.values()].filter((e) => e.type === 'plot' && (e.data as Record<string, unknown>).status === 'open');

  // ④ 关联事实：与在场实体关联的优先，importance 降序截断
  const ids = new Set(mentioned.map((e) => e.id));
  const relFacts = world.facts.filter((f) => f.entity_refs.some((r) => ids.has(r)));
  const otherFacts = world.facts.filter((f) => !f.entity_refs.some((r) => ids.has(r)));
  const rank = (f: Fact) => IMPORTANCE_ORDER[f.importance] ?? 9;
  const sorted = [...relFacts, ...otherFacts].sort((a, b) => rank(a) - rank(b) || b.created_at.localeCompare(a.created_at));
  const maxFacts = args.maxFacts ?? 12;

  return {
    summary: args.summary,
    mentioned,
    focus: args.focusQuery ? findEntityByName(world, args.focusQuery) ?? undefined : undefined,
    openPlots,
    facts: sorted.slice(0, maxFacts),
  };
}

// 实体档案渲染（data 摘要：location/state/traits/secrets/relation_hint 等，控制长度）
function renderEntity(e: Entity): string {
  const d = e.data as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of ['traits', 'state', 'secrets', 'relation_hint', 'summary', 'note']) {
    const v = d[k];
    if (typeof v === 'string' && v) parts.push(v);
  }
  const extra = Object.entries(d)
    .filter(([k, v]) => !['location', 'state', 'traits', 'secrets', 'relation_hint', 'summary', 'note', 'source', 'hooks', 'cosmology', 'factions'].includes(k) && typeof v === 'string' && v)
    .map(([k, v]) => `${k}: ${v}`);
  const loc = typeof d.location === 'string' && d.location ? `，位于${d.location}` : '';
  const alive = d.alive === false ? '，已死亡' : '';
  return `${e.name}（${e.type}${e.aliases?.length ? `，别称 ${e.aliases.join('/')}` : ''}${loc}${alive}）：${[...parts, ...extra].join('；')}`;
}

export interface MemoryBlock {
  text: string;
  stats: { summaryChars: number; entityChars: number; plotChars: number; factChars: number };
}

// 注入文本组装：按优先级（摘要 > 实体档案 > 线索 > 事实）截断到预算
export function renderMemoryBlock(ctx: MemoryContext, budget = MEMORY_TOKEN_BUDGET): MemoryBlock {
  const parts: string[] = [];
  let used = 0;
  const stats = { summaryChars: 0, entityChars: 0, plotChars: 0, factChars: 0 };
  const take = (s: string): boolean => {
    const cost = s.length;
    if (used + cost > budget) return false;
    used += cost;
    return true;
  };

  if (ctx.summary && take(`【历史记录】${ctx.summary}`)) {
    parts.push(`[CHRONICLE 历史记录]（上一节冒险的摘要，标注为发生过的事）\n${ctx.summary}`);
    stats.summaryChars = ctx.summary.length;
  }
  const focusTag = ctx.focus ? `（@${ctx.focus.name} 聚焦）` : '';
  const entityText = ctx.mentioned.map((e) => renderEntity(e)).join('\n');
  if (entityText && take(entityText)) {
    parts.push(`在场与提及${focusTag}：\n${entityText}`);
    stats.entityChars = entityText.length;
  }
  const plotText = ctx.openPlots.map((p) => `- ${p.name}（${(p.data as Record<string, unknown>).status === 'open' ? '调查中' : '已了结'}）`).join('\n');
  if (plotText && take(plotText)) {
    parts.push(`活跃线索：\n${plotText}`);
    stats.plotChars = plotText.length;
  }
  const factText = ctx.facts.map((f) => `- [${f.importance}] ${f.fact}`).join('\n');
  if (factText && take(factText)) {
    parts.push(`已知事实：\n${factText}`);
    stats.factChars = factText.length;
  }

  return { text: parts.join('\n\n'), stats };
}

// —— L2 摘要生成（§11.4：session 结束全量重生成；NeverEndingQuest Living Summary 范式）——
const SUMMARY_SYSTEM = `你是跑团记录员。把给定的整段会话压缩成一份"活摘要"，供下一场冒险的主持人使用。要求：
1. 覆盖关键事件（谁做了什么、结果如何），至少包含 3 条最重要的条目
2. 记录人物状态变化（NPC 好感、地点状态、道具易手、SAN/HP 变化）
3. 记录未完结的线索与悬念
4. 不编造会话中不存在的信息
用简洁的中文条目式输出，每条一行，总长不超过 400 字。不要任何开场白。`;

export async function generateSessionSummary(
  provider: Provider,
  messages: StoredMessage[],
  campaignName: string,
): Promise<string> {
  const chatMsgs: ChatMessage[] = [
    { role: 'system', content: SUMMARY_SYSTEM },
    { role: 'user', content: `战役：${campaignName}\n\n会话全文：\n${messages.map((m) => `${m.role === 'user' ? '玩家' : '守密人'}：${m.content}`).join('\n')}` },
  ];
  try {
    const res = await provider.chat(chatMsgs, [], { temperature: 0.4, maxTokens: 600 });
    const text = (res.content ?? '').trim();
    if (text.length >= 10) return text;
    throw new Error('摘要过短');
  } catch (e) {
    // 降级：规则摘要（离线/无 provider 时保证可用）
    console.error('[DiceKeeper] 摘要生成失败，降级规则摘要:', (e as Error).message);
    return fallbackSummary(messages);
  }
}

export function fallbackSummary(messages: StoredMessage[]): string {
  const events = messages.filter((m) => m.role === 'user').slice(-5).map((m) => `玩家：${m.content.slice(0, 60)}`);
  const replies = messages.filter((m) => m.role === 'assistant').slice(-3).map((m) => `守密人：${m.content.slice(0, 80)}`);
  const lines = [...events, ...replies];
  if (lines.length === 0) return '（本节省略）';
  return `[自动摘要] ${lines.join('；')}`;
}

// 提及检测（对外暴露，供 chat 组装 recentText 用）
export function recentTextOf(messages: StoredMessage[], window: number): string {
  return messages.slice(-window).map((m) => m.content).join('\n');
}

// —— L3 兜底事实提取（§3.3/§11.4：每 N 轮异步增量，AI 提取 + 冲突检测）——
// 主通道是 AI 的 remember 工具；这里是兜底通道：引擎定期把近期对话交给模型提取新事实
const EXTRACT_SYSTEM = `你是跑团记录员。从玩家与守密人的近期对话中，提取值得长期记住的新事实（NPC 性格/状态、人物关系、地点变化、关键事件、线索）。
规则：
1. 只提取对话中明确出现的信息，不要推测、不要编造
2. 每个事实一句话，简洁具体（如"埃德加欠码头赌债"）
3. entity_refs 填事实涉及的角色名（NPC/玩家的名字，没有可留空数组）
4. importance: high(关键剧情/秘密)/normal(一般)/low(细节)
5. 只输出 JSON 数组，格式 [{"fact":"...","entity_refs":["..."],"importance":"normal"}]，没有新事实输出 []
不要输出任何 JSON 以外的文字。`;

interface ExtractItem { fact?: unknown; entity_refs?: unknown; importance?: unknown }

// 容错解析：取第一个 [ 到最后一个 ] 的 JSON；失败返回 []
export function parseExtraction(content: string): { fact: string; entity_refs: string[]; importance: 'high' | 'normal' | 'low' }[] {
  const start = content.indexOf('[');
  const end = content.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const arr = JSON.parse(content.slice(start, end + 1)) as ExtractItem[];
    return arr
      .filter((x) => x && typeof x.fact === 'string' && x.fact.trim().length >= 4)
      .map((x) => ({
        fact: (x.fact as string).trim(),
        entity_refs: Array.isArray(x.entity_refs) ? x.entity_refs.filter((r): r is string => typeof r === 'string') : [],
        importance: (x.importance === 'high' || x.importance === 'low' ? x.importance : 'normal'),
      }));
  } catch {
    return [];
  }
}

// 事实冲突检测（与 remember 工具同规则：同实体 high 事实核心字覆盖 ≥50% → 视为改写冲突，保留既有）
export function factConflicts(world: World, fact: string, refs: string[]): string | null {
  const stopSet = new Set('的了在是有和与及或就都而但是也很被把将'.split(''));
  const coreChars = (s: string): string[] => [...new Set([...s])].filter((c) => !stopSet.has(c) && !/[0-9\s]/.test(c));
  const conflict = world.facts.find((f) => {
    if (f.importance !== 'high') return false;
    if (refs.length > 0 && !refs.some((r) => f.entity_refs.includes(r))) return false;
    const core = coreChars(f.fact);
    if (core.length < 4) return false;
    const shared = core.filter((c) => fact.includes(c)).length;
    return shared / core.length >= 0.5;
  });
  return conflict ? conflict.fact : null;
}

// 增量提取：把近期对话交给模型，提取新事实写入 world（去重 + 冲突跳过）
// 返回新增条数；离线/解析失败返回 0（不抛错，调用方 fire-and-forget）
export async function extractFactsIncrementally(
  provider: Provider,
  messages: StoredMessage[],
  world: World,
): Promise<number> {
  const recent = messages.slice(-10);
  if (recent.length < 3) return 0;
  const chatMsgs: ChatMessage[] = [
    { role: 'system', content: EXTRACT_SYSTEM },
    { role: 'user', content: `近期对话：\n${recent.map((m) => `${m.role === 'user' ? '玩家' : m.role === 'assistant' ? '守密人' : '系统'}：${m.content.slice(0, 300)}`).join('\n')}` },
  ];
  const res = await provider.chat(chatMsgs, [], { temperature: 0.3, maxTokens: 800 });
  const items = parseExtraction(res.content ?? '');
  let added = 0;
  const existing = new Set(world.facts.map((f) => f.fact));
  for (const it of items) {
    if (existing.has(it.fact)) continue;
    // 实体名 → id（命中别名也可）
    const refs = it.entity_refs
      .map((n) => findEntityByName(world, n)?.id)
      .filter((x): x is string => !!x);
    if (factConflicts(world, it.fact, refs)) continue; // 与既有 high 事实冲突 → 保留既有
    world.addFact(it.fact, refs, it.importance);
    existing.add(it.fact);
    added++;
  }
  return added;
}
