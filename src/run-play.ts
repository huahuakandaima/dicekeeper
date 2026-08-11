// run-play.ts — 完整团闭环冒烟：建团→车卡→世界→多轮对话→持久化→恢复
// 运行：node --experimental-strip-types src/run-play.ts

import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { loadRulePack } from './rules.ts';
import { generateCharacter } from './chargen.ts';
import { World } from './world.ts';
import { CampaignStore, toChatMessages } from './campaign.ts';
import { MockProvider, type ChatMessage } from './gateway/provider.ts';
import { runChat } from './gateway/chat.ts';
import { buildSystemPrompt } from './gateway/prompt.ts';
import type { ToolContext } from './gateway/tools.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const pack = loadRulePack(join(HERE, '..', 'rules', 'coc7e.yaml'));
const DB_PATH = join(HERE, '..', 'data', 'dicekeeper.db');
const store = new CampaignStore(DB_PATH);

// 建团（幂等：同一名字覆盖演示——实际产品用 id）
const char = generateCharacter(pack, { seed: 'play-char', name: '阿比盖尔·布莱克' });
const campaign = store.createCampaign({ name: '旧港疑云（冒烟）', rulePackId: 'coc7e', characters: [char] });

// 世界初始化：剧本包种子（v1 手写，Phase 3 由剧本包注入）
const world = new World();
world.addEntity('npc', '埃德加', { 职业: '老船长', 性格: '倔强、欠赌债', 秘密: '30 年前见过海怪' }, ['老船长', '渔夫']);
world.addEntity('location', '雾港酒馆', { 气氛: '烟味与海盐味', 常客: ['埃德加'] });
world.saveToDb(store.db, campaign.id);

const session = store.startSession(campaign.id);
console.log(`建团: ${campaign.name}（${campaign.id}）| 会话: ${session.id}`);
console.log(`角色: ${char.name}（${char.occupation}）侦查=${char.skills['侦查']}\n`);

// 模拟守密人对话引擎（两轮：检定 + 叙事/世界更新）
function makeKeeper(seed: string) {
  return new MockProvider('mock-keeper', [
    (msgs: ChatMessage[]) => {
      const last = msgs[msgs.length - 1] as { content: string };
      const skill = last.content.includes('雾气') ? '侦查' : '聆听';
      return {
        content: null,
        toolCalls: [{ id: 'c1', name: 'make_check', arguments: JSON.stringify({ skill, reason: `响应: ${last.content.slice(0, 20)}` }) }],
        model: 'mock-keeper',
      };
    },
    (msgs: ChatMessage[]) => {
      const tool = msgs[msgs.length - 1] as { content: string };
      const r = JSON.parse(tool.content) as { dice: string; taken: number; verdict: string };
      return {
        content: JSON.stringify({
          narrative: `骰子滚出 ${r.taken}，${r.verdict}。海雾在你眼前缓缓分开。`,
          dice_results: [r.dice],
          prompt_player: '1) 走进酒馆 2) 去码头看看 3) 站在原地',
        }),
        model: 'mock-keeper',
      };
    },
  ]);
}

async function playRound(action: string, seed: string): Promise<void> {
  const history = toChatMessages(store.getMessages(campaign.id, session.id));
  const world = World.loadFromDb(store.db, campaign.id);
  const toolCtx: ToolContext = { pack, character: char, world, seed };
  const provider = makeKeeper(seed);
  const out = await runChat(action, history, {
    provider,
    toolCtx,
    systemPrompt: buildSystemPrompt({ pack, character: char, world }),
  });
  // 落库：用户行动 + AI 叙事（含骰子引用） + 世界变更
  store.appendMessage(campaign.id, session.id, { role: 'user', content: action });
  store.appendMessage(campaign.id, session.id, { role: 'assistant', content: out.narrative, diceResults: out.diceResults });
  world.saveToDb(store.db, campaign.id);
  console.log(`玩家: ${action}`);
  console.log(`守密人: ${out.narrative}`);
  console.log(`  追问: ${out.promptPlayer} | 校验: ${out.issues.length === 0 ? '通过' : out.issues.map((i) => i.message).join('; ')}\n`);
}

await playRound('我推开雾港酒馆的门，看到埃德加坐在角落。', 'play-1');
await playRound('我走过去，假装不经意地问起码头最近的事。', 'play-2');

// 持久化恢复验证（新连接打开同一 db 文件）
store.endSession(campaign.id, session.id, '两轮对话：埃德加现身，调查开始');
const store2 = new CampaignStore(DB_PATH);
const restored = store2.loadCampaign(campaign.id);
const restoredSession = store2.loadSession(campaign.id, session.id);
const worldRestored = World.loadFromDb(store2.db, campaign.id);
console.log('── 持久化恢复 ──');
console.log(`战役: ${restored.name} | 角色: ${restored.characters[0].name}`);
console.log(`消息 ${restoredSession.messages.length} 条 | 实体 ${worldRestored.entities.size} 个 | 掷骰审计 ${worldRestored.diceLog.length} 条 | 会话摘要: ${restoredSession.session.summary}`);
