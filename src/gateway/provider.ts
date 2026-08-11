// gateway/provider.ts — LLM Provider 抽象（零依赖，Node 内置 fetch）
// OpenAI 兼容接口：OpenAI / DeepSeek / 通义 / Kimi / Ollama 本地 全部走同一协议

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON 字符串
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatRequestOptions {
  temperature?: number;
  maxTokens?: number;
}

export interface ChatResponse {
  content: string | null;
  toolCalls: ToolCall[] | null;
  usage?: { inputTokens?: number; outputTokens?: number };
  model: string;
}

export interface Provider {
  readonly id: string;
  chat(messages: ChatMessage[], tools: ToolSchema[], opts?: ChatRequestOptions): Promise<ChatResponse>;
  /** 流式聊天（SSE）：onDelta 逐段回调叙事文本；返回完整结果（与 chat 一致）。未实现时回退 chat */
  streamChat?(messages: ChatMessage[], tools: ToolSchema[], opts: ChatRequestOptions, onDelta: (text: string) => void): Promise<ChatResponse>;
}

export interface OpenAiConfig {
  baseUrl: string;   // 如 https://api.deepseek.com/v1
  apiKey: string;
  model: string;     // 如 deepseek-chat / qwen2.5:7b / gpt-4o-mini
  temperature?: number;
  timeoutMs?: number;
}

export class GatewayError extends Error {}

// 协议适配：内部 tool_calls 平铺 {id,name,arguments} → OpenAI 规范 {id,type:'function',function:{name,arguments}}
// （缺 type/function 嵌套会被严格校验端点（Ollama 等）拒绝：missing field `type`）
export function toWireMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((m) =>
    m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0
      ? {
          role: 'assistant',
          content: m.content,
          tool_calls: m.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          })),
        }
      : m,
  );
}

export class OpenAiCompatibleProvider implements Provider {
  readonly id: string;
  private cfg: OpenAiConfig;

  constructor(id: string, cfg: OpenAiConfig) {
    this.id = id;
    this.cfg = cfg;
  }

  async chat(messages: ChatMessage[], tools: ToolSchema[], opts: ChatRequestOptions = {}): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: toWireMessages(messages),
      temperature: opts.temperature ?? this.cfg.temperature ?? 0.9,
    };
    if (tools.length > 0) body.tools = tools;
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 60_000);
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.apiKey}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      throw new GatewayError(`请求失败: ${(e as Error).message}`);
    }
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GatewayError(`API ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      choices: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new GatewayError('API 返回空 choices');
    const toolCalls = (msg.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));
    return {
      content: msg.content,
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
      usage: data.usage ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens } : undefined,
      model: data.model ?? this.cfg.model,
    };
  }

  // 流式（SSE）：content delta 逐段回调；tool_calls 分段累积（arguments 分片拼接）
  async streamChat(messages: ChatMessage[], tools: ToolSchema[], opts: ChatRequestOptions = {}, onDelta: (text: string) => void): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: toWireMessages(messages),
      temperature: opts.temperature ?? this.cfg.temperature ?? 0.9,
      stream: true,
    };
    if (tools.length > 0) body.tools = tools;
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 60_000);
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.apiKey}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      throw new GatewayError(`请求失败: ${(e as Error).message}`);
    }
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GatewayError(`API ${res.status}: ${text.slice(0, 300)}`);
    }
    if (!res.body) throw new GatewayError('API 返回空响应流');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let content = '';
    let toolCalls: { id: string; name: string; arguments: string }[] = [];
    let buffer = '';
    let done = false;
    while (!done) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while (!done && (nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { done = true; break; }
        try {
          const chunk = JSON.parse(data) as {
            choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
          };
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.content) { content += delta.content; onDelta(delta.content); }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              toolCalls[idx] ??= { id: '', name: '', arguments: '' };
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.function?.name) toolCalls[idx].name = tc.function.name;
              if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
            }
          }
        } catch { /* 忽略解析失败的行（keep-alive 等） */ }
      }
    }
    reader.releaseLock();
    return {
      content: content || null,
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
      model: this.cfg.model,
    };
  }
}

// —— MockProvider：脚本化测试用 ——
// 每个条目按序消费；函数形态可基于 messages 动态决策（如模拟"先调工具再回复"）
export class MockProvider implements Provider {
  readonly id: string;
  private script: Array<(messages: ChatMessage[]) => ChatResponse>;
  private step = 0;
  private mockModel: string;

  constructor(id: string, script: Array<ChatResponse | ((messages: ChatMessage[]) => ChatResponse)>, mockModel = 'mock-model') {
    this.id = id;
    this.script = script.map((s) => (typeof s === 'function' ? s : () => s));
    this.mockModel = mockModel;
  }

  get callCount(): number { return this.step; }

  async chat(messages: ChatMessage[], _tools: ToolSchema[], _opts: ChatRequestOptions = {}): Promise<ChatResponse> {
    if (this.step >= this.script.length) throw new GatewayError(`MockProvider 脚本耗尽（第 ${this.step} 次调用）`);
    const r = this.script[this.step](messages);
    this.step++;
    return r;
  }

  // 流式：一次性回调全文（单测验证 onDelta 链路用）
  async streamChat(messages: ChatMessage[], tools: ToolSchema[], opts: ChatRequestOptions, onDelta: (text: string) => void): Promise<ChatResponse> {
    const r = await this.chat(messages, tools, opts);
    if (r.content) onDelta(r.content);
    return r;
  }

  get mockModelName(): string { return this.mockModel; }
}
