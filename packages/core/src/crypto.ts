import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config, ensureDataDir, ensureMasterKey } from "./config.js";

const ALGO = "aes-256-gcm";
const LEGACY_DEFAULT_KEY = "dev-insecure-key-change-me-please";

function deriveKey(secret?: string): Buffer {
  const s = secret ?? (config.masterKey || ensureMasterKey());
  return scryptSync(s, "second-brain-salt-v1", 32);
}

export function encrypt(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decrypt(payload: string, secret?: string): string {
  const buf = Buffer.from(payload, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const key = deriveKey(secret);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    "utf8",
  );
}

export type SecretsStore = Record<string, string>;

export function loadSecrets(): SecretsStore {
  ensureDataDir();
  if (!existsSync(config.secretsPath)) return {};
  try {
    const raw = readFileSync(config.secretsPath, "utf8");
    const parsed = JSON.parse(raw) as { payload: string };
    try {
      return JSON.parse(decrypt(parsed.payload)) as SecretsStore;
    } catch {
      const migrated = JSON.parse(
        decrypt(parsed.payload, LEGACY_DEFAULT_KEY),
      ) as SecretsStore;
      saveSecrets(migrated);
      return migrated;
    }
  } catch {
    return {};
  }
}

export function saveSecrets(secrets: SecretsStore): void {
  ensureDataDir();
  mkdirSync(dirname(config.secretsPath), { recursive: true });
  const payload = encrypt(JSON.stringify(secrets));
  writeFileSync(
    config.secretsPath,
    JSON.stringify({ v: 1, payload }, null, 2),
    "utf8",
  );
}

export function getSecret(key: string): string | undefined {
  return loadSecrets()[key];
}

export function setSecret(key: string, value: string): void {
  const s = loadSecrets();
  s[key] = value;
  saveSecrets(s);
}

export function deleteSecret(key: string): void {
  const s = loadSecrets();
  delete s[key];
  saveSecrets(s);
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function contentHash(parts: (string | null | undefined)[]): string {
  return sha256(parts.filter(Boolean).join("\n---\n").toLowerCase().trim());
}
