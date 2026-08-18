import {
  getDb,
  getSqlite,
  isVecReady,
  items,
  memoryChunks,
  goals,
  config,
  log,
  newId,
} from "@second-brain/core";
import { eq } from "drizzle-orm";
import { cosine, embedText, lastEmbedMeta } from "./embeddings.js";

export type RetrievalHit = {
  chunkId: string;
  kind: string;
  refId: string;
  text: string;
  score: number;
  ts: string | null;
  dwellMs: number;
};

function recencyScore(ts: string | null, halfLifeH: number): number {
  if (!ts) return 0.4;
  const ageH = (Date.now() - new Date(ts).getTime()) / (1000 * 60 * 60);
  if (Number.isNaN(ageH) || ageH < 0) return 0.5;
  return Math.exp((-Math.LN2 * ageH) / halfLifeH);
}

function dwellBoost(dwellMs: number): number {
  // Cap at ~30 min effective dwell
  const minutes = Math.min(30, dwellMs / 60_000);
  return Math.min(1, minutes / 15);
}

function goalBoost(text: string, goalTitles: string[]): number {
  if (goalTitles.length === 0) return 0.4;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const g of goalTitles) {
    const toks = g.toLowerCase().split(/\W+/).filter((t) => t.length > 3);
    if (toks.some((t) => lower.includes(t))) hits++;
  }
  return Math.min(1, hits / Math.max(1, goalTitles.length) + 0.2);
}

function authority(kind: string): number {
  const map: Record<string, number> = {
    email: 0.9,
    event: 0.85,
    issue: 0.95,
    pr: 0.95,
    observation: 0.7,
    ocr: 0.65,
    window: 0.55,
    browser: 0.6,
    loop: 0.9,
    block: 0.75,
  };
  return map[kind] ?? 0.5;
}

/** Recency- and dwell-weighted retrieval over memory_chunks */
export async function retrieveMemory(
  query: string,
  limit = 20,
): Promise<RetrievalHit[]> {
  const qEmb = await embedText(query);
  const db = getDb();
  const goalTitles = db
    .select()
    .from(goals)
    .all()
    .filter((g) => g.status === "active")
    .map((g) => g.title);

  // Prefer sqlite-vec when available
  if (isVecReady()) {
    try {
      const sqlite = getSqlite();
      const rows = sqlite
        .prepare(
          `SELECT chunk_id, distance FROM memory_chunks_vec
           WHERE embedding MATCH ?
           ORDER BY distance
           LIMIT ?`,
        )
        .all(JSON.stringify(qEmb), limit * 3) as Array<{
        chunk_id: string;
        distance: number;
      }>;
      const hits: RetrievalHit[] = [];
      for (const r of rows) {
        const chunk = db
          .select()
          .from(memoryChunks)
          .where(eq(memoryChunks.id, r.chunk_id))
          .get();
        if (!chunk) continue;
        const sim = 1 / (1 + (r.distance ?? 1));
        const rec = recencyScore(
          chunk.ts,
          config.scoring.recencyHalfLifeHours,
        );
        const dwell = dwellBoost(chunk.dwellMs);
        const gs = goalBoost(chunk.text, goalTitles);
        const auth = authority(chunk.kind);
        const score =
          sim * 0.45 + rec * 0.25 + dwell * 0.2 + gs * 0.05 + auth * 0.05;
        hits.push({
          chunkId: chunk.id,
          kind: chunk.kind,
          refId: chunk.refId,
          text: chunk.text,
          score,
          ts: chunk.ts,
          dwellMs: chunk.dwellMs,
        });
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, limit);
    } catch (e) {
      log.debug("vec retrieve failed, falling back", { err: String(e) });
    }
  }

  const chunks = db
    .select()
    .from(memoryChunks)
    .all()
    .filter((c) => c.embedded && c.embeddingJson)
    .slice(-2000); // bound full-scan

  const hits: RetrievalHit[] = [];
  for (const chunk of chunks) {
    let emb: number[];
    try {
      emb = JSON.parse(chunk.embeddingJson!) as number[];
    } catch {
      continue;
    }
    if (emb.length !== qEmb.length) continue;
    const sim = (cosine(emb, qEmb) + 1) / 2;
    const rec = recencyScore(chunk.ts, config.scoring.recencyHalfLifeHours);
    const dwell = dwellBoost(chunk.dwellMs);
    const gs = goalBoost(chunk.text, goalTitles);
    const auth = authority(chunk.kind);
    const score =
      sim * 0.45 + rec * 0.25 + dwell * 0.2 + gs * 0.05 + auth * 0.05;
    hits.push({
      chunkId: chunk.id,
      kind: chunk.kind,
      refId: chunk.refId,
      text: chunk.text,
      score,
      ts: chunk.ts,
      dwellMs: chunk.dwellMs,
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Score an external item (gmail/github/calendar) for open-loop ranking */
export async function scoreItem(itemId: string): Promise<number> {
  const db = getDb();
  const item = db.select().from(items).where(eq(items.id, itemId)).get();
  if (!item) throw new Error("item not found");

  const rec = recencyScore(
    item.publishedAt,
    config.scoring.recencyHalfLifeHours,
  );
  const auth = authority(item.kind);
  const total = rec * 0.55 + auth * 0.45;

  db.update(items)
    .set({
      relevance: total,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(items.id, itemId))
    .run();
  return total;
}

export async function embedUnembeddedItems(limit = 50): Promise<number> {
  const db = getDb();
  const pending = db
    .select()
    .from(items)
    .all()
    .filter((i) => !i.embedded)
    .slice(0, limit);

  const sqlite = getSqlite();
  const insertItem = sqlite.prepare(
    `INSERT OR REPLACE INTO item_embeddings (item_id, embedding_json, dims, model)
     VALUES (?, ?, ?, ?)`,
  );

  let n = 0;
  for (const item of pending) {
    const text = `${item.title}\n${(item.body ?? "").slice(0, 1500)}`;
    const emb = await embedText(text);
    const { model, dims } = lastEmbedMeta();
    insertItem.run(item.id, JSON.stringify(emb), dims, model);
    try {
      sqlite
        .prepare(
          `INSERT OR REPLACE INTO item_embeddings_vec (item_id, embedding) VALUES (?, ?)`,
        )
        .run(item.id, JSON.stringify(emb));
    } catch {
      /* no vec0 */
    }

    // also dual-write memory_chunks
    const chunkId = newId();
    db.insert(memoryChunks)
      .values({
        id: chunkId,
        kind: "item",
        refId: item.id,
        text: text.slice(0, 4000),
        embeddingJson: JSON.stringify(emb),
        dims,
        model,
        embedded: true,
        dwellMs: 0,
        ts: item.publishedAt ?? item.createdAt,
      })
      .run();
    storeChunkVec(chunkId, emb);

    db.update(items)
      .set({ embedded: true, updatedAt: new Date().toISOString() })
      .where(eq(items.id, item.id))
      .run();
    n++;
  }
  if (n) log.info("Embedded items", { count: n });
  return n;
}

export async function embedPendingChunks(limit = 80): Promise<number> {
  const db = getDb();
  const pending = db
    .select()
    .from(memoryChunks)
    .all()
    .filter((c) => !c.embedded)
    .slice(0, limit);

  let n = 0;
  for (const chunk of pending) {
    const emb = await embedText(chunk.text);
    const { model, dims } = lastEmbedMeta();
    db.update(memoryChunks)
      .set({
        embeddingJson: JSON.stringify(emb),
        dims,
        model,
        embedded: true,
      })
      .where(eq(memoryChunks.id, chunk.id))
      .run();
    storeChunkVec(chunk.id, emb);
    n++;
  }
  if (n) log.info("Embedded memory chunks", { count: n });
  return n;
}

function storeChunkVec(chunkId: string, emb: number[]): void {
  if (!isVecReady()) return;
  try {
    getSqlite()
      .prepare(
        `INSERT OR REPLACE INTO memory_chunks_vec (chunk_id, embedding) VALUES (?, ?)`,
      )
      .run(chunkId, JSON.stringify(emb));
  } catch {
    /* ignore */
  }
}

export async function scorePending(limit = 100): Promise<number> {
  const db = getDb();
  const list = db
    .select()
    .from(items)
    .all()
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
    .slice(0, limit);
  for (const item of list) {
    await scoreItem(item.id);
  }
  return list.length;
}

/** Bridge legacy item feedback into feedback_events (core-only, no agents import). */
export async function recordFeedback(
  itemId: string,
  signal: 1 | -1,
): Promise<void> {
  try {
    const { feedbackEvents, newId, getDb } = await import("@second-brain/core");
    getDb()
      .insert(feedbackEvents)
      .values({
        id: newId(),
        loopId: itemId,
        signal: signal > 0 ? "positive" : "negative",
        embeddingJson: null,
      })
      .run();
  } catch (e) {
    log.debug("recordFeedback failed", { err: String(e) });
  }
}

export async function runEnrichPipeline(): Promise<{
  embedded: number;
  chunks: number;
  scored: number;
}> {
  const embedded = await embedUnembeddedItems(40);
  const chunks = await embedPendingChunks(80);
  const scored = await scorePending(80);
  return { embedded, chunks, scored };
}
