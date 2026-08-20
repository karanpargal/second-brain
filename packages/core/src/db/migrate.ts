import { getSqlite, ensureEmbeddingTables } from "./client.js";
import { log } from "../log.js";
import { config } from "../config.js";

/**
 * Schema v2 — ambient memory (idempotent CREATE IF NOT EXISTS).
 * Disposable pre-v2 DBs: delete %LOCALAPPDATA%/second-brain/brain.db to rebuild clean.
 */
const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  cursor_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS raw_events (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  external_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_id, external_id)
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  raw_event_id TEXT REFERENCES raw_events(id),
  external_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  url TEXT,
  author TEXT,
  content_hash TEXT NOT NULL,
  published_at TEXT,
  relevance REAL NOT NULL DEFAULT 0,
  embedded INTEGER NOT NULL DEFAULT 0,
  annotated INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_id, external_id)
);
CREATE INDEX IF NOT EXISTS items_hash ON items(content_hash);
CREATE INDEX IF NOT EXISTS items_relevance ON items(relevance);
CREATE INDEX IF NOT EXISTS items_published ON items(published_at);

CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  horizon TEXT,
  topics_json TEXT NOT NULL DEFAULT '[]',
  salience REAL NOT NULL DEFAULT 0,
  summary TEXT,
  why_it_matters TEXT,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'person',
  aliases_json TEXT NOT NULL DEFAULT '[]',
  weight REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS horizons (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  weight REAL NOT NULL DEFAULT 1,
  color TEXT NOT NULL DEFAULT '#6366f1',
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  horizon_id TEXT NOT NULL REFERENCES horizons(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  target_date TEXT,
  progress REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  horizon_id TEXT NOT NULL REFERENCES horizons(id),
  goal_id TEXT REFERENCES goals(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  source TEXT NOT NULL,
  app TEXT,
  exe TEXT,
  window_title TEXT,
  url TEXT,
  domain TEXT,
  text TEXT,
  text_hash TEXT NOT NULL,
  dwell_ms INTEGER NOT NULL DEFAULT 0,
  redacted INTEGER NOT NULL DEFAULT 0,
  artifact_id TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS observations_ts ON observations(ts);
CREATE INDEX IF NOT EXISTS observations_hash ON observations(text_hash);
CREATE INDEX IF NOT EXISTS observations_app ON observations(app);
CREATE INDEX IF NOT EXISTS observations_domain ON observations(domain);

CREATE TABLE IF NOT EXISTS activity_blocks (
  id TEXT PRIMARY KEY,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  app TEXT,
  title TEXT,
  url TEXT,
  artifact_id TEXT,
  summary TEXT,
  dwell_ms INTEGER NOT NULL DEFAULT 0,
  obs_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS activity_blocks_range ON activity_blocks(start_at, end_at);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  last_touched_at TEXT NOT NULL,
  touch_count INTEGER NOT NULL DEFAULT 1,
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(kind, key)
);
CREATE INDEX IF NOT EXISTS artifacts_touched ON artifacts(last_touched_at);

CREATE TABLE IF NOT EXISTS open_loops (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL DEFAULT 'unfinished',
  status TEXT NOT NULL DEFAULT 'open',
  confidence REAL NOT NULL DEFAULT 0.5,
  detected_at TEXT NOT NULL,
  due_hint TEXT,
  last_seen_at TEXT,
  closed_at TEXT,
  close_reason TEXT,
  horizon_id TEXT REFERENCES horizons(id),
  artifact_id TEXT,
  origin TEXT NOT NULL DEFAULT 'detected',
  who TEXT,
  embedding_json TEXT,
  due_at TEXT,
  priority REAL DEFAULT 0.5,
  category TEXT NOT NULL DEFAULT 'other',
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS open_loops_status ON open_loops(status);
CREATE INDEX IF NOT EXISTS open_loops_kind ON open_loops(kind);

CREATE TABLE IF NOT EXISTS loop_evidence (
  id TEXT PRIMARY KEY,
  loop_id TEXT NOT NULL REFERENCES open_loops(id),
  observation_id TEXT,
  item_id TEXT,
  role TEXT NOT NULL DEFAULT 'progressed',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS loop_evidence_loop ON loop_evidence(loop_id);

CREATE TABLE IF NOT EXISTS memory_chunks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  text TEXT NOT NULL,
  embedding_json TEXT,
  dims INTEGER NOT NULL DEFAULT 768,
  model TEXT,
  embedded INTEGER NOT NULL DEFAULT 0,
  dwell_ms INTEGER NOT NULL DEFAULT 0,
  ts TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS memory_chunks_ref ON memory_chunks(kind, ref_id);
CREATE INDEX IF NOT EXISTS memory_chunks_embedded ON memory_chunks(embedded);

CREATE TABLE IF NOT EXISTS capture_rules (
  id TEXT PRIMARY KEY,
  rule_type TEXT NOT NULL,
  pattern TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS capture_rules_type ON capture_rules(rule_type);

CREATE TABLE IF NOT EXISTS user_spam_rules (
  id TEXT PRIMARY KEY,
  match_type TEXT NOT NULL,
  pattern TEXT NOT NULL,
  intent TEXT NOT NULL DEFAULT 'spam',
  enabled INTEGER NOT NULL DEFAULT 1,
  source_loop_id TEXT,
  source_item_id TEXT,
  note TEXT,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS user_spam_rules_type ON user_spam_rules(match_type);

CREATE TABLE IF NOT EXISTS learn_nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  reward REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS learn_nodes_kind ON learn_nodes(kind);
CREATE INDEX IF NOT EXISTS learn_nodes_created ON learn_nodes(created_at);

CREATE TABLE IF NOT EXISTS learn_edges (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES learn_nodes(id),
  to_id TEXT NOT NULL REFERENCES learn_nodes(id),
  rel TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS learn_edges_from ON learn_edges(from_id);
CREATE INDEX IF NOT EXISTS learn_edges_to ON learn_edges(to_id);
CREATE INDEX IF NOT EXISTS learn_edges_rel ON learn_edges(rel);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  horizon_id TEXT REFERENCES horizons(id),
  project_id TEXT REFERENCES projects(id),
  goal_id TEXT REFERENCES goals(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'todo',
  priority INTEGER NOT NULL DEFAULT 3,
  energy TEXT NOT NULL DEFAULT 'medium',
  estimate_min INTEGER NOT NULL DEFAULT 30,
  deadline TEXT,
  origin TEXT NOT NULL DEFAULT 'manual',
  confidence REAL,
  source_item_id TEXT REFERENCES items(id),
  approved_at TEXT,
  rejected_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS tasks_horizon ON tasks(horizon_id);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL UNIQUE,
  blocks_json TEXT NOT NULL DEFAULT '[]',
  rationale TEXT,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS briefs (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'morning',
  markdown TEXT NOT NULL,
  top_items_json TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(date, kind)
);

CREATE TABLE IF NOT EXISTS job_runs (
  id TEXT PRIMARY KEY,
  job TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  stats_json TEXT NOT NULL DEFAULT '{}',
  error TEXT
);
CREATE INDEX IF NOT EXISTS job_runs_job ON job_runs(job);
CREATE INDEX IF NOT EXISTS job_runs_started ON job_runs(started_at);

CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS calendar_blocks (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'confirmed',
  meta_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS calendar_blocks_range ON calendar_blocks(start_at, end_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL DEFAULT 'null',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  loop_id TEXT REFERENCES open_loops(id),
  title TEXT NOT NULL,
  fire_at TEXT NOT NULL,
  fired_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS reminders_fire_status ON reminders(fire_at, status);

CREATE TABLE IF NOT EXISTS insights (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  week_key TEXT
);

CREATE TABLE IF NOT EXISTS feedback_events (
  id TEXT PRIMARY KEY,
  loop_id TEXT,
  signal TEXT NOT NULL,
  embedding_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_profiles (
  id TEXT PRIMARY KEY,
  role TEXT,
  goals_json TEXT NOT NULL DEFAULT '[]',
  work_hours_json TEXT NOT NULL DEFAULT '{"start":"09:00","end":"18:00"}',
  timezone TEXT,
  interests_json TEXT NOT NULL DEFAULT '[]',
  interest_packs_json TEXT NOT NULL DEFAULT '[]',
  contacts_json TEXT NOT NULL DEFAULT '[]',
  onboarding_done INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function ensureColumn(
  sqlite: ReturnType<typeof getSqlite>,
  table: string,
  column: string,
  ddl: string,
): void {
  try {
    const cols = sqlite
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    if (cols.length > 0 && !cols.some((c) => c.name === column)) {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  } catch {
    /* table may not exist yet — CREATE IF NOT EXISTS handles it */
  }
}

export function migrate(): void {
  const sqlite = getSqlite();
  sqlite.exec(MIGRATION_SQL);
  // Existing installs: add columns if missing
  ensureColumn(
    sqlite,
    "user_spam_rules",
    "intent",
    "intent TEXT NOT NULL DEFAULT 'spam'",
  );
  ensureColumn(sqlite, "open_loops", "due_at", "due_at TEXT");
  ensureColumn(
    sqlite,
    "open_loops",
    "priority",
    "priority REAL DEFAULT 0.5",
  );
  ensureColumn(
    sqlite,
    "open_loops",
    "category",
    "category TEXT NOT NULL DEFAULT 'other'",
  );
  ensureColumn(
    sqlite,
    "open_loops",
    "tags_json",
    "tags_json TEXT NOT NULL DEFAULT '[]'",
  );
  ensureEmbeddingTables(sqlite);
  log.info("Migrations applied", { db: config.dbPath });
}

const isMain =
  process.argv[1] &&
  (process.argv[1].includes("migrate") ||
    process.argv[1].endsWith("migrate.ts"));
if (isMain) {
  migrate();
}
