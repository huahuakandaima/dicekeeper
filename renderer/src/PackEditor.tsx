// renderer/src/PackEditor.tsx — P3b 内容编辑器（规则包/剧本包可视化编辑）
// 三个标签页：表单（通用递归编辑器，双向绑定 DSL）/ 源码（YAML 直改，解析回填）/ 试跑（检定/世界书命中）
import { useEffect, useState } from 'react';
import { parseYaml } from '../../src/rules.ts';
import { serializeYaml } from '../../src/yaml-write.ts';
import { DRAG_GUARD } from './drag-guard';
import type { EditorOpenResult, PackMeta, CheckResult } from './global.d.ts';

// —— 通用递归值编辑器（表单 ↔ 对象 双向绑定）——
function ValueEditor({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  if (typeof value === 'string') {
    return value.length > 60 || value.includes('\n')
      ? <textarea rows={Math.min(6, Math.max(2, value.split('\n').length))} value={value} onChange={(e) => onChange(e.target.value)} />
      : <input value={value} onChange={(e) => onChange(e.target.value)} />;
  }
  if (typeof value === 'number') {
    return <input type="number" value={value} onChange={(e) => onChange(Number(e.target.value) || 0)} />;
  }
  if (typeof value === 'boolean') {
    return (
      <select value={value ? '1' : '0'} onChange={(e) => onChange(e.target.value === '1')}>
        <option value="1">true</option>
        <option value="0">false</option>
      </select>
    );
  }
  if (Array.isArray(value)) {
    if (value.length === 0 || value.every((v) => typeof v === 'string' || typeof v === 'number' || v === null)) {
      return <StringListEditor list={value as (string | number)[]} onChange={onChange} />;
    }
    return <ObjListEditor list={value} onChange={onChange} />;
  }
  if (value && typeof value === 'object') {
    return <ObjEditor obj={value as Record<string, unknown>} onChange={onChange} />;
  }
  return <span className="dim">（null）</span>;
}

// 标量数组：每行一个输入
function StringListEditor({ list, onChange }: { list: (string | number)[]; onChange: (v: unknown) => void }) {
  const isNum = typeof list[0] === 'number';
  const items = list.map(String);
  const commit = (arr: string[]) => onChange(isNum ? arr.map((s) => Number(s) || 0) : arr);
  return (
    <div className="str-list">
      {items.map((s, i) => (
        <div key={i} className="str-item">
          <input value={s} onChange={(e) => commit(items.map((x, j) => (j === i ? e.target.value : x)))} />
          <button className="danger-mini" title="删除" onClick={() => commit(items.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button className="ghost add-item" onClick={() => commit([...items, ''])}>＋ 添加</button>
    </div>
  );
}

function nameOf(item: Record<string, unknown>): string | null {
  for (const k of ['name', 'id', 'title', 'label']) {
    const v = item[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  const keys = Object.keys(item);
  if (keys.length === 1 && typeof item[keys[0]] === 'string') return `${keys[0]}: ${item[keys[0]]}`;
  return null;
}

// 对象数组：卡片列表（增删/排序）
function ObjListEditor({ list, onChange }: { list: unknown[]; onChange: (v: unknown) => void }) {
  const items = list as Record<string, unknown>[];
  const patch = (i: number, item: Record<string, unknown>) => onChange(items.map((x, j) => (j === i ? item : x)));
  const move = (i: number, dir: number) => {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const arr = [...items];
    [arr[i], arr[j]] = [arr[j], arr[i]];
    onChange(arr);
  };
  return (
    <div className="obj-list">
      {items.map((item, i) => (
        <div key={i} className="obj-card">
          <div className="obj-card-head">
            <b>{nameOf(item) ?? `项目 ${i + 1}`}</b>
            <span className="pack-actions">
              <button className="ghost mini-btn" title="上移" onClick={() => move(i, -1)}>↑</button>
              <button className="ghost mini-btn" title="下移" onClick={() => move(i, 1)}>↓</button>
              <button className="danger-mini" title="删除此项" onClick={() => onChange(items.filter((_, j) => j !== i))}>×</button>
            </span>
          </div>
          <ObjEditor obj={item} onChange={(v) => patch(i, v)} />
        </div>
      ))}
      <button className="ghost add-item" onClick={() => onChange([...items, {}])}>＋ 添加</button>
    </div>
  );
}

// 对象：字段行（可删）+ 添加自定义字段
// action 字段（规则包技能按钮类型，2026-08-11 用户需求"编辑时配置按钮"）：check/narrative/none 下拉
const ACTION_OPTIONS: Record<string, string> = {
  check: '检定（d100 对比技能值）',
  narrative: '叙事行动（不掷骰，AI 叙事推进）',
  none: '不显示按钮',
};
function ObjEditor({ obj, onChange }: { obj: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void }) {
  const [newKey, setNewKey] = useState('');
  const entries = Object.entries(obj);
  return (
    <div className="obj-fields">
      {entries.map(([k, v]) => (
        <div key={k} className="field-row">
          <div className="field-label">
            <span className="field-key">{k}</span>
            <button className="danger-mini" title="删除字段" onClick={() => {
              const rest = { ...obj };
              delete rest[k];
              onChange(rest);
            }}>×</button>
          </div>
          {k === 'action' ? (
            <select value={String(v ?? 'check')} onChange={(e) => onChange({ ...obj, [k]: e.target.value })}>
              {Object.entries(ACTION_OPTIONS).map(([val, label]) => <option key={val} value={val}>{label}</option>)}
            </select>
          ) : (
            <ValueEditor value={v} onChange={(nv) => onChange({ ...obj, [k]: nv })} />
          )}
        </div>
      ))}
      <div className="add-key">
        <input value={newKey} placeholder="新字段名（如 custom_note）" onChange={(e) => setNewKey(e.target.value)} />
        <button className="ghost" onClick={() => {
          const k = newKey.trim();
          if (k && !(k in obj)) { onChange({ ...obj, [k]: '' }); setNewKey(''); }
        }}>添加字段</button>
      </div>
    </div>
  );
}

// —— 主编辑器 ——
interface Props {
  type: 'rule' | 'scenario';
  meta: PackMeta;
  onClose: () => void;
  onSaved: (meta: PackMeta) => void;
}

type Msg = { kind: 'ok' | 'err'; text: string } | null;

export function PackEditor({ type, meta, onClose, onSaved }: Props) {
  const [doc, setDoc] = useState<EditorOpenResult | null>(null);
  const [tab, setTab] = useState<'form' | 'source' | 'test'>('form');
  const [obj, setObj] = useState<Record<string, unknown> | null>(null);
  const [srcText, setSrcText] = useState('');
  const [msg, setMsg] = useState<Msg>(null);

  // 试跑：规则包检定
  const [tcSkill, setTcSkill] = useState('侦查');
  const [tcValue, setTcValue] = useState(50);
  const [tcMode, setTcMode] = useState<'normal' | 'reward' | 'penalty'>('normal');
  const [tcResult, setTcResult] = useState<CheckResult | null>(null);
  // 试跑：剧本包世界书
  const [tlText, setTlText] = useState('玩家推开雾港酒馆的门，看见老船长埃德加在灌酒。');
  const [tlBudget, setTlBudget] = useState(3000);
  const [tlResult, setTlResult] = useState<{ budget: number; used: number; hits: { id: string; activation: string; content: string; priority: number; cost: number }[] } | null>(null);
  // AI 生成
  const [aiPrompt, setAiPrompt] = useState('');
  // AI 生成（§11.8：整包或单点，产出草稿人工确认）；规则包只有「整包骨架」目标，初始值按类型对齐（修复误选 pack 报错）
  const [aiTarget, setAiTarget] = useState(type === 'scenario' ? 'pack' : 'rule-pack');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiDraft, setAiDraft] = useState<{ target: string; field?: string; yaml: string; obj?: unknown } | null>(null); // 草稿（obj=后端校验过的内容：整包是对象、单点是字段值本身）
  // 按规则包生成剧本包：规则包列表选择（P3b 增强：注入所选规则包技能/属性体系）
  const [rulePacks, setRulePacks] = useState<PackMeta[]>([]);
  const [rulePackId, setRulePackId] = useState('');
  // 对草稿的继续调整意见（解决"AI 生成大相径庭"：生成后可对话式迭代修改）
  const [adjustPrompt, setAdjustPrompt] = useState('');
  useEffect(() => {
    window.dk.packs.list().then((p) => {
      setRulePacks(p.rulePacks);
      setRulePackId((cur) => cur || p.rulePacks[0]?.id || '');
    }).catch(() => {});
  }, []);
  // 试跑：成功率分布（§11.3）
  const [tcDist, setTcDist] = useState<{ trials: number; counts: Record<string, number> } | null>(null);

  useEffect(() => {
    window.dk.editor.open(type, meta.id).then((r) => {
      if (r.ok && r.obj) {
        setDoc(r);
        setObj(r.obj);
        setSrcText(r.yaml ?? serializeYaml(r.obj));
      } else {
        setMsg({ kind: 'err', text: r.error ?? '打开失败' });
      }
    });
  }, [type, meta.id]);

  async function save() {
    if (!doc || !obj) return;
    const r = await window.dk.editor.save({ type, id: meta.id, isBuiltin: !!doc.isBuiltin, obj });
    if (r.ok && r.meta) {
      onSaved(r.meta);
      setMsg({
        kind: 'ok',
        text: r.savedAs
          ? `✓ 内置包已另存为副本「${r.meta.name}」（id: ${r.savedAs}），原内置包未改动`
          : `✓ 已保存：${r.meta.name} v${r.meta.version}`,
      });
      setDoc({ ...doc, isBuiltin: false });
    } else {
      setMsg({ kind: 'err', text: `✗ 保存失败：${r.error ?? '未知错误'}` });
    }
  }

  // 源码 → 表单
  function applySource() {
    try {
      const parsed = parseYaml(srcText) as Record<string, unknown>;
      setObj(parsed);
      setTab('form');
      setMsg({ kind: 'ok', text: '✓ 源码已解析并应用（保存时做完整校验）' });
    } catch (e) {
      setMsg({ kind: 'err', text: `✗ YAML 解析失败：${(e as Error).message}` });
    }
  }
  // 表单 → 源码
  function refreshFromForm() {
    if (!obj) return;
    try {
      setSrcText(serializeYaml(obj));
      setMsg({ kind: 'ok', text: '✓ 已从表单重新生成源码' });
    } catch (e) {
      setMsg({ kind: 'err', text: `序列化失败：${(e as Error).message}` });
    }
  }

  async function runCheck() {
    if (!obj) return;
    const r = await window.dk.editor.testCheck({ obj, skill: tcSkill, value: tcValue, mode: tcMode });
    setTcResult(r);
  }
  async function runDist() {
    if (!obj) return;
    const r = await window.dk.editor.testDist({ obj, skill: tcSkill, value: tcValue, mode: tcMode, trials: 1000 });
    setTcDist(r);
  }
  async function runLore() {
    if (!obj) return;
    const r = await window.dk.editor.testLore({ obj, text: tlText, budget: tlBudget });
    setTlResult(r);
  }
  // AI 生成（§11.8：整包或单点，产出草稿人工确认）
  async function aiGenerate() {
    setAiBusy(true);
    setMsg(null);
    const r = await window.dk.editor.aiGenerate({
      type,
      prompt: aiPrompt.trim(),
      target: aiTarget,
      rulePackId: aiTarget === 'scenario-from-rule' ? rulePackId : undefined,
    });
    setAiBusy(false);
    if (r.ok) {
      setAiDraft({ target: r.target ?? aiTarget, field: r.field, yaml: r.yaml ?? '', obj: r.draft ?? undefined });
      setMsg({ kind: 'ok', text: r.isWhole ? '✓ AI 已生成整包草稿，可继续「按意见修改」或直接应用到表单' : `✓ AI 已生成「${targetLabel(r.target ?? aiTarget)}」草稿` });
    } else {
      setMsg({ kind: 'err', text: r.error ?? 'AI 生成失败' });
    }
  }
  // 迭代微调：对当前草稿提修改意见 → AI 在原草稿上修改（解决"生成大相径庭"：可多轮对话式调整）
  async function aiAdjust() {
    const text = adjustPrompt.trim();
    if (!text || !aiDraft) return;
    setAiBusy(true);
    setMsg(null);
    const r = await window.dk.editor.aiGenerate({ type, prompt: text, target: 'adjust', prevDraft: aiDraft.yaml });
    setAiBusy(false);
    if (r.ok) {
      setAiDraft({ target: 'adjust', field: undefined, yaml: r.yaml ?? '', obj: r.draft ?? undefined });
      setAdjustPrompt('');
      setMsg({ kind: 'ok', text: '✓ 已按你的意见修改草稿，检查后「应用到表单」' });
    } else {
      setMsg({ kind: 'err', text: r.error ?? '修改失败' });
    }
  }
  // 草稿 → 表单（整包替换 / 单点合并进对应字段）
  // 用后端返回的 draft 对象（已完整校验），避免二次 parseYaml 引入解析差异
  function applyAiDraft() {
    if (!aiDraft || !obj) return;
    if (!aiDraft.field) {
      // 整包：直接应用后端校验过的 draft 对象
      if (aiDraft.obj) {
        setObj(aiDraft.obj);
        setSrcText(serializeYaml(aiDraft.obj));
      } else {
        try {
          const parsed = parseYaml(aiDraft.yaml) as Record<string, unknown>;
          setObj(parsed);
          setSrcText(serializeYaml(parsed));
        } catch (e) {
          setMsg({ kind: 'err', text: `草稿解析失败：${(e as Error).message}` });
          return;
        }
      }
    } else {
      // 单点：后端 draft 就是字段值本身（如 npc_seeds 数组），直接作为新值（勿对字段值再取属性）
      const fieldVal = aiDraft.obj !== undefined ? aiDraft.obj : (() => {
        try {
          return (parseYaml(aiDraft.yaml) as Record<string, unknown>)[aiDraft.field];
        } catch {
          return undefined;
        }
      })();
      setObj({ ...obj, [aiDraft.field]: fieldVal });
      setSrcText(serializeYaml({ ...obj, [aiDraft.field]: fieldVal }));
    }
    setAiDraft(null);
    setTab('form');
    setMsg({ kind: 'ok', text: '✓ 草稿已应用到表单（保存时做完整校验）' });
  }

  const actLabel = (a: string) => (a === 'blue' ? '常驻' : a === 'green' ? '近期' : '历史');
  const targetLabel = (t: string) => ({
    pack: '整包', 'rule-pack': '整包', 'scenario-from-rule': '整包（按规则包）', adjust: '整包', npc: 'NPC 种子', location: '地点', world: '世界观', lore: '世界书条目', encounter: '遭遇模板', hooks: '开场白',
  }[t] ?? t);
  const distTiers: [string, string][] = [['crit_fail', '大失败'], ['extreme', '极限'], ['hard', '困难'], ['normal', '普通'], ['fail', '失败']];

  return (
    <div className="modal" onClick={(e) => { if (e.target === e.currentTarget && !DRAG_GUARD.isDrag(e)) onClose(); }} onMouseDownCapture={DRAG_GUARD.onMouseDownCapture}>
      <div className="modal-body modal-wide editor-modal" onClick={(e) => e.stopPropagation()}>
        <h2>
          ✏️ 编辑{type === 'rule' ? '规则包' : '剧本包'}：{meta.name}
          <span className="dim"> v{meta.version}{doc?.isBuiltin ? '（内置 · 保存将另存副本）' : ''}</span>
        </h2>

        <div className="editor-tabs">
          <button className={`ghost ${tab === 'form' ? 'active' : ''}`} onClick={() => setTab('form')}>📋 表单</button>
          <button className={`ghost ${tab === 'source' ? 'active' : ''}`} onClick={() => setTab('source')}>📄 源码</button>
          <button className={`ghost ${tab === 'test' ? 'active' : ''}`} onClick={() => setTab('test')}>🎲 试跑</button>
        </div>

        {msg && <div className={msg.kind === 'ok' ? 'ok-msg' : 'err-msg'}>{msg.text}</div>}

        {tab === 'form' && obj && (
          <div className="editor-scroll">
            <div className="ai-gen">
              <span className="dim">✨ AI 生成：</span>
              <select value={aiTarget} onChange={(e) => setAiTarget(e.target.value)}>
                {type === 'scenario' ? (
                  <>
                    <option value="pack">整包骨架</option>
                    <option value="scenario-from-rule">整包（按规则包生成）</option>
                    <option value="npc">NPC 种子</option>
                    <option value="location">地点</option>
                    <option value="world">世界观</option>
                    <option value="lore">世界书条目</option>
                    <option value="encounter">遭遇模板</option>
                    <option value="hooks">开场白</option>
                  </>
                ) : (
                  <>
                    <option value="rule-pack">整包骨架</option>
                  </>
                )}
              </select>
              {aiTarget === 'scenario-from-rule' && (
                <select value={rulePackId} onChange={(e) => setRulePackId(e.target.value)} title="剧本将使用该规则包的属性/技能/检定体系">
                  {rulePacks.map((p) => <option key={p.id} value={p.id}>{p.name}（v{p.version}）</option>)}
                </select>
              )}
              <input value={aiPrompt} placeholder={type === 'scenario' ? '输入主题，如「1920 年代伦敦的降神会连环失踪案」' : '输入规则体系需求，如「d100 系末世生存规则」'} onChange={(e) => setAiPrompt(e.target.value)} />
              <button className="ghost" onClick={aiGenerate} disabled={aiBusy || (aiTarget === 'scenario-from-rule' && !rulePackId)}>{aiBusy ? '生成中…' : '✨ 生成'}</button>
              <span className="dim">需已配置 AI 服务；「按规则包生成」= 剧本技能/检定贴合所选规则包；产出进草稿区，可继续按意见修改</span>
            </div>
            {aiDraft && (
              <div className="ai-draft">
                <div className="obj-card-head">
                  <b>AI 草稿：{targetLabel(aiDraft.target)}</b>
                  <span className="pack-actions">
                    <button className="primary mini-btn" onClick={applyAiDraft}>✅ 应用到表单</button>
                    <button className="ghost mini-btn" onClick={() => setAiDraft(null)}>丢弃</button>
                  </span>
                </div>
                <div className="ai-adjust">
                  <input value={adjustPrompt} onChange={(e) => setAdjustPrompt(e.target.value)} placeholder="不满意？对草稿提修改意见，如「把警长改成反派女店主，加一条雾潮线索，NPC 减到 4 个」" onKeyDown={(e) => e.key === 'Enter' && aiAdjust()} />
                  <button className="ghost" onClick={aiAdjust} disabled={aiBusy || !adjustPrompt.trim()}>🔧 按意见修改</button>
                </div>
                <pre className="draft-yaml">{aiDraft.yaml.slice(0, 1200)}{aiDraft.yaml.length > 1200 ? '\n…' : ''}</pre>
              </div>
            )}
            <ValueEditor value={obj} onChange={setObj} />
            <p className="hint">表单与 YAML 双向绑定：任何改动都会反映到「源码」标签；删除字段用 ×，添加自定义字段在底部输入。</p>
          </div>
        )}

        {tab === 'source' && (
          <div className="editor-scroll">
            <textarea className="src-area" value={srcText} onChange={(e) => setSrcText(e.target.value)} spellCheck={false} />
            <div className="ce-tools">
              <button className="ghost" onClick={applySource}>📥 应用源码（解析回表单）</button>
              <button className="ghost" onClick={refreshFromForm}>📤 从表单重新生成</button>
              <span className="dim">保存始终以「表单」对象为准；改了源码记得先「应用」</span>
            </div>
          </div>
        )}

        {tab === 'test' && obj && (
          <div className="editor-scroll">
            {type === 'rule' ? (
              <div className="test-box">
                <div className="ce-row">
                  <label>技能/属性
                    <input value={tcSkill} onChange={(e) => setTcSkill(e.target.value)} />
                  </label>
                  <label>数值
                    <input type="number" value={tcValue} onChange={(e) => setTcValue(Number(e.target.value) || 0)} />
                  </label>
                  <label>模式
                    <select value={tcMode} onChange={(e) => setTcMode(e.target.value as typeof tcMode)}>
                      <option value="normal">普通</option>
                      <option value="reward">奖励骰（取低）</option>
                      <option value="penalty">惩罚骰（取高）</option>
                    </select>
                  </label>
                  <button className="primary" onClick={runCheck}>🎲 试跑检定</button>
                </div>
                {tcResult && (
                  <div className={`verdict ${tcResult.outcome}`}>
                    <b>{tcResult.label}</b> <span>{tcResult.detail}</span>
                  </div>
                )}
                <div className="ce-row">
                  <button className="ghost" onClick={runDist}>📊 试跑 1000 次分布</button>
                </div>
                {tcDist && (
                  <div className="dist-box">
                    <p className="hint">1000 次检定档位分布（{tcSkill} {tcValue}，{tcMode === 'normal' ? '普通' : tcMode === 'reward' ? '奖励骰' : '惩罚骰'}）——调 check_rules 看分布变化</p>
                    {distTiers.map(([key, label]) => {
                      const n = tcDist.counts[key] ?? 0;
                      const pct = (n / tcDist.trials) * 100;
                      return (
                        <div key={key} className="dist-row">
                          <span className="dist-label">{label}</span>
                          <div className="dist-track">
                            <div className={`dist-bar bar-${key}`} style={{ width: `${pct}%` }} />
                          </div>
                          <span className="dist-num">{n}（{pct.toFixed(1)}%）</span>
                        </div>
                      );
                    })}
                  </div>
                )}
                <p className="hint">试跑用编辑中的规则包对象直接判定（判定本地化同款引擎）：修改 check_rules 表达式后立即生效。</p>
              </div>
            ) : (
              <div className="test-box">
                <label>玩家行动文本
                  <textarea rows={4} value={tlText} onChange={(e) => setTlText(e.target.value)} />
                </label>
                <div className="ce-row">
                  <label>token 预算
                    <input type="number" value={tlBudget} onChange={(e) => setTlBudget(Number(e.target.value) || 3000)} />
                  </label>
                  <button className="primary" onClick={runLore}>🔍 试跑世界书命中</button>
                </div>
                {tlResult && (
                  <div className="lore-test">
                    <p className="hint">命中 {tlResult.hits.length} 条，占用 {tlResult.used}/{tlResult.budget} tokens（按 priority 降序 + 预算截断）</p>
                    <ul className="dice-log">
                      {tlResult.hits.map((h) => (
                        <li key={h.id}>
                          <span className={`act-tag ${h.activation}`}>{actLabel(h.activation)}</span>
                          <b>{h.id}</b> <span className="dim">{h.cost} tokens</span>
                          <div className="lore-content">{h.content.slice(0, 90)}{h.content.length > 90 ? '…' : ''}</div>
                        </li>
                      ))}
                      {tlResult.hits.length === 0 && <li className="dim">无命中（蓝灯常驻条目除外）；调整关键词或 activation 重试</li>}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className="modal-actions">
          <button className="primary" onClick={save}>💾 保存</button>
          <button className="ghost" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
