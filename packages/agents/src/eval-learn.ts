/**
 * Persist eval reports so later LLM runs can few-shot from misses.
 */
import { getDb, settings } from "@second-brain/core";
import { eq } from "drizzle-orm";

const REPORT_KEY = "eval.lastReport";
const FEWSHOT_KEY = "eval.fewShot";

export type EvalLearnMiss = {
  id: string;
  note: string;
};

export type EvalLearnReport = {
  at: string;
  heuristicF1: number;
  heuristicN: number;
  aiSkipped?: boolean;
  aiF1?: number;
  aiN?: number;
  misses: EvalLearnMiss[];
};

function upsertSetting(key: string, value: unknown) {
  const db = getDb();
  const now = new Date().toISOString();
  const json = JSON.stringify(value);
  const existing = db.select().from(settings).where(eq(settings.key, key)).get();
  if (existing) {
    db.update(settings)
      .set({ valueJson: json, updatedAt: now })
      .where(eq(settings.key, key))
      .run();
  } else {
    db.insert(settings)
      .values({ key, valueJson: json, updatedAt: now })
      .run();
  }
}

function readSetting<T>(key: string): T | null {
  const row = getDb()
    .select()
    .from(settings)
    .where(eq(settings.key, key))
    .get();
  if (!row) return null;
  try {
    return JSON.parse(row.valueJson) as T;
  } catch {
    return null;
  }
}

export function saveEvalLearn(report: EvalLearnReport): void {
  upsertSetting(REPORT_KEY, report);
  const lines = report.misses
    .slice(0, 8)
    .map((m) => `- ${m.id}: ${m.note}`)
    .filter((l) => l.length > 8);
  upsertSetting(FEWSHOT_KEY, lines.join("\n"));
}

export function lastEvalLearn(): EvalLearnReport | null {
  return readSetting<EvalLearnReport>(REPORT_KEY);
}

/** Injected into STRUCTURE_LOOPS so the model corrects recent misses. */
export function evalFewShotForPrompt(): string {
  const raw = readSetting<string>(FEWSHOT_KEY);
  if (!raw || !raw.trim()) return "(none)";
  return raw.trim().slice(0, 1200);
}
