// electron/main.ts — Electron 主进程（引擎承载：存储 + AI 网关 + 判定）
// 引擎代码直接 import（vite 打包）；node:sqlite 在 Electron 内置 Node ≥23.4 默认可用

import { app, BrowserWindow, ipcMain, Menu, dialog } from 'electron';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChildProcess } from 'node:child_process';

declare const __dirname: string; // CJS 全局（vite lib cjs 输出）

// 防 EPIPE 崩溃：stdout/stderr 所接管道被关闭（如 E2E 输出被 head 提前截断）时，
// console.log/error 写入会抛 EPIPE → Electron 主进程默认弹 uncaught exception 并阻塞退出。此处静默吞掉。
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE') return; // 管道关闭：丢弃即可
    throw e;
  });
}

// —— 引擎层 ——
import { CampaignStore, toChatMessages, trimHistoryToWindow, type StoredMessage } from '../src/campaign.ts';
import { loadRulePack, parseYaml } from '../src/rules.ts';
import { serializeYaml } from '../src/yaml-write.ts';
import { loadScenarioPack } from '../src/scenario.ts';
import { matchLore } from '../src/lore.ts';
import { buildMemoryContext, renderMemoryBlock, generateSessionSummary, recentTextOf, extractFactsIncrementally } from '../src/memory.ts';
import { simulateNpcActions } from '../src/sim.ts';
import { computeTension, hasCountdownPlot, buildTensionPrompt, DEFAULT_TENSION, type TensionSettings } from '../src/tension.ts';
import { COC_ATTRIBUTE_DESC, COC_SKILL_DESC, COC_DERIVED_DESC, GENERIC_DESC } from '../src/coc7e-info.ts';
import { generateCharacter, buildCharacter, characterFields, computeDerived, type CharacterSpec } from '../src/chargen.ts';
import { World, parseMoveIntent } from '../src/world.ts';
import { adjudicate } from '../src/adjudicate.ts';
import { OpenAiCompatibleProvider, MockProvider, type Provider } from '../src/gateway/provider.ts';
import { runChat, extractNarrativePrefix } from '../src/gateway/chat.ts';
import { buildSystemPrompt } from '../src/gateway/prompt.ts';
import type { ToolContext } from '../src/gateway/tools.ts';
import { PackStore, validatePackContent, dkContent, parseDk, loadImportedScenario, loadImportedRulePack, parsePackObject, serializePackObject, savePackObject, buildNewPackTemplate, normalizeGeneratedPack, summarizeRulePackForPrompt, sanitizeAiYaml, parseAiOutput, genPackId, testPackCheck, testPackDistribution, testPackLore, summarizePackContent, type PackMeta, type PackSummary } from '../src/packs.ts';
import { PRESET_PERSONAS, renderPersona, validatePersona, findPersona, type Persona } from '../src/personas.ts';
import { checkOllama, listOllamaModels, pullOllamaModel, downloadFile, recommendModel, OLLAMA_DOWNLOAD_URL, OLLAMA_OPENAI_URL } from '../src/ollama.ts';
import { HWINFO_PS_SCRIPT, parseHwInfo } from '../src/hwinfo.ts';
import { WsServer } from '../src/ws-server.ts';
import { Room, type RoomPlayerInfo } from '../src/room.ts';
import { networkInterfaces } from 'node:os';
import type { ScenarioPack } from '../src/scenario.ts';

const APP_DATA = join(app.getPath('userData'), 'data');
mkdirSync(APP_DATA, { recursive: true });
// E2E 模式用独立临时库，不污染玩家数据
const DB_PATH = process.env.DK_E2E
  ? join(app.getPath('temp'), `dk-e2e-${Date.now()}.db`)
  : join(APP_DATA, 'dicekeeper.db');
// 内置规则包/剧本包路径：开发时在项目根（dist/electron → ../../rules），
// 打包后 electron-builder 通过 extraResources 复制到 resources/rules（asar 外，可读）
const RULES_PATH = app.isPackaged
  ? join(process.resourcesPath, 'rules', 'coc7e.yaml')
  : join(__dirname, '..', '..', 'rules', 'coc7e.yaml');
const SCENARIO_PATH = app.isPackaged
  ? join(process.resourcesPath, 'scenarios', 'fogharbor.yaml')
  : join(__dirname, '..', '..', 'scenarios', 'fogharbor.yaml');
// 内容包存储（P3a：导入的规则包/剧本包；E2E 用临时目录隔离）
const PACKS_DIR = process.env.DK_E2E
  ? join(app.getPath('temp'), `dk-e2e-packs-${Date.now()}`)
  : join(app.getPath('userData'), 'packs');

const store = new CampaignStore(DB_PATH);
const pack = loadRulePack(RULES_PATH);
const scenario = loadScenarioPack(SCENARIO_PATH);
const packStore = new PackStore(PACKS_DIR);

// 剧本包注册表：内置 + 导入（建团可选，P3a）
function loadScenarioById(id: string): ScenarioPack | null {
  if (id === scenario.id) return scenario;
  return loadImportedScenario(packStore, id);
}
function listScenarioPacks(): PackMeta[] {
  return [
    { id: scenario.id, name: scenario.name, version: scenario.version, type: 'scenario', isBuiltin: true },
    ...packStore.listImported().filter((m) => m.type === 'scenario'),
  ];
}
function listRulePacks(): PackMeta[] {
  return [
    { id: pack.id, name: pack.name, version: pack.version, type: 'rule', isBuiltin: true },
    ...packStore.listImported().filter((m) => m.type === 'rule'),
  ];
}
// 导入内容（校验 → 依赖检查 → 冲突检测 → 落盘），UI 与 E2E 共用
// opts.force：同 id 已存在时仍导入（覆盖）；opts.newId：换名导入（改内容 id + 文件名）
function importPackContent(
  content: string,
  opts: { force?: boolean; newId?: string } = {},
): { ok: boolean; canceled?: boolean; pack?: PackMeta; conflict?: boolean; summary?: PackSummary; content?: string; error?: string } {
  const result = validatePackContent(content, listRulePacks().map((m) => m.id));
  if (!result.ok || !result.type || !result.meta) return { ok: false, error: result.error };
  const summary = summarizePackContent(content);
  const exists = packStore.listImported().some((m) => m.type === result.type && m.id === result.meta!.id);
  // 冲突且未强制 → 不落盘，把内容回传 UI 供确认（覆盖/换名）
  if (exists && !opts.force) {
    return { ok: true, conflict: true, pack: result.meta, summary: summary ?? undefined, content };
  }
  try {
    let meta = result.meta;
    let body = parseDk(content).body;
    if (opts.newId) {
      // 换名导入：改内容 id（列表/加载按内容 id 识别）
      const raw = parseYaml(body) as Record<string, unknown>;
      raw.id = opts.newId;
      body = serializeYaml(raw);
      meta = { ...meta, id: opts.newId };
    }
    packStore.save(result.type, meta, dkContent(result.type, body));
  } catch (e) {
    return { ok: false, error: `导入失败: ${(e as Error).message}` };
  }
  return { ok: true, pack: result.meta, summary: summary ?? undefined };
}
// 导出（内置或导入包 → .dk 单文件）
function packBody(type: 'rule' | 'scenario', id: string): string | null {
  if (type === 'scenario' && id === scenario.id) return readFileSync(SCENARIO_PATH, 'utf-8');
  if (type === 'rule' && id === pack.id) return readFileSync(RULES_PATH, 'utf-8');
  return packStore.load(type, id);
}

// 启动自检：node:sqlite 是否真的可用（Electron 内置 Node 版本差异）
let sqliteOk = true;
try {
  store.db.prepare('SELECT 1').get();
} catch {
  sqliteOk = false;
  console.error('[DiceKeeper] node:sqlite 不可用（Electron 内置 Node 需 --experimental-sqlite）');
}
console.log(`[DiceKeeper] Electron ${process.versions.electron} / Node ${process.versions.node} / SQLite ${sqliteOk ? 'OK' : 'FAIL'}`);

// —— 会话状态（当前活动战役/会话）——
let activeCampaignId: string | null = null;
let activeSessionId: string | null = null;
let mainWindow: BrowserWindow | null = null; // 流式叙事转发目标
let provider: Provider = new MockProvider('offline', []); // 未配置 API 时离线兜底
const DEFAULT_PERSONA = '你是克苏鲁跑团的守密人（KP），冷静、克制、营造氛围。用中文叙事，描写注重感官细节，让玩家做选择，不要替玩家做决定。';

// —— 人格包（B5，§3.6：预设 6 档 + 玩家自建 + 战役绑定）——
const PERSONAS_PATH = process.env.DK_E2E
  ? join(app.getPath('temp'), `dk-e2e-personas-${Date.now()}.json`)
  : join(app.getPath('userData'), 'personas.json');
function loadCustomPersonas(): Persona[] {
  try {
    const s = JSON.parse(readFileSync(PERSONAS_PATH, 'utf-8')) as unknown;
    return Array.isArray(s) ? s as Persona[] : [];
  } catch { return []; }
}
function saveCustomPersonas(list: Persona[]): void {
  writeFileSync(PERSONAS_PATH, JSON.stringify(list, null, 2), 'utf-8');
}
let customPersonas: Persona[] = loadCustomPersonas();

// 解析当前生效的人格段：战役绑定 > 全局默认 > 内置默认
function resolvePersona(campaignId: string | null): string {
  let id: string | null = null;
  if (campaignId) {
    try { id = store.loadCampaign(campaignId).personaId ?? null; } catch { /* 战役可能已删 */ }
  }
  if (!id) id = loadSettings().defaultPersonaId ?? null;
  const p = id ? findPersona(PRESET_PERSONAS, customPersonas, id) : null;
  return p ? renderPersona(p) : DEFAULT_PERSONA;
}

function makeProvider(cfg: { baseUrl: string; apiKey: string; model: string }): Provider {
  if (!cfg.apiKey || !cfg.baseUrl || !cfg.model) return new MockProvider('offline', []);
  return new OpenAiCompatibleProvider('remote', cfg);
}

// —— AI 设置持久化（userData/settings.json；E2E 用临时文件隔离）——
const SETTINGS_PATH = process.env.DK_E2E
  ? join(app.getPath('temp'), `dk-e2e-settings-${Date.now()}.json`)
  : join(app.getPath('userData'), 'settings.json');

function loadSettings(): { baseUrl: string; apiKey: string; model: string; defaultPersonaId?: string; tension?: TensionSettings } {
  try {
    const s = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8')) as { baseUrl?: string; apiKey?: string; model?: string; defaultPersonaId?: string; tension?: Partial<TensionSettings> };
    return {
      baseUrl: s.baseUrl ?? '', apiKey: s.apiKey ?? '', model: s.model ?? '', defaultPersonaId: s.defaultPersonaId ?? '',
      tension: { ...DEFAULT_TENSION, ...(s.tension ?? {}) },
    };
  } catch {
    // 首次启动（无文件）：环境变量兜底（CI/E2E 注入）
    return { baseUrl: process.env.DK_BASE_URL ?? '', apiKey: process.env.DK_API_KEY ?? '', model: process.env.DK_MODEL ?? '', tension: { ...DEFAULT_TENSION } };
  }
}

// 启动即恢复上次保存的 AI 设置
{
  const saved = loadSettings();
  if (saved.apiKey) provider = makeProvider(saved);
}

// —— IPC：设置 ——
ipcMain.handle('settings:get', () => ({ ...loadSettings(), sqliteOk }));
ipcMain.handle('settings:set', (_e, cfg: { baseUrl: string; apiKey: string; model: string; defaultPersonaId?: string; tension?: TensionSettings }) => {
  provider = makeProvider(cfg);
  try {
    writeFileSync(SETTINGS_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch (e) {
    console.error('[DiceKeeper] 设置保存失败:', (e as Error).message);
    return { ok: false };
  }
  return { ok: true };
});
// —— IPC：人格包（B5）——
ipcMain.handle('personas:list', () => ({
  presets: PRESET_PERSONAS,
  custom: customPersonas,
  defaultId: loadSettings().defaultPersonaId ?? '',
}));
ipcMain.handle('personas:save', (_e, p: Persona) => {
  validatePersona(p);
  const saved: Persona = { ...p, isCustom: true };
  const idx = customPersonas.findIndex((x) => x.id === saved.id);
  if (idx >= 0) customPersonas[idx] = saved;
  else customPersonas.push(saved);
  saveCustomPersonas(customPersonas);
  return saved;
});
ipcMain.handle('personas:delete', (_e, id: string) => {
  customPersonas = customPersonas.filter((x) => x.id !== id);
  saveCustomPersonas(customPersonas);
  return { ok: true };
});
// 测试 AI 服务连通性：GET {base_url}/models（OpenAI 兼容端点，DeepSeek/通义/Kimi/Ollama 均支持）
// 成功返回可用模型列表（供 UI 下拉选择）；失败返回错误信息
ipcMain.handle('settings:test', async (_e, cfg: { baseUrl: string; apiKey: string }) => {
  if (!cfg.baseUrl?.trim() || !cfg.apiKey?.trim()) {
    return { ok: false, error: '请先填写接口地址与 API 密钥' };
  }
  const base = cfg.baseUrl.trim().replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${cfg.apiKey.trim()}` },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: `HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : '（接口拒绝了请求，请检查地址与密钥）'}` };
    }
    const data = (await res.json()) as { data?: { id?: string }[] };
    const models = (data.data ?? []).map((m) => m.id).filter(Boolean).slice(0, 60) as string[];
    return { ok: true, status: res.status, models };
  } catch (e) {
    clearTimeout(timer);
    const msg = (e as Error).message;
    return { ok: false, error: msg.includes('abort') ? '连接超时（10 秒），请检查地址或网络' : msg };
  }
});

// —— P6 本地模式：Ollama 应用内托管（技术方案 §3.2）——
// 检测 11434 端口 → 有则直接用（玩家自装 Ollama，兼容）；无则下载官方 zip 便携版 → 解压 → spawn ollama serve
// 模型目录（OLLAMA_MODELS）指向 userData/models，下载的模型不占系统盘 Ollama 的默认位置
const OLLAMA_DIR = process.env.DK_E2E
  ? join(app.getPath('temp'), `dk-e2e-ollama-${Date.now()}`)
  : join(app.getPath('userData'), 'ollama');
const OLLAMA_MODELS_DIR = process.env.DK_E2E
  ? join(app.getPath('temp'), `dk-e2e-models-${Date.now()}`)
  : join(app.getPath('userData'), 'models');
const POWERSHELL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const execFileAsync = promisify(execFile);
let managedOllama: ChildProcess | null = null; // 应用托管的 ollama serve 进程（退出时清理）

function sendOllamaProgress(win: BrowserWindow | null, phase: string, pct: number, label: string): void {
  win?.webContents.send('ollama:progress', { phase, pct, label });
}
function fmtMB(bytes: number): string {
  return bytes >= 1_000_000_000 ? `${(bytes / 1_000_000_000).toFixed(1)}GB` : `${Math.round(bytes / 1_000_000)}MB`;
}
function sleepMs(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

// 定位托管 ollama.exe：直放 + 一层子目录容错（zip 结构可能带顶层目录）
async function findOllamaExe(): Promise<string | null> {
  const direct = join(OLLAMA_DIR, 'ollama.exe');
  if (existsSync(direct)) return direct;
  try {
    for (const d of readdirSync(OLLAMA_DIR, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const p = join(OLLAMA_DIR, d.name, 'ollama.exe');
      if (existsSync(p)) return p;
    }
  } catch { /* 目录尚未创建 */ }
  return null;
}

// 下载官方 zip（进度经 ollama:progress 推送）→ Expand-Archive 解压 → 清理 zip
async function ensureOllamaInstalled(win: BrowserWindow | null): Promise<{ ok: boolean; error?: string }> {
  if (await findOllamaExe()) return { ok: true };
  mkdirSync(OLLAMA_DIR, { recursive: true });
  const zipPath = join(OLLAMA_DIR, 'ollama.zip');
  sendOllamaProgress(win, 'download', 0, '连接下载源…');
  try {
    await downloadFile(OLLAMA_DOWNLOAD_URL, zipPath, (pct, recv, total) => {
      sendOllamaProgress(win, 'download', pct, `下载 Ollama ${pct}%（${fmtMB(recv)} / ${fmtMB(total)}）`);
    });
  } catch (e) {
    return { ok: false, error: `下载 Ollama 失败：${(e as Error).message}（若 GitHub 被墙，请手动下载 ollama-windows-amd64.zip 到 ${OLLAMA_DIR}\\ollama.zip）` };
  }
  sendOllamaProgress(win, 'extract', 0, '解压中（约 1-2 分钟）…');
  const esc = (s: string): string => s.replace(/'/g, "''");
  try {
    await execFileAsync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -Path '${esc(zipPath)}' -DestinationPath '${esc(OLLAMA_DIR)}' -Force`], { timeout: 600_000, windowsHide: true });
  } catch (e) {
    return { ok: false, error: `解压 Ollama 失败：${(e as Error).message}` };
  }
  try { rmSync(zipPath, { force: true }); } catch { /* zip 清理失败不阻塞（省 1-2GB 磁盘） */ }
  if (!(await findOllamaExe())) return { ok: false, error: '解压完成但未找到 ollama.exe（zip 结构异常）' };
  return { ok: true };
}

// spawn ollama serve（OLLAMA_MODELS 指向应用托管目录）→ 轮询 /api/version 直到就绪
async function startManagedOllama(win: BrowserWindow | null): Promise<{ ok: boolean; error?: string; version?: string }> {
  const already = await checkOllama();
  if (already) return { ok: true, version: already.version };
  const exe = await findOllamaExe();
  if (!exe) return { ok: false, error: '未找到 ollama.exe，请先下载' };
  if (managedOllama && !managedOllama.killed) return { ok: false, error: 'Ollama 正在启动中，请稍候' };
  mkdirSync(OLLAMA_MODELS_DIR, { recursive: true });
  sendOllamaProgress(win, 'start', 0, '启动 Ollama 服务…');
  managedOllama = spawn(exe, ['serve'], {
    env: { ...process.env, OLLAMA_MODELS: OLLAMA_MODELS_DIR },
    windowsHide: true,
    stdio: 'ignore',
  });
  managedOllama.on('exit', (code) => {
    if (managedOllama) managedOllama = null;
    console.log('[DiceKeeper] Ollama 托管进程退出，code =', code);
  });
  for (let i = 0; i < 30; i++) {
    await sleepMs(1000);
    const v = await checkOllama();
    if (v) {
      sendOllamaProgress(win, 'start', 100, '服务已就绪');
      return { ok: true, version: v.version };
    }
  }
  return { ok: false, error: 'Ollama 启动超时（30 秒未就绪），可手动运行 ollama serve 排查' };
}

// 硬件检测：PowerShell/WMI + 注册表 qwMemorySize（>4GB 显存不回绕；不引入 systeminformation 依赖）
async function detectHardware(): Promise<{ totalRamGB: number | null; vramGB: number | null; gpuName: string | null }> {
  if (process.platform !== 'win32') return { totalRamGB: null, vramGB: null, gpuName: null };
  try {
    const { stdout } = await execFileAsync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', HWINFO_PS_SCRIPT], { timeout: 15_000, windowsHide: true });
    return parseHwInfo(stdout);
  } catch {
    return { totalRamGB: null, vramGB: null, gpuName: null };
  }
}

// —— IPC：本地模式（Ollama）——
// 状态：是否在跑（11434 探测）/ 是否已托管 / 目录信息；E2E 短路返回假数据
ipcMain.handle('ollama:status', async () => {
  if (process.env.DK_E2E) {
    return { running: false, managed: false, e2e: true, ollamaDir: OLLAMA_DIR, modelsDir: OLLAMA_MODELS_DIR, openaiUrl: OLLAMA_OPENAI_URL };
  }
  const v = await checkOllama();
  return {
    running: !!v,
    version: v?.version ?? undefined,
    managed: !!(await findOllamaExe()),
    ollamaDir: OLLAMA_DIR,
    modelsDir: OLLAMA_MODELS_DIR,
    openaiUrl: OLLAMA_OPENAI_URL,
  };
});
// 一键启用：下载（如需）→ 解压（如需）→ 启动；进度经 ollama:progress 推送
ipcMain.handle('ollama:setup', async (e) => {
  if (process.env.DK_E2E) return { ok: false, error: 'E2E 模式跳过托管' };
  const win = BrowserWindow.fromWebContents(e.sender);
  const inst = await ensureOllamaInstalled(win);
  if (!inst.ok) return inst;
  return startManagedOllama(win);
});
// 仅启动已托管的服务（下载已完成，重启应用后恢复）
ipcMain.handle('ollama:start', async (e) => {
  if (process.env.DK_E2E) return { ok: true, version: 'e2e' };
  return startManagedOllama(BrowserWindow.fromWebContents(e.sender));
});
// 硬件检测 + 推荐模型（Jan 规则：显存 <6GB 回退 CPU 按内存档）
ipcMain.handle('ollama:hwinfo', async () => {
  if (process.env.DK_E2E) return { totalRamGB: 16, vramGB: null, gpuName: 'E2E 虚拟显卡', recommend: recommendModel({ totalRamGB: 16, vramGB: null, gpuName: null }) };
  const hw = await detectHardware();
  return { ...hw, recommend: recommendModel(hw) };
});
// 已安装模型列表（/api/tags）
ipcMain.handle('ollama:models', async () => {
  if (process.env.DK_E2E) return [];
  return listOllamaModels();
});
// 拉取模型（/api/pull stream，进度经 ollama:progress 推送）
ipcMain.handle('ollama:pull', async (e, name: string) => {
  if (process.env.DK_E2E) return { ok: false, error: 'E2E 模式跳过下载' };
  if (!name || !/^[A-Za-z0-9._\-]+(:[A-Za-z0-9._\-]+)?$/.test(name)) return { ok: false, error: '模型名不合法' };
  const win = BrowserWindow.fromWebContents(e.sender);
  return pullOllamaModel(name, {
    onProgress: (pct, status) => sendOllamaProgress(win, 'pull', pct, `${name} ${status}`),
  });
});

// —— P5 局域网联机（房主中心化，技术方案 §6.1/§11.9）——
// 拓扑：玩家(WS client，瘦客户端) ─→ 房主(WsServer) ─→ 本地判定/AI 叙事 ─→ 广播
// 判定本地化铁律：玩家只发输入、收叙事/骰面；判定/移动/世界变更全在房主本地执行，AI 无权改。
// 跨网由第三方组网工具（Tailscale/ZeroTier 等）提供虚拟局域网，应用只做局域网直连。
let room: Room | null = null;
let roomServer: WsServer | null = null;
let roomClient: WebSocket | null = null; // 玩家模式：连房主的 WS client（Node 内置全局 WebSocket）

// 本机局域网 IPv4 列表（开房后展示给房主，玩家输地址加入）
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

// 房主收到玩家行动：玩家消息立即显示在房主 UI → 进串行队列（多人正确性：一次只处理一条，保证顺序、避免并发写库）→ 逐条走本地引擎全流程 → 广播
// 队列项：text 行动文本；source 发言人名（玩家消息落库带 [昵称] 前缀，房主消息为 undefined 不加前缀）；resolve/reject 供房主 chat:send 等待结果
type PlayerTurnResult = { narrative: string; diceResults: string[]; issues: { kind: string; message: string }[]; messageId?: number; promptPlayer?: string | null };
let roomQueue: { text: string; source?: string; resolve?: (r: PlayerTurnResult) => void; reject?: (e: Error) => void }[] = [];
let roomProcessing = false;

function enqueueRoomTurn(item: { text: string; source?: string }): Promise<PlayerTurnResult> {
  return new Promise((resolve, reject) => {
    roomQueue.push({ ...item, resolve, reject });
    void drainRoomQueue();
  });
}

async function handleRoomPlayerChat(p: RoomPlayerInfo, text: string): Promise<void> {
  mainWindow?.webContents.send('room:hostUser', { name: p.name, text });
  roomQueue.push({ text, source: p.name });
  void drainRoomQueue();
}

async function drainRoomQueue(): Promise<void> {
  if (roomProcessing) return;
  roomProcessing = true;
  try {
    while (roomQueue.length > 0) {
      const item = roomQueue.shift()!;
      try {
        const r = await runPlayerTurn(item.text, undefined, item.source);
        const payload = { text: r.narrative, dice: r.diceResults, prompt: r.promptPlayer ?? null };
        room?.broadcast('narrative', payload);
        mainWindow?.webContents.send('room:hostNarrative', payload);
        item.resolve?.(r);
      } catch (e) {
        const msg = (e as Error).message.replace(/^Error invoking remote method '[^']+':\s*/, '');
        room?.broadcast('system', { text: `处理失败：${msg}` });
        item.reject?.(e as Error);
      }
    }
  } finally {
    roomProcessing = false;
  }
}

// —— IPC：联机（房主）——
ipcMain.handle('room:host', async (_e, port = 0) => {
  if (room) return { ok: false, error: '房间已在运行' };
  const r = new Room({
    onPlayerJoined: (p) => {
      r.broadcast('system', { text: `${p.name} 加入了房间` });
      mainWindow?.webContents.send('room:players', { players: r.listPlayers(), notice: `${p.name} 加入了房间` });
    },
    onPlayerLeft: (p) => {
      mainWindow?.webContents.send('room:players', { players: r.listPlayers(), notice: `${p.name} 离开了房间` });
    },
    onPlayerChat: (p, text) => { void handleRoomPlayerChat(p, text); },
  });
  room = r;
  const srv = new WsServer((conn, req) => r.attach(conn, req));
  try {
    const actualPort = await srv.listen(port, '0.0.0.0');
    roomServer = srv;
    return { ok: true, port: actualPort, addresses: lanAddresses() };
  } catch (e) {
    room = null;
    roomServer = null;
    return { ok: false, error: `开房失败：${(e as Error).message}` };
  }
});
ipcMain.handle('room:close', async () => {
  room?.closeAll();
  room = null;
  if (roomServer) {
    await roomServer.close().catch(() => {});
    roomServer = null;
  }
  // 关房清理队列状态（防残留：下次开房不应继承旧队列/处理标记）
  for (const item of roomQueue) item.reject?.(new Error('房间已关闭'));
  roomQueue = [];
  mainWindow?.webContents.send('room:players', { players: [], notice: '房间已关闭' });
  return { ok: true };
});
ipcMain.handle('room:players', () => ({ players: room?.listPlayers() ?? [] }));

// —— IPC：联机（玩家）——
function wsUrlOf(address: string): string {
  let a = String(address ?? '').trim();
  if (!a) throw new Error('地址不能为空');
  if (!/^wss?:\/\//.test(a)) a = `ws://${a}`;
  return a;
}
ipcMain.handle('room:join', (_e, opts: { address: string; name: string }) => {
  if (roomClient) return Promise.resolve({ ok: false, error: '已在一个房间中' });
  const name = String(opts?.name ?? '').trim().slice(0, 16);
  if (!name) return Promise.resolve({ ok: false, error: '昵称不能为空' });
  let url: string;
  try {
    url = wsUrlOf(opts?.address ?? '');
  } catch (e) {
    return Promise.resolve({ ok: false, error: (e as Error).message });
  }
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      roomClient?.close();
      roomClient = null;
      resolve({ ok: false, error: '连接超时（10 秒），请检查地址与房主是否已开房' });
    }, 10_000);
    try {
      const ws = new WebSocket(url);
      roomClient = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: 'join', name }));
      ws.onmessage = (ev) => {
        let msg: { type: string; [k: string]: unknown };
        try {
          msg = JSON.parse(String(ev.data)) as { type: string; [k: string]: unknown };
        } catch {
          return;
        }
        if (msg.type === 'joined' && !settled) {
          settled = true;
          clearTimeout(timer);
          mainWindow?.webContents.send('room:joined', { id: msg.id, players: msg.players ?? [] });
          resolve({ ok: true, id: String(msg.id ?? ''), players: (msg.players as unknown[]) ?? [] });
        } else {
          mainWindow?.webContents.send('room:msg', msg);
        }
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        roomClient = null;
        resolve({ ok: false, error: '连接失败：请检查地址，或房主未开房/不在同一网络' });
      };
      ws.onclose = () => {
        if (settled) {
          mainWindow?.webContents.send('room:closed', {});
        }
        roomClient = null;
      };
    } catch (e) {
      clearTimeout(timer);
      roomClient = null;
      resolve({ ok: false, error: `连接异常：${(e as Error).message}` });
    }
  });
});
ipcMain.handle('room:send', (_e, text: string) => {
  if (!roomClient) return { ok: false, error: '未加入房间' };
  const t = String(text ?? '').trim();
  if (!t) return { ok: false };
  roomClient.send(JSON.stringify({ type: 'chat', text: t }));
  mainWindow?.webContents.send('room:msg', { type: 'self', text: t }); // 自己的消息立即回显
  return { ok: true };
});
ipcMain.handle('room:leave', () => {
  roomClient?.close();
  roomClient = null;
  mainWindow?.webContents.send('room:closed', {});
  return { ok: true };
});

// 应用退出时清理：关房间 + 断开玩家连接
app.on('will-quit', () => {
  if (managedOllama && !managedOllama.killed) {
    managedOllama.kill();
    managedOllama = null;
  }
  room?.closeAll();
  room = null;
  roomClient?.close();
  roomClient = null;
});

// —— IPC：战役 ——
// 战役 token 估算（对话量提示）：消息字符数近似（1 字 ≈ 1 token，中英统一）；SQLite LENGTH 是字节，中文按 3 字节/字折算
function campaignTokenStats(): Map<string, { msgs: number; chars: number }> {
  const rows = store.db.prepare(`
    SELECT s.campaign_id AS cid, COUNT(m.id) AS msgs,
           COALESCE(SUM(CASE WHEN m.content IS NOT NULL THEN LENGTH(m.content) / 3 ELSE 0 END), 0) AS chars
    FROM sessions s LEFT JOIN messages m ON m.session_id = s.id
    GROUP BY s.campaign_id
  `).all() as { cid: string; msgs: number; chars: number }[];
  return new Map(rows.map((r) => [r.cid, { msgs: r.msgs, chars: Math.round(r.chars) }]));
}
ipcMain.handle('campaign:list', () => {
  const tokens = campaignTokenStats();
  return store.listCampaigns().map(({ id, name, characters, scenarioPackId }) => ({
    id, name, pcCount: characters.length, scenarioPackId,
    msgs: tokens.get(id)?.msgs ?? 0,
    tokens: tokens.get(id)?.chars ?? 0,
  }));
});
// 当前战役精确 token 占用：消息全量字符（JS length，1 字 ≈ 1 token）+ 系统提示基础段估算
ipcMain.handle('campaign:tokens', (_e, id?: string) => {
  const cid = id ?? activeCampaignId;
  if (!cid) return { ok: false, error: '未打开战役' };
  const campaign = store.loadCampaign(cid);
  const char = campaign.characters[0];
  const msgs = store.db.prepare(
    'SELECT content, dice_results_json, role, tool_calls_json, tool_call_id FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE campaign_id = ?) ORDER BY id',
  ).all(cid) as unknown as StoredMessage[];
  // 与实际发送一致：L1 截断窗口（30 轮）后的消息才是每轮真实开销；stored 另报全量存储量
  const windowMsgs = trimHistoryToWindow(msgs);
  const msgChars = windowMsgs.reduce((s, m) => s + (m.content?.length ?? 0) + (m.dice_results_json?.length ?? 0), 0);
  const storedChars = msgs.reduce((s, m) => s + (m.content?.length ?? 0) + (m.dice_results_json?.length ?? 0), 0);
  // 系统提示基础段估算：规则参考 + 角色卡 + 人格 + 红线（不含记忆注入，近似）
  const sysChars = (pack.rules_reference ?? '').slice(0, 1500).length
    + (char ? JSON.stringify(char.attributes).length + JSON.stringify(char.skills).slice(0, 600).length : 0)
    + resolvePersona(cid).length
    + 400; // 红线 + 输出格式等固定段
  return { ok: true, campaignId: cid, messages: msgChars, system: sysChars, total: msgChars + sysChars, msgCount: windowMsgs.length, stored: storedChars };
});
ipcMain.handle('campaign:create', (_e, opts: { name: string; seed?: string; charName?: string; charSpec?: CharacterSpec; derivedOverrides?: Record<string, number>; scenarioPackId?: string; loaded?: boolean; personaId?: string }) => {
  let char: ReturnType<typeof generateCharacter>;
  if (opts.charSpec) {
    // 手动车卡（§11.10 微调）：校验 + 衍生自动算（overrides 保持 UI 重掷的幸运值）
    char = buildCharacter(pack, { ...opts.charSpec, name: opts.charName?.trim() || opts.charSpec.name || '无名调查员' }, opts.seed ?? `ui-${Date.now()}`, opts.derivedOverrides);
  } else {
    char = generateCharacter(pack, { seed: opts.seed ?? `ui-${Date.now()}`, name: opts.charName?.trim() || '无名调查员', loaded: opts.loaded });
  }
  // 剧本包可选（P3a：内置 + 导入包）
  const sc = opts.scenarioPackId ? loadScenarioById(opts.scenarioPackId) : scenario;
  if (!sc) throw new Error(`剧本包不存在: ${opts.scenarioPackId}`);
  const c = store.createCampaign({ name: opts.name, rulePackId: pack.id, scenarioPackId: sc.id, characters: [char], personaId: opts.personaId });
  // 剧本包初始化：世界设定 + NPC/地点/线索种子 + 世界书条目落库（§3.5）
  store.initScenarioWorld(c.id, sc);
  // 玩家位置实体（在场对话/@ 候选依据）：初始在剧本包第一个地点
  const w0 = World.loadFromDb(store.db, c.id);
  w0.addEntity('pc', char.name, { location: sc.locations[0]?.name ?? '未知' });
  w0.saveToDb(store.db, c.id);
  activeCampaignId = c.id;
  return c;
});
ipcMain.handle('campaign:open', (_e, id: string) => {
  activeCampaignId = id;
  return store.loadCampaign(id);
});
ipcMain.handle('campaign:delete', (_e, id: string) => {
  store.deleteCampaign(id);
  if (activeCampaignId === id) { activeCampaignId = null; activeSessionId = null; }
  return { ok: true };
});
ipcMain.handle('campaign:characters', (_e, id: string) => {
  const c = store.loadCampaign(id);
  return c.characters.map((ch) => ({ name: ch.name, occupation: ch.occupation, age: ch.age, attributes: ch.attributes, derived: ch.derived, skills: ch.skills }));
});

// —— IPC：车卡（一键随机/单项重骰：§11.10）——
function summarizeChar(ch: ReturnType<typeof generateCharacter>) {
  const topSkills = Object.entries(ch.skills).sort((a, b) => b[1] - a[1]).slice(0, 6);
  return {
    name: ch.name,
    gender: ch.gender,
    occupation: ch.occupation,
    age: ch.age,
    attributes: ch.attributes,
    derived: ch.derived,
    skills: ch.skills,           // 完整技能（手动编辑预填用）
    topSkills: Object.fromEntries(topSkills),
    seed: ch.created_seed,
  };
}
// 建团前预览（不落库）：前端"重骰"每次换 seed；loaded=灌铅模式（§11.10）
ipcMain.handle('characters:preview', (_e, seed?: string, loaded?: boolean) => {
  const char = generateCharacter(pack, { seed: seed || `preview-${Date.now()}`, loaded: !!loaded });
  return summarizeChar(char);
});
// 替换当前战役的 PC（保留名字，重骰其余）：侧边栏"重骰角色"
ipcMain.handle('characters:reroll', () => {
  if (!activeCampaignId) throw new Error('未打开战役');
  const campaign = store.loadCampaign(activeCampaignId);
  const old = campaign.characters[0];
  const char = generateCharacter(pack, { seed: `reroll-${Date.now()}`, name: old?.name ?? '无名调查员' });
  store.replaceCharacter(activeCampaignId, char);
  return summarizeChar(char);
});
// 手填车卡数据（§11.10 微调）：规则包字段 + 内置 CoC 说明
ipcMain.handle('characters:fields', () => ({
  attributes: pack.character_sheet.attributes.map((name) => ({ name, desc: COC_ATTRIBUTE_DESC[name] ?? GENERIC_DESC })),
  skills: pack.character_sheet.skills.map((s) => ({ name: s.name, base: s.base, desc: COC_SKILL_DESC[s.name] ?? GENERIC_DESC })),
  derived: pack.character_sheet.derived.map((name) => ({ name, desc: COC_DERIVED_DESC[name] ?? GENERIC_DESC })),
  occupations: (pack.chargen?.occupations ?? []).map((o) => o.name),
}));
// 手填后实时算衍生（不落库；幸运含随机，可重掷）
ipcMain.handle('characters:derive', (_e, spec: { attributes: Record<string, number>; age?: number }, seed?: string) => {
  const attributes = { ...(spec.attributes ?? {}) };
  for (const k of pack.character_sheet.attributes) {
    if (!Number.isInteger(attributes[k])) attributes[k] = Math.max(1, Math.min(99, Math.round(Number(attributes[k]) || 40)));
  }
  return computeDerived(pack, attributes, seed ?? `derive-${Date.now()}`, spec.age ?? 25);
});
// 保存手动编辑的角色卡（校验 + 衍生 + 替换当前战役 PC；overrides 保持 UI 重掷的幸运值）
ipcMain.handle('characters:update', (_e, spec: CharacterSpec, derivedOverrides?: Record<string, number>) => {
  if (!activeCampaignId) throw new Error('未打开战役');
  const char = buildCharacter(pack, spec, `edit-${Date.now()}`, derivedOverrides);
  store.replaceCharacter(activeCampaignId, char);
  return summarizeChar(char);
});

// —— IPC：会话 ——
ipcMain.handle('session:start', () => {
  if (!activeCampaignId) throw new Error('未打开战役');
  const s = store.startSession(activeCampaignId);
  activeSessionId = s.id;
  return s;
});
ipcMain.handle('session:list', () => (activeCampaignId ? store.listSessions(activeCampaignId) : []));
ipcMain.handle('session:open', (_e, id: string) => {
  if (!activeCampaignId) throw new Error('未打开战役');
  activeSessionId = id;
  return store.loadSession(activeCampaignId, id);
});
// 结束本节：生成 L2 摘要（全量重生成，§11.4）并落库；AI 不可用时降级规则摘要
ipcMain.handle('session:end', async () => {
  if (!activeCampaignId || !activeSessionId) throw new Error('没有进行中的会话');
  const msgs = store.getMessages(activeCampaignId, activeSessionId);
  const campaign = store.loadCampaign(activeCampaignId);
  const summary = await generateSessionSummary(provider, msgs, campaign.name);
  const s = store.endSession(activeCampaignId, activeSessionId, summary);
  activeSessionId = null;
  return { session: s, summary };
});

// —— IPC：实体候选（@ 唤起，§11.6：L3 按 importance + 最近活跃排序，前 8）——
ipcMain.handle('entities:suggest', (_e, query: string) => {
  if (!activeCampaignId) return [];
  const cid = activeCampaignId;
  const q = String(query ?? '').trim();
  // 轻量查询（@ 每击键触发一次，避免 World.loadFromDb 全量加载五张表）：
  // 只读 entities 表 + high 重要度事实的实体引用集合
  const es = store.db.prepare(
    'SELECT id, type, name, aliases_json, data_json, updated_at FROM entities WHERE campaign_id = ?',
  ).all(cid) as { id: string; type: string; name: string; aliases_json: string | null; data_json: string; updated_at: string }[];
  const highRefs = new Set<string>();
  for (const f of store.db.prepare(
    "SELECT entity_refs_json FROM memory_facts WHERE campaign_id = ? AND importance = 'high'",
  ).all(cid) as { entity_refs_json: string | null }[]) {
    for (const ref of JSON.parse(f.entity_refs_json ?? '[]') as string[]) highRefs.add(ref);
  }
  const candidates = es
    .filter((e) => !['pc', 'world', 'plot', 'encounter'].includes(e.type))
    .filter((e) => {
      // 地点（location）照常列出；NPC 只列玩家见过的（met:true）且未死亡
      if (e.type !== 'npc') return true;
      const d = JSON.parse(e.data_json || '{}') as Record<string, unknown>;
      return d.met === true && d.alive !== false;
    })
    .filter((e) => {
      if (!q) return true;
      if (e.name.includes(q)) return true;
      const aliases = e.aliases_json ? (JSON.parse(e.aliases_json) as string[]) : [];
      return aliases.some((a) => a.includes(q));
    })
    .map((e) => {
      const d = JSON.parse(e.data_json || '{}') as Record<string, unknown>;
      return {
        id: e.id,
        name: e.name,
        type: e.type,
        location: d.location as string | undefined,
        importance: highRefs.has(e.id) ? 'high' : 'normal',
        updated_at: e.updated_at,
      };
    })
    // 排序：NPC 优先（引用人物场景最多）→ 重要度 → 最近活跃
    .sort((a, b) => {
      const rank = (t: string) => (t === 'npc' ? 0 : 1);
      return rank(a.type) - rank(b.type)
        || (a.importance === 'high' ? -1 : 1) - (b.importance === 'high' ? -1 : 1)
        || b.updated_at.localeCompare(a.updated_at);
    })
    .slice(0, 8);
  return candidates;
});

// —— IPC：场景面板（人物/地点两个分类按钮，点开展开列表）——
// persons = 玩家见过的 NPC（met:true 未死亡），在场优先；places = 全部地点（当前所在地标注）
ipcMain.handle('scene:bar', (_e, _id?: string) => {
  if (!activeCampaignId) return { persons: [], places: [], here: '' };
  const world = World.loadFromDb(store.db, activeCampaignId);
  const pc = [...world.entities.values()].find((e) => e.type === 'pc');
  const here = (pc?.data as Record<string, unknown> | undefined)?.location as string | undefined ?? '';
  const persons = [...world.entities.values()]
    .filter((e) => e.type === 'npc')
    .map((e) => {
      const d = e.data as Record<string, unknown>;
      return { id: e.id, name: e.name, here: d.location === here, alive: d.alive !== false, met: d.met === true };
    })
    .filter((p) => p.alive && p.met)
    .sort((a, b) => (a.here === b.here ? a.name.localeCompare(b.name) : a.here ? -1 : 1));
  const places = [...world.entities.values()]
    .filter((e) => e.type === 'location')
    .map((e) => ({ id: e.id, name: e.name, here: e.name === here }))
    .sort((a, b) => (a.here === b.here ? a.name.localeCompare(b.name) : a.here ? -1 : 1));
  return { persons, places, here };
});

// —— IPC：检定（判定本地化：UI 直接触发，结果进审计）——
ipcMain.handle('check:skill', (_e, args: { skill: string; mode?: 'normal' | 'reward' | 'penalty' }) => {
  if (!activeCampaignId) throw new Error('未打开战役');
  const campaign = store.loadCampaign(activeCampaignId);
  const char = campaign.characters[0];
  if (!char) throw new Error('战役无角色');
  const value = char.skills[args.skill] ?? char.attributes[args.skill];
  if (value === undefined) throw new Error(`未知技能: ${args.skill}`);
  const a = adjudicate({ rulePack: pack, skill: args.skill, value, mode: args.mode ?? 'normal', seed: `ui-${Date.now()}` });
  const world = World.loadFromDb(store.db, activeCampaignId);
  world.addDice('d100', a.takenRoll, a.diceRolls, `${args.skill}（${a.label}）`, 'player', `ui-${Date.now()}`);
  world.saveToDb(store.db, activeCampaignId);
  return { ...a, value };
});

// 玩家回合主链路（chat:send 与 check:withChat 共用）：落库 → 记忆/lore 组装 → 流式 AI 叙事 → 兜底 → 摘要触发
// action：玩家可见文本（落库/恢复历史/提及检测用）；aiAction：AI 指令（默认=action；检定场景分离，避免内部指令泄漏给玩家）
async function runPlayerTurn(action: string, aiAction?: string, source?: string): Promise<PlayerTurnResult> {
  if (!activeCampaignId) throw new Error('还没有当前战役：请先在左侧「新建战役」或选择一个已有战役');
  if (!activeSessionId) throw new Error('还没有当前会话：请先选择/新建战役，系统会自动开始会话');
  const campaign = store.loadCampaign(activeCampaignId);
  const char = campaign.characters[0];
  const world = World.loadFromDb(store.db, activeCampaignId);
  // L1 上下文窗口截断（§3.3：AI 每轮只带最近 30 轮完整对话，更早历史由 L2 摘要压缩；
  // 消息表全量保留，恢复历史/审计不受影响；每次中途摘要（40 条触发）已覆盖被截断的最旧部分）
  const history = toChatMessages(trimHistoryToWindow(store.getMessages(activeCampaignId, activeSessionId)));

  // 玩家行动先落库（玩家可见文本；联机玩家消息带 [昵称] 来源，AI 上下文可区分发言人）
  const userContent = source ? `[${source}] ${action}` : action;
  store.appendMessage(activeCampaignId, activeSessionId, { role: 'user', content: userContent });

  const msgs = store.getMessages(activeCampaignId, activeSessionId);

  // 世界书命中检测（方案 §3.5：蓝灯常驻 + 绿灯近期 + 黄灯全史；窗口 [PLACEHOLDER 10 条]）
  let loreHits: ReturnType<typeof matchLore> = [];
  if (campaign.scenarioPackId) {
    const entries = store.getLoreEntries(campaign.scenarioPackId);
    loreHits = matchLore(entries, {
      recentText: recentTextOf(msgs, 10),
      allText: msgs.map((m) => m.content).join('\n'),
    });
  }

  // 记忆注入（P1）：@ 唤起 + 本地提及检测（最近 5 轮）+ 活跃线索 + 关联事实 + 上一节 CHRONICLE 摘要
  const focusMatch = /@([\u4e00-\u9fa5A-Za-z0-9·\-]{1,12})/.exec(action);
  const sessions = store.listSessions(activeCampaignId);
  const prevEnded = sessions.find((s) => s.id !== activeSessionId && s.summary) ?? sessions.find((s) => s.summary);
  const memoryCtx = buildMemoryContext({
    world,
    recentText: recentTextOf(msgs, 5),
    allText: msgs.map((m) => m.content).join('\n'),
    focusQuery: focusMatch ? focusMatch[1] : undefined,
    summary: prevEnded?.summary,
  });
  const memory = renderMemoryBlock(memoryCtx);

  // 见过标记（@ 候选依据）：本地提及检测命中的未见过 NPC → 自动"相识"（提到名字即知道此人）
  // 纯引擎兜底，不依赖 AI 标记；与 AI 相遇标记（prompt 红线）互补
  let metMarked = false;
  for (const e of memoryCtx.mentioned) {
    if (e.type !== 'npc') continue;
    const d = e.data as Record<string, unknown>;
    if (d.met !== true) {
      world.updateEntity(e.id, { met: true });
      metMarked = true;
    }
  }

  // 移动意图本地识别（判定本地化同源：移动也本地，AI 只写叙事）：
  // 玩家输入含"去/前往/离开/回 + 地点名" → 引擎直接更新 pc location（审计落库），
  // 并把"已切换场景"作为事实告知 AI（追加到 aiAction，玩家不可见，不污染历史）
  let moveNote = '';
  const moveTarget = parseMoveIntent(aiAction ?? action, world);
  if (moveTarget) {
    const pc = [...world.entities.values()].find((e) => e.type === 'pc');
    if (pc) {
      const from = (pc.data as Record<string, unknown>).location as string | undefined;
      if (from !== moveTarget.name) {
        world.updateEntity(pc.id, { location: moveTarget.name }, 'player');
        moveNote = `\n\n（场景切换，已由本地引擎裁定：玩家离开${from ?? '原地'}，抵达「${moveTarget.name}」。请以新场景展开叙事：描写抵达过程、环境与在场的人，不要再接旧场景的对话。）`;
      }
    }
  }

  const toolCtx: ToolContext = { pack, character: char, world, seed: `chat-${Date.now()}`, extraFields: char ? characterFields(char) : {} };
  // 张力仪表（§11.7 戏剧引擎）：本地数值 + 玩家滑杆 → prompt 红线注入
  // 最近玩家检定的失败次数（本地审计统计，不依赖 AI；reason 形如 "侦查（普通成功）"）
  const recentChecks = world.diceLog.filter((d) => d.requested_by === 'player').slice(-8);
  const recentFails = recentChecks.filter((d) => /失败/.test(d.reason)).length;
  const tensionCtx = computeTension(loadSettings().tension ?? { ...DEFAULT_TENSION }, {
    hasCountdown: hasCountdownPlot(world),
    recentCheckFails: recentFails,
  });
  const tensionBlock = buildTensionPrompt(tensionCtx);
  let narrative: string;
  let diceResults: string[];
  let issues: { kind: string; message: string }[] = [];
  let promptPlayer: string | null = null;
  try {
    // 流式：剥离 JSON 外壳后增量推送叙事片段（UI 逐字显示）
    let streamAcc = '';
    let streamShown = 0;
    const out = await runChat(`${aiAction ?? action}${moveNote}`, history, {
      provider,
      toolCtx,
      systemPrompt: buildSystemPrompt({ pack, character: char, world, persona: resolvePersona(activeCampaignId), loreHits, memory, tension: tensionBlock }),
      onDelta: (t) => {
        streamAcc += t;
        const shown = extractNarrativePrefix(streamAcc);
        if (shown.length > streamShown) {
          mainWindow?.webContents.send('chat:chunk', shown.slice(streamShown));
          streamShown = shown.length;
        }
      },
    });
    narrative = out.narrative;
    diceResults = out.diceResults;
    issues = out.issues;
    promptPlayer = out.promptPlayer;
  } catch (e) {
    // AI 不可用（未配 key / 网络错）→ 离线兜底：本地叙事（不透传英文报错，日志保留原文）
    const raw = (e as Error).message;
    console.error('[DiceKeeper] AI 调用失败:', raw);
    narrative = fallbackNarrative(action, provider, raw);
    diceResults = [];
    issues = [];
  }
  store.appendMessage(activeCampaignId, activeSessionId, { role: 'assistant', content: narrative, diceResults });
  world.saveToDb(store.db, activeCampaignId);
  const assistantMsg = store.getMessages(activeCampaignId, activeSessionId).at(-1);

  // 中途增量摘要（§11.4：超长 session 中途触发，不阻塞回复；结束才全量重生成）
  if (msgs.length >= 40 && msgs.length % 40 === 0) {
    generateSessionSummary(provider, msgs, campaign.name).then((summary) => {
      try {
        store.db.prepare('UPDATE sessions SET summary = ? WHERE id = ?').run(summary, activeSessionId);
      } catch { /* 会话可能已结束 */ }
    }).catch(() => {});
  }

  // L3 兜底事实提取（§3.3/§11.4：每 5 轮异步增量，不阻塞回复；离线/失败静默）
  if (msgs.length >= 5 && msgs.length % 5 === 0 && !(provider instanceof MockProvider)) {
    extractFactsIncrementally(provider, msgs, world).then((added) => {
      if (added > 0) {
        console.log(`[DiceKeeper] 兜底事实提取: 新增 ${added} 条`);
        try {
          const w = World.loadFromDb(store.db, activeCampaignId);
          w.saveToDb(store.db, activeCampaignId);
        } catch { /* 战役可能已切换 */ }
      }
    }).catch(() => {});
    // NPC 幕后推演（世界活着：每 5 轮推演 NPC 移动/状态；与在场对话联动）
    simulateNpcActions(provider, world, msgs, campaign.name).then((n) => {
      if (n > 0) {
        console.log(`[DiceKeeper] NPC 幕后推演: ${n} 个 NPC 行动已落库`);
        try {
          const w = World.loadFromDb(store.db, activeCampaignId);
          w.saveToDb(store.db, activeCampaignId);
        } catch { /* 战役可能已切换 */ }
      }
    }).catch(() => {});
  }

  return { narrative, diceResults, issues, messageId: assistantMsg?.id, promptPlayer };
}

// 离线兜底叙事：检定场景给出基于结果的本地剧情推进（避免"未配置 AI 服务"误导成功能失效）
function fallbackNarrative(action: string, provider: Provider, raw: string): string {
  if (!(provider instanceof MockProvider)) {
    return `（守密人暂时无法响应：AI 服务出错。${raw}）\n你感到海雾裹住了整座酒馆，只能听见自己的心跳。`;
  }
  const m = /【检定】(.+?)：(.+?)（骰面 (\d+)/.exec(action);
  if (m) {
    const skill = m[1];
    const label = m[2];
    const roll = m[3];
    const success = label.includes('成功');
    const desc = (s: string) => {
      const map: Record<string, string> = { 侦查: '俯身细看周围', 聆听: '侧耳倾听', 话术: '试着套话', 潜行: '压低身形', 心理学: '观察对方神情', 图书馆使用: '翻查资料', 医学: '检查伤势', 急救: '处理伤口' };
      return map[s] ?? `尝试${s}`;
    };
    return success
      ? `你${desc(skill)}，${label}（骰面 ${roll}）。\n\n（离线模式：本地判定已生效。配置 AI 服务后，守密人会基于这个结果展开完整剧情。）`
      : `你${desc(skill)}，${label}（骰面 ${roll}），一无所获，空气中只剩下凝滞的寂静。\n\n（离线模式：本地判定已生效。配置 AI 服务后，守密人会基于这个结果展开完整剧情。）`;
  }
  return '（离线模式）守密人暂时无法响应：未配置 AI 服务。请点击左下角「设置」，填写接口地址与 API 密钥。\n你感到海雾裹住了整座酒馆，只能听见自己的心跳。';
}

// —— IPC：对话（AI 网关全链路）——
// 房主开房时：房主消息也进串行队列（与玩家消息统一，防并发写库）；单机照旧直走
ipcMain.handle('chat:send', (_e, action: string) =>
  room ? enqueueRoomTurn({ text: String(action ?? '') }) : runPlayerTurn(String(action ?? '')));

// 检定接剧情（方案 §5 会话流程：本地判定 → 结果附进请求 → AI 基于结果叙事）：
// 本地执行检定（审计）→ 推送 chat:check 供 UI 立即显示 → AI 继续剧情（流式）
ipcMain.handle('check:withChat', async (_e, skill: string) => {
  if (!activeCampaignId) throw new Error('还没有当前战役：请先在左侧「新建战役」或选择一个已有战役');
  if (!activeSessionId) throw new Error('还没有当前会话：请先选择/新建战役，系统会自动开始会话');
  const campaign = store.loadCampaign(activeCampaignId);
  const char = campaign.characters[0];
  if (!char) throw new Error('战役无角色');
  const value = char.skills[skill] ?? char.attributes[skill];
  if (value === undefined) throw new Error(`未知技能: ${skill}`);

  // ① 本地检定（判定本地化铁律：结果由引擎产生，AI 只基于结果叙事）
  const a = adjudicate({ rulePack: pack, skill, value, seed: `check-${Date.now()}` });
  const world = World.loadFromDb(store.db, activeCampaignId);
  const rec = world.addDice('d100', a.takenRoll, a.diceRolls, `${skill}（${a.label}）`, 'player', `check-${Date.now()}`);
  world.saveToDb(store.db, activeCampaignId);
  const checkInfo = { skill, value, ...a };

  // ② 推送检定结果（UI 立即显示骰面）
  mainWindow?.webContents.send('chat:check', { skill, value, label: a.label, detail: a.detail, takenRoll: a.takenRoll });

  // ③ 检定作为玩家行动进入对话流，AI 基于结果继续叙事
  // 落库用玩家可见文本（恢复历史/提及检测干净）；AI 指令带真实记录 ID（防 AI 编造 ID）
  const playerAction = `🎲 玩家检定「${skill}」：${a.label}（骰面 ${a.takenRoll}）`;
  const aiAction = `玩家主动进行了一次检定，结果由本地引擎判定完毕：
【检定】${skill}：${a.label}（骰面 ${a.takenRoll}，技能值 ${value}）。掷骰记录ID: ${rec.id}
${a.detail}

你（守密人）不需要复述检定过程或数值，直接描写检定结果带来的剧情发展：成功则推进事件/揭示线索，失败则描写代价、意外或悬而未决的后果。
输出 JSON 时 dice_results 必须引用上面的记录ID（["${rec.id}"]），不要自己编造。`;
  const out = await runPlayerTurn(playerAction, aiAction);

  // ④ 宽容清洗：AI 若未按指令引用真实 ID 而编造（如 "格斗-40-普通成功"），
  // 替换为本回合真实玩家检定记录 ID（防伪不破：替换目标必须是审计中真实存在的记录）
  const badRefs = out.issues.filter((i) => i.kind === 'bad_roll_ref');
  if (badRefs.length > 0 && out.diceResults.length > 0) {
    const w2 = World.loadFromDb(store.db, activeCampaignId);
    const realIds = new Set(w2.diceLog.map((d) => d.id));
    const playerRec = w2.diceLog.filter((d) => d.requested_by === 'player').at(-1);
    if (playerRec) {
      const fixed = out.diceResults.map((id) => (realIds.has(id) ? id : playerRec.id));
      const realOnly = fixed.filter((id) => realIds.has(id));
      // 更新返回与落库消息（保持一致）
      out.diceResults = realOnly;
      out.issues = out.issues.filter((i) => i.kind !== 'bad_roll_ref');
      if (out.messageId !== undefined) {
        store.db.prepare('UPDATE messages SET dice_results_json = ? WHERE id = ?')
          .run(JSON.stringify(realOnly), out.messageId);
      }
      console.log(`[DiceKeeper] 检定记录ID清洗: AI 编造引用 ${badRefs.map((i) => i.message).join('; ')} → 已替换为真实记录`);
    }
  }
  return { check: checkInfo, ...out };
});

// —— IPC：剧本包 ——
ipcMain.handle('scenario:info', () => ({
  id: scenario.id,
  name: scenario.name,
  hooks: scenario.hooks,
}));
ipcMain.handle('scenario:list', () => listScenarioPacks());

// —— IPC：内容包（P3a，§3.7 Foundry 范式）——
ipcMain.handle('packs:list', () => ({ rulePacks: listRulePacks(), scenarioPacks: listScenarioPacks() }));
ipcMain.handle('packs:import', async () => {
  const r = await dialog.showOpenDialog(mainWindow ?? undefined as never, {
    title: '导入 DiceKeeper 内容包（.dk）',
    filters: [{ name: 'DiceKeeper 内容包', extensions: ['dk', 'yaml', 'yml'] }],
    properties: ['openFile'],
  });
  if (r.canceled || r.filePaths.length === 0) return { ok: false, canceled: true };
  try {
    const content = readFileSync(r.filePaths[0], 'utf-8');
    return importPackContent(content);
  } catch (e) {
    return { ok: false, error: `读取文件失败: ${(e as Error).message}` };
  }
});
// 纯内容导入（测试/E2E 用；UI 走 packs:import 弹窗）。force：冲突覆盖；newId：换名导入
ipcMain.handle('packs:importText', (_e, req: string | { content: string; force?: boolean; newId?: string }) => {
  if (typeof req === 'string') return importPackContent(req); // 兼容旧调用（E2E）
  return importPackContent(req?.content ?? '', { force: !!req?.force, newId: req?.newId?.trim() || undefined });
});
ipcMain.handle('packs:export', async (_e, type: 'rule' | 'scenario', id: string) => {
  const body = packBody(type, id);
  if (!body) throw new Error(`内容包不存在: ${type}/${id}`);
  const r = await dialog.showSaveDialog(mainWindow ?? undefined as never, {
    title: '导出内容包',
    defaultPath: `${id}.dk`,
    filters: [{ name: 'DiceKeeper 内容包', extensions: ['dk'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  writeFileSync(r.filePath, dkContent(type, body), 'utf-8');
  return { ok: true, path: r.filePath };
});
ipcMain.handle('packs:delete', (_e, type: 'rule' | 'scenario', id: string) => {
  if (type === 'scenario' && id === scenario.id) throw new Error('内置剧本包不可删除');
  if (type === 'rule' && id === pack.id) throw new Error('内置规则包不可删除');
  packStore.remove(type, id);
  return { ok: true };
});

// —— IPC：内容编辑器（P3b：可视化编辑规则包/剧本包）——
function packMetaById(type: 'rule' | 'scenario', id: string): PackMeta | null {
  return (type === 'rule' ? listRulePacks() : listScenarioPacks()).find((m) => m.id === id) ?? null;
}
// 新建内容包：生成合法最小模板 → 校验 → 落盘 → 返回 meta（前端拿到后打开编辑器）
ipcMain.handle('editor:create', (_e, req: { type?: 'rule' | 'scenario'; name?: string }) => {
  const type: 'rule' | 'scenario' = req?.type === 'scenario' ? 'scenario' : 'rule';
  const rawName = String(req?.name ?? '').trim().slice(0, 20);
  const name = rawName || (type === 'rule' ? '新规则包' : '新剧本包');
  const id = genPackId(type);
  try {
    const obj = buildNewPackTemplate(type, name, id);
    const body = serializePackObject(type, obj as never);
    const res = validatePackContent(dkContent(type, body), listRulePacks().map((m) => m.id));
    if (!res.ok || !res.meta) return { ok: false, error: res.error ?? '模板校验失败' };
    packStore.save(type, res.meta, body);
    return { ok: true, meta: res.meta };
  } catch (e) {
    return { ok: false, error: `创建失败：${(e as Error).message}` };
  }
});
// 打开编辑器：返回解析后的对象（表单用）+ 序列化 YAML（源码视图用）
ipcMain.handle('editor:open', (_e, type: 'rule' | 'scenario', id: string) => {
  const meta = packMetaById(type, id);
  if (!meta) return { ok: false, error: `内容包不存在: ${type}/${id}` };
  const body = packBody(type, id);
  if (!body) return { ok: false, error: '内容包读取失败' };
  try {
    const obj = parsePackObject(type, body);
    return { ok: true, meta, isBuiltin: meta.isBuiltin, obj, yaml: serializePackObject(type, obj) };
  } catch (e) {
    return { ok: false, error: `解析失败: ${(e as Error).message}` };
  }
});
// 保存：校验 → 序列化 → 落盘（内置包另存副本，见 savePackObject）
ipcMain.handle('editor:save', (_e, req: { type: 'rule' | 'scenario'; id: string; isBuiltin: boolean; obj: unknown }) => {
  if (!req || !req.obj) return { ok: false, error: '缺少编辑对象' };
  return savePackObject({ type: req.type, id: req.id, isBuiltin: !!req.isBuiltin, obj: req.obj as never, store: packStore });
});
// 试跑：规则包检定模拟（判定本地化同款引擎，改完立即生效）
ipcMain.handle('editor:testCheck', (_e, req: { obj: unknown; skill: string; value: number; mode?: string }) => {
  if (!req?.obj) return { ok: false, error: '缺少规则包对象' };
  const mode = req.mode === 'reward' || req.mode === 'penalty' ? req.mode : 'normal';
  return testPackCheck(req.obj as never, String(req.skill ?? '侦查'), Number(req.value) || 50, mode);
});
// 试跑：成功率分布（§11.3：N 次档位统计，供调 check_rules）
ipcMain.handle('editor:testDist', (_e, req: { obj: unknown; skill: string; value: number; mode?: string; trials?: number }) => {
  if (!req?.obj) return { ok: false, error: '缺少规则包对象' };
  const mode = req.mode === 'reward' || req.mode === 'penalty' ? req.mode : 'normal';
  const trials = Math.min(5000, Math.max(100, Number(req.trials) || 1000));
  return testPackDistribution(req.obj as never, String(req.skill ?? '侦查'), Number(req.value) || 50, mode, trials);
});
// 试跑：剧本包世界书命中模拟（蓝/绿/黄 + priority + 预算截断）
ipcMain.handle('editor:testLore', (_e, req: { obj: unknown; text: string; budget?: number }) => {
  if (!req?.obj) return { ok: false, error: '缺少剧本包对象' };
  return testPackLore(req.obj as never, String(req.text ?? ''), Number(req.budget) || 3000);
});
// AI 帮助生成内容（§11.8）：target 细分为整包/单点；产出草稿（UI 人工确认后应用）
// 剧本包 target: pack | npc | location | world | lore | encounter | hooks
// 规则包 target: rule-pack（整包骨架）
function extractYaml(text: string): string {
  // 优先取代码块（yaml/yml/json 标记均可；可能有多个，取最长——AI 偶尔重复输出）
  const blocks = [...text.matchAll(/```(?:yaml|yml|json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  if (blocks.length > 0) return blocks.reduce((a, b) => (b.length > a.length ? b : a));
  // 无代码块：找 YAML 顶层字段起点（id 优先，单点生成找具体字段）
  for (const key of ['id:', 'npc_seeds:', 'locations:', 'world:', 'lore_entries:', 'encounters:', 'hooks:', 'character_sheet:', 'check_rules:']) {
    const i = text.indexOf(key);
    if (i >= 0) return text.slice(i);
  }
  // 可能是 JSON 混在文字里：找第一个 {（交给 parseAiOutput 做 JSON 定位与尾部截断）
  const b = text.indexOf('{');
  if (b >= 0) return text.slice(b);
  return text;
}
const AI_TARGET_FIELD: Record<string, string> = {
  npc: 'npc_seeds',
  location: 'locations',
  lore: 'lore_entries',
  encounter: 'encounters',
  hooks: 'hooks',
  world: 'world',
};
// 规则包摘要注入：AI 按规则包生成剧本包时，把所选规则包的属性/技能/检定体系塞进 prompt
function describeRulePackForPrompt(rulePackId: string): { ok: boolean; requiresId?: string; text?: string } {
  let rulePack: RulePack | null = null;
  try {
    if (rulePackId === pack.id) rulePack = pack;
    else rulePack = loadImportedRulePack(packStore, rulePackId);
  } catch {
    rulePack = null;
  }
  if (!rulePack) return { ok: false };
  return { ok: true, requiresId: rulePack.id, text: summarizeRulePackForPrompt(rulePack) };
}
const AI_GEN_TARGET_SYSTEMS: Record<string, string> = {
  pack: `你是资深 TRPG 剧本设计者。根据主题生成一个 DiceKeeper 剧本包（只输出纯 YAML，不要任何解释）。
结构必须完整：
id: 英文小写下划线
name: 中文名称
version: "1.0"
requires: coc7e
world: {summary, cosmology, factions: [{name, stance}]}
npc_seeds: 4-6 个 [{name, aliases, traits, secrets, relation_hint}]
locations: 4-6 个 [{name, aliases, state, secrets}]
plot_threads: 3-4 个 [{id, name, status: open, branches: [..]}]
encounters: 3-5 个 [{name, type: social|combat|exploration, skill, note}]
hooks: 2-3 条叙事开场白
lore_entries: 8-12 条 [{id, key_terms: [3-5 个关键词], activation: blue|green|yellow, content, priority}]
格式约束：缩进两空格；list 项用 "key: value" 展开；多行文本用 | 块标量或单行；全中文内容。`,
  'scenario-from-rule': `你是资深 TRPG 剧本设计者。根据【依赖规则包】与主题，生成一个 DiceKeeper 剧本包（只输出纯 YAML，不要任何解释）。
剧本必须贴合依赖规则包的属性/技能/检定体系：NPC 秘密、地点线索、遭遇的 skill、世界书里的行动建议，一律使用该规则包的技能名与属性，不要自造技能。
结构必须完整：
id: 英文小写下划线
name: 中文名称
version: "1.0"
requires: <依赖规则包的 id>
world: {summary, cosmology, factions: [{name, stance}]}
npc_seeds: 4-6 个 [{name, aliases, traits, secrets, relation_hint}]
locations: 4-6 个 [{name, aliases, state, secrets}]
plot_threads: 3-4 个 [{id, name, status: open, branches: [..]}]
encounters: 3-5 个 [{name, type: social|combat|exploration, skill: <规则包技能名>, note}]
hooks: 2-3 条叙事开场白
lore_entries: 8-12 条 [{id, key_terms: [3-5 个关键词], activation: blue|green|yellow, content, priority}]
格式约束：缩进两空格；全中文内容。`,
  adjust: `你是资深 TRPG 剧本设计者。下面是用户已有的剧本/规则包 YAML 草稿，根据用户的修改意见修改它。
要求：
- 只输出修改后的完整纯 YAML，不要任何解释、不要 JSON 外壳、不要省略字段
- 保持结构完整合法（id/name/version 等字段保留）
- 修改意见没涉及的部分尽量保持原样
- 新增内容用中文`,
  npc: `你是 TRPG 剧本设计者。根据给定设定生成 npc_seeds 列表（4-6 个 NPC，只输出 YAML，带顶层 npc_seeds:）。
每项格式：
npc_seeds:
  - name: 中文名
    aliases: [别称1, 别称2]
    traits: 性格与外貌（2-3 句）
    secrets: 隐藏秘密（与主题相关）
    relation_hint: 与主线/其他角色的关联
格式约束：缩进两空格；全中文；不要输出解释文字。`,
  location: `你是 TRPG 剧本设计者。根据给定设定生成 locations 列表（4-6 个地点，只输出 YAML，带顶层 locations:）。
每项格式：
locations:
  - name: 地点名
    aliases: [别称]
    state: 当前状态
    secrets: 隐藏的秘密/线索
格式约束：缩进两空格；全中文；不要输出解释文字。`,
  world: `你是 TRPG 剧本设计者。根据给定设定生成 world 世界观（只输出 YAML，带顶层 world:）。
格式：
world:
  summary: 世界观总览（3-5 句，用 | 块标量）
  cosmology: 宇宙观/神秘设定（2-4 句，用 | 块标量）
  factions:
    - name: 势力名
      stance: 立场与行为描述
格式约束：缩进两空格；全中文；不要输出解释文字。`,
  lore: `你是 TRPG 剧本设计者。根据给定设定生成世界书条目 lore_entries（8-12 条，只输出 YAML，带顶层 lore_entries:）。
每项格式：
lore_entries:
  - id: 英文小写id
    key_terms: [触发关键词1, 关键词2, 关键词3]
    activation: blue | green | yellow
    content: 注入内容（2-3 句）
    priority: 0-10 整数
激活策略：blue=常驻注入（世界观核心）；green=关键词出现在近期对话时注入（NPC/地点资料）；yellow=关键词出现在整场历史时注入（罕见事件）。
格式约束：缩进两空格；全中文；不要输出解释文字。`,
  encounter: `你是 TRPG 剧本设计者。根据给定设定生成遭遇模板 encounters（3-5 个，只输出 YAML，带顶层 encounters:）。
每项格式：
encounters:
  - name: 遭遇名
    type: social | combat | exploration
    skill: 建议检定技能
    note: 遭遇要点
格式约束：缩进两空格；全中文；不要输出解释文字。`,
  hooks: `你是 TRPG 剧本设计者。根据给定设定生成叙事开场白 hooks（2-3 条，只输出 YAML，带顶层 hooks:）。
格式：
hooks:
  - 第一条开场白（第一人称/第二人称混合，营造氛围并引导行动）
格式约束：每条一句到两句话，全中文；不要输出解释文字。`,
  'rule-pack': `你是 TRPG 规则设计者。根据需求生成一个 DiceKeeper 规则包（只输出纯 YAML，不要任何解释）。
结构：
id: 英文小写下划线
name: 中文名称
version: "1.0"
dice_schema: d100 或 d20
character_sheet:
  attributes: [4-8 个中文属性名，禁止空数组、禁止省略]
  derived: [衍生值1, ...]
  skills:
    - {name: 技能名, base: 初始值, category: 分类}
check_rules:
  extreme: "DSL 表达式（如 d100 <= fifth(SKILL)）"
  hard: "d100 <= half(SKILL)"
  normal: "d100 <= SKILL"
  crit_fail: "d100 >= 96"
chargen:
  attribute_methods:
    - {name: 属性生成法, formula: "3d6*5", fields: [属性1, ...]}
  derived_formulas:
    衍生名: "公式（如 (SIZ+CON)/10）"
  occupations:
    - {name: 职业名, skills: [技能1, 技能2], points: "点数公式（如 EDU*2+INT*2）"}
rules_reference: 规则文本（裁决时注入，用 | 块标量）
DSL 可用函数：floor/half/fifth/advantage/disadvantage/successes/min/max；骰子 d100/2d6 等；字段引用 SKILL 或属性名。
格式约束：缩进两空格；list 项展开；全中文（技能/属性/职业名用中文）。`,
};
ipcMain.handle('editor:aiGenerate', async (_e, req: { type?: string; prompt?: string; target?: string; rulePackId?: string; prevDraft?: string }) => {
  if (provider instanceof MockProvider) return { ok: false, error: '未配置 AI 服务：请先在「设置」填写接口地址与 API 密钥' };
  const type = req?.type === 'rule' ? 'rule' : 'scenario';
  const target = String(req?.target ?? 'pack');
  if (target === 'pack' && type === 'rule') return { ok: false, error: '规则包请用「整包生成」' };
  // 按规则包生成剧本包：先解析所选规则包摘要，注入 prompt；requires 锁定该包
  let ruleNote = '';
  let requiresId: string | undefined;
  if (target === 'scenario-from-rule') {
    const d = describeRulePackForPrompt(String(req?.rulePackId ?? ''));
    if (!d.ok) return { ok: false, error: '请先选择要依据的规则包（或该规则包已被删除）' };
    ruleNote = d.text ?? '';
    requiresId = d.requiresId;
  }
  const system = AI_GEN_TARGET_SYSTEMS[target] ?? AI_GEN_TARGET_SYSTEMS.pack;
  try {
    const userParts = [
      ruleNote || null,
      `主题/需求：${String(req?.prompt ?? '克苏鲁风格悬疑剧本')}`,
      target === 'adjust' && req?.prevDraft ? `现有草稿：\n${req.prevDraft}` : null,
    ].filter(Boolean).join('\n\n');
    // AI 输出不可控：清洗 + 智能解析（YAML/JSON 都支持）+ 解析失败自动重试 1 次
    let raw: Record<string, unknown> | null = null;
    let rawText = '';
    let parseErr: Error | null = null;
    let lastEmpty = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await provider.chat(
        [
          { role: 'system', content: system },
          { role: 'user', content: userParts + (attempt > 0 ? '\n\n（提示：上次输出为空或无法解析，请严格两空格缩进输出纯 YAML（或 JSON 对象），不要任何解释文字、不要 markdown 代码块标记）' : '') },
        ],
        [],
        // 上次空内容 → 重试降 maxTokens（部分模型/中转对高 max_tokens 返回空）；格式错误 → 保持 5000 防截断
        { temperature: 0.7, maxTokens: attempt === 0 ? 5000 : lastEmpty ? 2000 : 5000 },
      );
      const content = String(res.content ?? '');
      lastEmpty = content.trim() === '';
      rawText = extractYaml(content);
      raw = parseAiOutput(rawText);
      if (raw) {
        parseErr = null;
        break;
      }
      parseErr = new Error(
        lastEmpty
          ? 'AI 服务返回了空内容（可能是模型对超长输出支持不佳、临时限流或接口异常），建议稍后重试'
          : `输出无法解析为 YAML/JSON。AI 原文开头：${JSON.stringify(content.slice(0, 150))}…`,
      );
    }
    if (parseErr || !raw) {
      return { ok: false, error: `AI 输出的格式有问题（已自动重试 1 次仍失败）：${parseErr?.message ?? ''}` };
    }
    if (target === 'pack' || target === 'rule-pack' || target === 'scenario-from-rule' || target === 'adjust') {
      // 整包：AI 输出兜底规范化（缺 id/name/空字段用模板补全）→ 完整校验
      const normalized = normalizeGeneratedPack(type, raw, String(req?.prompt ?? ''));
      if (requiresId) normalized.requires = requiresId; // 按规则包生成：依赖锁定所选规则包
      // adjust 迭代：AI 若丢了 requires，恢复原草稿的依赖（锁定贯通：按规则包生成的剧本迭代后仍依赖该包）
      if (target === 'adjust' && type === 'scenario' && req?.prevDraft) {
        try {
          const prev = parsePackObject('scenario', req.prevDraft) as ScenarioPack;
          if (prev.requires && prev.requires !== normalized.requires) normalized.requires = prev.requires;
        } catch { /* prevDraft 解析失败忽略 */ }
      }
      const obj = parsePackObject(type, serializeYaml(normalized));
      return { ok: true, target, draft: obj, yaml: serializePackObject(type, obj), isWhole: true };
    }
    // 单点：从智能解析结果提取该字段（AI 生成部分，保存时统一校验）
    const field = AI_TARGET_FIELD[target];
    if (!field || !(field in raw)) {
      return { ok: false, error: `AI 输出缺少 ${field} 字段，请重试` };
    }
    return { ok: true, target, field, draft: raw[field], yaml: rawText };
  } catch (e) {
    // AI 输出问题给可操作提示（不是纯技术报错）
    const msg = (e as Error).message;
    return { ok: false, error: msg.includes('缺少') || msg.includes('必须') || msg.includes('表达式非法')
      ? `AI 生成的骨架不完整：${msg}。可补全细节后重试，或改用「单点生成」逐块生成`
      : `AI 生成失败: ${msg}` };
  }
});

// —— IPC：审计 ——
ipcMain.handle('audit:dice', () => (activeCampaignId ? World.loadFromDb(store.db, activeCampaignId).diceLog.slice(-20) : []));
ipcMain.handle('audit:world', () => {
  if (!activeCampaignId) return { entities: [], facts: [], relations: [], changes: [] };
  const w = World.loadFromDb(store.db, activeCampaignId);
  return {
    entities: [...w.entities.values()].map((e) => ({ id: e.id, type: e.type, name: e.name, data: e.data })),
    facts: w.facts,
    relations: w.relations.map((r) => {
      const a = w.entities.get(r.entityAId);
      const b = w.entities.get(r.entityBId);
      return { id: r.id, a: a?.name ?? r.entityAId, b: b?.name ?? r.entityBId, relationType: r.relationType, description: r.description, since: r.since };
    }),
    changes: w.changes.slice(-30).reverse(), // 倒序：最新在前
  };
});
// —— IPC：世界审计编辑（§11.4 记忆可修改 / §11.5 变更回滚）——
function withWorld<T>(fn: (w: World) => T): T {
  if (!activeCampaignId) throw new Error('未打开战役');
  const w = World.loadFromDb(store.db, activeCampaignId);
  const out = fn(w);
  w.saveToDb(store.db, activeCampaignId);
  return out;
}
ipcMain.handle('world:updateFact', (_e, id: string, patch: { fact?: string; importance?: string }) =>
  withWorld((w) => {
    const f = w.updateFact(String(id), { fact: patch?.fact, importance: patch?.importance as never });
    if (!f) throw new Error('事实不存在');
    return f;
  }));
ipcMain.handle('world:deleteFact', (_e, id: string) => withWorld((w) => w.deleteFact(String(id))));
ipcMain.handle('world:deleteRelation', (_e, id: string) => withWorld((w) => w.deleteRelation(String(id))));
ipcMain.handle('world:addFact', (_e, req: { fact: string; importance?: string }) => {
  if (!req?.fact?.trim()) throw new Error('事实内容不能为空');
  return withWorld((w) => w.addFact(req.fact.trim(), [], (req.importance as never) ?? 'normal', 'player'));
});
// 变更回滚（§11.5：before/after 快照恢复，回滚本身入日志不可再回滚）
ipcMain.handle('world:rollback', (_e, changeId: string) => withWorld((w) => w.rollbackChange(String(changeId))));

// —— 菜单：打包版彻底移除（玩家不需要菜单栏，窗口顶部干净；编辑快捷键在输入框内由 Chromium 默认处理）；
//    开发版保留中文菜单（重新加载 / 开发者工具 / 缩放，调试用）——
function setupMenu(): void {
  if (app.isPackaged) {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        { role: 'quit', label: '退出', accelerator: 'CmdOrCtrl+Q' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
  ]));
}

// —— 窗口 ——
function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'DiceKeeper — AI 守密人跑团',
    backgroundColor: '#f5f0e8',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow = win;
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  const rendererIndex = join(__dirname, '..', 'renderer', 'index.html');
  if (existsSync(rendererIndex)) win.loadFile(rendererIndex);
  else win.loadURL('http://localhost:5173');

  // E2E 截图钩子（DK_SCREENSHOT=路径 时自动截图，供无头验证）
  if (process.env.DK_SCREENSHOT) {
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const img = await win.webContents.capturePage();
        writeFileSync(process.env.DK_SCREENSHOT!, img.toPNG());
        console.log(`[DiceKeeper] 截图已保存: ${process.env.DK_SCREENSHOT}`);
      } catch (e) {
        console.error('[DiceKeeper] 截图失败:', (e as Error).message);
      }
    });
  }

  // E2E 冒烟钩子（DK_E2E=1 时在渲染进程执行真实 IPC 链路并退出）
  if (process.env.DK_E2E) {
    // 诊断：转发渲染进程 console（定位 executeJavaScript 失败根因）
    win.webContents.on('console-message', (_e, level, msg) => {
      console.log(`[E2E-renderer:${level}] ${String(msg).slice(0, 300)}`);
    });
    win.webContents.once('did-finish-load', async () => {
      let step = 'r1';
      try {
        const js = (code: string) => win.webContents.executeJavaScript(code);
        const r1 = await js(`window.dk.campaign.create({ name: 'E2E 战役', seed: 'e2e' }).then(r => JSON.stringify(r.id))`);
        const cid = JSON.parse(r1);
        // 关键回归用例：模拟"重启后打开已有战役"路径（open → session.start）
        const r1b = await js(`window.dk.campaign.open('${cid}').then(r => JSON.stringify(r.name))`);
        const r2 = await js(`window.dk.session.start().then(r => JSON.stringify(r.id))`);
        const r3 = await js(`window.dk.check({ skill: '侦查' }).then(r => JSON.stringify(r.detail))`);
        const r4 = await js(`window.dk.chat('我推开雾港酒馆的门，看见埃德加。').then(r => JSON.stringify({ n: r.narrative.slice(0, 36), issues: r.issues.length }))`);
        const r5 = await js(`window.dk.audit.dice().then(r => JSON.stringify(r.length))`);
        // P2 回归：剧本包初始化（世界实体 + 世界书条目）与命中注入
        const r6 = await js(`window.dk.audit.world().then(r => JSON.stringify(r.entities.filter(e => e.type === 'npc' || e.type === 'world').map(e => e.type + ':' + e.name)))`);
        const r7 = await js(`window.dk.scenario.info().then(r => JSON.stringify(r.name + '/' + r.hooks.length))`);
        // 反馈修复轮回归：① 聊天记录恢复（重开战役后最近会话消息仍在）② 车卡预览/重骰 ③ 设置持久化
        const r8 = await js(`window.dk.campaign.open('${cid}').then(async () => {
          const list = await window.dk.session.list();
          if (list.length === 0) return 'NO_SESSION';
          const data = await window.dk.session.open(list[0].id);
          return JSON.stringify(data.messages.length);
        })`);
        const r9 = await js(`window.dk.characters.preview('fix').then(r => JSON.stringify(r.occupation + '/' + r.age + '/' + r.derived.SAN))`);
        const r10 = await js(`window.dk.characters.reroll().then(r => JSON.stringify(r.name + '/' + r.occupation))`);
        // 设置持久化回归（含 P3a 内容包相关 IPC 不在此 E2E 覆盖，由单测 test/packs.test.ts 保障）
        const r11 = await js(`window.dk.settings.set({ baseUrl: 'https://e2e.local/v1', apiKey: 'sk-e2e', model: 'e2e-model' }).then(async () => {
          const g = await window.dk.settings.get();
          return JSON.stringify(g.baseUrl + '/' + g.model);
        })`);
        // P1 记忆系统回归：结束会话生成摘要（离线降级规则摘要）→ 新会话注入 CHRONICLE
        const r12 = await js(`window.dk.session.end().then(r => JSON.stringify({ ended: r.session.summary ? 'yes' : 'no', sum: (r.summary || '').slice(0, 20) }))`);
        const r13 = await js(`window.dk.session.start().then(async (s) => {
          await window.dk.session.open(s.id);
          const out = await window.dk.chat('@埃德加 告诉我上一节发生了什么。');
          return JSON.stringify(out.narrative.slice(0, 20));
        })`);
        const r14 = await js(`window.dk.audit.world().then(r => JSON.stringify({ facts: r.facts.length, rels: r.relations.length }))`);
        const r15 = await js(`window.dk.settings.test({ baseUrl: 'https://e2e.local/v1', apiKey: 'bad' }).then(r => JSON.stringify({ ok: r.ok, err: r.error ? 'has-error' : 'none' }))`);
        // 手填车卡回归（§11.10）：fields → update（校验+衍生）→ 角色卡替换
        const r16 = await js(`window.dk.characters.fields().then(async (f) => {
          const attrs = Object.fromEntries(f.attributes.map(a => [a.name, 50]));
          const skills = Object.fromEntries(f.skills.map(s => [s.name, s.base]));
          const p = await window.dk.characters.update({ name: '手填调查员', age: 30, occupation: f.occupations[0], attributes: attrs, skills });
          return JSON.stringify(p.name + '/' + p.age + '/' + p.derived.HP);
        })`);
        const r17 = await js(`window.dk.characters.update({ name: '', age: 30, occupation: '医生', attributes: { STR: 99 }, skills: {} }).then(() => 'BAD').catch(e => 'REJECTED')`);
        // P3b 内容编辑器回归：open（内置）→ save（内置自动另存副本）→ 列表出现副本；试跑检定/世界书
        step = 'r22';
        const r22 = await js(`window.dk.editor.open('scenario', 'fog_harbor').then(r => JSON.stringify(r.ok + '/' + r.isBuiltin + '/' + (r.obj?.npc_seeds?.length ?? 0)))`);
        const r23 = await js(`window.dk.editor.open('scenario', 'fog_harbor').then(async (r) => {
          const obj = r.obj; obj.name = '雾港疑云 E2E 副本';
          const s = await window.dk.editor.save({ type: 'scenario', id: 'fog_harbor', isBuiltin: true, obj });
          const list = await window.dk.packs.list();
          return JSON.stringify({ savedAs: s.savedAs, hasCopy: list.scenarioPacks.some(p => p.id === s.savedAs) });
        })`);
        const r24 = await js(`window.dk.editor.open('rule', 'coc7e').then(async (r) => {
          const c = await window.dk.editor.testCheck({ obj: r.obj, skill: '侦查', value: 50, mode: 'normal' });
          return JSON.stringify(c.label + '/' + c.diceRolls.length);
        })`);
        const r25 = await js(`window.dk.editor.open('scenario', 'fog_harbor').then(async (r) => {
          const l = await window.dk.editor.testLore({ obj: r.obj, text: '埃德加灌了一口酒', budget: 200 });
          return JSON.stringify({ hits: l.hits.length, used: l.used, budget: l.budget });
        })`);
        // 补强回归：分布图 / 变更回滚 / 人格包 / 导入冲突向导
        const r26 = await js(`window.dk.editor.open('rule', 'coc7e').then(async (r) => {
          const d = await window.dk.editor.testDist({ obj: r.obj, skill: '侦查', value: 50, mode: 'normal', trials: 200 });
          const total = d.counts.extreme + d.counts.hard + d.counts.normal + d.counts.fail + d.counts.crit_fail;
          return JSON.stringify({ trials: d.trials, total });
        })`);
        const r27 = await js(`(async () => {
          const before = await window.dk.audit.world();
          const target = before.changes.find(c => c.kind === 'fact_add' || c.kind === 'entity_update');
          if (!target) return 'NO_CHANGE';
          const ok = await window.dk.world.rollback(target.id);
          return JSON.stringify({ ok, kind: target.kind });
        })()`);
        const r28 = await js(`window.dk.personas.list().then(async (p) => {
          const saved = await window.dk.personas.save({ id: 'e2e-persona', name: 'E2E 风格', tone: 't', style: 's', narration: 'n', rulings: 'r', catchphrases: [] });
          const after = await window.dk.personas.list();
          const del = await window.dk.personas.delete('e2e-persona');
          return JSON.stringify({ presets: p.presets.length, saved: saved.name, custom: after.custom.length, del: del.ok });
        })`);
        const r29 = await js(`window.dk.editor.open('scenario', 'fog_harbor').then(async (r) => {
          const text = r.yaml;
          const c1 = await window.dk.packs.importText(text, { force: true });
          const c2 = await window.dk.packs.importText(text); // 同名 → 冲突
          const c3 = await window.dk.packs.importText(text, { force: true, newId: 'fog_harbor_v2' });
          const list = await window.dk.packs.list();
          return JSON.stringify({ first: c1.ok, conflict: !!c2.conflict, renamed: c3.ok, hasV2: list.scenarioPacks.some(p => p.id === 'fog_harbor_v2') });
        })`);
        // 检定接剧情回归（放最后：多次 checkWithChat 后 executeJavaScript 偶发 Script failed，已知竞态）
        step = 'r18';
        const r18 = await js(`window.dk.checkWithChat('侦查').then(r => JSON.stringify({ c: r.check.label, n: r.narrative.slice(0, 16) }))`);
        const r19 = await js(`(async () => {
          await new Promise(r => setTimeout(r, 1500)); // 等 React 挂载完成（避免事件竞态）
          await window.dk.checkWithChat('侦查');       // App 就绪后触发：onCheck 监听器必收到
          await new Promise(r => setTimeout(r, 400));  // 等渲染 flush
          const txt = document.body.innerText;
          return JSON.stringify({ checkBubble: txt.includes('【检定】') });
        })()`);
        // 诊断：onCheck 事件是否真的到达渲染进程（独立监听器）
        const r20 = await js(`(async () => {
          let got = null;
          window.dk.onCheck((info) => { got = info; });
          await window.dk.checkWithChat('侦查');
          await new Promise(r => setTimeout(r, 300));
          return JSON.stringify(got ? got.skill + '/' + got.label : 'NO_EVENT');
        })()`);
        // 编造 ID 清洗回归：action 带真实记录 ID，AI 引用即通过（离线兜底无 dice_results，验证链路不报错）
        const r21 = await js(`window.dk.checkWithChat('聆听').then(r => JSON.stringify({ issues: r.issues.length, dice: r.diceResults.length }))`);
        // 回归：检定消息落库为玩家可见文本（内部指令不泄漏；重开软件后历史恢复干净）
        const r30 = await js(`window.dk.campaign.open('${cid}').then(async () => {
          const list = await window.dk.session.list();
          const data = await window.dk.session.open(list[0].id);
          const lastUser = [...data.messages].reverse().find(m => m.role === 'user');
          const leak = lastUser && (lastUser.content.includes('掷骰记录ID') || lastUser.content.includes('本地引擎判定完毕'));
          return JSON.stringify({ clean: !leak, sample: lastUser ? lastUser.content.slice(0, 24) : 'none' });
        })`);
        // 移动本地识别 + 场景快捷栏（方案 C/B：本地裁定位置，不依赖 AI）
        const r31 = await js(`window.dk.chat('我离开酒馆去码头看看').then(async () => {
          const b = await window.dk.scene.bar();
          return JSON.stringify({ here: b.here, places: b.places.length, persons: b.persons.length });
        })`);
        // P6 本地模式：ollama IPC 全链路存在且 E2E 短路（不真下载/启动）
        const r32 = await js(`window.dk.ollama.status().then(async (s) => {
          const hw = await window.dk.ollama.hwinfo();
          const models = await window.dk.ollama.models();
          return JSON.stringify({ e2e: s.e2e === true, running: s.running, url: s.openaiUrl || '', rec: hw.recommend, models: models.length });
        })`);
        // P5 局域网联机：真实开房 → 浏览器 WebSocket 玩家加入 → 发行动 → 收叙事广播
        const r33 = await js(`window.dk.room.host({ port: 0 }).then(async (h) => {
          if (!h.ok) return JSON.stringify({ host: h.error });
          const types = [];
          const ws = new WebSocket('ws://127.0.0.1:' + h.port);
          await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
          const joined = await new Promise((r) => {
            ws.onmessage = (ev) => { const m = JSON.parse(ev.data); types.push(m.type); if (m.type === 'joined') r(true); };
            ws.send(JSON.stringify({ type: 'join', name: 'E2E玩家' }));
            setTimeout(() => r(false), 3000);
          });
          ws.send(JSON.stringify({ type: 'chat', text: '我环顾四周，寻找线索' }));
          await new Promise((r) => setTimeout(r, 2500));
          const narrative = types.includes('narrative');
          const players = await window.dk.room.players();
          ws.close();
          await window.dk.room.close();
          return JSON.stringify({ joined, narrative, types: types.join(','), players: players.players.length });
        })`);
        const line = '[DiceKeeper-E2E] 建团=' + r1 + ' 打开=' + r1b + ' 会话=' + r2 + ' 检定=' + r3 + ' 对话=' + r4 + ' 骰子审计=' + r5 + ' 剧本种子=' + r6 + ' 剧本信息=' + r7 + ' 历史恢复=' + r8 + ' 车卡预览=' + r9 + ' 车卡重骰=' + r10 + ' 设置持久化=' + r11 + ' 结束会话摘要=' + r12 + ' 新会话注入=' + r13 + ' 记忆面板=' + r14 + ' 测试连接=' + r15 + ' 手填车卡=' + r16 + ' 非法拒收=' + r17 + ' 检定接剧情=' + r18 + ' UI渲染=' + r19 + ' onCheck事件=' + r20 + ' 编造ID清洗=' + r21 + ' 检定消息干净=' + r30 + ' 移动识别=' + r31 + ' 本地模式IPC=' + r32 + ' 联机往返=' + r33 + ' 编辑器打开=' + r22 + ' 编辑器保存副本=' + r23 + ' 试跑检定=' + r24 + ' 试跑世界书=' + r25 + ' 试跑分布=' + r26 + ' 变更回滚=' + r27 + ' 人格包=' + r28 + ' 导入冲突=' + r29;
        console.log(line);
        try { writeFileSync(join(app.getPath('temp'), 'dk-e2e-result.txt'), line, 'utf-8'); } catch { /* 非关键 */ }
      } catch (e) {
        console.error(`[DiceKeeper-E2E] 失败于步骤 ${step}:`, (e as Error).message, '| destroyed:', win.webContents.isDestroyed(), '| crashed:', win.webContents.isCrashed());
      }
      setTimeout(() => app.quit(), 600);
    });
  }
}

app.whenReady().then(() => {
  setupMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
