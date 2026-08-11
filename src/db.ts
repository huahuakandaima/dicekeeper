// db.ts — SQLite 数据库封装（node:sqlite，零依赖）
// Schema 对齐方案 §4：campaigns / characters / sessions / messages / dice_rolls / entities / relations / memory_facts / changes
// 运行需 --experimental-sqlite flag（Node 22）

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type { DatabaseSync };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  rule_pack_id TEXT NOT NULL,
  scenario_pack_id TEXT,
  persona_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  type TEXT NOT NULL DEFAULT 'pc',
  name TEXT NOT NULL,
  sheet_json TEXT NOT NULL,
  sheet_version TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL,
  content TEXT,
  dice_results_json TEXT,
  tool_calls_json TEXT,
  tool_call_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dice_rolls (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  session_id TEXT,
  expression TEXT NOT NULL,
  result INTEGER NOT NULL,
  detail_json TEXT,
  reason TEXT,
  requested_by TEXT NOT NULL,
  seed TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  aliases_json TEXT,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS relations (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  entity_a_id TEXT NOT NULL,
  entity_b_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  description TEXT,
  since TEXT,
  until TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_facts (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  fact TEXT NOT NULL,
  entity_refs_json TEXT,
  importance TEXT NOT NULL DEFAULT 'normal',
  source_message_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS changes (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  target TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL
);
-- 世界书条目（方案 §4）：剧本包级预装内容，与运行时 entities 物理隔离
CREATE TABLE IF NOT EXISTS lore_entries (
  id TEXT PRIMARY KEY,
  scenario_pack_id TEXT NOT NULL,
  key_terms_json TEXT NOT NULL,
  activation_strategy TEXT NOT NULL DEFAULT 'green',
  content TEXT NOT NULL,
  token_budget INTEGER NOT NULL DEFAULT 200,
  priority INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_dice_campaign ON dice_rolls(campaign_id);
CREATE INDEX IF NOT EXISTS idx_entities_campaign ON entities(campaign_id);
CREATE INDEX IF NOT EXISTS idx_facts_campaign ON memory_facts(campaign_id);
CREATE INDEX IF NOT EXISTS idx_lore_scenario ON lore_entries(scenario_pack_id);
`;

export function openDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  migrateRelationsId(db);
  return db;
}

// 迁移：relations.id 早期 schema 为 INTEGER AUTOINCREMENT，统一为 TEXT（与 entities 一致，uuid 写入兼容）
function migrateRelationsId(db: DatabaseSync): void {
  const rel = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='relations'").get() as { sql: string } | undefined;
  if (!rel || /^\s*id TEXT/i.test(rel.sql)) return;
  db.exec(`
    CREATE TABLE relations_v2 (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      entity_a_id TEXT NOT NULL,
      entity_b_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      description TEXT,
      since TEXT,
      until TEXT,
      updated_at TEXT NOT NULL
    );
    INSERT INTO relations_v2 SELECT CAST(id AS TEXT), campaign_id, entity_a_id, entity_b_id, relation_type, description, since, until, updated_at FROM relations;
    DROP TABLE relations;
    ALTER TABLE relations_v2 RENAME TO relations;
  `);
}

// —— 通用 JSON 辅助 ——
export function toJson(v: unknown): string { return JSON.stringify(v); }
export function fromJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}
