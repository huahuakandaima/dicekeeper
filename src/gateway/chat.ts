// gateway/chat.ts — 会话循环（tool loop + 结构化输出解析 + 防伪校验）
// 流程：玩家行动 → 组装 messages → LLM(可调工具) → 本地执行工具 → 回填 → 循环
// → 无工具调用 → 解析 JSON 输出 → 校验（dice id + 叙事轻检测）→ 返回

import type { Provider, ChatMessage, ToolCall } from './provider.ts';
import { TOOL_SCHEMAS, executeTool, type ToolContext, ToolError } from './tools.ts';
import { verifyOutput, type VerifyIssue } from './verify.ts';
import type { World } from '../world.ts';

export interface ChatOutput {
  narrative: string;
  diceResults: string[];
  promptPlayer: string | null;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  toolRounds: number;
  issues: VerifyIssue[];
}

export interface ChatSessionOptions {
  provider: Provider;
  toolCtx: ToolContext;
  systemPrompt: string;
  maxToolRounds?: number;
  temperature?: number;
  onDelta?: (text: string) => void; // 流式叙事回调（逐段推送，UI 逐字渲染）
}

export class ChatError extends Error {}

interface ParsedOutput {
  narrative: string;
  dice_results?: string[];
  prompt_player?: string;
}

const MAX_TOOL_ROUNDS_DEFAULT = 6;

export async function runChat(playerAction: string, history: ChatMessage[], opts: ChatSessionOptions): Promise<ChatOutput> {
  const { provider, toolCtx } = opts;
  const maxRounds = opts.maxToolRounds ?? MAX_TOOL_ROUNDS_DEFAULT;
  const messages: ChatMessage[] = [
    { role: 'system', content: opts.systemPrompt },
    ...history,
    { role: 'user', content: playerAction },
  ];

  let toolRounds = 0;
  let model = '';
  let usage: ChatOutput['usage'];

  for (;;) {
    const temp = opts.temperature ?? 0.9;
    // 流式优先（provider 实现 streamChat 时），否则回退一次性 chat
    const res = opts.onDelta && provider.streamChat
      ? await provider.streamChat(messages, TOOL_SCHEMAS, { temperature: temp }, (t) => opts.onDelta!(t))
      : await provider.chat(messages, TOOL_SCHEMAS, { temperature: temp });
    model = res.model;
    usage = res.usage;

    if (!res.toolCalls || res.toolCalls.length === 0) {
      // 最终回复：解析结构化输出
      const parsed = parseStructured(res.content ?? '');
      const issues = verifyOutput(parsed.narrative, parsed.dice_results, toolCtx.world);
      return {
        narrative: parsed.narrative,
        diceResults: parsed.dice_results ?? [],
        promptPlayer: parsed.prompt_player ?? null,
        model,
        usage,
        toolRounds,
        issues,
      };
    }

    if (++toolRounds > maxRounds) throw new ChatError(`工具调用超过 ${maxRounds} 轮，疑似循环`);

    // 执行工具（本地），全部成功后再回填（保持原子性：一个失败整体终止）
    const results: string[] = [];
    for (const call of res.toolCalls) {
      try {
        const r = await executeTool(call, toolCtx);
        results.push(r.content);
      } catch (e) {
        const msg = e instanceof ToolError ? e.message : `工具执行错误: ${(e as Error).message}`;
        results.push(JSON.stringify({ error: msg }));
      }
    }
    // assistant 消息带 tool_calls + 对应 tool 消息
    messages.push({
      role: 'assistant',
      content: res.content,
      tool_calls: res.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })),
    });
    res.toolCalls.forEach((tc, i) => {
      messages.push({ role: 'tool', tool_call_id: tc.id, content: results[i] });
    });
  }
}

// 容错字符串值扫描：从 startQuote（'"' 下标）开始提取 JSON 字符串值，
// 容忍 AI 输出中未转义的引号（如 narrative 里「"名单"」）——遇到 '"' 时，
// 若后随 , } ] 或空白后随这些 → 视为字符串结束；否则当作文本引号继续。
function scanJsonString(text: string, startQuote: number): { value: string; end: number } | null {
  let i = startQuote + 1;
  let out = '';
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      const n = text[i + 1];
      if (n === 'n') out += '\n';
      else if (n === 't') out += '\t';
      else if (n === 'r') out += '\r';
      else if (n === '"') out += '"';
      else if (n === '\\') out += '\\';
      else if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
        out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
        i += 5;
      } else out += n;
      i += 2;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
      const next = text[j];
      if (next === ',' || next === '}' || next === ']' || next === undefined) {
        return { value: out, end: i };
      }
      out += ch; // 未转义引号（叙事内引号），按文本处理
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return { value: out, end: text.length }; // 未闭合：返回已提取部分
}

// 提取 JSON 字段的字符串值（key 存在但值缺失时返回 null）
function extractJsonField(text: string, key: string): string | null {
  const re = new RegExp(`"${key}"\\s*:\\s*"`);
  const m = re.exec(text);
  if (!m) return null;
  const res = scanJsonString(text, m.index + m[0].length - 1);
  return res ? res.value : null;
}

// 提取 JSON 数组字段（dice_results 等）：逐个扫描字符串元素
function extractJsonArray(text: string, key: string): string[] | null {
  const re = new RegExp(`"${key}"\\s*:\\s*\\[`);
  const m = re.exec(text);
  if (!m) return null;
  const out: string[] = [];
  let i = m.index + m[0].length;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const res = scanJsonString(text, i);
      if (res) out.push(res.value);
      i = res ? res.end + 1 : i + 1;
    } else if (ch === ']') break;
    else i++;
  }
  return out;
}

// 容错 JSON 解析：优先取 {"narrative" 起点（避免叙事废话里含 { 干扰），退化取第一个 { 到最后一个 }
export function parseStructured(content: string): ParsedOutput {
  let text = content;
  // 数组包裹剥壳（AI 偶发输出 [{"narrative":...}]）：剥最外层 [ ]
  if (/^\s*\[/.test(text) && /\][\s\n]*$/.test(text)) {
    const inner = text.trim().slice(1, -1).trim();
    if (inner.startsWith('{')) text = inner;
  }
  const keyStart = text.indexOf('{"narrative"');
  const start = keyStart >= 0 ? keyStart : text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    // 非 JSON：整体作为叙事（若含泄露特征，verify 会拦截提示）
    return { narrative: text.trim(), dice_results: [], prompt_player: null };
  }
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as Partial<ParsedOutput>;
    return {
      narrative: (obj.narrative ?? '').trim() || text.slice(0, start).trim(),
      dice_results: Array.isArray(obj.dice_results) ? obj.dice_results.map(String) : [],
      prompt_player: obj.prompt_player ?? null,
    };
  } catch {
    // 解析失败（常见：叙事含未转义引号如 "名单"）：
    // 容错提取三字段——绝不再把含 JSON 外壳的原始全文当 narrative 落库
    // narrative 值可能未加引号（YAML 风格）——两条链都试，避免空数组命中导致外壳落库
    const narrative = extractJsonField(text, 'narrative')
      ?? (/\"narrative"\s*:\s*([^,"}\n][^,"}\n]*)/.exec(text)?.[1]?.trim() ?? null);
    const dice = extractJsonArray(text, 'dice_results');
    const prompt = extractJsonField(text, 'prompt_player');
    if (narrative !== null || prompt !== null || dice !== null) {
      const prefix = text.slice(0, start).trim();
      return {
        narrative: (narrative ?? '').trim() || (prefix || text.trim()),
        dice_results: dice ?? [],
        prompt_player: prompt ?? null,
      };
    }
    // 完全提取不到：按纯叙事处理（保留原始文本，校验照常；含泄露特征时 verify 拦截）
    return { narrative: text.trim(), dice_results: [], prompt_player: null };
  }
}

// 流式叙事前缀提取：LLM 输出是 JSON（{"narrative":"..."}），流式过程中逐步剥离外壳，
// 只暴露 narrative 内容供 UI 逐字显示；非 JSON 文本原样返回
export function extractNarrativePrefix(acc: string): string {
  let s = acc.trimStart();
  // 剥 code fence（AI 有时输出 ```json ... ```）：避免 ```json 与 JSON 外壳泄漏到界面
  const fence = /^```(?:json|yaml)?\s*/.exec(s);
  if (fence) s = s.slice(fence[0].length);
  // 数组包裹 [{"narrative":...}]：剥最外层 [（结尾 ] 在流式结束时出现，交给末尾剥壳）
  if (s.startsWith('[{')) s = s.slice(1);
  // AI 先输出废话再 JSON（"好的，{"narrative":"..."}"）：定位 JSON 起点，保留废话 + 提取叙事
  const jsonStart = s.indexOf('{"narrative"');
  if (jsonStart > 0) {
    const tail = s.slice(jsonStart);
    const prefix = s.slice(0, jsonStart).trimEnd();
    try {
      const obj = JSON.parse(tail) as Partial<ParsedOutput>;
      if (typeof obj.narrative === 'string') return `${prefix}\n${obj.narrative}`;
    } catch { /* 未完整或含未转义引号：渐进提取 */ }
    const nar = extractJsonField(tail, 'narrative');
    if (nar !== null) return prefix ? `${prefix}\n${nar}` : nar;
  }
  if (!s.startsWith('{')) return acc; // 非 JSON 流：原样
  // 已完整：直接解析
  try {
    const obj = JSON.parse(s) as Partial<ParsedOutput>;
    if (typeof obj.narrative === 'string') return obj.narrative;
  } catch { /* 未闭合或含未转义引号，继续渐进 */ }
  // 渐进：容错扫描 narrative 字段（容忍叙事内未转义引号，如 "名单"）
  return extractJsonField(s, 'narrative') ?? '';
}
