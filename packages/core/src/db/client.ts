import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config, ensureDataDir } from "../config.js";
import { log } from "../log.js";
import * as schema from "./schema.js";

export type BrainDb = ReturnType<typeof createDb>;

let _db: BrainDb | null = null;
let _sqlite: Database.Database | null = null;
let _vecReady = false;

const require = createRequire(import.meta.url);

function collectVecPaths(): string[] {
  const candidates: string[] = [];
  if (process.env.SQLITE_VEC_EXT) candidates.push(process.env.SQLITE_VEC_EXT);

  try {
    const mod = require("sqlite-vec") as {
      getLoadablePath?: () => string;
      load?: (db: Database.Database) => void;
    };
    if (typeof mod.getLoadablePath === "function") {
      const p = mod.getLoadablePath();
      if (p) candidates.push(p);
    }
  } catch {
    /* optional */
  }

  // Common npm package layout under workspaces
  try {
    const pkgRoot = dirname(require.resolve("sqlite-vec/package.json"));
    const plat = process.platform;
    const arch = process.arch;
    const names = [
      join(pkgRoot, `sqlite-vec-${plat}-${arch}`, "vec0.dll"),
      join(pkgRoot, `sqlite-vec-${plat}-${arch}`, "vec0.so"),
      join(pkgRoot, `sqlite-vec-${plat}-${arch}`, "vec0.dylib"),
      join(pkgRoot, "vec0.dll"),
      join(pkgRoot, "vec0.so"),
    ];
    for (const n of names) {
      if (existsSync(n)) candidates.push(n);
    }
  } catch {
    /* optional */
  }

  return [...new Set(candidates)];
}

function tryLoadSqliteVec(sqlite: Database.Database): boolean {
  try {
    const mod = require("sqlite-vec") as {
      load?: (db: Database.Database) => void;
    };
    if (typeof mod.load === "function") {
      mod.load(sqlite);
      log.info("sqlite-vec loaded via package load()");
      _vecReady = true;
      return true;
    }
  } catch (e) {
    log.debug("sqlite-vec load() failed", { err: String(e) });
  }

  for (const p of collectVecPaths()) {
    try {
      // better-sqlite3 requires enable load extension
      sqlite.loadExtension(p);
      log.info("sqlite-vec loaded", { path: p });
      _vecReady = true;
      return true;
    } catch (e) {
      log.debug("sqlite-vec load failed", { path: p, err: String(e) });
    }
  }
  log.warn(
    "sqlite-vec not available — vector search uses JSON cosine fallback",
  );
  return false;
}

export function isVecReady(): boolean {
  return _vecReady;
}

export function getSqlite(): Database.Database {
  if (_sqlite) return _sqlite;
  ensureDataDir();
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const sqlite = new Database(config.dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  try {
    // Required on some Windows builds before loadExtension
    (sqlite as unknown as { loadExtension: (p: string) => void }).loadExtension;
  } catch {
    /* */
  }
  tryLoadSqliteVec(sqlite);
  _sqlite = sqlite;
  return sqlite;
}

export function createDb() {
  const sqlite = getSqlite();
  return drizzle(sqlite, { schema });
}

export function getDb(): BrainDb {
  if (!_db) _db = createDb();
  return _db;
}

export function closeDb(): void {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
    _vecReady = false;
  }
}

/** Ensure embedding storage tables exist (vec0 if available, else JSON fallback). */
export function ensureEmbeddingTables(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS item_embeddings (
      item_id TEXT PRIMARY KEY,
      embedding_json TEXT NOT NULL,
      dims INTEGER NOT NULL DEFAULT 384,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const dims = config.embed.dims;
  try {
    // Drop stale vec table if present with wrong dims (best-effort)
    sqlite.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_vec USING vec0(
        chunk_id TEXT PRIMARY KEY,
        embedding float[${dims}]
      );
    `);
    log.info("memory_chunks_vec ready", { dims });
    _vecReady = true;
  } catch (e) {
    log.debug("vec0 memory_chunks_vec not created", { err: String(e) });
  }

  try {
    sqlite.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS item_embeddings_vec USING vec0(
        item_id TEXT PRIMARY KEY,
        embedding float[${dims}]
      );
    `);
  } catch (e) {
    log.debug("vec0 item_embeddings_vec not created", { err: String(e) });
  }
}

export function backupDb(): string {
  ensureDataDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(config.backupDir, `brain-${stamp}.db`);
  const sqlite = getSqlite();
  try {
    sqlite.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } catch {
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
    if (existsSync(config.dbPath)) {
      copyFileSync(config.dbPath, dest);
    }
  }
  log.info("Database backup created", { dest });
  return dest;
}

// silence unused in some bundlers
void fileURLToPath;

export { schema };
