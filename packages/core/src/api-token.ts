import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, ensureDataDir } from "./config.js";

const TOKEN_FILE = "api-token";

export function apiTokenPath(): string {
  return join(config.dataDir, TOKEN_FILE);
}

/**
 * Load or create the per-install API token.
 * Stored as plain text in the local data dir (same trust boundary as brain.db).
 */
export function ensureApiToken(): string {
  ensureDataDir();
  const path = apiTokenPath();
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= 32) return existing;
  }
  const token = randomBytes(32).toString("base64url");
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(path, token, { encoding: "utf8", mode: 0o600 });
  return token;
}

export function readApiToken(): string | null {
  const path = apiTokenPath();
  if (!existsSync(path)) return null;
  const t = readFileSync(path, "utf8").trim();
  return t.length >= 32 ? t : null;
}

export function extractBearerToken(
  authorization: string | undefined,
  xBrainToken: string | undefined,
): string | null {
  if (xBrainToken?.trim()) return xBrainToken.trim();
  if (!authorization) return null;
  const m = authorization.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() ?? null;
}

export const API_TOKEN_COOKIE = "brain_token";

/**
 * The SPA is served by this same process, so it can authenticate with a cookie
 * we set ourselves. SameSite=Strict keeps other sites from riding along.
 */
export function apiTokenCookieHeader(): string {
  const token = ensureApiToken();
  return `${API_TOKEN_COOKIE}=${token}; Path=/; SameSite=Strict; HttpOnly; Max-Age=31536000`;
}

export function extractCookieToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== API_TOKEN_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    if (value) return value;
  }
  return null;
}

export function isValidApiToken(presented: string | null | undefined): boolean {
  if (!presented) return false;
  const expected = ensureApiToken();
  if (presented.length !== expected.length) return false;
  // Constant-time compare
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  }
  return diff === 0;
}

/** Origins allowed to call the local API (CORS). */
export const ALLOWED_ORIGINS = [
  "http://127.0.0.1:3000",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "tauri://localhost",
  "https://tauri.localhost",
  "http://tauri.localhost",
] as const;

export function corsOriginFor(requestOrigin: string | undefined): string | null {
  if (!requestOrigin) return null;
  if ((ALLOWED_ORIGINS as readonly string[]).includes(requestOrigin)) {
    return requestOrigin;
  }
  // Allow any 127.0.0.1 / localhost port used by Vite/Tauri
  try {
    const u = new URL(requestOrigin);
    if (
      (u.hostname === "127.0.0.1" || u.hostname === "localhost") &&
      (u.protocol === "http:" || u.protocol === "https:")
    ) {
      return requestOrigin;
    }
  } catch {
    /* */
  }
  return null;
}
