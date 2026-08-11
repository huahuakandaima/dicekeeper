// sim.ts — NPC 幕后推演（"世界活着"：玩家视野之外的 NPC 移动与状态变化）
// 每 N 轮对话触发一次：把 NPC 名单（含位置/性格/秘密）+ 最近剧情交给守密人，
// 推演每个人"去了哪 / 在做什么 / 状态怎么变" → updateEntity 落库（全量审计 + 可回滚）
// 与「在场对话」联动：location 是相遇/对话限制的依据（太远/已死亡 → 提示无法对话）

import type { Provider, ChatMessage } from './gateway/provider.ts';
import type { World, Entity } from './world.ts';
import type { StoredMessage } from './campaign.ts';

export interface NpcAction {
  name: string;
  location?: string; // 新地点（'原地' 或省略 = 不动）
  state?: string;    // 最近动向/状态变化（一句话）
}

const SIM_SYSTEM = `你是跑团世界的模拟引擎。根据世界状态与最近剧情，推演 NPC 们在玩家视野之外做了什么（幕后发展）。
规则：
1. 每个 NPC 输出一条行动：去了哪里 / 在做什么 / 状态变化（情绪、怀疑、伤势、行踪等）
2. 行动要符合 NPC 的性格与动机（参考 traits / secrets / relation_hint），并与剧情进展呼应
3. 只输出 JSON 数组，格式：[{"name":"NPC名","location":"新地点（没移动就写原地）","state":"正在做什么/状态变化，一句话"}]
4. 不要推进主线结局、不要杀死 NPC、不要替玩家做决定；没特别行动就输出 []
不要输出 JSON 以外的任何文字。`;

// 容错解析 AI 输出（取第一个 [ 到最后一个 ]）
export function parseNpcActions(content: string): NpcAction[] {
  const start = content.indexOf('[');
  const end = content.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const arr = JSON.parse(content.slice(start, end + 1)) as { name?: unknown; location?: unknown; state?: unknown }[];
    return arr
      .filter((x) => x && typeof x.name === 'string' && x.name.trim())
      .map((x) => ({
        name: (x.name as string).trim(),
        location: typeof x.location === 'string' && x.location.trim() ? x.location.trim() : undefined,
        state: typeof x.state === 'string' && x.state.trim() ? x.state.trim() : undefined,
      }));
  } catch {
    return [];
  }
}

// 玩家可引用的 NPC（@ 候选）：见过（met:true，剧本介绍或已相遇/被提及）且未死亡
// 初始种子 NPC 不带 met → 开场 @ 为空；玩家提到/遇见谁，谁才进入 @ 列表（引擎提及检测自动相识）
export function metNpcs(world: World): Entity[] {
  return [...world.entities.values()].filter((e) => {
    if (e.type !== 'npc') return false;
    const d = e.data as Record<string, unknown>;
    if (d.alive === false) return false; // 死亡 NPC 碰不到
    return d.met === true;
  });
}

// 推演一次：更新 NPC 的 location/state（走 updateEntity，审计 + 回滚）。返回更新的实体数。
export async function simulateNpcActions(
  provider: Provider,
  world: World,
  messages: StoredMessage[],
  campaignName: string,
  maxNpcs = 8,
): Promise<number> {
  const npcs = [...world.entities.values()].filter((e) => e.type === 'npc').slice(0, maxNpcs);
  if (npcs.length === 0) return 0;
  const roster = npcs.map((e) => {
    const d = e.data as Record<string, unknown>;
    return `- ${e.name}（现处：${d.location ?? '未知'}；性格：${String(d.traits ?? '').slice(0, 40)}；秘密：${String(d.secrets ?? '').slice(0, 30)}）`;
  }).join('\n');
  const recent = messages.slice(-6)
    .map((m) => `${m.role === 'user' ? '玩家' : m.role === 'assistant' ? '守密人' : '系统'}：${m.content.slice(0, 150)}`)
    .join('\n');
  const chatMsgs: ChatMessage[] = [
    { role: 'system', content: SIM_SYSTEM },
    { role: 'user', content: `战役：${campaignName}\n\nNPC 名单：\n${roster}\n\n最近剧情：\n${recent}` },
  ];
  const res = await provider.chat(chatMsgs, [], { temperature: 0.6, maxTokens: 1000 });
  const actions = parseNpcActions(res.content ?? '');
  let updated = 0;
  for (const a of actions) {
    const e = [...world.entities.values()].find((x) => x.type === 'npc' && (x.name === a.name || x.aliases?.includes(a.name)));
    if (!e) continue;
    const delta: Record<string, unknown> = {};
    if (a.location && a.location !== '原地') delta.location = a.location;
    if (a.state) delta.state = a.state;
    if (Object.keys(delta).length > 0) {
      world.updateEntity(e.id, delta);
      updated++;
    }
  }
  return updated;
}
