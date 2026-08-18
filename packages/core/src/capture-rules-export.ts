/**
 * Write capture-rules.json for the Rust engine from DB.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, getDb, captureRules, ensureDataDir } from "@second-brain/core";

export function exportCaptureRulesFile(): string {
  ensureDataDir();
  const db = getDb();
  const rules = db.select().from(captureRules).all().filter((r) => r.enabled);
  const block_exe: string[] = [];
  const block_domain: string[] = [];
  for (const r of rules) {
    if (r.ruleType === "block_exe") block_exe.push(r.pattern.toLowerCase());
    if (r.ruleType === "block_domain")
      block_domain.push(r.pattern.toLowerCase());
  }
  const path = join(config.dataDir, "capture-rules.json");
  writeFileSync(path, JSON.stringify({ block_exe, block_domain }, null, 2));
  return path;
}
