import { eq } from "drizzle-orm";
import { getDb } from "./db/client.js";
import { jobRuns } from "./db/schema.js";
import { log } from "./log.js";
import { randomUUID } from "node:crypto";

export type JobResult = {
  stats?: Record<string, unknown>;
};

export async function runJob(
  job: string,
  fn: () => Promise<JobResult | void> | JobResult | void,
): Promise<JobResult> {
  const db = getDb();
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  db.insert(jobRuns)
    .values({
      id,
      job,
      status: "running",
      startedAt,
    })
    .run();

  try {
    const result = (await fn()) ?? {};
    const stats = result.stats ?? {};
    db.update(jobRuns)
      .set({
        status: "ok",
        finishedAt: new Date().toISOString(),
        statsJson: JSON.stringify(stats),
      })
      .where(eq(jobRuns.id, id))
      .run();
    log.info(`Job ok: ${job}`, stats);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.update(jobRuns)
      .set({
        status: "error",
        finishedAt: new Date().toISOString(),
        error: message,
      })
      .where(eq(jobRuns.id, id))
      .run();
    log.error(`Job error: ${job}`, { error: message });
    throw err;
  }
}

export async function withBackoff<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseMs?: number; label?: string } = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  const baseMs = opts.baseMs ?? 500;
  let last: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i === retries) break;
      const wait = baseMs * 2 ** i + Math.random() * 100;
      log.warn(`Retry ${i + 1}/${retries} ${opts.label ?? ""}`, {
        wait,
        err: String(e),
      });
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}

export function newId(): string {
  return randomUUID();
}
