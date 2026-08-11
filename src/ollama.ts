// src/ollama.ts — Ollama 本地托管（P6）：检测 / 下载 / 模型管理（零 npm 依赖，Node 内置 fetch）
// 设计（技术方案 §3.2）：检测 11434 端口 → 有则直接用；无则下载官方 zip 便携版 → spawn ollama serve
// 模型下载/切换/更新全用 Ollama 的 pull/list 能力，不自己造轮子。
// 注意：下载/解压/启动等"编排"在主进程（electron/main.ts），本模块只放可单测的纯逻辑与网络原语。

// import { createWriteStream } from 'node:fs'; — 不顶层引入：renderer 也 import 本模块（MODEL_CARDS），
// 顶层 node:fs 会让 vite 打出 externalize 警告；downloadFile 仅在主进程调用，改函数内动态 import
import type { WriteStream } from 'node:fs';

export const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
/** OpenAI 兼容端点（provider 抽象层直接指到这里，apiKey 任意值） */
export const OLLAMA_OPENAI_URL = `${OLLAMA_BASE_URL}/v1`;
/** GitHub latest 重定向：不硬编码版本号，永远拿最新稳定版 zip */
export const OLLAMA_DOWNLOAD_URL = 'https://github.com/ollama/ollama/releases/latest/download/ollama-windows-amd64.zip';
/** 下载体积提示（新版本 zip 含 CUDA/ROCm/Vulkan 运行时，约 1-2GB，技术方案 v0.5 估的 ~200MB 已过时） */
export const OLLAMA_ZIP_SIZE_LABEL = '约 1~2GB';

// —— 模型卡（照抄 Jan Model Hub 交互：显示每个模型的体积/需求，玩家点下载）——
export interface OllamaModelCard {
  name: string;      // Ollama 模型名（qwen2.5:7b）
  sizeLabel: string; // 下载体积
  ram: string;       // 硬件需求文案
  note: string;      // 说明
  bytes: number;     // 估算下载字节数（用于排序/展示）
}

export const MODEL_CARDS: OllamaModelCard[] = [
  { name: 'qwen2.5:3b',  sizeLabel: '约 2.0GB', ram: '8GB 内存（无独显）',  note: '低配首选，流畅但文采一般', bytes: 2_000_000_000 },
  { name: 'qwen2.5:7b',  sizeLabel: '约 4.7GB', ram: '16GB 内存 / 6GB+ 显存', note: '中文跑团质量/资源平衡点（默认推荐）', bytes: 4_700_000_000 },
  { name: 'qwen2.5:14b', sizeLabel: '约 9.0GB', ram: '32GB 内存 / 10GB+ 显存', note: '文采更好，吃配置', bytes: 9_000_000_000 },
  { name: 'qwen2.5:32b', sizeLabel: '约 19GB',  ram: '20GB+ 显存',           note: '接近云端体验，旗舰配置', bytes: 19_000_000_000 },
];

export interface HardwareInfo {
  totalRamGB: number | null;   // 系统内存（GB，四舍五入 1 位）
  vramGB: number | null;       // 最大独立显存（GB）；无独显/未知为 null
  gpuName: string | null;      // 主显卡名（UI 展示用）
}

/** 硬件 → 推荐模型（抄 Jan 的规则：GPU VRAM <6GB 阈值 → 静默回退 CPU 按内存档） */
export function recommendModel(hw: HardwareInfo): string {
  const vram = hw.vramGB ?? 0;
  if (vram >= 20) return 'qwen2.5:32b';
  if (vram >= 10) return 'qwen2.5:14b';
  if (vram >= 6) return 'qwen2.5:7b';
  // CPU 路径（<6GB 显存或无独显）：按内存
  const ram = hw.totalRamGB ?? 0;
  if (ram >= 32) return 'qwen2.5:14b';
  if (ram >= 16) return 'qwen2.5:7b';
  return 'qwen2.5:3b';
}

// —— 检测 ——
export interface OllamaVersion { version: string }

/** 探测本地 Ollama 是否在跑（GET /api/version，超时可配） */
export async function checkOllama(timeoutMs = 2000, baseUrl = OLLAMA_BASE_URL): Promise<OllamaVersion | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/version`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<OllamaVersion>;
    return typeof data.version === 'string' ? { version: data.version } : null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// —— 模型列表（GET /api/tags）——
export interface OllamaModelInfo {
  name: string;
  size: number;       // 磁盘占用字节
  digest: string;
  modifiedAt: string;
}

export interface OllamaTagsResponse {
  models?: { name?: string; size?: number; digest?: string; modified_at?: string }[];
}

export async function listOllamaModels(baseUrl = OLLAMA_BASE_URL, timeoutMs = 5000): Promise<OllamaModelInfo[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = (await res.json()) as OllamaTagsResponse;
    return (data.models ?? [])
      .filter((m) => typeof m.name === 'string')
      .map((m) => ({ name: m.name as string, size: m.size ?? 0, digest: m.digest ?? '', modifiedAt: m.modified_at ?? '' }));
  } catch {
    clearTimeout(timer);
    return [];
  }
}

// —— 模型下载（POST /api/pull，stream 模式逐行 JSON）——
export type PullStatus =
  | { kind: 'progress'; name: string; completed: number; total: number; pct: number }
  | { kind: 'status'; name: string; status: string }
  | { kind: 'done'; name: string };

export interface PullCallbacks {
  onProgress?: (pct: number, status: string) => void;
}

/** 解析 /api/pull 的一行（兼容 NDJSON 与带 data: 前缀的 SSE 两种形态） */
export function parsePullLine(line: string): PullStatus | null {
  const t = line.trim();
  if (!t) return null;
  const json = t.startsWith('data:') ? t.slice(5).trim() : t;
  if (!json || json === '[DONE]') return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  const name = typeof obj.name === 'string' ? obj.name : '';
  const status = typeof obj.status === 'string' ? obj.status : '';
  if (status === 'success') return { kind: 'done', name };
  const completed = typeof obj.completed === 'number' ? obj.completed : 0;
  const total = typeof obj.total === 'number' ? obj.total : 0;
  if (status === 'downloading' && total > 0) {
    return { kind: 'progress', name, completed, total, pct: Math.min(100, Math.round((completed / total) * 100)) };
  }
  if (status) return { kind: 'status', name, status };
  return null;
}

/** 拉取模型：走 /api/pull stream，进度经 onProgress 回调（0-100 + 阶段文案） */
export async function pullOllamaModel(
  name: string,
  cb: PullCallbacks = {},
  baseUrl = OLLAMA_BASE_URL,
  timeoutMs = 0, // 0 = 不超时（大模型下载可达几十分钟）
): Promise<{ ok: boolean; error?: string }> {
  const ctrl = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(`${baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stream: true }),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}` };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const ev = parsePullLine(line);
        if (!ev) continue;
        if (ev.kind === 'progress') {
          cb.onProgress?.(ev.pct, `下载 ${ev.pct}%`);
        } else if (ev.kind === 'status') {
          cb.onProgress?.(0, ev.status);
        } else if (ev.kind === 'done') {
          cb.onProgress?.(100, '完成');
          return { ok: true };
        }
      }
    }
    return { ok: false, error: '下载流意外结束（未收到 success）' };
  } catch (e) {
    const msg = (e as Error).message;
    return { ok: false, error: msg.includes('abort') ? '下载已取消或超时' : msg };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// —— 文件下载（Ollama zip 用；进度回调 0-100）——
export async function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (pct: number, receivedBytes: number, totalBytes: number) => void,
  timeoutMs = 0,
): Promise<void> {
  const ctrl = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  let res: Response;
  try {
    res = await fetch(url, { signal: ctrl.signal });
  } catch (e) {
    if (timer) clearTimeout(timer);
    throw new Error(`下载请求失败: ${(e as Error).message}`);
  }
  if (!res.ok || !res.body) {
    if (timer) clearTimeout(timer);
    throw new Error(`下载失败 HTTP ${res.status}${res.status === 302 || res.status === 307 ? '（重定向未跟随？）' : ''}`);
  }
  const total = Number(res.headers.get('content-length') ?? 0);
  const reader = res.body.getReader();
  const { createWriteStream } = await import('node:fs');
  let received = 0;
  await new Promise<void>((resolve, reject) => {
    const out: WriteStream = createWriteStream(destPath);
    const pump = async (): Promise<void> => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (total > 0) onProgress?.(Math.min(100, Math.round((received / total) * 100)), received, total);
        await new Promise<void>((wr, wj) => out.write(value, (e) => (e ? wj(e) : wr())));
      }
    };
    pump()
      .then(() => out.end((e) => (e ? reject(e) : resolve())))
      .catch(reject);
  });
  if (timer) clearTimeout(timer);
}
