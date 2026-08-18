/**
 * In-process memory tools — also used by packages/mcp.
 */
import {
  getDb,
  items,
  openLoops,
  calendarBlocks,
  artifacts,
  activityBlocks,
  observations,
  loopEvidence,
  newId,
  horizons,
} from "@second-brain/core";
import { retrieveMemory } from "@second-brain/enrich";
import { eq } from "drizzle-orm";
import { createReminder } from "./reminders.js";

export { listRecentlyAutoClosed } from "./loops.js";

export const toolDefs = [
  {
    name: "search_memory",
    description: "Semantic search across local memory chunks",
    parameters: { query: "string", limit: "number?" },
  },
  {
    name: "timeline",
    description: "Activity blocks for a date (YYYY-MM-DD)",
    parameters: { date: "string" },
  },
  {
    name: "open_loops",
    description: "List open loops",
    parameters: { status: "string?" },
  },
  {
    name: "what_did_i_do",
    description: "Summarize activity on a date or recent hours",
    parameters: { date: "string?", hours: "number?" },
  },
  {
    name: "where_did_i_leave_off",
    description: "Recent artifacts with attached open loops",
    parameters: { limit: "number?" },
  },
  {
    name: "find_artifact",
    description: "Find artifacts by title or key substring",
    parameters: { query: "string" },
  },
] as const;

export async function searchMemory(query: string, limit = 15) {
  return retrieveMemory(query, limit);
}

export function timeline(date: string) {
  const db = getDb();
  return db
    .select()
    .from(activityBlocks)
    .all()
    .filter((b) => b.startAt.startsWith(date) || b.startAt.includes(date))
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
}

/**
 * The "open source" affordance follows the link, not the item kind — Gmail
 * classifies plenty of mail as `notification`, which used to read "Open on
 * GitHub" on ordinary email.
 */
function openLabelFor(url: string | null, kind: string | null): string {
  const u = (url ?? "").toLowerCase();
  if (u.includes("mail.google.com")) return "Open in Gmail";
  if (u.includes("calendar.google.com")) return "Open in Calendar";
  if (u.includes("github.com")) return "Open on GitHub";
  if (kind === "email" || kind === "newsletter") return "Open in Gmail";
  if (kind === "pr" || kind === "issue") return "Open on GitHub";
  if (kind === "event") return "Open in Calendar";
  return "Open source";
}

export function listOpenLoops(status = "open") {
  const db = getDb();
  const loops = db
    .select()
    .from(openLoops)
    .all()
    .filter((l) => {
      if (status === "all") return true;
      if (status === "resolved") {
        return l.status === "closed" || l.status === "dismissed";
      }
      return l.status === status;
    })
    .sort((a, b) => {
      if (status === "resolved") {
        return (b.closedAt ?? b.detectedAt).localeCompare(
          a.closedAt ?? a.detectedAt,
        );
      }
      const pd = (b.priority ?? 0) - (a.priority ?? 0);
      if (Math.abs(pd) > 0.001) return pd;
      return (b.confidence ?? 0) - (a.confidence ?? 0);
    });

  return loops.map((loop) => {
    const ev = db
      .select()
      .from(loopEvidence)
      .all()
      .filter((e) => e.loopId === loop.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    let sourceUrl: string | null = null;
    let sourceKind: string | null = null;
    let sourceLabel: string | null = null;

    for (const e of ev) {
      const urlFromNote = e.note?.match(/https?:\/\/\S+/)?.[0] ?? null;
      if (e.itemId) {
        const it = db.select().from(items).where(eq(items.id, e.itemId)).get();
        if (it) {
          sourceUrl = it.url ?? urlFromNote;
          sourceKind = it.kind;
          sourceLabel = openLabelFor(sourceUrl, it.kind);
          break;
        }
      }
      if (e.observationId) {
        const o = db
          .select()
          .from(observations)
          .where(eq(observations.id, e.observationId))
          .get();
        if (o?.url) {
          sourceUrl = o.url;
          sourceKind = "pc";
          sourceLabel = "Open page";
          break;
        }
      }
      if (urlFromNote) {
        sourceUrl = urlFromNote;
        sourceLabel = "Open source";
      }
    }

    let tags: string[] = [];
    try {
      const parsed = JSON.parse(loop.tagsJson || "[]") as unknown;
      if (Array.isArray(parsed)) tags = parsed.map(String);
    } catch {
      /* */
    }

    return {
      ...loop,
      sourceUrl,
      sourceKind,
      sourceLabel,
      category: loop.category || "other",
      tags,
    };
  });
}

export function whatDidIDo(opts: { date?: string; hours?: number } = {}) {
  const db = getDb();
  const hours = opts.hours ?? 12;
  const since = opts.date
    ? `${opts.date}T00:00:00`
    : new Date(Date.now() - hours * 3600_000).toISOString();
  const until = opts.date ? `${opts.date}T23:59:59` : new Date().toISOString();

  const blocks = db
    .select()
    .from(activityBlocks)
    .all()
    .filter((b) => b.startAt >= since && b.startAt <= until)
    .sort((a, b) => a.startAt.localeCompare(b.startAt));

  const obs = db
    .select()
    .from(observations)
    .all()
    .filter((o) => o.ts >= since && o.ts <= until)
    .slice(0, 50);

  return {
    blocks,
    sampleObservations: obs.map((o) => ({
      ts: o.ts,
      app: o.app,
      title: o.windowTitle,
      url: o.url,
      source: o.source,
    })),
  };
}

export function whereDidILeaveOff(limit = 8) {
  const db = getDb();
  return db
    .select()
    .from(artifacts)
    .all()
    .sort((a, b) => b.lastTouchedAt.localeCompare(a.lastTouchedAt))
    .slice(0, limit);
}

export function findArtifact(query: string) {
  const db = getDb();
  const q = query.toLowerCase();
  return db
    .select()
    .from(artifacts)
    .all()
    .filter(
      (a) =>
        a.title.toLowerCase().includes(q) ||
        a.key.toLowerCase().includes(q),
    )
    .slice(0, 25);
}

export function getLoopEvidence(loopId: string) {
  const db = getDb();
  return db
    .select()
    .from(loopEvidence)
    .all()
    .filter((e) => e.loopId === loopId);
}

export function queryItems(limit = 20) {
  const db = getDb();
  return db
    .select()
    .from(items)
    .all()
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, limit)
    .map((i) => ({
      id: i.id,
      title: i.title,
      kind: i.kind,
      relevance: i.relevance,
      url: i.url,
    }));
}

export function getCalendar(date: string) {
  const db = getDb();
  return db
    .select()
    .from(calendarBlocks)
    .all()
    .filter((b) => b.startAt.startsWith(date) || b.startAt.includes(date));
}

export function updateLoopStatus(
  id: string,
  status: "open" | "closed" | "snoozed" | "dismissed",
) {
  const db = getDb();
  const now = new Date().toISOString();

  if (status === "snoozed") {
    const fireAt = new Date(Date.now() + 60 * 60_000).toISOString();
    db.update(openLoops)
      .set({ status: "snoozed", updatedAt: now })
      .where(eq(openLoops.id, id))
      .run();
    const loop = db.select().from(openLoops).where(eq(openLoops.id, id)).get();
    createReminder({
      title: `Snooze wake: ${loop?.title ?? "loop"}`,
      fireAt,
      loopId: id,
      meta: { kind: "snooze" },
    });
    return { id, status };
  }

  db.update(openLoops)
    .set({
      status,
      closedAt: status === "closed" || status === "dismissed" ? now : null,
      closeReason: status === "closed" || status === "dismissed" ? "manual" : null,
      updatedAt: now,
    })
    .where(eq(openLoops.id, id))
    .run();

  // Fire-and-forget feedback (positive on close, negative on dismiss)
  void import("./feedback.js").then(({ recordLoopFeedback }) => {
    if (status === "closed") return recordLoopFeedback(id, "positive");
    if (status === "dismissed") return recordLoopFeedback(id, "dismiss");
    return;
  });

  return { id, status };
}

export function createManualLoop(input: {
  title: string;
  kind?: string;
  description?: string;
  dueHint?: string;
  horizonSlug?: string;
  tags?: string[];
  category?: string;
}) {
  const db = getDb();
  const h = input.horizonSlug
    ? db
        .select()
        .from(horizons)
        .all()
        .find((x) => x.slug === input.horizonSlug)
    : null;
  const id = newId();
  const now = new Date().toISOString();
  db.insert(openLoops)
    .values({
      id,
      title: input.title,
      description: input.description ?? null,
      kind: input.kind ?? "unfinished",
      status: "open",
      confidence: 1,
      detectedAt: now,
      dueHint: input.dueHint ?? null,
      lastSeenAt: now,
      origin: "manual",
      horizonId: h?.id ?? null,
      category: input.category ?? "other",
      tagsJson: JSON.stringify(input.tags ?? []),
    })
    .run();
  return { id };
}

// legacy aliases
export function listTasks() {
  return listOpenLoops("open");
}

export function proposeTask(input: {
  title: string;
  description?: string;
  horizonSlug?: string;
  priority?: number;
  confidence?: number;
  sourceItemId?: string;
}) {
  return createManualLoop({
    title: input.title,
    description: input.description,
    horizonSlug: input.horizonSlug,
  });
}
