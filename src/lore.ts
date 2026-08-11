// lore.ts — 世界书命中检测（方案 §3.5，抄 SillyTavern Lorebook 激活策略）
// 蓝灯（blue，常驻）：永远注入；绿灯（green，近期）：关键词出现在最近 N 条消息时注入；
// 黄灯（yellow，历史）：关键词出现在整场历史时注入（罕见但重要的事件）
// 命中条目按 priority 降序，token 预算内截断

import type { StoredLoreEntry } from './campaign.ts';

export interface LoreContext {
  recentText: string;  // 最近 N 条消息拼接（近期窗口）
  allText: string;     // 整场历史拼接（含 recentText）
  budget?: number;     // token 预算（中文近似 1 字 ≈ 1 token）
}

export interface LoreHit {
  entry: StoredLoreEntry;
  activatedBy: 'blue' | 'green' | 'yellow';
}

// 命中检测：返回按优先级排序、预算内截断的条目（含激活档位）
export function matchLore(entries: StoredLoreEntry[], ctx: LoreContext): LoreHit[] {
  const budget = ctx.budget ?? 3000;
  const hits: LoreHit[] = [];

  for (const e of entries) {
    const terms = e.keyTerms.filter((t) => t.trim() !== '');
    if (e.activation === 'blue') {
      hits.push({ entry: e, activatedBy: 'blue' });
    } else if (terms.length > 0) {
      const hitRecent = terms.some((t) => ctx.recentText.includes(t));
      if (e.activation === 'green' && hitRecent) {
        hits.push({ entry: e, activatedBy: 'green' });
      } else if (e.activation === 'yellow' && !hitRecent && terms.some((t) => ctx.allText.includes(t))) {
        hits.push({ entry: e, activatedBy: 'yellow' });
      }
    }
  }

  // priority 降序（同档按 id 稳定排序，保证确定性）
  hits.sort((a, b) => b.entry.priority - a.entry.priority || a.entry.id.localeCompare(b.entry.id));

  // token 预算截断：蓝灯常驻优先保住，超预算时按序截断
  let used = 0;
  const out: LoreHit[] = [];
  for (const h of hits) {
    const cost = h.entry.content.length + 4; // 4 = 条目头开销近似
    if (used + cost > budget) continue;
    used += cost;
    out.push(h);
  }
  return out;
}

// 注入文本组装（供 prompt 使用）
export function renderLoreBlock(hits: LoreHit[]): string {
  if (hits.length === 0) return '';
  const lines = hits.map((h) => {
    const tag = h.activatedBy === 'blue' ? '常驻' : h.activatedBy === 'green' ? '近期' : '历史';
    return `【世界书·${tag}】${h.entry.content}`;
  });
  return `世界档案：\n${lines.join('\n')}`;
}
