import { google } from "googleapis";
import {
  getDb,
  calendarBlocks,
  newId,
} from "@second-brain/core";
import { eq } from "drizzle-orm";
import { getAuthedClient, googleStatus } from "./google-auth.js";
import {
  getSource,
  readCursor,
  writeCursor,
  setSourceError,
  upsertItems,
  type ConnectorResult,
  type NormalizedItem,
  log,
} from "./base.js";

export async function syncGcal(): Promise<ConnectorResult> {
  const sourceId = "src-gcal";
  getSource(sourceId);

  const status = await googleStatus();
  if (!status.connected) throw new Error("Google not connected");

  const auth = await getAuthedClient();
  const cal = google.calendar({ version: "v3", auth });
  const cursor = readCursor(sourceId);
  let syncToken = cursor.syncToken as string | undefined;

  const timeMin = new Date();
  timeMin.setDate(timeMin.getDate() - 1);
  const timeMax = new Date();
  timeMax.setDate(timeMax.getDate() + 21);

  const normalized: NormalizedItem[] = [];
  const db = getDb();

  try {
    type EventItem = {
      id?: string | null;
      summary?: string | null;
      description?: string | null;
      htmlLink?: string | null;
      status?: string | null;
      start?: { dateTime?: string | null; date?: string | null };
      end?: { dateTime?: string | null; date?: string | null };
      organizer?: { email?: string | null; displayName?: string | null };
      attendees?: unknown;
      recurringEventId?: string | null;
    };

    const events: EventItem[] = [];
    let pageToken: string | undefined;

    do {
      const res = await cal.events.list({
        calendarId: "primary",
        singleEvents: true,
        orderBy: syncToken ? undefined : "startTime",
        timeMin: syncToken ? undefined : timeMin.toISOString(),
        timeMax: syncToken ? undefined : timeMax.toISOString(),
        syncToken: syncToken,
        pageToken,
        maxResults: 250,
      });
      events.push(...((res.data.items ?? []) as EventItem[]));
      pageToken = res.data.nextPageToken ?? undefined;
      if (res.data.nextSyncToken) {
        syncToken = res.data.nextSyncToken;
      }
    } while (pageToken);

    for (const ev of events) {
      if (!ev.id) continue;
      const start = ev.start?.dateTime ?? ev.start?.date;
      const end = ev.end?.dateTime ?? ev.end?.date;
      if (!start || !end) continue;
      const allDay = Boolean(ev.start?.date && !ev.start?.dateTime);
      const title = ev.summary || "(busy)";

      normalized.push({
        externalId: ev.id,
        kind: "event",
        title,
        body: ev.description ?? undefined,
        url: ev.htmlLink ?? undefined,
        author: ev.organizer?.displayName ?? ev.organizer?.email ?? undefined,
        publishedAt: start,
        meta: {
          start,
          end,
          allDay,
          status: ev.status,
          recurringEventId: ev.recurringEventId,
        },
        raw: ev,
      });

      const existing = db
        .select()
        .from(calendarBlocks)
        .where(eq(calendarBlocks.externalId, ev.id))
        .get();

      if (existing) {
        db.update(calendarBlocks)
          .set({
            title,
            startAt: new Date(start).toISOString(),
            endAt: new Date(end).toISOString(),
            allDay,
            status: ev.status ?? "confirmed",
            metaJson: JSON.stringify(ev),
            updatedAt: new Date().toISOString(),
          })
          .where(eq(calendarBlocks.id, existing.id))
          .run();
      } else {
        db.insert(calendarBlocks)
          .values({
            id: newId(),
            externalId: ev.id,
            title,
            startAt: new Date(start).toISOString(),
            endAt: new Date(end).toISOString(),
            allDay,
            status: ev.status ?? "confirmed",
            metaJson: JSON.stringify(ev),
          })
          .run();
      }
    }

    const upserted = upsertItems(sourceId, normalized);
    writeCursor(sourceId, { syncToken });
    log.info("GCal synced", { events: events.length, upserted });
    return { fetched: events.length, upserted, cursor: { syncToken } };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // 410 Gone => full resync
    if (msg.includes("410") || msg.includes("Sync token")) {
      log.warn("GCal sync token expired — clearing");
      writeCursor(sourceId, {});
      return { fetched: 0, upserted: 0 };
    }
    setSourceError(sourceId, msg);
    throw e;
  }
}

/** Free blocks between work hours for a given local date (YYYY-MM-DD). */
export function freeBlocksForDate(
  date: string,
  opts: { workStartHour?: number; workEndHour?: number; tzOffsetMin?: number } = {},
): { start: string; end: string; minutes: number }[] {
  const workStart = opts.workStartHour ?? 9;
  const workEnd = opts.workEndHour ?? 18;
  const db = getDb();

  // Interpret date as local YYYY-MM-DD
  const dayStart = new Date(`${date}T00:00:00`);
  const winStart = new Date(dayStart);
  winStart.setHours(workStart, 0, 0, 0);
  const winEnd = new Date(dayStart);
  winEnd.setHours(workEnd, 0, 0, 0);

  const busy = db
    .select()
    .from(calendarBlocks)
    .all()
    .filter((b) => {
      if (b.status === "cancelled") return false;
      if (b.allDay) return false;
      const s = new Date(b.startAt).getTime();
      const e = new Date(b.endAt).getTime();
      return e > winStart.getTime() && s < winEnd.getTime();
    })
    .map((b) => ({
      start: Math.max(new Date(b.startAt).getTime(), winStart.getTime()),
      end: Math.min(new Date(b.endAt).getTime(), winEnd.getTime()),
    }))
    .sort((a, b) => a.start - b.start);

  // merge overlapping
  const merged: { start: number; end: number }[] = [];
  for (const b of busy) {
    const last = merged[merged.length - 1];
    if (last && b.start <= last.end) {
      last.end = Math.max(last.end, b.end);
    } else {
      merged.push({ ...b });
    }
  }

  const free: { start: string; end: string; minutes: number }[] = [];
  let cursor = winStart.getTime();
  for (const b of merged) {
    if (b.start > cursor) {
      const minutes = Math.round((b.start - cursor) / 60_000);
      if (minutes >= 15) {
        free.push({
          start: new Date(cursor).toISOString(),
          end: new Date(b.start).toISOString(),
          minutes,
        });
      }
    }
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < winEnd.getTime()) {
    const minutes = Math.round((winEnd.getTime() - cursor) / 60_000);
    if (minutes >= 15) {
      free.push({
        start: new Date(cursor).toISOString(),
        end: winEnd.toISOString(),
        minutes,
      });
    }
  }
  return free;
}
