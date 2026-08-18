import {
  getDb,
  sources,
  rawEvents,
  items,
  contentHash,
  newId,
  log,
  withBackoff,
  isSpam,
} from "@second-brain/core";
import { eq } from "drizzle-orm";

export type ConnectorResult = {
  fetched: number;
  upserted: number;
  skippedSpam?: number;
  cursor?: Record<string, unknown>;
};

export type NormalizedItem = {
  externalId: string;
  kind: string;
  title: string;
  body?: string;
  url?: string;
  author?: string;
  publishedAt?: string;
  meta?: Record<string, unknown>;
  raw: unknown;
};

export function getSource(id: string) {
  const db = getDb();
  const row = db.select().from(sources).where(eq(sources.id, id)).get();
  if (!row) throw new Error(`Source not found: ${id}`);
  return row;
}

export function readCursor(sourceId: string): Record<string, unknown> {
  const row = getSource(sourceId);
  try {
    return JSON.parse(row.cursorJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function writeCursor(
  sourceId: string,
  cursor: Record<string, unknown>,
): void {
  const db = getDb();
  db.update(sources)
    .set({
      cursorJson: JSON.stringify(cursor),
      lastRunAt: new Date().toISOString(),
      lastError: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(sources.id, sourceId))
    .run();
}

export function setSourceError(sourceId: string, err: string): void {
  const db = getDb();
  db.update(sources)
    .set({
      lastError: err,
      lastRunAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(sources.id, sourceId))
    .run();
}

function labelsFromMeta(meta?: Record<string, unknown>): string[] | null {
  if (!meta) return null;
  const ids = meta.labelIds;
  if (Array.isArray(ids)) return ids.map(String);
  return null;
}

export function upsertItems(
  sourceId: string,
  list: NormalizedItem[],
): number {
  const db = getDb();
  let n = 0;
  let skippedSpam = 0;
  for (const it of list) {
    const verdict = isSpam({
      kind: it.kind,
      title: it.title,
      body: it.body,
      author: it.author,
      url: it.url,
      labels: labelsFromMeta(it.meta),
      meta: it.meta,
    });
    if (verdict) {
      skippedSpam++;
      continue;
    }

    const rawId = newId();
    const hash = contentHash([
      it.kind,
      it.title,
      it.body ?? "",
      it.url ?? "",
      it.externalId,
    ]);

    try {
      db.insert(rawEvents)
        .values({
          id: rawId,
          sourceId,
          externalId: it.externalId,
          payloadJson: JSON.stringify(it.raw),
        })
        .onConflictDoNothing()
        .run();
    } catch {
      // ignore
    }

    const existing = db
      .select()
      .from(items)
      .where(eq(items.externalId, it.externalId))
      .all()
      .find((r) => r.sourceId === sourceId);

    if (existing) {
      if (existing.contentHash !== hash) {
        db.update(items)
          .set({
            title: it.title,
            body: it.body ?? null,
            url: it.url ?? null,
            author: it.author ?? null,
            contentHash: hash,
            publishedAt: it.publishedAt ?? null,
            metaJson: JSON.stringify(it.meta ?? {}),
            embedded: false,
            annotated: false,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(items.id, existing.id))
          .run();
        n++;
      }
      continue;
    }

    db.insert(items)
      .values({
        id: newId(),
        sourceId,
        rawEventId: rawId,
        externalId: it.externalId,
        kind: it.kind,
        title: it.title,
        body: it.body ?? null,
        url: it.url ?? null,
        author: it.author ?? null,
        contentHash: hash,
        publishedAt: it.publishedAt ?? null,
        metaJson: JSON.stringify(it.meta ?? {}),
      })
      .run();
    n++;
  }
  if (skippedSpam > 0) {
    log.info("Internal spam filter skipped items", { sourceId, skippedSpam });
  }
  return n;
}

export { log, withBackoff };
