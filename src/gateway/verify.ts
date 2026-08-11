// gateway/verify.ts — 防伪校验（§11.2 判定本地化的执行层）
// ① dice_results 引用的 roll_id 必须真实存在（AI 不能引用不存在的掷骰）
// ② 叙事层轻检测：拦截"掷骰语义动词 + 数字"组合——数字必须与审计记录匹配

import type { World } from '../world.ts';

export interface VerifyIssue {
  kind: 'bad_roll_ref' | 'narrative_fabricated_dice' | 'narrative_mismatch';
  message: string;
}

// 掷骰语义动词（中文 + 英文混合，跑团语境）
const DICE_VERB_RE = /(?:掷出|骰出|投出|滚出|roll(?:出|了)?|rolled)\s*[:：]?\s*(\d{1,3})/gi;

export function verifyDiceRefs(diceResults: string[], world: World): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  for (const id of diceResults ?? []) {
    const found = world.diceLog.some((d) => d.id === id);
    if (!found) issues.push({ kind: 'bad_roll_ref', message: `引用了不存在的掷骰记录 ${id}` });
  }
  return issues;
}

// 叙事轻检测：允许普通数字（三匹马/五分钟），只拦"掷骰语义+数字"且该数字不在审计中
export function verifyNarrative(text: string, world: World): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  for (const m of text.matchAll(DICE_VERB_RE)) {
    const n = parseInt(m[1], 10);
    const known = world.diceLog.some((d) => d.result === n);
    if (!known) {
      issues.push({
        kind: 'narrative_fabricated_dice',
        message: `叙事声称掷出 ${n}，但审计中无此结果（骰面由本地引擎产生）`,
      });
    }
  }
  return issues;
}

// 完整校验：结构化引用 + 叙事文本
export function verifyOutput(narrative: string, diceResults: string[] | undefined, world: World): VerifyIssue[] {
  return [
    ...verifyDiceRefs(diceResults ?? [], world),
    ...verifyNarrative(narrative ?? '', world),
  ];
}
