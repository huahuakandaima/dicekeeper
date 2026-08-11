// gateway/prompt.ts — system prompt 组装（四段式：人格 + 规则约束 + 世界记忆 + 行为红线）
// v1 简化记忆注入：角色卡 + 在场实体 + 高重要度事实（完整三层记忆 Phase 2）

import type { RulePack } from '../rules.ts';
import type { Character } from '../chargen.ts';
import type { World, Entity } from '../world.ts';
import { renderLoreBlock, type LoreHit } from '../lore.ts';
import type { MemoryBlock } from '../memory.ts';

export interface PromptContext {
  pack: RulePack;
  character?: Character;
  world: World;
  persona?: string;   // 人格包 v1：纯文本段落
  presentEntities?: Entity[];
  maxFacts?: number;
  loreHits?: LoreHit[]; // 世界书命中条目（P2：关键词触发注入）
  memory?: MemoryBlock; // L2/L3 记忆注入（P1：提及实体档案/活跃线索/关联事实/CHRONICLE 摘要）
  tension?: string;    // 张力仪表注入段（§11.7 戏剧引擎，本地计算的数值 + 行为红线）
}

export function buildSystemPrompt(ctx: PromptContext): string {
  const { pack, character, world } = ctx;
  const persona = ctx.persona ?? '你是克苏鲁跑团的守密人（KP），冷静、克制、营造氛围。用中文叙事，描写注重感官细节，让玩家做选择，不要替玩家做决定。';

  // ② 规则约束（截断到预算内，v1 直接全量规则文本）
  const rules = (pack.rules_reference ?? '').slice(0, 1500);

  // ③ 世界记忆（提供 memory 块时以记忆管理层组装为准，旧简化段跳过避免重复）
  const charBlock = character
    ? `角色卡：${character.name}（${character.occupation}，${character.age}岁）
  属性：${Object.entries(character.attributes).map(([k, v]) => `${k} ${v}`).join(' / ')}
  衍生：HP ${character.derived.HP} / MP ${character.derived.MP} / SAN ${character.derived.SAN} / 幸运 ${character.derived.幸运}
  技能：${Object.entries(character.skills).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k} ${v}`).join(' / ')}`
    : '';
  const presentBlock = !ctx.memory && (ctx.presentEntities ?? []).length > 0
    ? `在场：${ctx.presentEntities!.map((e) => `${e.name}（${e.type}）`).join('、')}`
    : '';
  const facts = world.getFacts(undefined, undefined).slice(-(ctx.maxFacts ?? 8));
  const factsBlock = !ctx.memory && facts.length > 0
    ? `已知事实：\n${facts.map((f) => `- ${f.fact}`).join('\n')}`
    : '';
  // ③.5 世界书注入（剧本包 lore_entries 命中条目，按激活档位标记）
  const loreBlock = ctx.loreHits ? renderLoreBlock(ctx.loreHits) : '';
  // ③.6 记忆注入（L2 CHRONICLE 摘要 + L3 提及实体/活跃线索/关联事实，预算内）
  const memoryBlock = ctx.memory?.text ?? '';
  // ③.7 NPC 位置一览（在场对话联动：AI 判断"谁在哪、能否对话"的依据）
  const npcRoster = [...world.entities.values()]
    .filter((e) => e.type === 'npc')
    .slice(0, 12)
    .map((e) => {
      const d = e.data as Record<string, unknown>;
      return `${e.name}（${d.location ?? '位置未知'}${d.alive === false ? '，已死亡' : ''}）`;
    })
    .join('，');

  // ④ 行为红线（判定本地化的边界声明）
  const chronicleNote = ctx.memory?.text.includes('[CHRONICLE')
    ? '\n- 本节是新的冒险：开场叙事应自然带出上一节的悬念/事件（让玩家感到世界连续），但不要生硬复述摘要内容。'
    : '';
  const redLines = `【行为红线】
- 所有随机结果必须通过 roll_dice / make_check 获取，禁止自行编造任何数字（骰面、判定结论都由本地引擎产生）。
- 叙事中不得声称审计之外的骰值；检定结论以 make_check 返回的 verdict 为准，叙事只能描述其结果。
- 不确定的世界细节必须先 query_world，禁止脑补不存在的实体。
- 与玩家对话/回应玩家搭话的，必须是实体名册中已存在登记的 NPC（见【NPC 位置】与实体资料）；禁止凭空创造新人物来承接对话。玩家用称呼（如"船长""警长""老板娘"）指代某人时，先按 NPC 的别名表匹配——"船长"对应老船长埃德加，"警长"对应霍勒斯·温特等；若称呼对不上任何已知 NPC，让现场最合适的已存在人物回应或纠正（如"你找船长？他在角落那桌"），仍不得创造新角色。
- 必须引入新 NPC 时（玩家主动寻找新人物），先 update_entity 落库建档再让其登场；未经落库的人物不得开口说话。
- 已经建立对话/在场的 NPC 保持身份连续：后续回复继续由同一人物承接，不得无理由换人顶替；玩家未点单时，桌上饮品等环境细节沿用前文设定，不得擅自更改。
- 世界状态变更必须通过 update_entity / remember 声明，禁止只写进叙事不落库。
- 玩家只能与在场或当面的人物直接对话：提到不在场的人物时，用"玩家动身去找"的叙事过渡（如"你穿过雾气走进酒馆"）；距离太远、人物已死亡（alive=false）或绝对无法接触时，明确提示无法对话并交代原因，不得强行安排对话。
- 当玩家与某个 NPC 相遇/对话/目击/被介绍时，用 update_entity 把该实体标记 met: true（此后玩家可在 @ 中引用他/她）。
- 玩家移动/进入新地点时，用 update_entity 更新玩家实体（type=pc）的 location 字段（与 NPC 位置的在场判断一致）。${chronicleNote}`;

  return [
    persona,
    `【规则】${pack.name} v${pack.version}（${pack.dice_schema}）`,
    rules,
    npcRoster ? `【NPC 位置】${npcRoster}` : '',
    charBlock,
    presentBlock,
    loreBlock,
    memoryBlock,
    factsBlock,
    ctx.tension ?? '',
    redLines,
    '【输出格式】最终回复必须输出 JSON：{"narrative": "叙事文本", "dice_results": ["掷骰记录id"], "prompt_player": "对玩家的追问或选项"}。',
  ].filter(Boolean).join('\n\n');
}

// 组装工具调用后的回填消息（tool result → assistant 的 tool 消息）
export function buildToolMessages(calls: { id: string; name: string; arguments: string }[], results: string[]): unknown[] {
  return calls.map((c, i) => ({ role: 'tool', tool_call_id: c.id, content: results[i] }));
}
