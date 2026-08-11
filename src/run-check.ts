// run-check.ts — 核心闭环 CLI 冒烟
// 模拟：玩家行动 → 引擎统一掷骰 → DSL 级联判定 → 输出给叙事者的审计 JSON
// 运行：node --experimental-strip-types src/run-check.ts

import { fileURLToPath } from 'node:url';
import { loadRulePack } from './rules.ts';
import { adjudicate } from './adjudicate.ts';

const rulesPath = fileURLToPath(new URL('../rules/coc7e.yaml', import.meta.url));
const pack = loadRulePack(rulesPath);

function round(label: string, opts: Parameters<typeof adjudicate>[0]): void {
  const a = adjudicate(opts);
  console.log(`\n== ${label} ==`);
  console.log(a.detail);
  console.log(JSON.stringify({
    dice: { expression: 'd100', rolls: a.diceRolls, taken: a.takenRoll },
    verdict: { outcome: a.outcome, label: a.label },
    tiers: a.tiers,
    to_narrator: `只可描述：${a.label}。骰面与判定由本地引擎产生，叙事不得改写。`,
  }, null, 2));
}

console.log(`规则包已加载: ${pack.name} v${pack.version}（${pack.character_sheet.skills.length} 项技能）`);

round('普通侦查检定（侦查 60）', { rulePack: pack, skill: '侦查', value: 60, seed: 'smoke-normal' });
round('奖励骰侦查（侦查 60）', { rulePack: pack, skill: '侦查', value: 60, mode: 'reward', seed: 'smoke-reward' });
round('惩罚骰侦查（侦查 60）', { rulePack: pack, skill: '侦查', value: 60, mode: 'penalty', seed: 'smoke-penalty' });

// 固定 rng 演示五档判定全路径
const fixed = (x: number) => () => x;
console.log('\n== 五档判定全路径（固定骰值演示）==');
for (const [r, name] of [[0.1, 'd100=11 → 极限成功'], [0.2, 'd100=21 → 困难成功'], [0.5, 'd100=51 → 普通成功'], [0.8, 'd100=81 → 失败'], [0.96, 'd100=97 → 大失败']] as const) {
  const a = adjudicate({ rulePack: pack, skill: '侦查', value: 60, rng: fixed(r) });
  console.log(`  ${name}: → ${a.label}`);
}
