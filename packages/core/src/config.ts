import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

function loadDotEnv(): void {
  const candidates = [
    join(process.cwd(), ".env"),
    join(dirname(fileURLToPath(import.meta.url)), "../../../.env"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
    break;
  }
}

loadDotEnv();

/**
 * Ollama keep_alive must be a Go duration ("5m", "24h") or JSON number -1.
 * String "-1" fails on Ollama 0.32+: `time: missing unit in duration "-1"`.
 */
export function normalizeOllamaKeepAlive(
  raw: string | undefined,
): string | number {
  const v = (raw ?? "-1").trim();
  if (!v || v === "-1" || v.toLowerCase() === "forever") return -1;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function defaultDataDir(): string {
  if (process.env.BRAIN_DATA_DIR) return process.env.BRAIN_DATA_DIR;
  // Windows: %LOCALAPPDATA%\second-brain — never inside OneDrive
  if (process.platform === "win32") {
    const local =
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(local, "second-brain");
  }
  return join(homedir(), ".local", "share", "second-brain");
}

export const config = {
  dataDir: defaultDataDir(),
  get dbPath() {
    return join(this.dataDir, "brain.db");
  },
  get backupDir() {
    return join(this.dataDir, "backups");
  },
  get secretsPath() {
    return join(this.dataDir, "secrets.enc.json");
  },
  get spoolDir() {
    return join(this.dataDir, "spool");
  },
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
  webPort: Number(process.env.WEB_PORT ?? 5173),
  /** Built SPA; core serves it so only one process needs a port */
  get webDist() {
    return (
      process.env.WEB_DIST ??
      join(dirname(fileURLToPath(import.meta.url)), "../../../apps/web/dist")
    );
  },
  /** Default timezone — prefer explicit TZ / user profile over a locale guess */
  tz:
    process.env.TZ ??
    Intl.DateTimeFormat().resolvedOptions().timeZone ??
    "UTC",
  get masterKey() {
    return process.env.BRAIN_MASTER_KEY?.trim() || readStoredMasterKey();
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    redirectUri:
      process.env.GOOGLE_REDIRECT_URI ??
      "http://127.0.0.1:3456/oauth/callback",
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.readonly",
      "openid",
      "email",
      "profile",
    ],
  },
  github: {
    token: process.env.GITHUB_TOKEN ?? "",
  },
  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
    models: {
      /** Prefer gpt-oss:20b when pulled; fall back to qwen2.5:14b */
      fast: process.env.OLLAMA_MODEL_FAST ?? "gpt-oss:20b",
      smart: process.env.OLLAMA_MODEL_SMART ?? "gpt-oss:20b",
      fallback: process.env.OLLAMA_MODEL_FALLBACK ?? "qwen2.5:14b",
    },
    /** Embeddings model (GPU when possible) */
    embedModel: process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text",
    /**
     * Keep model loaded. Prefer a Go duration ("24h", "30m") or numeric -1.
     * Bare string "-1" is rejected by Ollama ≥0.32 (`time: missing unit in duration`).
     */
    keepAlive: normalizeOllamaKeepAlive(process.env.OLLAMA_KEEP_ALIVE),
    maxTokens: Number(process.env.OLLAMA_MAX_TOKENS ?? 8192),
    /** Per-call timeout for Ollama chat (ms) */
    timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS ?? 180_000),
  },
  embed: {
    /** Fallback local model when Ollama embeddings unavailable */
    fallbackModel: "Xenova/bge-small-en-v1.5",
    fallbackDims: 384,
    dims: Number(process.env.EMBED_DIMS ?? 768),
  },
  scoring: {
    topNForLlm: 30,
    recencyHalfLifeHours: 48,
  },
  capture: {
    ocrRetentionDays: Number(process.env.OCR_RETENTION_DAYS ?? 30),
    idleSeconds: Number(process.env.CAPTURE_IDLE_SECONDS ?? 120),
  },
  schedule: {
    gmail: "*/15 * * * *",
    gcal: "*/10 * * * *",
    github: "*/20 * * * *",
    capture: "*/1 * * * *",
    enrich: "*/5 * * * *",
    loops: "*/30 * * * *",
    brief: "0 7 * * *",
    plan: "5 7 * * *",
    purge: "30 3 * * *",
    backup: "0 3 * * *",
    reminders: "*/1 * * * *",
    insights: "0 8 * * 1",
    advisor: "30 8 * * *",
    evals: "20 4 * * *",
  },
  hostedLlm: {
    url: process.env.BRAIN_HOSTED_LLM_URL ?? "",
    key: process.env.BRAIN_HOSTED_LLM_KEY ?? "",
    model: process.env.BRAIN_HOSTED_LLM_MODEL ?? "gpt-4o-mini",
  },
};

function masterKeyPath(): string {
  return join(defaultDataDir(), "master.key");
}

function readStoredMasterKey(): string {
  try {
    if (!existsSync(masterKeyPath())) return "";
    return readFileSync(masterKeyPath(), "utf8").trim();
  } catch {
    return "";
  }
}

/** Per-install secret for AES. Never fall back to a public default. */
export function ensureMasterKey(): string {
  const fromEnv = process.env.BRAIN_MASTER_KEY?.trim();
  if (fromEnv) return fromEnv;
  const stored = readStoredMasterKey();
  if (stored) {
    process.env.BRAIN_MASTER_KEY = stored;
    return stored;
  }
  mkdirSync(defaultDataDir(), { recursive: true });
  const key = randomBytes(32).toString("hex");
  writeFileSync(masterKeyPath(), key, { encoding: "utf8", mode: 0o600 });
  process.env.BRAIN_MASTER_KEY = key;
  return key;
}

export function ensureDataDir(): string {
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.backupDir, { recursive: true });
  mkdirSync(config.spoolDir, { recursive: true });
  ensureMasterKey();
  return config.dataDir;
}
