// run-chargen.ts — 随机车卡 CLI 冒烟
// 运行：node --experimental-strip-types src/run-chargen.ts

import { fileURLToPath } from 'node:url';
import { loadRulePack } from './rules.ts';
import { generateCharacter, characterFields } from './chargen.ts';

const pack = loadRulePack(fileURLToPath(new URL('../rules/coc7e.yaml', import.meta.url)));

console.log(`随机车卡演示（${pack.name} v${pack.version}）\n`);
for (const seed of ['smoke-a', 'smoke-b']) {
  const c = generateCharacter(pack, { seed });
  console.log(`── ${c.name}（${c.occupation}，${c.age} 岁）──`);
  const attrs = Object.entries(c.attributes).map(([k, v]) => `${k}${String(v).padStart(3)}`).join('  ');
  console.log(`属性: ${attrs}`);
  console.log(`衍生: HP=${c.derived.HP} MP=${c.derived.MP} SAN=${c.derived.SAN} 幸运=${c.derived.幸运} DB=${c.derived.DB} Build=${c.derived.Build} MOV=${c.derived.MOV}`);
  const topSkills = Object.entries(c.skills).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([k, v]) => `${k}${v}`).join('  ');
  console.log(`技能TOP6: ${topSkills}`);
  console.log();
}

// 车卡 → 检定闭环：用刚生成的角色做一次侦查检定
const c = generateCharacter(pack, { seed: 'smoke-check' });
const fields = characterFields(c);
const spot = c.skills['侦查'];
console.log(`闭环演示：${c.name} 侦查=${spot}，投一个侦查检定…`);
import { adjudicate } from './adjudicate.ts';
const a = adjudicate({ rulePack: pack, skill: '侦查', value: spot, seed: 'smoke-check-roll', extraFields: fields });
console.log(`  ${a.detail}`);
