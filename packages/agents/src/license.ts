/**
 * Per-seat license / trial for local installs.
 * Validation is offline HMAC of the key against BRAIN_LICENSE_SECRET (or master key).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  getDb,
  settings,
  config,
  getSecret,
  setSecret,
} from "@second-brain/core";
import { eq } from "drizzle-orm";

const TRIAL_DAYS = 14;

function licenseSecret(): string {
  return (
    process.env.BRAIN_LICENSE_SECRET ||
    config.masterKey ||
    "second-brain-dev-license"
  );
}

function settingGet(key: string): unknown {
  const row = getDb().select().from(settings).where(eq(settings.key, key)).get();
  if (!row) return null;
  try {
    return JSON.parse(row.valueJson);
  } catch {
    return row.valueJson;
  }
}

function settingSet(key: string, value: unknown): void {
  const db = getDb();
  const valueJson = JSON.stringify(value);
  const existing = db.select().from(settings).where(eq(settings.key, key)).get();
  const now = new Date().toISOString();
  if (existing) {
    db.update(settings)
      .set({ valueJson, updatedAt: now })
      .where(eq(settings.key, key))
      .run();
  } else {
    db.insert(settings).values({ key, valueJson }).run();
  }
}

function ensureTrialStart(): string {
  const existing = settingGet("license.trialStartedAt");
  if (typeof existing === "string" && existing) return existing;
  const now = new Date().toISOString();
  settingSet("license.trialStartedAt", now);
  return now;
}

export function verifyLicenseKey(key: string): boolean {
  const raw = key.trim();
  // Format: SB1.<payload>.<sig> where payload is base64url email|expiry
  const parts = raw.split(".");
  if (parts.length !== 3 || parts[0] !== "SB1") return false;
  const [, payload, sig] = parts;
  const expected = createHmac("sha256", licenseSecret())
    .update(payload!)
    .digest("base64url");
  try {
    const a = Buffer.from(sig!);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    if (!timingSafeEqual(a, b)) return false;
  } catch {
    return false;
  }
  try {
    const decoded = Buffer.from(payload!, "base64url").toString("utf8");
    const expiry = decoded.split("|")[1];
    if (expiry && Date.parse(expiry) < Date.now()) return false;
  } catch {
    return false;
  }
  return true;
}

export async function activateLicense(key: string): Promise<{ ok: boolean; error?: string }> {
  if (!verifyLicenseKey(key)) {
    return { ok: false, error: "Invalid or expired license key" };
  }
  await setSecret("license_key", key.trim());
  settingSet("license.activatedAt", new Date().toISOString());
  return { ok: true };
}

export async function licenseStatus(): Promise<{
  licensed: boolean;
  trial: boolean;
  expiresAt: string | null;
}> {
  const key = await getSecret("license_key");
  if (key && verifyLicenseKey(key)) {
    let expiresAt: string | null = null;
    try {
      const payload = key.split(".")[1]!;
      const decoded = Buffer.from(payload, "base64url").toString("utf8");
      expiresAt = decoded.split("|")[1] ?? null;
    } catch {
      /* */
    }
    return { licensed: true, trial: false, expiresAt };
  }
  const started = ensureTrialStart();
  const end = new Date(Date.parse(started) + TRIAL_DAYS * 86400_000).toISOString();
  const trialActive = Date.now() < Date.parse(end);
  return {
    licensed: trialActive,
    trial: trialActive,
    expiresAt: end,
  };
}
