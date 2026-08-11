// world.ts — 世界状态 v1（实体/事实/掷骰审计；内存 + JSON 落盘）
// Phase 2 将升级为 SQLite 三层记忆；此处接口保持与 MemoryStore 抽象一致（addFact/getFacts/searchEntities/updateState）

import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Entity {
  id: string;
  // 运行态类型 + 剧本包种子类型（world/plot/encounter 由 initScenario 创建）
  type: 'npc' | 'pc' | 'location' | 'item' | 'org' | 'world' | 'plot' | 'encounter';
  name: string;
  aliases?: string[];
  data: Record<string, unknown>;
  updated_at: string;
}

export interface Fact {
  id: string;
  fact: string;
  entity_refs: string[];
  importance: 'high' | 'normal' | 'low';
  created_at: string;
}

export interface DiceRecord {
  id: string;
  expression: string;
  result: number;
  rolls: number[];
  reason: string;
  requested_by: string; // 'ai' | 'player' | 'engine'
  seed: string;
  created_at: string;
}

export interface ChangeRecord {
  id: string;
  actor: string;         // 'ai' | 'player' | 房主名
  kind: 'entity_update' | 'entity_add' | 'fact_add' | 'manual';
  target: string;
  before: unknown;
  after: unknown;
  created_at: string;
}

// 关系（时序轻量图谱，抄 Zep：since/until 可追溯 NPC 关系建立/断裂）
export interface Relation {
  id: string;
  entityAId: string;
  entityBId: string;
  relationType: string;   // 如 认识/敌对/欠债/家人
  description: string;
  since: string;
  until?: string;
  updated_at: string;
}

export class World {
  entities: Map<string, Entity> = new Map();
  facts: Fact[] = [];
  relations: Relation[] = [];
  diceLog: DiceRecord[] = [];
  changes: ChangeRecord[] = [];

  // 关系：记录实体间关联（AI 通过 update_entity 演进；剧本包种子不预置）
  addRelation(aId: string, bId: string, relationType: string, description: string): Relation {
    const r: Relation = {
      id: randomUUID().slice(0, 8),
      entityAId: aId,
      entityBId: bId,
      relationType,
      description,
      since: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.relations.push(r);
    this.changes.push({ id: randomUUID().slice(0, 8), actor: 'ai', kind: 'entity_update', target: `${aId}↔${bId}`, before: null, after: r, created_at: r.updated_at });
    return r;
  }

  getRelations(entityId?: string): Relation[] {
    if (!entityId) return this.relations;
    return this.relations.filter((r) => r.entityAId === entityId || r.entityBId === entityId);
  }

  addEntity(type: Entity['type'], name: string, data: Record<string, unknown>, aliases?: string[]): Entity {
    const e: Entity = {
      id: randomUUID().slice(0, 8),
      type,
      name,
      aliases,
      data,
      updated_at: new Date().toISOString(),
    };
    this.entities.set(e.id, e);
    this.changes.push({ id: randomUUID().slice(0, 8), actor: 'ai', kind: 'entity_add', target: e.id, before: null, after: e, created_at: e.updated_at });
    return e;
  }

  updateEntity(id: string, delta: Record<string, unknown>, actor = 'ai'): Entity | null {
    const e = this.entities.get(id);
    if (!e) return null;
    const before = { ...e };
    e.data = { ...e.data, ...delta };
    e.updated_at = new Date().toISOString();
    this.changes.push({ id: randomUUID().slice(0, 8), actor, kind: 'entity_update', target: id, before, after: { ...e }, created_at: e.updated_at });
    return e;
  }

  // 实体检索：名称 / 别名 / 类型过滤（提及检测的基础）
  search(query: string, type?: Entity['type']): Entity[] {
    const q = query.trim().toLowerCase();
    if (!q) return [...this.entities.values()].filter((e) => (type ? e.type === type : true));
    return [...this.entities.values()].filter((e) => {
      if (type && e.type !== type) return false;
      if (e.name.toLowerCase().includes(q)) return true;
      if (e.aliases?.some((a) => a.toLowerCase().includes(q))) return true;
      return false;
    });
  }

  addFact(fact: string, entity_refs: string[] = [], importance: Fact['importance'] = 'normal', actor: string = 'ai'): Fact {
    const f: Fact = {
      id: randomUUID().slice(0, 8),
      fact,
      entity_refs,
      importance,
      created_at: new Date().toISOString(),
    };
    this.facts.push(f);
    this.changes.push({ id: randomUUID().slice(0, 8), actor, kind: 'fact_add', target: f.id, before: null, after: f, created_at: f.created_at });
    return f;
  }

  // —— 记忆审计可修改（§11.4：玩家可见 L3 内容、可修改）——
  updateFact(id: string, patch: Partial<Pick<Fact, 'fact' | 'importance'>>): Fact | null {
    const f = this.facts.find((x) => x.id === id);
    if (!f) return null;
    const before = { ...f };
    if (patch.importance && ['high', 'normal', 'low'].includes(patch.importance)) f.importance = patch.importance;
    if (typeof patch.fact === 'string' && patch.fact.trim()) f.fact = patch.fact.trim();
    this.changes.push({ id: randomUUID().slice(0, 8), actor: 'player', kind: 'fact_add', target: f.id, before, after: { ...f }, created_at: new Date().toISOString() });
    return f;
  }

  deleteFact(id: string): boolean {
    const i = this.facts.findIndex((f) => f.id === id);
    if (i < 0) return false;
    const [removed] = this.facts.splice(i, 1);
    this.changes.push({ id: randomUUID().slice(0, 8), actor: 'player', kind: 'manual', target: id, before: removed, after: null, created_at: new Date().toISOString() });
    return true;
  }

  deleteRelation(id: string): boolean {
    const i = this.relations.findIndex((r) => r.id === id);
    if (i < 0) return false;
    const [removed] = this.relations.splice(i, 1);
    this.changes.push({ id: randomUUID().slice(0, 8), actor: 'player', kind: 'manual', target: id, before: removed, after: null, created_at: new Date().toISOString() });
    return true;
  }

  // —— 变更回滚（§11.5：全量变更日志 + 可回滚）——
  // 依据 change 记录的 before/after 快照恢复；回滚操作本身追加一条 manual 记录（不可再回滚）
  rollbackChange(changeId: string): boolean {
    const c = this.changes.find((x) => x.id === changeId);
    if (!c || c.kind === 'manual') return false;
    let ok = true;
    if (c.kind === 'entity_update' && c.before && typeof c.before === 'object' && 'id' in (c.before as object)) {
      // 实体更新回滚：恢复 before 快照（含 id）
      const before = c.before as Entity;
      this.entities.set(before.id, before);
    } else if (c.kind === 'entity_update' && c.before === null && c.after && typeof c.after === 'object' && 'entityAId' in (c.after as object)) {
      // 关系新增回滚：删除该关系
      const rel = c.after as Relation;
      this.relations = this.relations.filter((r) => r.id !== rel.id);
    } else if (c.kind === 'entity_add' && c.after && typeof c.after === 'object' && 'id' in (c.after as object)) {
      // 实体新增回滚：删除
      this.entities.delete((c.after as Entity).id);
    } else if (c.kind === 'fact_add' && c.target) {
      // 事实新增回滚：删除
      this.facts = this.facts.filter((f) => f.id !== c.target);
    } else {
      ok = false;
    }
    if (ok) {
      this.changes.push({ id: randomUUID().slice(0, 8), actor: 'player', kind: 'manual', target: c.id, before: c.after, after: c.before, created_at: new Date().toISOString() });
    }
    return ok;
  }

  getFacts(ref?: string, importance?: Fact['importance']): Fact[] {
    return this.facts.filter((f) => {
      if (ref && !f.entity_refs.includes(ref)) return false;
      if (importance && f.importance !== importance) return false;
      return true;
    });
  }

  addDice(expression: string, result: number, rolls: number[], reason: string, requestedBy: string, seed: string): DiceRecord {
    const d: DiceRecord = {
      id: randomUUID().slice(0, 8),
      expression,
      result,
      rolls,
      reason,
      requested_by: requestedBy,
      seed,
      created_at: new Date().toISOString(),
    };
    this.diceLog.push(d);
    return d;
  }

  // 持久化（JSON 文件；Phase 2 换 SQLite）
  save(filePath: string): void {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({
      entities: [...this.entities.values()],
      facts: this.facts,
      relations: this.relations,
      diceLog: this.diceLog,
      changes: this.changes,
    }, null, 2), 'utf-8');
  }

  static load(filePath: string): World {
    const w = new World();
    if (!existsSync(filePath)) return w;
    const data = JSON.parse(readFileSync(filePath, 'utf-8')) as {
      entities: Entity[]; facts: Fact[]; relations: Relation[]; diceLog: DiceRecord[]; changes: ChangeRecord[];
    };
    for (const e of data.entities ?? []) w.entities.set(e.id, e);
    w.facts = data.facts ?? [];
    w.relations = data.relations ?? [];
    w.diceLog = data.diceLog ?? [];
    w.changes = data.changes ?? [];
    return w;
  }

  // —— SQLite 持久化（node:sqlite；全量同步 v1，数据量小）——
  saveToDb(db: import('./db.ts').DatabaseSync, campaignId: string): void {
    const tx = db.prepare('BEGIN');
    tx.run();
    try {
      db.prepare('DELETE FROM entities WHERE campaign_id = ?').run(campaignId);
      db.prepare('DELETE FROM memory_facts WHERE campaign_id = ?').run(campaignId);
      db.prepare('DELETE FROM relations WHERE campaign_id = ?').run(campaignId);
      db.prepare('DELETE FROM dice_rolls WHERE campaign_id = ?').run(campaignId);
      db.prepare('DELETE FROM changes WHERE campaign_id = ?').run(campaignId);
      const insE = db.prepare(
        `INSERT INTO entities (id, campaign_id, type, name, aliases_json, data_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const e of this.entities.values()) {
        insE.run(e.id, campaignId, e.type, e.name, e.aliases ? JSON.stringify(e.aliases) : null, JSON.stringify(e.data), e.updated_at, e.updated_at);
      }
      const insF = db.prepare(
        'INSERT INTO memory_facts (id, campaign_id, fact, entity_refs_json, importance, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const f of this.facts) {
        insF.run(f.id, campaignId, f.fact, JSON.stringify(f.entity_refs), f.importance, f.created_at);
      }
      const insR = db.prepare(
        `INSERT INTO relations (id, campaign_id, entity_a_id, entity_b_id, relation_type, description, since, until, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of this.relations) {
        insR.run(r.id, campaignId, r.entityAId, r.entityBId, r.relationType, r.description, r.since, r.until ?? null, r.updated_at);
      }
      const insD = db.prepare(
        `INSERT INTO dice_rolls (id, campaign_id, expression, result, detail_json, reason, requested_by, seed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const d of this.diceLog) {
        insD.run(d.id, campaignId, d.expression, d.result, JSON.stringify(d.rolls), d.reason, d.requested_by, d.seed, d.created_at);
      }
      const insC = db.prepare(
        'INSERT INTO changes (id, campaign_id, actor, kind, target, before_json, after_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const c of this.changes) {
        insC.run(c.id, campaignId, c.actor, c.kind, c.target, c.before === null ? null : JSON.stringify(c.before), c.after === null ? null : JSON.stringify(c.after), c.created_at);
      }
      db.prepare('COMMIT').run();
    } catch (e) {
      db.prepare('ROLLBACK').run();
      throw e;
    }
  }

  static loadFromDb(db: import('./db.ts').DatabaseSync, campaignId: string): World {
    const w = new World();
    const es = db.prepare('SELECT * FROM entities WHERE campaign_id = ?').all(campaignId) as unknown as {
      id: string; type: string; name: string; aliases_json: string | null; data_json: string; updated_at: string;
    }[];
    for (const e of es) {
      w.entities.set(e.id, {
        id: e.id,
        type: e.type as Entity['type'],
        name: e.name,
        aliases: e.aliases_json ? JSON.parse(e.aliases_json) : undefined,
        data: JSON.parse(e.data_json),
        updated_at: e.updated_at,
      });
    }
    const fs = db.prepare('SELECT * FROM memory_facts WHERE campaign_id = ? ORDER BY created_at').all(campaignId) as unknown as {
      id: string; fact: string; entity_refs_json: string | null; importance: string; created_at: string;
    }[];
    w.facts = fs.map((f) => ({
      id: f.id,
      fact: f.fact,
      entity_refs: f.entity_refs_json ? JSON.parse(f.entity_refs_json) : [],
      importance: f.importance as Fact['importance'],
      created_at: f.created_at,
    }));
    const rs = db.prepare('SELECT * FROM relations WHERE campaign_id = ? ORDER BY updated_at').all(campaignId) as unknown as {
      id: string; entity_a_id: string; entity_b_id: string; relation_type: string;
      description: string | null; since: string | null; until: string | null; updated_at: string;
    }[];
    w.relations = rs.map((r) => ({
      id: r.id,
      entityAId: r.entity_a_id,
      entityBId: r.entity_b_id,
      relationType: r.relation_type,
      description: r.description ?? '',
      since: r.since ?? r.updated_at,
      until: r.until ?? undefined,
      updated_at: r.updated_at,
    }));
    const ds = db.prepare('SELECT * FROM dice_rolls WHERE campaign_id = ? ORDER BY created_at').all(campaignId) as unknown as {
      id: string; expression: string; result: number; detail_json: string | null;
      reason: string | null; requested_by: string; seed: string | null; created_at: string;
    }[];
    w.diceLog = ds.map((d) => ({
      id: d.id,
      expression: d.expression,
      result: d.result,
      rolls: d.detail_json ? JSON.parse(d.detail_json) : [],
      reason: d.reason ?? '',
      requested_by: d.requested_by,
      seed: d.seed ?? '',
      created_at: d.created_at,
    }));
    const cs = db.prepare('SELECT * FROM changes WHERE campaign_id = ? ORDER BY created_at').all(campaignId) as unknown as {
      id: string; actor: string; kind: string; target: string | null;
      before_json: string | null; after_json: string | null; created_at: string;
    }[];
    w.changes = cs.map((c) => ({
      id: c.id,
      actor: c.actor,
      kind: c.kind as ChangeRecord['kind'],
      target: c.target ?? '',
      before: c.before_json ? JSON.parse(c.before_json) : null,
      after: c.after_json ? JSON.parse(c.after_json) : null,
      created_at: c.created_at,
    }));
    return w;
  }
}

// —— 移动意图本地识别（方案 C：移动也本地化，不依赖 AI 自觉）——
// 玩家输入含"去/前往/离开/回/到 + 地点名"时，引擎本地解析目标地点并更新 pc location。
// 与判定本地化同源：AI 只写叙事，位置永远准。
const MOVE_VERB_RE = /(?:去|前往|到|回到|回|走去|赶往|赶去|动身去|溜去|跑去|返回|离开|走出|出了)\s*([\u4e00-\u9fa5A-Za-z·\-]{2,12})/g;

export function parseMoveIntent(action: string, world: World): Entity | null {
  const locs = [...world.entities.values()].filter((e) => e.type === 'location');
  if (locs.length === 0) return null;
  // 地点名/别名索引（长名优先，避免"酒馆"命中"雾港酒馆"前先命中别的）
  const allNames: { label: string; entity: Entity }[] = [];
  for (const l of locs) {
    allNames.push({ label: l.name, entity: l });
    for (const a of l.aliases ?? []) allNames.push({ label: a, entity: l });
  }
  allNames.sort((a, b) => b.label.length - a.label.length);
  MOVE_VERB_RE.lastIndex = 0;
  let best: Entity | null = null;
  let m: RegExpExecArray | null;
  while ((m = MOVE_VERB_RE.exec(action)) !== null) {
    // 贪心捕获可能吞掉后续内容（"离开酒馆去码头看看"→"酒馆去码头看看"）：
    // 从完整捕获开始逐字截尾找匹配；命中后游标推进到"地点名实际长度"之后，避免吞掉后续移动动词
    const verbLen = m[0].length - m[1].length;
    const target = m[1];
    let matchedLabel: string | null = null;
    for (let len = target.length; len >= 2; len--) {
      const t = target.slice(0, len);
      // 第一优先：完全相等（"码头"必须命中渔市码头的别名"码头"，而非"码头酒馆"）
      let hit = allNames.find(({ label }) => label === t);
      // 第二优先：地点是 t 的前缀（动词正后方紧跟地点，如"码头看看"→"码头"）/
      // t 是地点名的前缀（长地名被截断，如"北角"→北角灯塔）
      if (!hit) hit = allNames.find(({ label }) => t.startsWith(label) || label.startsWith(t));
      // 第三优先：地点在 t 内部（"去了码头"→"了码头"含"码头"）
      if (!hit) hit = allNames.find(({ label }) => t.includes(label));
      if (hit) { matchedLabel = hit.label; break; }
    }
    if (matchedLabel) {
      best = allNames.find(({ label }) => label === matchedLabel)!.entity; // 取最后一个匹配（"先去码头再回酒馆"→ 酒馆）
      MOVE_VERB_RE.lastIndex = m.index + verbLen + matchedLabel.length;
    } else {
      // 无匹配：只推进动词本身，保留后续搜索（防"看到"吞掉"去码头"）
      MOVE_VERB_RE.lastIndex = m.index + verbLen + 2;
    }
  }
  return best;
}
