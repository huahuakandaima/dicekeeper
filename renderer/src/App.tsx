// renderer/src/App.tsx — DiceKeeper MVP 主界面
// 布局：左侧战役栏（建团/切团）｜中间聊天区（对话+输入）｜右侧检定与审计
import { useEffect, useRef, useState } from 'react';
import type { CharView, CheckResult, CharPreview, CharSpec, CharFields, PackMeta, ImportPackResult, Persona } from './global.d.ts';
import { CharEdit } from './CharEdit.tsx';
import { InfoTip, HoverTip } from './InfoTip.tsx';
import { PackEditor } from './PackEditor.tsx';
import { COC_ATTRIBUTE_DESC, COC_SKILL_DESC, COC_DERIVED_DESC } from '../../src/coc7e-info.ts';
import { MODEL_CARDS } from '../../src/ollama.ts';

type Msg = { role: 'user' | 'keeper'; text: string; dice?: string[]; issues?: { kind: string; message: string }[]; prompt?: string | null };

// 变更日志摘要（§11.5：who / 做了什么 / 目标）
function summarizeChange(c: { actor: string; kind: string; target: string; before: unknown; after: unknown }, gmTitle: string): string {
  const actor = c.actor === 'ai' ? gmTitle : c.actor === 'player' ? '玩家' : c.actor;
  const nameOf = (o: unknown) => (o && typeof o === 'object' && 'name' in (o as object) ? (o as { name: string }).name : null);
  if (c.kind === 'entity_update') {
    const n = nameOf(c.after) ?? c.target;
    return c.before === null ? `${actor} 建立关系 ${n}` : `${actor} 更新 ${n}`;
  }
  if (c.kind === 'entity_add') return `${actor} 新增 ${nameOf(c.after) ?? c.target}`;
  if (c.kind === 'fact_add') {
    if (c.before && c.after) return `${actor} 调整事实：${String((c.after as { fact?: string }).fact ?? '').slice(0, 14)}…`;
    const f = (c.after as { fact?: string } | null)?.fact ?? c.target;
    return `${actor} 记录事实：${String(f).slice(0, 14)}…`;
  }
  return `${actor} 手动操作`;
}

import { DRAG_GUARD } from './drag-guard';

export function App() {
  const [campaigns, setCampaigns] = useState<{ id: string; name: string; pcCount: number; msgs?: number; tokens?: number }[]>([]);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [tokenUsage, setTokenUsage] = useState<{ messages: number; system: number; total: number; msgCount: number } | null>(null); // 当前战役上下文占用
  const [char, setChar] = useState<CharView | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastCheck, setLastCheck] = useState<CheckResult | null>(null);
  const [diceLog, setDiceLog] = useState<Awaited<ReturnType<typeof window.dk.audit.dice>>>([]);
  const [notice, setNotice] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [cfg, setCfg] = useState({ baseUrl: '', apiKey: '', model: '', defaultPersonaId: '', tension: { intensity: 50, surprise: 50, consequence: 50 } });
  const [sqliteOk, setSqliteOk] = useState(true);
  const [showNew, setShowNew] = useState(false);      // 新建战役弹窗
  const [newName, setNewName] = useState('');
  const [charName, setCharName] = useState('无名调查员');
  const [preview, setPreview] = useState<CharPreview | null>(null); // 建团弹窗的车卡预览
  const [previewBusy, setPreviewBusy] = useState(false); // 车卡生成中（确认按钮防连点）
  const [loaded, setLoaded] = useState(false);         // C14 灌铅模式（属性骰取优）
  const [pendingDel, setPendingDel] = useState<{ id: string; name: string } | null>(null); // 删除确认
  const [scenario, setScenario] = useState<{ id: string; name: string; hooks: string[]; place?: string | null; person?: string | null } | null>(null);
  const [scenarioPacks, setScenarioPacks] = useState<PackMeta[]>([]);
  // 技能按钮类型（规则包 character_sheet.skills[].action：check/narrative/none）——右侧技能栏按此渲染
  const [skillActions, setSkillActions] = useState<Record<string, 'check' | 'narrative' | 'none'>>({});
  // 主持人称谓（规则包 gm_title：守密人/地下城主/主持人…；未设置的规则包缺省"主持人"，"守密人"是 CoC 的叫法）
  const [gmTitle, setGmTitle] = useState('主持人');
  const [selScenarioId, setSelScenarioId] = useState('');
  const [selRulePackId, setSelRulePackId] = useState(''); // 建团规则包（空=默认 CoC 7e；"不能换规则包"修复）
  const [rulePacksList, setRulePacksList] = useState<{ id: string; name: string; version: string }[]>([]);
  const [packsInfo, setPacksInfo] = useState<{ rulePacks: PackMeta[]; scenarioPacks: PackMeta[] } | null>(null);
  const [packNotice, setPackNotice] = useState('');
  const [packEditor, setPackEditor] = useState<{ type: 'rule' | 'scenario'; meta: PackMeta } | null>(null); // P3b 内容编辑器
  // B12 导入冲突确认（同名包：覆盖/换名/取消）
  const [importPending, setImportPending] = useState<{ type: 'rule' | 'scenario'; id: string; name: string; version: string; summary?: ImportPackResult['summary']; content: string } | null>(null);
  const [importNewId, setImportNewId] = useState('');
  // B5 人格包（设置弹窗）
  const [personas, setPersonas] = useState<{ presets: Persona[]; custom: Persona[]; defaultId: string } | null>(null);
  const [personaDraft, setPersonaDraft] = useState<Persona | null>(null); // 正在编辑/自建的人格
  // P6 本地模式（Ollama）：状态 / 编排进度 / 硬件推荐 / 已装模型
  const [ollama, setOllama] = useState<{ checked: boolean; running: boolean; managed: boolean; version?: string; openaiUrl: string }>({ checked: false, running: false, managed: false, openaiUrl: '' });
  const [ollamaPhase, setOllamaPhase] = useState<'idle' | 'setup' | 'pulling'>('idle'); // 编排阶段（setup=下载/解压/启动）
  const [ollamaProg, setOllamaProg] = useState<{ phase: string; pct: number; label: string } | null>(null);
  const [hwInfo, setHwInfo] = useState<{ totalRamGB: number | null; vramGB: number | null; gpuName: string | null; recommend: string } | null>(null);
  const [installedModels, setInstalledModels] = useState<string[]>([]);
  const [busyModel, setBusyModel] = useState<string | null>(null); // 正在下载的模型名
  // P5 局域网联机（房主中心化：开房 / 加入双模式）
  const [roomModal, setRoomModal] = useState(false);
  const [hosting, setHosting] = useState(false); // 本机是否已开房
  const [roomAddr, setRoomAddr] = useState<{ port: number; addresses: string[] } | null>(null);
  const [roomPlayers, setRoomPlayers] = useState<{ id: string; name: string }[]>([]);
  const [roomNotice, setRoomNotice] = useState('');
  const [joinAddr, setJoinAddr] = useState('');
  const [joinName, setJoinName] = useState('');
  const [joinState, setJoinState] = useState<'idle' | 'connecting' | 'joined'>('idle');
  const [joinError, setJoinError] = useState('');
  const [roomJoined, setRoomJoined] = useState(false); // 玩家模式激活（发送走房间通道）
  const [settingsTab, setSettingsTab] = useState<'ai' | 'local' | 'drama' | 'persona' | 'packs'>('ai'); // 设置弹窗分模块 Tab
  const [selPersonaId, setSelPersonaId] = useState(''); // 建团弹窗选择
  const [pendingText, setPendingText] = useState(''); // 流式叙事累积（AI 思考时逐字显示）
  const [atCandidates, setAtCandidates] = useState<{ id: string; name: string; type: string; location?: string }[]>([]);
  const [sceneBar, setSceneBar] = useState<{ persons: { id: string; name: string; here: boolean }[]; places: { id: string; name: string; here: boolean }[]; here: string }>({ persons: [], places: [], here: '' });
  const [sceneTab, setSceneTab] = useState<null | 'persons' | 'places'>(null);
  const [worldData, setWorldData] = useState<Awaited<ReturnType<typeof window.dk.audit.world>> | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; status?: number; models?: string[]; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  // 手填车卡（§11.10 微调）
  const [editMode, setEditMode] = useState(false);          // 建团弹窗：随机 / 手动切换
  const [charFields, setCharFields] = useState<CharFields | null>(null);
  const [editSpec, setEditSpec] = useState<CharSpec | null>(null);   // 编辑中表单
  const [editDerived, setEditDerived] = useState<Record<string, number>>({});
  const [luckOverride, setLuckOverride] = useState<number | null>(null); // 重掷幸运后记住 UI 值（保存时透传，防被重随机覆盖）
  const [editModal, setEditModal] = useState<null | 'new' | 'existing'>(null); // 编辑弹窗（建团 / 侧边栏）
  const [newFactText, setNewFactText] = useState('');       // B7 人工添加事实
  const [newFactImportance, setNewFactImportance] = useState('normal');
  const [lastSummary, setLastSummary] = useState<string | null>(null); // 上节摘要（右栏展示：守密人的记忆）
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // API 预设（OpenAI 兼容，参数与官方文档一致；Ollama 为本地模式）
  const PRESETS: Record<string, { label: string; baseUrl: string; model: string; hint: string }> = {
    deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', hint: '模型：deepseek-v4-flash / deepseek-v4-pro' },
    qwen: { label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', hint: '模型：qwen-plus / qwen-turbo / qwen-max' },
    kimi: { label: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', hint: '模型：moonshot-v1-8k / 32k / 128k' },
    ollama: { label: 'Ollama 本地', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b', hint: '需先启动 Ollama 并已拉取模型；可填已装的任意模型名' },
  };

  function applyPreset(key: string) {
    const p = PRESETS[key];
    setCfg({ ...cfg, baseUrl: p.baseUrl, model: p.model });
    setTestResult(null);
  }

  // —— 内容包（P3a/P3b）——
  async function refreshPacks() {
    setPacksInfo(await window.dk.packs.list());
  }
  // B12 导入向导：校验 → 冲突检测 → 预览确认（覆盖/换名/取消）
  // P3b 增强：从零新建规则包/剧本包（后端生成合法模板 → 直接打开编辑器）
  async function doNewPack(type: 'rule' | 'scenario') {
    const r = await window.dk.editor.create({ type });
    if (!r.ok || !r.meta) { setPackNotice(`✗ 新建失败：${r.error ?? '未知错误'}`); return; }
    setPackEditor({ type, meta: r.meta });
  }
  async function doImportPack() {
    const r = await window.dk.packs.import();
    if (r.canceled) return;
    if (r.ok && r.pack) {
      if (r.conflict) {
        setImportPending({ type: r.pack.type, id: r.pack.id, name: r.pack.name, version: r.pack.version, summary: r.summary, content: r.content ?? '' });
        setImportNewId('');
        return;
      }
      await finishImport(r);
    } else {
      setPackNotice(`✗ 导入失败：${r.error ?? '未知错误'}`);
    }
  }
  // 导入完成：刷新列表 + 提示（含摘要）
  async function finishImport(r: ImportPackResult) {
    if (r.ok && r.pack) {
      const s = r.summary;
      const detail = s ? `（NPC ${s.npcCount ?? '-'} / 地点 ${s.locationCount ?? '-'} / 线索 ${s.plotCount ?? '-'} / 世界书 ${s.loreCount ?? '-'} / 技能 ${s.skillCount ?? '-'}）` : '';
      setPackNotice(`✓ 已导入内容包：${r.pack.name} v${r.pack.version} ${detail}`);
      await refreshPacks();
      const list = await window.dk.scenario.list();
      setScenarioPacks(list);
    } else {
      setPackNotice(`✗ 导入失败：${r.error ?? '未知错误'}`);
    }
  }
  async function doImportOverwrite() {
    if (!importPending) return;
    const r = await window.dk.packs.importText(importPending.content, { force: true });
    setImportPending(null);
    await finishImport(r);
  }
  async function doImportRename() {
    if (!importPending) return;
    const newId = importNewId.trim();
    if (!newId) { setPackNotice('请输入新的包 id（英文小写/数字/下划线）'); return; }
    const r = await window.dk.packs.importText(importPending.content, { force: true, newId });
    setImportPending(null);
    if (r.ok && r.pack) setPackNotice(`✓ 已换名导入为「${r.pack.name}」（id: ${r.pack.id}）`);
    await refreshPacks();
    const list = await window.dk.scenario.list();
    setScenarioPacks(list);
  }
  async function doExportPack(type: 'rule' | 'scenario', id: string, name: string) {
    const r = await window.dk.packs.export(type, id);
    if (r.ok) setPackNotice(`✓ 已导出 ${name}.dk`);
  }
  async function doDeletePack(type: 'rule' | 'scenario', id: string, name: string) {
    await window.dk.packs.delete(type, id);
    setPackNotice(`已删除内容包：${name}`);
    await refreshPacks();
    const list = await window.dk.scenario.list();
    setScenarioPacks(list);
  }
  // P3b：编辑器保存后刷新列表与建团下拉
  async function onPackSaved(meta: PackMeta) {
    await refreshPacks();
    const list = await window.dk.scenario.list();
    setScenarioPacks(list);
    if (meta) setPackNotice(`✓ 内容包已保存：${meta.name} v${meta.version}`);
  }

  // —— B7 记忆审计可修改（§11.4：玩家可见 L3、可修改）——
  async function onUpdateFact(id: string, patch: { fact?: string; importance?: string }) {
    await window.dk.world.updateFact(id, patch);
    refreshAudit();
  }
  async function onDeleteFact(id: string) {
    await window.dk.world.deleteFact(id);
    refreshAudit();
  }
  async function onDeleteRelation(id: string) {
    await window.dk.world.deleteRelation(id);
    refreshAudit();
  }
  async function onAddFact() {
    if (!newFactText.trim()) return;
    await window.dk.world.addFact({ fact: newFactText.trim(), importance: newFactImportance });
    setNewFactText('');
    refreshAudit();
  }
  // B8 变更回滚（§11.5）
  async function onRollback(changeId: string) {
    const ok = await window.dk.world.rollback(changeId);
    setNotice(ok ? '✓ 已回滚该变更（回滚本身已记入日志）' : '该变更不可回滚（manual 记录或类型不支持）');
    refreshAudit();
  }

  // —— B5 人格包（§3.6）——
  async function loadPersonas() {
    const p = await window.dk.personas.list();
    setPersonas(p);
    if (!cfg.defaultPersonaId && p.presets[0]) setCfg((c) => ({ ...c, defaultPersonaId: p.presets[0].id }));
  }
  function newPersonaDraft() {
    setPersonaDraft({ id: `custom-${Date.now().toString(36)}`, name: '', description: '自定义风格', tone: '', catchphrases: [], style: '', narration: '', rulings: '' });
  }
  function editPersona(p: Persona) { setPersonaDraft({ ...p, catchphrases: [...p.catchphrases] }); }
  async function savePersonaDraft() {
    if (!personaDraft) return;
    if (!personaDraft.name.trim()) { setNotice('人格名称不能为空'); return; }
    if (!personaDraft.tone.trim() || !personaDraft.style.trim() || !personaDraft.narration.trim() || !personaDraft.rulings.trim()) {
      setNotice('请补全语气 / 主持风格 / 叙事偏好 / 裁决哲学 四项'); return;
    }
    try {
      const saved = await window.dk.personas.save({ ...personaDraft, catchphrases: personaDraft.catchphrases.filter((c) => c.trim()) });
      setNotice(`✓ 人格已保存：${saved.name}`);
      setPersonaDraft(null);
      await loadPersonas();
    } catch (e) {
      setNotice(`保存失败：${(e as Error).message.replace(/^Error invoking remote method '[^']+':\s*/, '')}`);
    }
  }
  async function deletePersona(p: Persona) {
    await window.dk.personas.delete(p.id);
    setNotice(`已删除人格：${p.name}`);
    await loadPersonas();
  }

  async function testConnection() {
    if (!cfg.baseUrl || !cfg.apiKey) { setTestResult({ ok: false, error: '请先填写接口地址与 API 密钥' }); return; }
    setTesting(true);
    setTestResult(null);
    const r = await window.dk.settings.test({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
    setTestResult(r);
    setTesting(false);
  }

  // —— 手填车卡（§11.10 微调：随机打底 → 手动改）——
  // rp 为建团弹窗选中的规则包（换规则包后字段随之变化，不缓存）
  async function ensureCharFields(rp?: string) {
    const f = await window.dk.characters.fields(rp);
    setCharFields(f);
    return f;
  }

  // 打开编辑：source='new' 用随机预览打底（建团弹窗，按所选规则包），'existing' 用当前角色卡（侧边栏）
  // fromOverride 可选：换规则包确认后直接以新预览为底（React state 异步，不能依赖 setPreview 后立即读 preview）
  async function openCharEdit(source: 'new' | 'existing', fromOverride?: CharPreview | null) {
    const rp = source === 'new' ? (selRulePackId || undefined) : undefined;
    const f = await ensureCharFields(rp);
    const from = source === 'new' ? (fromOverride ?? preview) : (char ? { ...char, name: char.name, skills: char.skills } : null);
    const spec: CharSpec = {
      name: from?.name ?? charName ?? '无名调查员',
      gender: from?.gender ?? '男',
      age: from?.age ?? 25,
      occupation: from?.occupation ?? f.occupations[0] ?? '',
      attributes: Object.fromEntries(f.attributes.map((a) => [a.name, from?.attributes?.[a.name] ?? 40])),
      skills: Object.fromEntries(f.skills.map((s) => [s.name, from?.skills?.[s.name] ?? s.base])),
    };
    setCharFields(f);
    setEditSpec(spec);
    setEditModal(source);
    // 首次衍生
    const d = await window.dk.characters.derive({ attributes: spec.attributes, age: spec.age }, undefined, rp);
    setEditDerived(d);
  }

  // 表单改动：更新 spec + 防抖重算衍生（幸运含随机，可点重掷）
  useEffect(() => {
    if (!editSpec || !editModal) return;
    const rp = editModal === 'new' ? (selRulePackId || undefined) : undefined;
    const t = setTimeout(async () => {
      const d = await window.dk.characters.derive({ attributes: editSpec.attributes, age: editSpec.age }, undefined, rp);
      setEditDerived(d);
    }, 350);
    return () => clearTimeout(t);
  }, [editSpec, editModal, selRulePackId]);

  async function rerollLuck() {
    if (!editSpec) return;
    const rp = editModal === 'new' ? (selRulePackId || undefined) : undefined;
    const d = await window.dk.characters.derive({ attributes: editSpec.attributes, age: editSpec.age }, undefined, rp);
    setEditDerived(d);
    if (d['幸运'] !== undefined) setLuckOverride(d['幸运']); // 记住本次重掷值
  }

  // 保存：建团模式把 spec 交给 create（并保持预览一致）；侧边栏模式直接替换当前卡
  async function saveCharEdit() {
    if (!editSpec) return;
    const overrides = luckOverride !== null ? { 幸运: luckOverride } : undefined;
    if (editModal === 'new') {
      setShowNew(false);
      setEditModal(null);
      setNewName('');
      const c = await window.dk.campaign.create({ name: newName.trim(), seed: `edit-${Date.now()}`, charName: editSpec.name, charSpec: editSpec, derivedOverrides: overrides });
      setCampaigns(await window.dk.campaign.list());
      await openCampaign(c.id);
    } else {
      try {
        const p = await window.dk.characters.update(editSpec, overrides);
        setChar({ name: p.name, occupation: p.occupation, age: p.age, attributes: p.attributes, derived: p.derived, skills: p.skills });
        setNotice(`✓ 角色卡已保存：${p.name}（${p.occupation}，${p.age} 岁）`);
      } catch (e) {
        setNotice(`保存失败：${(e as Error).message.replace(/^Error invoking remote method '[^']+':\s*/, '')}`);
        return;
      }
      setEditModal(null);
    }
    setLuckOverride(null);
  }

  // 挂载：读取战役列表；有历史战役则自动打开最近一个（重启恢复体验）
  useEffect(() => {
    (async () => {
      const [list, info, packs, p, pk] = await Promise.all([window.dk.campaign.list(), window.dk.scenario.info(), window.dk.scenario.list(), window.dk.personas.list(), window.dk.packs.list()]);
      setCampaigns(list);
      setScenario(info);
      setScenarioPacks(packs);
      setSelScenarioId(packs[0]?.id ?? '');
      setPersonas(p);
      setSelPersonaId(p.defaultId || p.presets[0]?.id || '');
      setRulePacksList(pk.rulePacks);
      setCfg((c) => ({ ...c, defaultPersonaId: c.defaultPersonaId || p.defaultId || p.presets[0]?.id || '' }));
      if (list.length > 0) await openCampaign(list[0].id);
    })();
    refreshAudit();
  }, []);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs, pendingText]);
  // 流式：主进程推送的叙事片段逐字累积（挂载时注册一次）
  useEffect(() => {
    window.dk.onChunk((t) => setPendingText((prev) => prev + t));
    // 检定结果推送：AI 叙事前先显示骰面（本地判定，即时反馈）
    window.dk.onCheck((info) => {
      const outcome = /成功/.test(info.label)
        ? (info.label.includes('极限') ? 'extreme' : info.label.includes('困难') ? 'hard' : 'normal')
        : (info.label.includes('大失败') ? 'crit_fail' : 'fail');
      setLastCheck({ outcome, label: info.label, diceRolls: [info.takenRoll], takenRoll: info.takenRoll, detail: info.detail, value: info.value });
      setMsgs((m) => [...m, { role: 'keeper', text: `🎲 【检定】${info.skill}：${info.label}（骰面 ${info.takenRoll}，技能值 ${info.value}）——${info.detail}` }]);
    });
    // —— P5 联机事件：玩家模式收房主广播；房主模式收玩家消息与叙事回传 ——
    window.dk.room.onMsg((m) => {
      if (m.type === 'narrative') {
        setMsgs((prev) => [...prev, { role: 'keeper', text: String(m.text ?? ''), dice: (m.dice as string[] | undefined) ?? [], prompt: (m.prompt as string | null | undefined) ?? null }]);
      } else if (m.type === 'check') {
        setMsgs((prev) => [...prev, { role: 'keeper', text: `🎲 【检定】${String(m.skill ?? '')}：${String(m.label ?? '')}（骰面 ${String(m.takenRoll ?? '')}）——${String(m.detail ?? '')}` }]);
      } else if (m.type === 'system') {
        setMsgs((prev) => [...prev, { role: 'keeper', text: `（房间）${String(m.text ?? '')}` }]);
      } else if (m.type === 'self') {
        setMsgs((prev) => [...prev, { role: 'user', text: String(m.text ?? '') }]);
      }
    });
    window.dk.room.onHostUser((m) => setMsgs((prev) => [...prev, { role: 'user', text: `[${m.name}] ${m.text}` }]));
    window.dk.room.onHostNarrative((m) => setMsgs((prev) => [...prev, { role: 'keeper', text: m.text, dice: m.dice, prompt: m.prompt }]));
    window.dk.room.onPlayers((m) => { setRoomPlayers(m.players); if (m.notice) setRoomNotice(m.notice); });
    window.dk.room.onJoined((m) => { setJoinState('joined'); setRoomPlayers(m.players); });
    window.dk.room.onClosed(() => { setJoinState('idle'); setRoomPlayers([]); setRoomJoined(false); setNotice('已离开房间'); });
  }, []);

  // 弹窗遮罩点击关闭：仅当点击目标是遮罩本身（非弹窗内容）且没有拖选文本时关闭，
  // 防止"选中文字复制时鼠标拖到遮罩上松开"导致弹窗误关（反馈 bug 修复）
  function onModalMask(e: React.MouseEvent, close: () => void) {
    if (e.target !== e.currentTarget) return;
    if (DRAG_GUARD.isDrag(e)) return; // 拖选文字（mousedown/mouseup 距离大）不关闭
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 0) return;
    close();
  }

  async function refreshAudit() {
    const d = await window.dk.audit.dice();
    setDiceLog(d.slice().reverse());
    const w = await window.dk.audit.world();
    setWorldData(w);
    // 场景面板（人物/地点分类按钮）
    window.dk.scene.bar().then((b) => setSceneBar(b)).catch(() => {});
    // 上下文占用（对话越长每轮发送越多 → 越贵越慢；点「结束本节」压缩存档）
    if (campaignId) {
      const t = await window.dk.campaign.tokens(campaignId);
      if (t.ok) setTokenUsage({ messages: t.messages ?? 0, system: t.system ?? 0, total: t.total ?? 0, msgCount: t.msgCount ?? 0 });
    }
  }

  // 结束本节：生成 L2 摘要 → 开新会话继续（P1 记忆系统）
  // 反馈：摘要全文进聊天区（玩家可见"存了什么/有什么用"），不再只是底部小字
  async function endSession() {
    if (!campaignId) return;
    try {
      const r = await window.dk.session.end();
      setLastSummary(r.summary);
      setMsgs((m) => [...m, {
        role: 'keeper',
        text: `—— 📔 本节已结束，摘要已存档 ——\n${gmTitle}会在下一节开场引用这段摘要，从而记得本节发生的事。\n\n📝 存档摘要：\n${r.summary}`,
      }]);
      setNotice(`✓ 本节已结束，摘要已存档（下一节${gmTitle}会记得本节）`);
      const s = await window.dk.session.start();
      await window.dk.session.open(s.id);
      setMsgs((m) => [...m, { role: 'keeper', text: `—— 新的一节开始。${gmTitle}翻开了上一节的记录。` }]);
    } catch (e) {
      setNotice(`结束会话失败：${(e as Error).message.replace(/^Error invoking remote method '[^']+':\s*/, '')}`);
    }
  }

  // @ 唤起候选（§11.6）：输入末尾 "@前缀" 时弹出
  async function onInputChange(v: string) {
    setInput(v);
    const m = /@([\u4e00-\u9fa5A-Za-z0-9]*)$/.exec(v);
    if (m) {
      const list = await window.dk.entities.suggest(m[1]);
      setAtCandidates(list.map((c) => ({ id: c.id, name: c.name, type: c.type, location: c.location })));
    } else {
      setAtCandidates([]);
    }
  }

  function pickAt(name: string) {
    const m = /@([\u4e00-\u9fa5A-Za-z0-9]*)$/.exec(input);
    const prefix = m ? input.slice(0, m.index) : input;
    setInput(`${prefix}@${name} `);
    setAtCandidates([]);
  }

  // 解析 AI 输出的 prompt_player 选项（① ② ③ ④ 或 1. 2. 3. 前缀行）为可点击行动
  function parsePromptOptions(prompt: string): string[] {
    return prompt
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => /^(?:[①-⑳]|\d+[.、)])/.test(s))
      .map((s) => s.replace(/^(?:[①-⑳]|\d+[.、)])\s*/, ''));
  }

  // 车卡预览（建团弹窗内，不落库；loaded=灌铅模式；按所选规则包）。
  // rerollPreview 与 applyRulePack 原为两份近乎复制（code-review 去重）——合并：editMode 时同步刷新编辑表单
  async function regenPreview(label: string) {
    setPreviewBusy(true);
    try {
      const p = await window.dk.characters.preview(`ui-${Date.now()}`, loaded, selRulePackId || undefined);
      setPreview(p);
      if (editMode) await openCharEdit('new', p);
    } catch (e) {
      // 静默失败曾让用户误判"还是默认规则"——必须报错可见（如规则包缺 chargen 段）
      setNotice(`${label}失败：${(e as Error).message}`);
    } finally {
      setPreviewBusy(false);
    }
  }
  const rerollPreview = () => regenPreview('随机车卡');
  const applyRulePack = () => regenPreview('按规则包生成');
  // 剧本包-规则包联动（用户要求：剧情包只能根据规则包选择）：选/换规则包时自动切到第一个配套剧本包
  function handleRulePackChange(id: string) {
    setSelRulePackId(id);
    const rpId = id || (rulePacksList[0]?.id ?? 'coc7e');
    const compat = scenarioPacks.filter((sp) => !sp.requires || sp.requires === rpId);
    if (!compat.some((sp) => sp.id === selScenarioId)) setSelScenarioId(compat[0]?.id ?? '');
  }
  // 当前所选规则包 id（空=默认内置 CoC 7e）；配套剧本包（requires 匹配；无 requires 视为通用）
  const selRulePackIdFor = selRulePackId || (rulePacksList[0]?.id ?? 'coc7e');
  const compatScenarios = scenarioPacks.filter((sp) => !sp.requires || sp.requires === selRulePackIdFor);
  function ruleNameOf(id: string): string {
    return rulePacksList.find((r) => r.id === id)?.name ?? id;
  }

  // Electron 不支持 window.prompt/confirm —— 用自绘弹窗
  async function doCreateCampaign() {
    const name = newName.trim();
    if (!name) { setNotice('请输入战役名称'); return; }
    setShowNew(false);
    setNewName('');
    try {
      const c = await window.dk.campaign.create({ name, seed: preview?.seed ?? `ui-${Date.now()}`, charName, scenarioPackId: selScenarioId || undefined, loaded, personaId: selPersonaId || undefined, rulePackId: selRulePackId || undefined });
      setCampaigns(await window.dk.campaign.list());
      await openCampaign(c.id);
    } catch (e) {
      setNotice(`建团失败：${(e as Error).message}`);
      setShowNew(true); // 失败弹窗别关，用户可改设置重试
    }
  }

  // 建团后（或已有战役）侧边栏"重骰角色"：替换 PC 卡并刷新
  async function doRerollChar() {
    if (!campaignId) return;
    const p = await window.dk.characters.reroll();
    setChar({ name: p.name, occupation: p.occupation, attributes: p.attributes, derived: p.derived, skills: { ...p.topSkills } });
    setNotice(`角色已重骰：${p.name}（${p.occupation}，${p.age} 岁）`);
  }

  async function deleteCampaign(id: string, name: string) {
    setPendingDel({ id, name }); // 弹确认框
  }

  async function doDeleteCampaign() {
    if (!pendingDel) return;
    await window.dk.campaign.delete(pendingDel.id);
    setPendingDel(null);
    const list = await window.dk.campaign.list();
    setCampaigns(list);
    if (pendingDel.id === campaignId) {
      setCampaignId(null);
      setChar(null);
      setMsgs([]);
      setLastCheck(null);
    } else if (list.length > 0) {
      await openCampaign(list[0].id);
    }
  }

  async function openCampaign(id: string) {
    setCampaignId(id);
    await window.dk.campaign.open(id); // 关键：绑定主进程"当前战役"（漏了它 → session:start/chat:send 全报未打开战役）
    // 按当前战役刷新剧本包（开场白用 hooks[0]；曾只在挂载时取一次=内置雾港，选自定义剧本包开场仍默认）
    const info = await window.dk.scenario.info();
    setScenario(info);
    // 技能按钮类型（按当前战役规则包）：右侧技能栏按 action 渲染检定/叙事行动/不显示
    const f = await window.dk.characters.fields();
    setSkillActions(Object.fromEntries(f.skills.map((s) => [s.name, s.action])));
    setGmTitle(f.gmTitle ?? '主持人'); // 主持人称谓（规则包 gm_title）
    const chars = await window.dk.campaign.characters(id);
    setChar(chars[0] ?? null);
    // 反馈修复：重开战役恢复最近会话的聊天历史（不再每次新建空会话丢记录）
    const sessions = await window.dk.session.list();
    setLastSummary(sessions.find((s) => s.summary)?.summary ?? null); // 右栏展示上节摘要（守密人的记忆）
    if (sessions.length > 0) {
      const last = sessions[0];
      const data = await window.dk.session.open(last.id);
      if (data.messages.length > 0) {
        setMsgs(data.messages.map((m) => ({
          role: m.role === 'user' ? 'user' as const : 'keeper' as const,
          text: m.content,
          dice: m.diceResults,
        })));
        refreshAudit();
        return;
      }
    }
    // 无历史 → 新会话 + 剧本开场白
    const s = await window.dk.session.start();
    await window.dk.session.open(s.id);
    // 开场白：战役剧本包的 hooks（P2）；旧战役（无剧本包）回退硬编码开场
    const meta = (await window.dk.campaign.list()).find((c) => c.id === id);
    // 用局部 info 而非 scenario state（setScenario 异步，同函数内闭包仍是旧值=内置雾港）
    const opening = meta?.scenarioPackId && info
      ? `${info.hooks[0]}\n——冒险开始了。`
      : `雾港的钟声敲了三下。你（${chars[0]?.name ?? '无名调查员'}）推开酒馆的门，海盐与烟味扑面而来。老船长埃德加坐在角落，抬眼看向你。\n——冒险开始了。`;
    setMsgs([{ role: 'keeper', text: opening }]);
    refreshAudit();
  }

  async function doCheck(skill: string) {
    if (!campaignId || busy) return;
    setBusy(true);
    setPendingText('');
    try {
      // 检定接剧情：本地判定 → 立即显示骰面（onCheck 推送）→ AI 基于结果继续叙事（流式）
      const r = await window.dk.checkWithChat(skill);
      setLastCheck(r.check);
      setMsgs((m) => [...m, { role: 'keeper', text: r.narrative, dice: r.diceResults, issues: r.issues, prompt: r.promptPlayer }]);
      if (r.issues.length > 0) setNotice(`⚠ 校验拦截 ${r.issues.length} 处：${r.issues.map((i) => i.message).join('；')}`);
    } catch (e) {
      setMsgs((m) => [...m, { role: 'keeper', text: `（提示）${(e as Error).message.replace(/^Error invoking remote method '[^']+':\s*/, '')}` }]);
    }
    setPendingText('');
    setBusy(false);
    refreshAudit();
  }

  async function send(optText?: string) {
    const text = (optText ?? input).trim();
    if (!text || busy) return;
    // 玩家模式：消息走房间通道（房主本地判定 + AI 叙事，结果经广播回来）
    if (roomJoined) {
      setInput('');
      const r = await window.dk.room.send(text);
      if (!r.ok) setNotice(`发送失败：${r.error ?? ''}`);
      return;
    }
    if (!campaignId) { setNotice('请先在左侧「新建战役」或选择一个已有战役，再开始对话。'); return; }
    setInput('');
    setBusy(true);
    setPendingText('');
    setMsgs((m) => [...m, { role: 'user', text }]);
    try {
      const r = await window.dk.chat(text);
      setMsgs((m) => [...m, { role: 'keeper', text: r.narrative, dice: r.diceResults, issues: r.issues, prompt: r.promptPlayer }]);
      if (r.issues.length > 0) setNotice(`⚠ 校验拦截 ${r.issues.length} 处：${r.issues.map((i) => i.message).join('；')}`);
    } catch (e) {
      setMsgs((m) => [...m, { role: 'keeper', text: `（提示）${(e as Error).message.replace(/^Error invoking remote method '[^']+':\s*/, '')}` }]);
    }
    setPendingText('');
    setBusy(false);
    refreshAudit();
  }

  async function saveSettings() {
    const r = await window.dk.settings.set(cfg);
    setShowSettings(false);
    if (r.ok) setNotice(`已保存。配置了 API 后${gmTitle}即可响应。`);
  }

  useEffect(() => {
    window.dk.settings.get().then((s) => { setCfg({ baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model, defaultPersonaId: s.defaultPersonaId ?? '', tension: s.tension ?? { intensity: 50, surprise: 50, consequence: 50 } }); setSqliteOk(s.sqliteOk); });
  }, []);

  // —— P6 本地模式：打开设置时检测 Ollama；进度事件挂载一次 ——
  useEffect(() => {
    window.dk.ollama.onProgress((info) => setOllamaProg(info));
  }, []);
  useEffect(() => {
    if (!showSettings) return;
    setSettingsTab('ai'); // 每次打开设置回到第一个模块（弹窗太长问题：分 Tab 显示）
    setHwInfo(null);
    window.dk.ollama.status().then((s) => setOllama({ checked: true, running: s.running, managed: s.managed, version: s.version, openaiUrl: s.openaiUrl }));
    window.dk.ollama.models().then((ms) => setInstalledModels(ms.map((m) => m.name)));
  }, [showSettings]);

  // 一键启用：下载（如需）→ 解压 → 启动 → 自动硬件检测推荐
  async function doOllamaSetup() {
    setOllamaPhase('setup');
    setOllamaProg({ phase: 'start', pct: 0, label: '准备中…' });
    const r = await window.dk.ollama.setup();
    setOllamaPhase('idle');
    setOllamaProg(null);
    if (!r.ok) { setNotice(`本地模式启用失败：${r.error}`); return; }
    setOllama((o) => ({ ...o, running: true, version: r.version ?? o.version }));
    setNotice('Ollama 服务已就绪，检测硬件并选择模型即可开跑');
    const h = await window.dk.ollama.hwinfo();
    setHwInfo(h);
    window.dk.ollama.models().then((ms) => setInstalledModels(ms.map((m) => m.name)));
  }
  async function doHwInfo() {
    const h = await window.dk.ollama.hwinfo();
    setHwInfo(h);
  }
  // 已装模型 → 直接启用本地模式（写入 AI 设置指向本地端点）
  async function applyLocalModel(name: string) {
    const url = ollama.openaiUrl || 'http://127.0.0.1:11434/v1';
    const next = { ...cfg, baseUrl: url, apiKey: 'ollama', model: name };
    const r = await window.dk.settings.set(next);
    setCfg(next);
    if (r.ok) setNotice(`本地模型 ${name} 已启用 ✓（AI 设置已指向本机）`);
  }
  // 下载模型 → 完成后自动启用
  async function doPullModel(name: string) {
    setBusyModel(name);
    setOllamaPhase('pulling');
    setOllamaProg({ phase: 'pull', pct: 0, label: `${name} 连接下载…` });
    const r = await window.dk.ollama.pull(name);
    setOllamaPhase('idle');
    setBusyModel(null);
    setOllamaProg(null);
    if (!r.ok) { setNotice(`模型下载失败：${r.error}`); return; }
    window.dk.ollama.models().then((ms) => setInstalledModels(ms.map((m) => m.name)));
    await applyLocalModel(name);
  }

  const skillList = char ? Object.entries(char.skills).sort((a, b) => b[1] - a[1]) : [];

  // —— P5 联机操作：开房 / 关房 / 加入 / 离开 ——
  async function doHostRoom() {
    const r = await window.dk.room.host(0);
    if (!r.ok) { setNotice(`开房失败：${r.error ?? ''}`); return; }
    setHosting(true);
    setRoomAddr({ port: r.port ?? 0, addresses: r.addresses ?? [] });
    setRoomPlayers([]);
    setRoomNotice('');
    setNotice(`房间已开启，把地址（${(r.addresses?.[0] ?? '127.0.0.1')}:${r.port}）发给同一网络的玩家`);
  }
  async function closeHostRoom() {
    await window.dk.room.close();
    setHosting(false);
    setRoomAddr(null);
    setRoomPlayers([]);
  }
  async function doJoinRoom() {
    setJoinError('');
    setJoinState('connecting');
    const r = await window.dk.room.join({ address: joinAddr, name: joinName });
    if (!r.ok) { setJoinState('idle'); setJoinError(r.error ?? '加入失败'); return; }
    setRoomJoined(true);
    setNotice(`已加入房间，昵称「${joinName.trim() || '玩家'}」。发送消息由房主判定与叙事。`);
  }
  async function leaveRoom() {
    await window.dk.room.leave();
    setJoinState('idle');
    setRoomJoined(false);
    setRoomPlayers([]);
  }

  return (
    <div className="app">
      {!roomJoined && (
        <aside className="sidebar">
          <h1>🎲 DiceKeeper</h1>
          <p className="sub">AI 主持人跑团</p>
          {!sqliteOk && <p className="warn">⚠ SQLite 不可用（需 --experimental-sqlite）</p>}
          <button className="primary" onClick={() => { setShowNew(true); void rerollPreview(); }}>＋ 新建战役</button>
        <div className="campaign-list">
          {campaigns.map((c) => (
            <div key={c.id} className={c.id === campaignId ? 'campaign-row active' : 'campaign-row'}>
              <button className="campaign" onClick={() => openCampaign(c.id)} title={c.name}>
                {c.name} <span className="dim">（{c.pcCount} 名调查员{c.tokens ? ` · ≈${c.tokens.toLocaleString()} tokens` : ''}）</span>
              </button>
              <button className="campaign-del" title="删除战役" onClick={() => deleteCampaign(c.id, c.name)}>×</button>
            </div>
          ))}
          {campaigns.length === 0 && <div className="dim empty-hint">还没有战役，点上方「＋ 新建战役」开始</div>}
        </div>
        {char && (
          <div className="char-mini">
            <div className="char-name">{char.name}<span className="dim"> · {char.gender ?? ''} · {char.occupation}</span></div>
            <div className="attrs">
              {Object.entries(char.attributes).map(([k, v]) => (
                <HoverTip key={k} text={`${COC_ATTRIBUTE_DESC[k] ?? '属性'}`}>
                  <span className="attr-item">{k}{v}</span>
                </HoverTip>
              ))}
            </div>
            <div className="derived">
              {Object.entries(char.derived).slice(0, 4).map(([k, v]) => (
                <HoverTip key={k} text={`${COC_DERIVED_DESC[k] ?? '衍生值'}`}>
                  <span className="attr-item">{k} {v}</span>
                </HoverTip>
              ))}
            </div>
            <div className="char-btns">
              <button className="ghost char-reroll" onClick={doRerollChar} title="重骰角色卡（保留名字）" disabled={busy}>🎲 重骰</button>
              <button className="ghost char-edit-btn" onClick={() => openCharEdit('existing')} title="手动编辑角色卡" disabled={busy}>✏️ 编辑</button>
            </div>
          </div>
        )}
        <HoverTip text={`把本节全部对话压缩成一份摘要存档。\n下一节${gmTitle}只带摘要（不再逐轮重发本节全文），更省 token、记忆更清晰。\n一段冒险告一段落、或对话较长时点一下即可；不点也能继续玩。`}>
          <button className="ghost" onClick={endSession} disabled={!campaignId}>📔 结束本节（存摘要）</button>
        </HoverTip>
        <button className="ghost" onClick={() => setRoomModal(true)}>🌐 联机</button>
        <button className="ghost" onClick={() => setShowSettings(true)}>⚙ 设置</button>
        </aside>
      )}

      <main className="chat">
        {roomJoined && (
          <div className="room-banner">
            🌐 已连接到房主 · 玩家模式（判定与 AI 由房主本地执行）
            <button className="ghost" onClick={() => setRoomModal(true)}>联机详情</button>
          </div>
        )}
        <div className="messages">
          {msgs.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              <div className="bubble">{m.text}</div>
              {m.dice && m.dice.length > 0 && <div className="dice-ref">🎲 本轮包含 {m.dice.length} 次本地掷骰（详见右侧审计）</div>}
              {m.role === 'keeper' && m.prompt && (
                <div className="prompt-opts">
                  {parsePromptOptions(m.prompt).map((opt, j) => (
                    <button key={j} className="prompt-opt" onClick={() => send(opt)} disabled={busy}>{opt}</button>
                  ))}
                </div>
              )}
            </div>
          ))}
          {busy && (
            <div className="msg keeper">
              <div className={pendingText ? 'bubble streaming' : 'bubble typing'}>
                  {pendingText || `${gmTitle}沉思中…`}
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
        <div className="composer">
          {!roomJoined && campaignId && (sceneBar.persons.length > 0 || sceneBar.places.length > 0) && (
            <div className="scene-bar">
              <div className="scene-tabs">
                <button
                  className={sceneTab === 'persons' ? 'scene-tab active' : 'scene-tab'}
                  onClick={() => setSceneTab(sceneTab === 'persons' ? null : 'persons')}
                  title="和见过的角色说话（点击展开）"
                >人物{sceneBar.persons.length > 0 ? `（${sceneBar.persons.length}）` : ''}</button>
                <button
                  className={sceneTab === 'places' ? 'scene-tab active' : 'scene-tab'}
                  onClick={() => setSceneTab(sceneTab === 'places' ? null : 'places')}
                  title="前往其他地点（点击展开）"
                >地点{sceneBar.places.length > 0 ? `（${sceneBar.places.length}）` : ''}</button>
              </div>
              {sceneTab === 'persons' && sceneBar.persons.length > 0 && (
                <div className="scene-list">
                  {sceneBar.persons.map((n) => (
                    <button key={n.id} className="scene-item" onClick={() => { setSceneTab(null); setInput(`@${n.name} `); inputRef.current?.focus(); }} title={`和${n.name}说话（点击填入输入框）`}>
                      {n.name}{n.here ? '（此处）' : ''}
                    </button>
                  ))}
                </div>
              )}
              {sceneTab === 'places' && sceneBar.places.length > 0 && (
                <div className="scene-list">
                  {sceneBar.places.map((p) => (
                    <button key={p.id} className="scene-item" onClick={() => { setSceneTab(null); setInput(`前往${p.name}`); inputRef.current?.focus(); }} disabled={p.here} title={p.here ? '当前所在' : `前往${p.name}（点击填入输入框）`}>
                      {p.name}{p.here ? '（此地）' : ''}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="composer-wrap">
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => onInputChange(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
              placeholder={roomJoined
                ? `描述你的行动…（由房主${gmTitle}响应）`
                : scenario?.place
                  ? `描述你的行动…（例：去${scenario.place} / @${scenario.person ?? '某人'} 聊聊 / 查看周围）`
                  : '描述你的行动…（例：前往某地 / 找人聊聊 / 查看周围）'}
              disabled={busy}
            />
            {atCandidates.length > 0 && (
              <div className="at-pop">
                {atCandidates.map((c) => (
                  <button key={c.id} className="at-item" onClick={() => pickAt(c.name)}>
                    {c.name} <span className="dim">{c.type}{c.location ? ` · ${c.location}` : ''}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* 修复：onClick 曾直接绑 send —— React 会把 click 事件当 optText 传入导致 TypeError 静默失败（"发送键不管用只能回车"） */}
          <button className="primary" onClick={() => send()} disabled={busy}>{busy ? `${gmTitle}思考中…` : '发送'}</button>
        </div>
        {notice && <div className="notice">{notice}</div>}
      </main>

      {!roomJoined && (
      <aside className="panel">
        <section>
          <h3>技能检定</h3>
          {lastCheck && (
            <div className={`verdict ${lastCheck.outcome}`}>
              <b>{lastCheck.label}</b> <span>{lastCheck.detail}</span>
            </div>
          )}
          <div className="skill-grid">
            {skillList.slice(0, 12).map(([name, v]) => {
              const action = skillActions[name] ?? 'check';
              // action=none：不渲染按钮（规则包声明该技能非检定也非行动按钮）
              if (action === 'none') return null;
              // action=narrative：叙事行动——不掷骰，作为行动消息发送由守密人叙事推进
              if (action === 'narrative') {
                return (
                  <HoverTip key={name} text={`${COC_SKILL_DESC[name] ?? '技能'}（当前 ${v}）· 叙事行动：不掷骰，点击发送行动由${gmTitle}叙事推进`}>
                    <button className="skill skill-narrative" onClick={() => send(`我使用「${name}」（当前 ${v}）`)} disabled={busy}>
                      {name} <span className="dim">{v} · 行动</span>
                    </button>
                  </HoverTip>
                );
              }
              return (
                <HoverTip key={name} text={`${COC_SKILL_DESC[name] ?? '技能'}（当前 ${v}%，点击检定）`}>
                  <button className="skill" onClick={() => doCheck(name)} disabled={busy}>
                    {name} <span className="dim">{v}</span>
                  </button>
                </HoverTip>
              );
            })}
          </div>
        </section>
        <section>
          <h3>掷骰审计（最近）</h3>
          <ul className="dice-log">
            {diceLog.slice(0, 10).map((d) => (
              <li key={d.id}><b>{d.result}</b> [{d.expression}] {d.reason} <span className="dim">由{d.requested_by === 'player' ? '玩家' : gmTitle}</span></li>
            ))}
            {diceLog.length === 0 && <li className="dim">暂无记录</li>}
          </ul>
        </section>
        <section>
          <h3>地图 / 位置</h3>
          {worldData ? (
            <div className="map-card">
              {(() => {
                const pc = worldData.entities.find((e) => e.type === 'pc');
                const loc = pc && typeof pc.data.location === 'string' ? pc.data.location : null;
                const npcs = worldData.entities
                  .filter((e) => e.type === 'npc' && e.data.met === true && e.data.alive !== false)
                  .sort((a, b) => String(b.data.updated_at ?? '').localeCompare(String(a.data.updated_at ?? '')));
                return (
                  <>
                    <div className="map-where">📍 你在：<b>{loc ?? '未知'}</b></div>
                    {npcs.length > 0 && (
                      <ul className="dice-log">
                        {npcs.slice(0, 8).map((e) => (
                          <li key={e.id}>
                            {e.name} <span className="dim">{typeof e.data.location === 'string' && e.data.location ? e.data.location : '位置未知'}{typeof e.data.state === 'string' && e.data.state ? ` · ${e.data.state.slice(0, 14)}` : ''}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {npcs.length === 0 && <li className="dim">还没遇到过谁——在对话中提起/遇见人物后，他们才会出现在这里和 @ 列表里</li>}
                  </>
                );
              })()}
            </div>
          ) : <li className="dim">加载中…</li>}
        </section>
        <section>
            <h3>{gmTitle}的记忆（上节摘要）</h3>
          {lastSummary ? (
              <div className="summary-card" title={`每轮对话都会注入${gmTitle}的上下文，开场叙事会自然带出`}>
              {lastSummary.slice(0, 140)}{lastSummary.length > 140 ? '…' : ''}
            </div>
          ) : <li className="dim">暂无存档摘要（点「📔 结束本节」后生成，供下一节{gmTitle}引用）</li>}
        </section>
        <section>
          <h3>上下文占用</h3>
          {tokenUsage ? (
              <HoverTip text={`${gmTitle}每轮回复都要发送这些内容（按 1 字 ≈ 1 token 估算）。对话越长每轮越贵越慢——点「结束本节」把消息压缩成摘要存档即可下降。`}>
              <div className="token-card">
                <div>消息：<b>{tokenUsage.messages.toLocaleString()}</b> tokens（{tokenUsage.msgCount} 条）</div>
                <div>系统提示：<b>{tokenUsage.system.toLocaleString()}</b> tokens</div>
                <div className="dim">每轮合计 ≈ <b>{tokenUsage.total.toLocaleString()}</b> tokens</div>
              </div>
            </HoverTip>
          ) : <li className="dim">打开战役后显示</li>}
        </section>
        <section>
          <h3>记忆档案（L3）</h3>
          {worldData ? (
            <>
              {worldData.facts.length > 0 && (
                <ul className="dice-log">
                  {worldData.facts.slice(-6).reverse().map((f) => (
                    <li key={f.id} className="fact-row">
                      <span className={`tag-${f.importance}`}>{f.importance === 'high' ? '重' : f.importance === 'low' ? '轻' : '常'}</span>
                      <span className="fact-text" title={f.fact}>{f.fact.slice(0, 24)}{f.fact.length > 24 ? '…' : ''}</span>
                      <span className="pack-actions">
                        <select className="mini-select" value={f.importance} onChange={(e) => onUpdateFact(f.id, { importance: e.target.value })} title="调整重要性">
                          <option value="high">重</option>
                          <option value="normal">常</option>
                          <option value="low">轻</option>
                        </select>
                        <button className="danger-mini" title="删除此事实" onClick={() => onDeleteFact(f.id)}>×</button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {worldData.relations.length > 0 && (
                <ul className="dice-log">
                  {worldData.relations.slice(-5).reverse().map((r) => (
                    <li key={r.id} className="fact-row">
                      <span className="fact-text">{r.a} —{r.relationType}— {r.b}</span>
                      <button className="danger-mini" title="删除此关系" onClick={() => onDeleteRelation(r.id)}>×</button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="fact-add">
                <input value={newFactText} placeholder="＋ 人工记录事实（标记重点）" onChange={(e) => setNewFactText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onAddFact()} />
                <select className="mini-select" value={newFactImportance} onChange={(e) => setNewFactImportance(e.target.value)}>
                  <option value="high">重</option>
                  <option value="normal">常</option>
                  <option value="low">轻</option>
                </select>
                <button className="ghost" onClick={onAddFact}>＋</button>
              </div>
              {worldData.facts.length === 0 && worldData.relations.length === 0 && <li className="dim">暂无记忆（{gmTitle}通过 remember / 互动会逐步建立；也可手动记录）</li>}
            </>
          ) : <li className="dim">加载中…</li>}
        </section>
        <section>
          <h3>变更日志（可回滚）</h3>
          {worldData && worldData.changes.length > 0 ? (
            <ul className="dice-log">
              {worldData.changes.slice(0, 8).map((c) => (
                <li key={c.id} className="fact-row">
                  <span className={`chg-kind chg-${c.kind}`}>{c.kind === 'manual' ? '手' : c.kind === 'entity_update' ? '改' : c.kind === 'entity_add' ? '增' : '记'}</span>
                  <span className="fact-text" title={summarizeChange(c, gmTitle)}>{summarizeChange(c, gmTitle)}</span>
                  {c.kind !== 'manual' && <button className="danger-mini" title="回滚此变更" onClick={() => onRollback(c.id)}>↺</button>}
                </li>
              ))}
            </ul>
          ) : <li className="dim">暂无变更（世界状态被修改时记录，可回滚）</li>}
        </section>
      </aside>
      )}

      {/* P5 联机弹窗（房主开房 / 玩家加入） */}
      {roomModal && (
        <div className="modal" onClick={(e) => onModalMask(e, () => setRoomModal(false))} onMouseDownCapture={DRAG_GUARD.onMouseDownCapture}>
          <div className="modal-body" onClick={(e) => e.stopPropagation()}>
            <h2>局域网联机</h2>
            <p className="hint">房主开房后，同一网络（或 Tailscale / ZeroTier 虚拟局域网）内的玩家输入「地址:端口」加入。掷骰判定与 AI 叙事全在房主本地执行，玩家为轻量端。</p>

            <div className="packs-box">
              <div className="packs-head"><b>房主模式</b>{hosting && <span className="tag ok">房间运行中</span>}</div>
              {!hosting ? (
                <div className="ollama-actions">
                  <button className="ghost" onClick={doHostRoom} disabled={joinState === 'joined'}>▶ 开启房间（局域网）</button>
                  <span className="dim small">开房后本机继续正常游玩，玩家行动会并入当前战役</span>
                </div>
              ) : (
                <>
                  <div className="dim small">把地址发给玩家（同一网络直接可用；跨网先连 Tailscale/ZeroTier）：</div>
                  {roomAddr && roomAddr.addresses.map((a) => (
                    <div key={a} className="room-addr">{a}:{roomAddr.port}</div>
                  ))}
                  <div className="room-players">
                    <b>房间玩家（{roomPlayers.length}）</b>
                    {roomPlayers.map((p) => <div key={p.id} className="dim">{p.name}</div>)}
                    {roomPlayers.length === 0 && <span className="dim small">等待玩家加入…</span>}
                  </div>
                  {roomNotice && <div className="dim small">{roomNotice}</div>}
                  <button className="ghost" onClick={closeHostRoom}>关闭房间</button>
                </>
              )}
            </div>

            <div className="packs-box">
              <div className="packs-head"><b>玩家模式</b>{joinState === 'joined' && <span className="tag ok">已连接</span>}</div>
              {joinState === 'idle' || joinState === 'connecting' ? (
                <>
                  <label>房主地址 <input value={joinAddr} onChange={(e) => setJoinAddr(e.target.value)} placeholder="192.168.1.5:12345" disabled={hosting || joinState === 'connecting'} /></label>
                  <label>昵称 <input value={joinName} onChange={(e) => setJoinName(e.target.value)} placeholder="你的称呼（房主可见）" maxLength={16} disabled={hosting || joinState === 'connecting'} /></label>
                  {joinError && <div className="err-msg">{joinError}</div>}
                  <div className="ollama-actions">
                    <button className="ghost" onClick={doJoinRoom} disabled={hosting || joinState === 'connecting'}>{joinState === 'connecting' ? '连接中…' : '加入房间'}</button>
                  </div>
                </>
              ) : (
                <>
                  <div className="dim">已连接房主。你发送的消息由房主判定与叙事；收到回复前可以继续说话。</div>
                  <div className="room-players">
                    <b>房间玩家（{roomPlayers.length}）</b>
                    {roomPlayers.map((p) => <div key={p.id} className="dim">{p.name}</div>)}
                  </div>
                  <button className="ghost" onClick={leaveRoom}>离开房间</button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {showNew && (
        <div className="modal" onClick={(e) => onModalMask(e, () => setShowNew(false))} onMouseDownCapture={DRAG_GUARD.onMouseDownCapture}>
          <div className={`modal-body${editMode ? ' modal-wide' : ''}`} onClick={(e) => e.stopPropagation()}>
            <h2>新建战役</h2>
            <label>战役名称
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && doCreateCampaign()}
                placeholder="如：旧港疑云"
                autoFocus
              />
            </label>
            {rulePacksList.length > 0 && (
              <label>规则包
                <select value={selRulePackId} onChange={(e) => handleRulePackChange(e.target.value)}>
                  <option value="">默认（克苏鲁的呼唤 7 版）</option>
                  {rulePacksList.map((rp) => (
                    <option key={rp.id} value={rp.id}>{rp.name} v{rp.version}</option>
                  ))}
                </select>
                <span className="dim">决定属性/技能/检定规则；剧本包下拉会随所选规则包联动（剧情包只能配套对应规则包）</span>
                {selRulePackId && (
                  <button className="ghost" onClick={() => void applyRulePack()} disabled={previewBusy}>
                    {editMode ? '🔄 按规则包刷新编辑' : '🎲 按规则包生成角色卡'}
                  </button>
                )}
              </label>
            )}
            {scenarioPacks.length > 0 && (
              <label>剧本包
                {/* 只显示与所选规则包配套的剧本包（用户要求：剧情包只能根据规则包选择） */}
                {compatScenarios.length > 0 ? (
                  <select value={selScenarioId} onChange={(e) => setSelScenarioId(e.target.value)}>
                    {compatScenarios.map((sp) => (
                      <option key={sp.id} value={sp.id}>{sp.name} v{sp.version}{sp.isBuiltin ? '（内置）' : ''}（{sp.requires ? `规则：${ruleNameOf(sp.requires)}` : '通用'}）</option>
                    ))}
                  </select>
                ) : (
                  <span className="dim">该规则包暂无配套剧本包——可在设置→内容包「新建剧本包」时指定 requires 为该规则包，或导入配套 .dk</span>
                )}
                <span className="dim">建团即载入该剧本的世界观、NPC 种子与线索；更多剧本包可在设置→内容包导入 .dk</span>
              </label>
            )}
            {personas && (
              <label>主持人风格（人格包）
                <select value={selPersonaId} onChange={(e) => setSelPersonaId(e.target.value)}>
                  {[...personas.presets, ...personas.custom].map((p) => (
                    <option key={p.id} value={p.id}>{p.name}{p.isCustom ? '（自定义）' : ''}</option>
                  ))}
                </select>
                <span className="dim">可后续在设置→主持人风格里自建；不选用全局默认</span>
              </label>
            )}
            <div className="chargen-box">
              <div className="chargen-mode">
                {!editMode && <button className="ghost" onClick={() => { setEditMode(true); void openCharEdit('new'); }}>✏️ 手动编辑</button>}
                {editMode && <button className="ghost" onClick={() => { setEditMode(false); setEditModal(null); }}>← 返回随机</button>}
              </div>
              {!editMode ? (
                <>
                  <label>调查员名字
                    <input value={charName} onChange={(e) => setCharName(e.target.value)} placeholder="无名调查员" />
                  </label>
                  <button className="primary" onClick={rerollPreview}>🎲 随机车卡</button>
                  <label className="inline-check">
                    <input type="checkbox" checked={loaded} onChange={(e) => setLoaded(e.target.checked)} />
                    <span>灌铅模式（属性骰重复投一次取更优，角色更强）</span>
                  </label>
                  {preview && (
                    <div className="char-preview">
                      <div className="char-preview-head">
                        <b>{preview.name}</b>
                        <span className="dim"> · {preview.occupation} · {preview.age} 岁</span>
                      </div>
                      <div className="attrs">{Object.entries(preview.attributes).map(([k, v]) => `${k} ${v}`).join('  ')}</div>
                      {/* 衍生值按规则包动态渲染（曾硬编码 HP/MP/SAN/幸运=CoC 名，非 CoC 包显示 undefined/默认名） */}
                      <div className="derived">{Object.entries(preview.derived).map(([k, v]) => `${k} ${v}`).join('  ')}</div>
                      <div className="dim">擅长：{Object.entries(preview.topSkills).slice(0, 5).map(([k, v]) => `${k} ${v}`).join(' · ')}</div>
                    </div>
                  )}
                  <p className="hint">可反复点「随机车卡」直到满意；也可切「手动编辑」在随机结果上微调。</p>
                </>
              ) : (
                <>
                  {editSpec && charFields && (
                    <>
                      <CharEdit fields={charFields} spec={editSpec} derived={editDerived} onChange={setEditSpec} />
                      <div className="ce-tools">
                        <button className="ghost" onClick={rerollLuck}>🎲 重掷幸运</button>
                        <span className="dim">幸运 = 3d6×5，随机；其余衍生随属性自动算</span>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
            <div className="modal-actions">
              {editMode
                ? <button className="primary" onClick={saveCharEdit}>保存并创建</button>
                : <button className="primary" onClick={doCreateCampaign}>创建</button>}
              <button className="ghost" onClick={() => setShowNew(false)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {pendingDel && (
        <div className="modal" onClick={(e) => onModalMask(e, () => setPendingDel(null))} onMouseDownCapture={DRAG_GUARD.onMouseDownCapture}>
          <div className="modal-body" onClick={(e) => e.stopPropagation()}>
            <h2>删除战役</h2>
            <p>确定删除「{pendingDel.name}」？其全部角色、对话记录、世界状态将一并删除，<b>无法恢复</b>。</p>
            <div className="modal-actions">
              <button className="danger" onClick={doDeleteCampaign}>删除</button>
              <button className="ghost" onClick={() => setPendingDel(null)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {editModal === 'existing' && editSpec && charFields && (
        <div className="modal" onClick={(e) => onModalMask(e, () => setEditModal(null))} onMouseDownCapture={DRAG_GUARD.onMouseDownCapture}>
          <div className="modal-body modal-wide" onClick={(e) => e.stopPropagation()}>
            <h2>编辑角色卡</h2>
            <CharEdit fields={charFields} spec={editSpec} derived={editDerived} onChange={setEditSpec} />
            <div className="ce-tools">
              <button className="ghost" onClick={rerollLuck}>🎲 重掷幸运</button>
              <span className="dim">技能右栏为初始值；保存后检定按新数值执行</span>
            </div>
            <div className="modal-actions">
              <button className="primary" onClick={saveCharEdit}>保存</button>
              <button className="ghost" onClick={() => setEditModal(null)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {showSettings && (
        <div className="modal" onClick={(e) => onModalMask(e, () => setShowSettings(false))} onMouseDownCapture={DRAG_GUARD.onMouseDownCapture}>
          <div className="modal-body settings-modal" onClick={(e) => e.stopPropagation()}>
            <h2>设置</h2>
            <div className="settings-tabs">
              {([
                ['ai', 'AI 服务'],
                ['local', '本地模式'],
                ['drama', '戏剧引擎'],
                ['persona', '主持人风格'],
                ['packs', '内容包'],
              ] as const).map(([key, label]) => (
                <button key={key} className={settingsTab === key ? 'settings-tab active' : 'settings-tab'} onClick={() => setSettingsTab(key)}>{label}</button>
              ))}
            </div>

            {settingsTab === 'ai' && (
            <>
            <div className="preset-row">
              <span className="dim">预设：</span>
              {Object.entries(PRESETS).map(([k, p]) => (
                <button key={k} className="ghost preset-btn" onClick={() => applyPreset(k)} title={p.hint}>{p.label}</button>
              ))}
            </div>
            <label>接口地址 <input value={cfg.baseUrl} onChange={(e) => setCfg({ ...cfg, baseUrl: e.target.value })} placeholder="https://api.deepseek.com" /></label>
            <label>API 密钥 <input value={cfg.apiKey} onChange={(e) => setCfg({ ...cfg, apiKey: e.target.value })} placeholder="sk-..." type="password" /></label>
            <label>模型名称 <input value={cfg.model} onChange={(e) => setCfg({ ...cfg, model: e.target.value })} placeholder="deepseek-v4-flash / qwen-plus / qwen2.5:7b" /></label>
            <div className="test-row">
              <button className="ghost" onClick={testConnection} disabled={testing}>{testing ? '测试中…' : '🛜 测试连接'}</button>
              {testResult && (
                <div className={`test-result ${testResult.ok ? 'ok' : 'fail'}`}>
                  {testResult.ok
                    ? <>✓ 连接成功（HTTP {testResult.status}），发现 {testResult.models?.length ?? 0} 个模型：</>
                    : <>✗ 连接失败：{testResult.error}</>}
                </div>
              )}
              {testResult?.ok && testResult.models && testResult.models.length > 0 && (
                <div className="model-list">
                  {testResult.models.slice(0, 12).map((m) => (
                    <button key={m} className="ghost model-chip" onClick={() => setCfg({ ...cfg, model: m })} title="点此选用">{m}</button>
                  ))}
                  {testResult.models.length > 12 && <span className="dim">…共 {testResult.models.length} 个</span>}
                </div>
              )}
            </div>
            <p className="hint">预设仅填入地址与建议模型名，密钥需自己粘贴；「测试连接」会拉取该服务的可用模型列表，点击即可选用。</p>
            </>
            )}

            {settingsTab === 'local' && (
            <>
            {/* P6 本地模式（§3.2：Ollama 应用内托管 + 硬件检测推荐模型，抄 Jan Model Hub 交互） */}
            <div className="packs-box">
              <div className="packs-head">
                <b>本地模式（Ollama · 免费 / 断网可用）</b>
                {cfg.baseUrl.includes('11434') && <span className="tag ok">当前使用中</span>}
              </div>
              <div className="ollama-status">
                {!ollama.checked
                  ? '⏳ 检测 Ollama 服务…'
                  : ollama.running
                    ? <>● <b>运行中</b>{ollama.version ? `（v${ollama.version}）` : ''}</>
                    : <>○ 未运行{ollama.managed ? '（便携版已就绪）' : ''}</>}
              </div>
              {!ollama.running && (
                <div className="ollama-actions">
                  <button className="ghost" disabled={ollamaPhase !== 'idle'} onClick={doOllamaSetup}>
                    {ollamaPhase === 'setup' ? '启用中…' : ollama.managed ? '▶ 启动本地服务' : '📥 下载并启用本地模式'}
                  </button>
                  <span className="dim small">自动检测已安装的 Ollama；未装则下载官方便携版（约 1~2GB）到本机，无需安装器、无需管理员权限</span>
                </div>
              )}
              {ollamaPhase === 'setup' && ollamaProg && (
                <div className="ollama-progress">
                  <div className="bar"><div className="fill" style={{ width: `${Math.max(ollamaProg.pct, 3)}%` }} /></div>
                  <span className="dim small">{ollamaProg.label}</span>
                </div>
              )}
              {ollama.running && (
                <>
                  <div className="ollama-hw">
                    <button className="ghost" onClick={doHwInfo}>🔍 检测硬件并推荐模型</button>
                    {hwInfo && (
                      <span className="dim small">
                        内存 {hwInfo.totalRamGB ? `${hwInfo.totalRamGB}GB` : '未知'} · {hwInfo.gpuName ?? '无独立显卡'}{hwInfo.vramGB ? `（${hwInfo.vramGB}GB 显存）` : ''}
                        {' → 推荐 '}<b>{hwInfo.recommend}</b>
                      </span>
                    )}
                  </div>
                  <div className="ollama-models">
                    {MODEL_CARDS.map((m) => {
                      const isInstalled = installedModels.includes(m.name);
                      const isBusy = busyModel === m.name;
                      const isRec = hwInfo?.recommend === m.name;
                      return (
                        <div key={m.name} className={`ollama-card${isRec ? ' rec' : ''}`}>
                          <div className="ollama-card-head">
                            <b>{m.name}</b>
                            {isRec && <span className="tag">推荐</span>}
                            {isInstalled && <span className="tag ok">已安装</span>}
                          </div>
                          <div className="dim small">{m.sizeLabel} · {m.ram}</div>
                          <div className="dim small">{m.note}</div>
                          <button
                            className="ghost" disabled={isBusy || ollamaPhase !== 'idle'}
                            onClick={() => (isInstalled ? applyLocalModel(m.name) : doPullModel(m.name))}
                          >
                            {isBusy ? '下载中…' : isInstalled ? '✓ 使用此模型' : '📥 下载并启用'}
                          </button>
                          {isBusy && ollamaProg && (
                            <div className="ollama-progress">
                              <div className="bar"><div className="fill" style={{ width: `${Math.max(ollamaProg.pct, 3)}%` }} /></div>
                              <span className="dim small">{ollamaProg.label}</span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <p className="hint">模型走本机推理：隐私、免费、断网可用。质量上限约 7B 档（与云端大模型有差距）；「下载并启用」完成后上方 AI 设置自动指向 {ollama.openaiUrl || 'http://127.0.0.1:11434/v1'}。</p>
                </>
              )}
            </div>
            </>
            )}

            {settingsTab === 'drama' && (
            <>
            {/* P4 张力仪表（§11.7 戏剧引擎：玩家可调滑杆，本地数值注入 prompt） */}
            <div className="packs-box">
              <div className="packs-head"><b>戏剧引擎（张力仪表）</b></div>
              {([
                ['intensity', '张力强度', '多紧绷：高=紧迫感强、倒计时感明显；低=松弛铺垫'],
                ['surprise', '意外频率', '多转折：高=高频两难/时限事件；低=平铺直叙'],
                ['consequence', '失败代价', '多严苛：高=失败受伤/恶化局势；低=失败影响叙事但不致命'],
              ] as const).map(([key, label, hint]) => (
                <label key={key} className="tension-row">
                  <span className="tension-label">{label}：<b>{cfg.tension[key]}</b></span>
                  <input
                    type="range" min={0} max={100} step={5} value={cfg.tension[key]}
                    onChange={(e) => setCfg({ ...cfg, tension: { ...cfg.tension, [key]: Number(e.target.value) } })}
                  />
                  <span className="dim">{hint}</span>
                </label>
              ))}
            </div>
            </>
            )}

            {settingsTab === 'persona' && (
            <>
            {/* B5 人格包（§3.6：预设 6 档 + 玩家自建 + 全局默认） */}
            <div className="packs-box">
              <div className="packs-head">
                <b>主持人风格（人格包）</b>
                <button className="ghost" onClick={newPersonaDraft}>＋ 自建人格</button>
              </div>
              {personas && (
                <div className="persona-row">
                  <span className="dim">全局默认：</span>
                  <select value={cfg.defaultPersonaId ?? ''} onChange={(e) => setCfg({ ...cfg, defaultPersonaId: e.target.value })}>
                    {[...personas.presets, ...personas.custom].map((p) => (
                      <option key={p.id} value={p.id}>{p.name}{p.isCustom ? '（自定义）' : ''}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="persona-list">
                {personas && [...personas.presets, ...personas.custom].map((p) => (
                  <div key={p.id} className="persona-card">
                    <div className="persona-card-head">
                      <b>{p.name}</b>
                      <span className="pack-actions">
                        <button className="ghost" onClick={() => editPersona(p)}>✏️</button>
                        {p.isCustom && <button className="ghost" onClick={() => deletePersona(p)}>🗑</button>}
                      </span>
                    </div>
                    <div className="dim">{p.description ?? ''}</div>
                    <div className="dim small">裁决：{p.rulings.slice(0, 26)}{p.rulings.length > 26 ? '…' : ''}</div>
                  </div>
                ))}
              </div>
              {personaDraft && (
                <div className="persona-edit">
                  <div className="ce-row">
                    <label>名称<input value={personaDraft.name} onChange={(e) => setPersonaDraft({ ...personaDraft, name: e.target.value })} placeholder="如：冷面档案员" /></label>
                    <label>一句话说明<input value={personaDraft.description ?? ''} onChange={(e) => setPersonaDraft({ ...personaDraft, description: e.target.value })} /></label>
                  </div>
                  <label>语气<textarea rows={2} value={personaDraft.tone} onChange={(e) => setPersonaDraft({ ...personaDraft, tone: e.target.value })} placeholder="如：冷静、克制、带书卷气" /></label>
                  <label>主持风格<textarea rows={2} value={personaDraft.style} onChange={(e) => setPersonaDraft({ ...personaDraft, style: e.target.value })} placeholder="如：按部就班，细节完整" /></label>
                  <label>叙事偏好<textarea rows={2} value={personaDraft.narration} onChange={(e) => setPersonaDraft({ ...personaDraft, narration: e.target.value })} placeholder="如：感官细节浓重，短句制造氛围" /></label>
                  <label>裁决哲学<textarea rows={2} value={personaDraft.rulings} onChange={(e) => setPersonaDraft({ ...personaDraft, rulings: e.target.value })} placeholder="如：严格，失败带代价" /></label>
                  <div className="ce-row">
                    <label>口头禅（每行一条）
                      <textarea rows={2} value={personaDraft.catchphrases.join('\n')} onChange={(e) => setPersonaDraft({ ...personaDraft, catchphrases: e.target.value.split('\n') })} placeholder={'如：\n有意思。\n你确定？'} />
                    </label>
                    <button className="primary" onClick={savePersonaDraft}>保存人格</button>
                    <button className="ghost" onClick={() => setPersonaDraft(null)}>取消</button>
                  </div>
                </div>
              )}
              <p className="hint">人格影响{gmTitle}的语气/风格/裁决倾向；建团时可选，也可在此设全局默认。自建人格存本机。</p>
            </div>
            </>
            )}

            {settingsTab === 'packs' && (
            <>
            <div className="packs-box">
              <div className="packs-head">
                <b>内容包（规则包 / 剧本包）</b>
                <span className="pack-actions">
                  <button className="ghost" onClick={() => doNewPack('rule')} title="从零创建规则包">＋ 新建规则包</button>
                  <button className="ghost" onClick={() => doNewPack('scenario')} title="从零创建剧本包">＋ 新建剧本包</button>
                  <button className="ghost" onClick={doImportPack}>📥 导入 .dk</button>
                </span>
              </div>
              <button className="ghost" onClick={refreshPacks}>刷新列表</button>
              {packsInfo && (
                <div className="packs-list">
                  <div className="dim">规则包</div>
                  {packsInfo.rulePacks.map((m) => (
                    <div key={m.type + m.id} className="pack-row">
                      <span>{m.name} <span className="dim">v{m.version}{m.isBuiltin ? '（内置）' : ''}</span></span>
                      <span className="pack-actions">
                        <button className="ghost" onClick={() => setPackEditor({ type: 'rule', meta: m })} title="可视化编辑规则包">✏️ 编辑</button>
                        <button className="ghost" onClick={() => doExportPack('rule', m.id, m.name)}>导出</button>
                        {!m.isBuiltin && <button className="ghost" onClick={() => doDeletePack('rule', m.id, m.name)}>删除</button>}
                      </span>
                    </div>
                  ))}
                  <div className="dim">剧本包</div>
                  {packsInfo.scenarioPacks.map((m) => (
                    <div key={m.type + m.id} className="pack-row">
                      <span>{m.name} <span className="dim">v{m.version}{m.isBuiltin ? '（内置）' : ''}{m.requires ? ` · 需规则 ${m.requires}` : ''}</span></span>
                      <span className="pack-actions">
                        <button className="ghost" onClick={() => setPackEditor({ type: 'scenario', meta: m })} title="可视化编辑剧本包">✏️ 编辑</button>
                        <button className="ghost" onClick={() => doExportPack('scenario', m.id, m.name)}>导出</button>
                        {!m.isBuiltin && <button className="ghost" onClick={() => doDeletePack('scenario', m.id, m.name)}>删除</button>}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {packNotice && <div className="pack-notice">{packNotice}</div>}
              <p className="hint">导出：把包分享给朋友，对方在「内容包→导入 .dk」即可使用；剧本包导入时会检查依赖的规则包。✏️ 编辑：可视化修改内容（内置包保存时自动另存为副本）。</p>
            </div>
            </>
            )}
            <div className="modal-actions">
              <button className="primary" onClick={saveSettings}>保存</button>
              <button className="ghost" onClick={() => setShowSettings(false)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {importPending && (
        <div className="modal" onClick={(e) => { if (e.target === e.currentTarget && !DRAG_GUARD.isDrag(e)) setImportPending(null); }} onMouseDownCapture={DRAG_GUARD.onMouseDownCapture}>
          <div className="modal-body" onClick={(e) => e.stopPropagation()}>
            <h2>内容包已存在</h2>
            <p>
              「<b>{importPending.name}</b> v{importPending.version}」（id: {importPending.id}）已安装。
              导入将覆盖原内容，或可换名导入保留两者。
            </p>
            {importPending.summary && (
              <div className="pack-preview dim">
                {importPending.type === 'scenario'
                  ? `包含：NPC ${importPending.summary.npcCount ?? '-'} 名 · 地点 ${importPending.summary.locationCount ?? '-'} · 线索 ${importPending.summary.plotCount ?? '-'} · 世界书 ${importPending.summary.loreCount ?? '-'} 条${importPending.summary.requires ? ` · 需规则 ${importPending.summary.requires}` : ''}`
                  : `包含：技能 ${importPending.summary.skillCount ?? '-'} 项 · 属性 ${importPending.summary.attributeCount ?? '-'} 项`}
              </div>
            )}
            <div className="ce-row">
              <label>换名导入（新 id）
                <input value={importNewId} onChange={(e) => setImportNewId(e.target.value)} placeholder={importPending.id} />
              </label>
            </div>
            <div className="modal-actions">
              <button className="primary" onClick={doImportOverwrite}>覆盖导入</button>
              <button className="ghost" onClick={doImportRename}>换名导入</button>
              <button className="ghost" onClick={() => setImportPending(null)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {packEditor && (
        <PackEditor
          type={packEditor.type}
          meta={packEditor.meta}
          onClose={() => setPackEditor(null)}
          onSaved={onPackSaved}
        />
      )}
    </div>
  );
}
