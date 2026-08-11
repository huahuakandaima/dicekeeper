// campaign.ts — 战役/会话/消息存储（SQLite 后端，node:sqlite 零依赖）
// 方法签名与 JSON 版一致；World 持久化见 saveWorld/loadWorld（world.ts 提供 db 适配）

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from './db.ts';
import { openDatabase, toJson, fromJson } from './db.ts';
import type { Character } from './chargen.ts';
import type { ChatMessage, ToolCall } from './gateway/provider.ts';
import type { ScenarioPack, LoreEntry, Activation } from './scenario.ts';

export class StorageError extends Error {}

export interface CampaignMeta {
  id: string;
  name: string;
  rulePackId: string;
  scenarioPackId?: string;
  personaId?: string;
  created_at: string;
  characters: Character[];
}

export interface SessionMeta {
  id: string;
  campaignId: string;
  started_at: string;
  ended_at?: string;
  summary?: string;
}

export interface StoredMessage {
  id?: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  diceResults?: string[];
  created_at: string;
}

export interface SessionData {
  session: SessionMeta;
  messages: StoredMessage[];
}

interface CampaignRow {
  id: string; name: string; rule_pack_id: string; scenario_pack_id: string | null;
  persona_id: string | null; created_at: string;
}
interface CharacterRow {
  id: number; campaign_id: string; type: string; name: string; sheet_json: string;
  sheet_version: string; is_active: number; created_at: string; updated_at: string;
}
interface SessionRow {
  id: string; campaign_id: string; started_at: string; ended_at: string | null;
  summary: string | null; status: string;
}
interface MessageRow {
  id: number; session_id: string; role: string; content: string | null;
  dice_results_json: string | null; tool_calls_json: string | null; tool_call_id: string | null; created_at: string;
}
interface LoreRow {
  id: string; scenario_pack_id: string; key_terms_json: string; activation_strategy: string;
  content: string; token_budget: number; priority: number;
}

// 世界书条目（DB 形态，供注入组装）
export interface StoredLoreEntry {
  id: string;
  scenarioPackId: string;
  keyTerms: string[];
  activation: Activation;
  content: string;
  tokenBudget: number;
  priority: number;
}

export class CampaignStore {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
  }

  // —— 战役 ——
  createCampaign(opts: { name: string; rulePackId: string; scenarioPackId?: string; characters: Character[]; personaId?: string }): CampaignMeta {
    const id = randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT INTO campaigns (id, name, rule_pack_id, scenario_pack_id, persona_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, opts.name, opts.rulePackId, opts.scenarioPackId ?? null, opts.personaId ?? null, now);
    const ins = this.db.prepare(
      'INSERT INTO characters (campaign_id, type, name, sheet_json, sheet_version, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
    );
    for (const c of opts.characters) {
      ins.run(id, 'pc', c.name, toJson(c), c.sheet_version, now, now);
    }
    return { id, name: opts.name, rulePackId: opts.rulePackId, scenarioPackId: opts.scenarioPackId, personaId: opts.personaId, created_at: now, characters: opts.characters };
  }

  // 更新战役绑定的人格（B5：战役级覆盖全局默认）
  setCampaignPersona(campaignId: string, personaId: string | null): void {
    this.db.prepare('UPDATE campaigns SET persona_id = ? WHERE id = ?').run(personaId, campaignId);
  }

  // 替换战役的 PC（车卡重骰：删旧插新，保留事务语义）
  replaceCharacter(campaignId: string, char: Character): void {
    const exists = this.db.prepare('SELECT id FROM campaigns WHERE id = ?').get(campaignId);
    if (!exists) throw new StorageError(`战役不存在: ${campaignId}`);
    const now = new Date().toISOString();
    this.db.prepare("DELETE FROM characters WHERE campaign_id = ? AND type = 'pc'").run(campaignId);
    this.db.prepare(
      'INSERT INTO characters (campaign_id, type, name, sheet_json, sheet_version, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
    ).run(campaignId, 'pc', char.name, toJson(char), char.sheet_version, now, now);
  }

  loadCampaign(id: string): CampaignMeta {
    const row = this.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id) as CampaignRow | undefined;
    if (!row) throw new StorageError(`战役不存在: ${id}`);
    const charRows = this.db.prepare(
      'SELECT * FROM characters WHERE campaign_id = ? AND is_active = 1 ORDER BY id',
    ).all(id) as unknown as CharacterRow[];
    return {
      id: row.id,
      name: row.name,
      rulePackId: row.rule_pack_id,
      scenarioPackId: row.scenario_pack_id ?? undefined,
      personaId: row.persona_id ?? undefined,
      created_at: row.created_at,
      characters: charRows.map((r) => ({ ...fromJson<Character>(r.sheet_json, {} as Character), name: r.name })),
    };
  }

  listCampaigns(): CampaignMeta[] {
    const rows = this.db.prepare('SELECT id FROM campaigns ORDER BY created_at DESC').all() as unknown as { id: string }[];
    return rows.map((r) => this.loadCampaign(r.id));
  }

  // —— 会话 ——
  startSession(campaignId: string): SessionMeta {
    const exists = this.db.prepare('SELECT id FROM campaigns WHERE id = ?').get(campaignId);
    if (!exists) throw new StorageError(`战役不存在: ${campaignId}`);
    const session: SessionMeta = {
      id: randomUUID().slice(0, 8),
      campaignId,
      started_at: new Date().toISOString(),
    };
    this.db.prepare(
      'INSERT INTO sessions (id, campaign_id, started_at, status) VALUES (?, ?, ?, ?)',
    ).run(session.id, campaignId, session.started_at, 'active');
    return session;
  }

  loadSession(campaignId: string, sessionId: string): SessionData {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ? AND campaign_id = ?').get(sessionId, campaignId) as SessionRow | undefined;
    if (!row) throw new StorageError(`会话不存在: ${sessionId}`);
    const msgs = this.db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id').all(sessionId) as unknown as MessageRow[];
    return {
      session: {
        id: row.id,
        campaignId: row.campaign_id,
        started_at: row.started_at,
        ended_at: row.ended_at ?? undefined,
        summary: row.summary ?? undefined,
      },
      messages: msgs.map((m) => ({
        id: m.id,
        role: m.role as StoredMessage['role'],
        content: m.content ?? '',
        tool_call_id: m.tool_call_id ?? undefined,
        tool_calls: fromJson<ToolCall[]>(m.tool_calls_json, undefined as unknown as ToolCall[]),
        diceResults: fromJson<string[]>(m.dice_results_json, undefined as unknown as string[]),
        created_at: m.created_at,
      })),
    };
  }

  listSessions(campaignId: string): SessionMeta[] {
    const rows = this.db.prepare('SELECT * FROM sessions WHERE campaign_id = ? ORDER BY started_at DESC').all(campaignId) as unknown as SessionRow[];
    return rows.map((r) => ({
      id: r.id, campaignId: r.campaign_id, started_at: r.started_at,
      ended_at: r.ended_at ?? undefined, summary: r.summary ?? undefined,
    }));
  }

  appendMessage(campaignId: string, sessionId: string, msg: Omit<StoredMessage, 'created_at'>): StoredMessage {
    // 校验会话属于该战役
    const row = this.db.prepare('SELECT id FROM sessions WHERE id = ? AND campaign_id = ?').get(sessionId, campaignId);
    if (!row) throw new StorageError(`会话不存在: ${sessionId}`);
    const now = new Date().toISOString();
    const r = this.db.prepare(
      `INSERT INTO messages (session_id, role, content, dice_results_json, tool_calls_json, tool_call_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      msg.role,
      msg.content ?? '',
      msg.diceResults ? toJson(msg.diceResults) : null,
      msg.tool_calls ? toJson(msg.tool_calls) : null,
      msg.tool_call_id ?? null,
      now,
    );
    return { ...msg, id: Number(r.lastInsertRowid), created_at: now };
  }

  getMessages(campaignId: string, sessionId: string): StoredMessage[] {
    return this.loadSession(campaignId, sessionId).messages;
  }

  endSession(campaignId: string, sessionId: string, summary?: string): SessionMeta {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE sessions SET ended_at = ?, summary = ?, status = ? WHERE id = ? AND campaign_id = ?')
      .run(now, summary ?? null, 'ended', sessionId, campaignId);
    return this.loadSession(campaignId, sessionId).session;
  }

  // —— 剧本包初始化（方案 §3.5：NPC 是种子不是成品，剧情是线索网络）——
  // 把剧本包内容展开为 L3 种子：world 实体（固定 id 'world'）+ NPC/地点/线索/遭遇实体 + lore_entries 落库（幂等）
  initScenarioWorld(campaignId: string, scenario: ScenarioPack): void {
    const exists = this.db.prepare('SELECT id FROM campaigns WHERE id = ?').get(campaignId);
    if (!exists) throw new StorageError(`战役不存在: ${campaignId}`);
    const now = new Date().toISOString();
    const ins = this.db.prepare(
      `INSERT OR REPLACE INTO entities (id, campaign_id, type, name, aliases_json, data_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // 确定性 id（类型+名称）：重复 initScenarioWorld 幂等（INSERT OR REPLACE）
    const eid = (type: string, name: string) => `${scenario.id}:${type}:${name}`;

    ins.run('world', campaignId, 'world', scenario.name, null, toJson({
      summary: scenario.world.summary,
      cosmology: scenario.world.cosmology ?? '',
      factions: scenario.world.factions ?? [],
      hooks: scenario.hooks,
    }), now, now);

    for (const n of scenario.npc_seeds) {
      ins.run(eid('npc', n.name), campaignId, 'npc', n.name, n.aliases?.length ? toJson(n.aliases) : null, toJson({
        traits: n.traits,
        secrets: n.secrets ?? '',
        relation_hint: n.relation_hint ?? '',
        source: 'scenario-seed',
      }), now, now);
    }
    for (const l of scenario.locations) {
      ins.run(eid('location', l.name), campaignId, 'location', l.name, l.aliases?.length ? toJson(l.aliases) : null, toJson({
        state: l.state ?? '',
        secrets: l.secrets ?? '',
        source: 'scenario-seed',
      }), now, now);
    }
    for (const t of scenario.plot_threads) {
      ins.run(eid('plot', t.name), campaignId, 'plot', t.name, null, toJson({
        thread_id: t.id,
        status: t.status,
        branches: t.branches ?? [],
        source: 'scenario-seed',
      }), now, now);
    }
    for (const e of scenario.encounters ?? []) {
      ins.run(eid('encounter', e.name), campaignId, 'encounter', e.name, null, toJson({
        type: e.type,
        skill: e.skill ?? '',
        note: e.note ?? '',
        source: 'scenario-seed',
      }), now, now);
    }

    this.upsertLoreEntries(scenario);
  }

  // lore_entries 幂等写入（剧本包级，多战役共享；INSERT OR REPLACE 防重复初始化）
  upsertLoreEntries(scenario: ScenarioPack): void {
    const ins = this.db.prepare(
      `INSERT OR REPLACE INTO lore_entries (id, scenario_pack_id, key_terms_json, activation_strategy, content, token_budget, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of scenario.lore_entries) {
      ins.run(e.id, scenario.id, toJson(e.key_terms), e.activation, e.content, e.token_budget ?? 200, e.priority ?? 0);
    }
  }

  getLoreEntries(scenarioPackId: string): StoredLoreEntry[] {
    const rows = this.db.prepare('SELECT * FROM lore_entries WHERE scenario_pack_id = ?').all(scenarioPackId) as unknown as LoreRow[];
    return rows.map((r) => ({
      id: r.id,
      scenarioPackId: r.scenario_pack_id,
      keyTerms: fromJson<string[]>(r.key_terms_json, []),
      activation: r.activation_strategy as Activation,
      content: r.content,
      tokenBudget: r.token_budget,
      priority: r.priority,
    }));
  }

  // 删除战役（级联清理全部关联数据，事务保护）
  deleteCampaign(campaignId: string): void {
    const exists = this.db.prepare('SELECT id FROM campaigns WHERE id = ?').get(campaignId);
    if (!exists) throw new StorageError(`战役不存在: ${campaignId}`);
    const del = (sql: string) => this.db.prepare(sql).run(campaignId);
    this.db.exec('BEGIN');
    try {
      del('DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE campaign_id = ?)');
      del('DELETE FROM sessions WHERE campaign_id = ?');
      del('DELETE FROM characters WHERE campaign_id = ?');
      del('DELETE FROM dice_rolls WHERE campaign_id = ?');
      del('DELETE FROM entities WHERE campaign_id = ?');
      del('DELETE FROM relations WHERE campaign_id = ?');
      del('DELETE FROM memory_facts WHERE campaign_id = ?');
      del('DELETE FROM changes WHERE campaign_id = ?');
      del('DELETE FROM campaigns WHERE id = ?');
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  close(): void {
    try { this.db.close(); } catch { /* 已关闭 */ }
  }
}

// 存储消息 → 网关 ChatMessage（system 由 prompt 组装，不入存储）
export function toChatMessages(msgs: StoredMessage[]): ChatMessage[] {
  return msgs.map((m) => {
    if (m.role === 'user') return { role: 'user', content: m.content };
    if (m.role === 'tool') return { role: 'tool', content: m.content, tool_call_id: m.tool_call_id! };
    return { role: 'assistant', content: m.content, tool_calls: m.tool_calls ?? undefined };
  });
}

// L1 上下文窗口截断（§3.3：AI 每轮只带最近 30 轮完整对话，更早历史由 L2 CHRONICLE 摘要压缩；
// 消息表全量保留，恢复历史/审计不受影响）
// 规则：从尾部向前数 maxRounds 个 user 消息作为窗口起点；若起点前一条是 tool 消息
// （属于窗口外的 assistant tool_calls），向前扩展直到窗口开头不是 tool，保证工具调用链完整
export function trimHistoryToWindow(msgs: StoredMessage[], maxRounds = 30): StoredMessage[] {
  if (msgs.length <= maxRounds * 2) return msgs;
  let startIdx = 0;
  let rounds = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') {
      rounds++;
      if (rounds === maxRounds) { startIdx = i; break; }
    }
  }
  // tool 消息必须跟随其 assistant（tool_calls 链完整），向前扩展吸收悬挂的 tool
  while (startIdx > 0 && msgs[startIdx - 1].role === 'tool') startIdx--;
  return msgs.slice(startIdx);
}
