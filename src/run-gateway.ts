// run-gateway.ts — AI 网关完整对话冒烟（MockProvider 模拟守密人）
// 展示：玩家行动 → AI 请求本地检定 → 结果回填 → 叙事输出 → 防伪校验 → 审计落档
// 运行：node --experimental-strip-types src/run-gateway.ts

import { fileURLToPath } from 'node:url';
import { loadRulePack } from './rules.ts';
import { generateCharacter } from './chargen.ts';
import { World } from './world.ts';
import { MockProvider, type ChatMessage } from './gateway/provider.ts';
import { runChat } from './gateway/chat.ts';
import { buildSystemPrompt } from './gateway/prompt.ts';
import type { ToolContext } from './gateway/tools.ts';

const pack = loadRulePack(fileURLToPath(new URL('../rules/coc7e.yaml', import.meta.url)));
const character = generateCharacter(pack, { seed: 'gateway-smoke', name: '阿比盖尔·布莱克' });
const world = new World();
world.addEntity('npc', '埃德加', { 职业: '老船长', 性格: '倔强、欠赌债', 秘密: '30 年前见过海怪' }, ['老船长', '渔夫']);
world.addEntity('location', '雾港酒馆', { 气氛: '烟味与海盐味混杂', 常客: ['埃德加'] });
world.addFact('埃德加最近在码头鬼鬼祟祟', ['埃德加'], 'normal');

const toolCtx: ToolContext = { pack, character, world, seed: 'gateway-smoke' };

// 模拟守密人：先本地检定，再基于真实骰值写叙事 + 更新世界
const provider = new MockProvider('mock-keeper', [
  (msgs: ChatMessage[]) => ({
    content: null,
    toolCalls: [{ id: 'c1', name: 'make_check', arguments: JSON.stringify({ skill: '侦查', reason: '雾中辨认人影' }) }],
    model: 'mock-keeper',
  }),
  (msgs: ChatMessage[]) => {
    const toolMsg = msgs[msgs.length - 1] as { content: string };
    const r = JSON.parse(toolMsg.content) as { dice: string; taken: number; verdict: string };
    return {
      content: JSON.stringify({
        narrative: `你眯起眼，海雾里那道身影摇摇晃晃。骰子滚出 ${r.taken}，${r.verdict}——你看清了：是老船长埃德加，正把什么沉甸甸的东西往码头边的桶里塞。`,
        dice_results: [r.dice],
        prompt_player: '1) 上前打招呼  2) 悄悄绕到桶边  3) 按兵不动',
      }),
      model: 'mock-keeper',
    };
  },
]);

const out = await runChat('我眯起眼，想看清雾中的人影是谁。', [], {
  provider,
  toolCtx,
  systemPrompt: buildSystemPrompt({ pack, character, world }),
});

console.log('── 守密人回复 ──');
console.log(out.narrative);
console.log(`\n追问: ${out.promptPlayer}`);
console.log(`\n工具轮数: ${out.toolRounds} | 模型: ${out.model}`);
console.log(`防伪校验: ${out.issues.length === 0 ? '通过 ✓' : JSON.stringify(out.issues)}`);
console.log('\n── 本地审计 ──');
console.log(`掷骰记录: ${world.diceLog.length} 条`);
for (const d of world.diceLog) console.log(`  [${d.id}] ${d.expression} = ${d.rolls.join(',')} (${d.reason}) by ${d.requested_by}`);
console.log(`世界变更: ${world.changes.length} 条`);
console.log(`记忆事实: ${world.facts.length} 条`);
