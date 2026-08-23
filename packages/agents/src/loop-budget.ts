/**
 * Budget Ollama calls for loop structuring so we don't thrash local VRAM/CPU.
 * Defaults are effectively uncapped for AI-first quality; settings still override.
 */

import { getDb, settings, usageEvents, log } from "@second-brain/core";

const DEFAULT_MAX_PER_RUN = 400;
const DEFAULT_MAX_PER_DAY = 2000;

function readSettingNumber(key: string, fallback: number): number {
  try {
    const row = getDb().select().from(settings).all().find((r) => r.key === key);
    if (!row) return fallback;
    const v = JSON.parse(row.valueJson);
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

export function getLoopLlmBudget(): {
  maxPerRun: number;
  maxPerDay: number;
  usedToday: number;
  remainingToday: number;
} {
  const maxPerRun = readSettingNumber("loops.llmMaxPerRun", DEFAULT_MAX_PER_RUN);
  const maxPerDay = readSettingNumber("loops.llmMaxPerDay", DEFAULT_MAX_PER_DAY);
  const dayPrefix = new Date().toISOString().slice(0, 10);
  const usedToday = getDb()
    .select()
    .from(usageEvents)
    .all()
    .filter((e) => {
      if (!e.createdAt?.startsWith(dayPrefix)) return false;
      if (e.kind !== "ollama" && e.kind !== "loop-structure") return false;
      try {
        const meta = JSON.parse(e.metaJson || "{}") as { purpose?: string };
        return (
          meta.purpose === "structure_loops" ||
          meta.purpose === "loop_extract" ||
          meta.purpose === "loop_repair" ||
          meta.purpose === "loop_dedupe" ||
          meta.purpose === "loop_resolve" ||
          meta.purpose === "loop_review" ||
          meta.purpose === "polish_chat" ||
          e.kind === "loop-structure"
        );
      } catch {
        return false;
      }
    }).length;
  return {
    maxPerRun,
    maxPerDay,
    usedToday,
    remainingToday: Math.max(0, maxPerDay - usedToday),
  };
}

/** How many LLM structure calls this detect run may make */
export function llmSlotsForThisRun(): number {
  const b = getLoopLlmBudget();
  const slots = Math.min(b.maxPerRun, b.remainingToday);
  if (slots <= 0) {
    log.info("Loop LLM budget exhausted — heuristics only", {
      usedToday: b.usedToday,
      maxPerDay: b.maxPerDay,
    });
  }
  return slots;
}

/** Serial queue so loop LLM calls never overlap (one resident model). */
let queueTail: Promise<unknown> = Promise.resolve();

export function enqueueLlm<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueTail.then(fn, fn);
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
