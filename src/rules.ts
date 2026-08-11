// rules.ts — 规则包加载与校验（mini YAML 解析器 + schema 校验）
// YAML 支持子集：缩进 map / list / inline 数组与对象 / 标量(数字/布尔/字符串) / 行首 # 注释
// 不支持（schema 会避开）：锚点、多行字符串、复杂 flow 结构

import { readFileSync } from 'node:fs';
import { evaluate } from './dsl.ts';

export class RulePackError extends Error {}

export interface RulePack {
  id: string;
  name: string;
  version: string;
  dice_schema: string;
  character_sheet: {
    attributes: string[];
    derived: string[];
    // action：技能按钮类型（2026-08-11 用户需求"不同规则包编辑时配置按钮"）——
    // check=检定（默认，d100 对比技能值）/ narrative=叙事行动（不掷骰，AI 叙事推进）/ none=不显示按钮
    skills: { name: string; base: number; category: string; action?: 'check' | 'narrative' | 'none' }[];
  };
  check_rules: Record<string, string>; // extreme/hard/normal/crit_fail 等，DSL 表达式
  // GM/主持人的规则包称谓（"守密人"是 CoC 的；D&D 用"地下城主/DM"等）——UI 与默认人格按此显示，缺省"主持人"
  gm_title?: string;
  modifiers?: { name: string; condition?: string }[];
  chargen?: {
    attribute_methods?: { name: string; formula: string; fields: string[] }[];
    age_adjustments?: { min: number; max: number; note: string }[];
    derived_formulas?: Record<string, string>;
    occupations?: { name: string; skills: string[]; points: string }[];
  };
  tables?: Record<string, unknown[]>;
  rules_reference?: string;
}

// GM/主持人称谓：规则包 gm_title 决定，缺省"主持人"（"守密人"是 CoC 的叫法，需规则包显式声明）
export function gmTitleOf(rp: { gm_title?: string }): string {
  return rp.gm_title?.trim() || '主持人';
}

// —— mini YAML ——
export function parseYaml(src: string): unknown {
  const lines = src.split(/\r?\n/).map((l, i) => ({ raw: l, n: i + 1 }));
  let idx = 0;

  function indentOf(line: string): number {
    const m = /^ */.exec(line)!;
    if (/^\t/.test(line)) throw new RulePackError(`第 ${line} 行禁止使用 tab 缩进`);
    return m[0].length;
  }

  function parseBlock(minIndent: number): unknown {
    const out: Record<string, unknown> = {};
    while (idx < lines.length) {
      const { raw, n } = lines[idx];
      if (raw.trim() === '' || raw.trim().startsWith('#')) { idx++; continue; }
      const ind = indentOf(raw);
      if (ind < minIndent) break;
      if (ind > minIndent) throw new RulePackError(`第 ${n} 行缩进异常（期望 ${minIndent}）`);
      const content = raw.trim();
      if (content.startsWith('- ')) throw new RulePackError(`第 ${n} 行：list 不能出现在 map 位置`);
      const sep = content.indexOf(':');
      if (sep <= 0) throw new RulePackError(`第 ${n} 行：期望 "key: value"`);
      const key = content.slice(0, sep).trim();
      let rest = content.slice(sep + 1).trim();
      // 去掉行内注释（仅当 # 前有空格且不在引号内）
      rest = stripComment(rest);
      idx++;
      if (rest === '|' || rest === '>') {
        // 块标量：收集后续缩进行（| 保留换行，> 折叠为单行）
        const blockLines: string[] = [];
        while (idx < lines.length) {
          const { raw } = lines[idx];
          if (raw.trim() === '' || raw.trim().startsWith('#')) { idx++; continue; }
          const ind = indentOf(raw);
          if (ind <= minIndent) break;
          blockLines.push(raw.slice(ind));
          idx++;
        }
        out[key] = rest === '|' ? blockLines.join('\n') : blockLines.join(' ');
      } else if (rest === '') {
        // 嵌套块：可能是 map 或 list
        const next = lines[idx];
        if (next && next.raw.trim().startsWith('- ') && indentOf(next.raw) > ind) {
          out[key] = parseList(ind);
        } else {
          out[key] = parseBlock(ind + 2);
        }
      } else {
        out[key] = parseInline(rest);
      }
    }
    return out;
  }

  function parseList(minIndent: number): unknown[] {
    const arr: unknown[] = [];
    while (idx < lines.length) {
      const { raw, n } = lines[idx];
      if (raw.trim() === '' || raw.trim().startsWith('#')) { idx++; continue; }
      const ind = indentOf(raw);
      if (ind < minIndent) break;
      if (!raw.trim().startsWith('-')) {
        if (ind === minIndent) break;
        throw new RulePackError(`第 ${n} 行：list 项必须 "- " 开头`);
      }
      let item = raw.trim().slice(1).trim();
      item = stripComment(item);
      idx++;
      if (item === '') {
        const next = lines[idx];
        if (next && indentOf(next.raw) > ind && !next.raw.trim().startsWith('- ')) {
          arr.push(parseBlock(ind + 2));
        } else if (next && indentOf(next.raw) > ind && next.raw.trim().startsWith('- ')) {
          arr.push(parseList(ind + 2));
        } else {
          arr.push(null);
        }
      } else {
        // list 项为展开的 map（"- key: value" + 缩进更深的子行）：
        // 回退到 item 行并提升缩进，交给 parseBlock 统一解析（含块标量/嵌套 list）
        const m = /^([^:]+):/.exec(item);
        if (m && !item.startsWith('[') && !item.startsWith('{')) {
          idx--;
          lines[idx] = { raw: ' '.repeat(ind + 2) + item, n };
          arr.push(parseBlock(ind + 2));
        } else {
          arr.push(parseInline(item));
        }
      }
    }
    return arr;
  }

  // 去掉行内注释：只处理 # 前面是空白的情况（引号内的 # 不动）
  function stripComment(s: string): string {
    let inQuote: string | null = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inQuote) { if (c === inQuote) inQuote = null; continue; }
      if (c === '"' || c === "'") { inQuote = c; continue; }
      if (c === '#' && (i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t')) return s.slice(0, i).trimEnd();
    }
    return s;
  }

  function parseInline(s: string): unknown {
    if (s === '') return '';
    if (s.startsWith('[') && s.endsWith(']')) {
      const inner = s.slice(1, -1).trim();
      if (inner === '') return [];
      return inner.split(',').map((x) => parseInline(x.trim()));
    }
    if (s.startsWith('{') && s.endsWith('}')) {
      const inner = s.slice(1, -1).trim();
      const obj: Record<string, unknown> = {};
      if (inner !== '') {
        for (const part of splitTopLevel(inner, ',')) {
          const m = /^([^:]+):\s*(.*)$/.exec(part.trim());
          if (!m) throw new RulePackError(`无法解析的 inline 对象: ${part}`);
          obj[m[1].trim()] = parseInline(m[2].trim());
        }
      }
      return obj;
    }
    return parseScalar(s);
  }

  function splitTopLevel(s: string, sep: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let cur = '';
    for (const c of s) {
      if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') depth--;
      if (c === sep && depth === 0) { parts.push(cur); cur = ''; }
      else cur += c;
    }
    parts.push(cur);
    return parts;
  }

  function parseScalar(s: string): unknown {
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null' || s === '~') return null;
    if (/^-?\d+$/.test(s)) return parseInt(s, 10);
    if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1);
    }
    return s;
  }

  const root = parseBlock(0);
  if (idx < lines.length) throw new RulePackError(`第 ${lines[idx].n} 行：无法解析的内容`);
  return root;
}

// —— 加载与校验 ——
export function loadRulePack(filePath: string): RulePack {
  const text = readFileSync(filePath, 'utf-8');
  const raw = parseYaml(text) as Record<string, unknown>;
  return validateRulePack(raw);
}

export function validateRulePack(raw: Record<string, unknown>): RulePack {
  const err = (msg: string) => { throw new RulePackError(msg); };
  if (!raw.id || typeof raw.id !== 'string') err('规则包缺少 id');
  if (!raw.name || typeof raw.name !== 'string') err('规则包缺少 name');
  if (raw.version === undefined || raw.version === null) err('规则包缺少 version');
  // 宽容：version 写 1.0 或 "1.0" 均可，统一为字符串
  if (!raw.dice_schema || typeof raw.dice_schema !== 'string') err('规则包缺少 dice_schema');
  const cs = raw.character_sheet as Record<string, unknown> | undefined;
  if (!cs || typeof cs !== 'object') err('规则包缺少 character_sheet');
  if (!Array.isArray(cs.attributes) || (cs.attributes as unknown[]).length === 0) err('character_sheet.attributes 必须是非空数组');
  // gm_title（主持人称谓）可选，但必须是字符串
  if (raw.gm_title !== undefined && (typeof raw.gm_title !== 'string' || !raw.gm_title.trim())) err('gm_title 必须是字符串');
  // 技能按钮类型校验（action：check/narrative/none，缺省 check）
  if (Array.isArray(cs.skills)) {
    for (const s of cs.skills as Record<string, unknown>[]) {
      if (s.action !== undefined && !['check', 'narrative', 'none'].includes(String(s.action))) {
        err(`技能 ${String(s.name ?? '?')} 的 action 非法: "${String(s.action)}"（须为 check/narrative/none）`);
      }
    }
  }
  const cr = raw.check_rules as Record<string, unknown> | undefined;
  if (!cr || typeof cr !== 'object') err('规则包缺少 check_rules');
  // 校验 check_rules 表达式可被 DSL 解析（试 parse，不执行——字段引用留到运行时）
  for (const [name, expr] of Object.entries(cr)) {
    if (typeof expr !== 'string') err(`check_rules.${name} 必须是字符串`);
    try {
      evaluate(expr, { fields: {}, rng: () => 0.5 });
    } catch (e) {
      if (/未知字段/.test((e as Error).message)) continue; // 字段引用运行时才知
      err(`check_rules.${name} 表达式非法: ${(e as Error).message}`);
    }
  }
  return raw as unknown as RulePack;
}
