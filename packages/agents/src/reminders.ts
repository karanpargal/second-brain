import {
  getDb,
  reminders,
  openLoops,
  calendarBlocks,
  newId,
  log,
  config,
} from "@second-brain/core";
import { eq } from "drizzle-orm";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export function createReminder(input: {
  title: string;
  fireAt: string;
  loopId?: string | null;
  meta?: Record<string, unknown>;
}): string {
  const id = newId();
  getDb()
    .insert(reminders)
    .values({
      id,
      title: input.title,
      fireAt: input.fireAt,
      loopId: input.loopId ?? null,
      status: "pending",
      metaJson: JSON.stringify(input.meta ?? {}),
    })
    .run();
  return id;
}

/** Snooze a loop: set status snoozed and schedule wake reminder. */
export function snoozeLoop(loopId: string, minutes = 60): { ok: boolean } {
  const db = getDb();
  const loop = db.select().from(openLoops).where(eq(openLoops.id, loopId)).get();
  if (!loop) return { ok: false };
  const fireAt = new Date(Date.now() + minutes * 60_000).toISOString();
  const now = new Date().toISOString();
  db.update(openLoops)
    .set({ status: "snoozed", updatedAt: now })
    .where(eq(openLoops.id, loopId))
    .run();
  createReminder({
    title: `Snooze wake: ${loop.title}`,
    fireAt,
    loopId,
    meta: { kind: "snooze" },
  });
  return { ok: true };
}

export function fireDueReminders(): {
  fired: number;
  notifications: Array<{ title: string; body: string; loopId?: string | null }>;
} {
  const db = getDb();
  const now = new Date().toISOString();
  const due = db
    .select()
    .from(reminders)
    .all()
    .filter((r) => r.status === "pending" && r.fireAt <= now)
    .slice(0, 50);

  const notifications: Array<{
    title: string;
    body: string;
    loopId?: string | null;
  }> = [];

  for (const r of due) {
    db.update(reminders)
      .set({ status: "fired", firedAt: now })
      .where(eq(reminders.id, r.id))
      .run();

    let meta: { kind?: string } = {};
    try {
      meta = JSON.parse(r.metaJson || "{}") as { kind?: string };
    } catch {
      /* */
    }

    if (meta.kind === "snooze" && r.loopId) {
      db.update(openLoops)
        .set({ status: "open", updatedAt: now, lastSeenAt: now })
        .where(eq(openLoops.id, r.loopId))
        .run();
    }

    notifications.push({
      title: "Second Brain",
      body: r.title,
      loopId: r.loopId,
    });
  }

  if (notifications.length > 0) {
    try {
      writeFileSync(
        join(config.dataDir, "pending-notifications.json"),
        JSON.stringify({ at: now, items: notifications }),
      );
    } catch (e) {
      log.warn("Failed to write pending notifications", { err: String(e) });
    }
  }

  return { fired: notifications.length, notifications };
}

/** Ensure calendar events today get a 15-min lead reminder once. */
export function ensureCalendarLeadReminders(): number {
  const db = getDb();
  const day = new Date().toISOString().slice(0, 10);
  const events = db
    .select()
    .from(calendarBlocks)
    .all()
    .filter((b) => b.startAt.startsWith(day));
  let n = 0;
  for (const ev of events) {
    const start = Date.parse(ev.startAt);
    if (Number.isNaN(start)) continue;
    const fireAt = new Date(start - 15 * 60_000).toISOString();
    if (fireAt < new Date().toISOString()) continue;
    const key = `cal:${ev.externalId}`;
    const exists = db
      .select()
      .from(reminders)
      .all()
      .some((r) => {
        try {
          return (JSON.parse(r.metaJson || "{}") as { key?: string }).key === key;
        } catch {
          return false;
        }
      });
    if (exists) continue;
    createReminder({
      title: `Upcoming: ${ev.title}`,
      fireAt,
      meta: { kind: "calendar", key },
    });
    n++;
  }
  return n;
}
