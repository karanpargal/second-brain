import {
  readdirSync,
  readFileSync,
  existsSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import {
  config,
  ensureDataDir,
  getDb,
  observations,
  activityBlocks,
  artifacts,
  memoryChunks,
  sources,
  contentHash,
  newId,
  log,
  isSpam,
} from "@second-brain/core";
import { eq, and, lt } from "drizzle-orm";

export type SpoolObservation = {
  ts: string;
  source: "window" | "browser" | "ocr" | "file";
  app?: string;
  exe?: string;
  window_title?: string;
  url?: string;
  domain?: string;
  text?: string;
  dwell_ms?: number;
  redacted?: boolean;
  chat?: boolean;
  trading?: boolean;
  meta?: Record<string, unknown>;
};

export type CaptureResult = {
  files: number;
  lines: number;
  inserted: number;
  blocks: number;
  artifacts: number;
};

function domainFromUrl(url?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function searchQueryForKey(u: URL): string | null {
  const q =
    u.searchParams.get("q") ??
    u.searchParams.get("p") ??
    u.searchParams.get("query") ??
    u.searchParams.get("search_query");
  const blob = `${u.hostname}${u.pathname}`;
  const isSearch =
    /google\.com\/search|bing\.com\/search|duckduckgo\.com|search\.yahoo|youtube\.com\/results/i.test(
      blob,
    );
  if (!isSearch || !q?.trim()) return null;
  return q.trim().toLowerCase().slice(0, 120);
}

function artifactKey(
  obs: SpoolObservation,
): { kind: string; key: string; title: string } | null {
  if (obs.url) {
    try {
      const u = new URL(obs.url);
      const q = searchQueryForKey(u);
      return {
        kind: "url",
        key: q
          ? `${u.origin}${u.pathname}?q=${encodeURIComponent(q)}`
          : `${u.origin}${u.pathname}`,
        title: obs.window_title || obs.url,
      };
    } catch {
      return { kind: "url", key: obs.url, title: obs.window_title || obs.url };
    }
  }
  if (obs.window_title && obs.app) {
    return {
      kind: "window",
      key: contentHash([obs.app, obs.window_title]),
      title: `${obs.app}: ${obs.window_title}`,
    };
  }
  if (obs.app) {
    return {
      kind: "window",
      key: `app:${obs.app}`,
      title: obs.app,
    };
  }
  return null;
}

function readNewLines(
  filePath: string,
  offset: number,
): { lines: string[]; newOffset: number } {
  const size = statSync(filePath).size;
  if (offset >= size) return { lines: [], newOffset: offset };
  const fd = openSync(filePath, "r");
  try {
    const len = size - offset;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, offset);
    const text = buf.toString("utf8");
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    // if file didn't end with newline, still consume all bytes read
    return { lines, newOffset: size };
  } finally {
    closeSync(fd);
  }
}

function touchArtifact(
  kind: string,
  key: string,
  title: string,
  ts: string,
): string {
  const db = getDb();
  const existing = db
    .select()
    .from(artifacts)
    .all()
    .find((a) => a.kind === kind && a.key === key);
  if (existing) {
    db.update(artifacts)
      .set({
        title,
        lastTouchedAt: ts,
        touchCount: existing.touchCount + 1,
      })
      .where(eq(artifacts.id, existing.id))
      .run();
    return existing.id;
  }
  const id = newId();
  db.insert(artifacts)
    .values({
      id,
      kind,
      key,
      title,
      lastTouchedAt: ts,
      touchCount: 1,
    })
    .run();
  return id;
}

function insertMemoryChunk(opts: {
  kind: string;
  refId: string;
  text: string;
  ts: string;
  dwellMs: number;
}): void {
  if (!opts.text.trim()) return;
  const db = getDb();
  db.insert(memoryChunks)
    .values({
      id: newId(),
      kind: opts.kind,
      refId: opts.refId,
      text: opts.text.slice(0, 4000),
      embedded: false,
      dwellMs: opts.dwellMs,
      ts: opts.ts,
    })
    .run();
}

/** Merge contiguous similar observations into activity blocks */
export function sessionizeRecent(hours = 24): number {
  const db = getDb();
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const obs = db
    .select()
    .from(observations)
    .all()
    .filter((o) => o.ts >= since)
    .sort((a, b) => a.ts.localeCompare(b.ts));

  if (obs.length === 0) return 0;

  const GAP_MS = 5 * 60_000;
  type Block = {
    start: string;
    end: string;
    app: string | null;
    title: string | null;
    url: string | null;
    artifactId: string | null;
    dwell: number;
    count: number;
  };

  const blocks: Block[] = [];
  let cur: Block | null = null;

  for (const o of obs) {
    const same =
      cur &&
      cur.app === (o.app ?? null) &&
      (cur.title === (o.windowTitle ?? null) ||
        cur.url === (o.url ?? null)) &&
      new Date(o.ts).getTime() - new Date(cur.end).getTime() < GAP_MS;

    if (same && cur) {
      cur.end = o.ts;
      cur.dwell += o.dwellMs;
      cur.count += 1;
      if (!cur.title && o.windowTitle) cur.title = o.windowTitle;
      if (!cur.url && o.url) cur.url = o.url;
      if (!cur.artifactId && o.artifactId) cur.artifactId = o.artifactId;
    } else {
      if (cur) blocks.push(cur);
      cur = {
        start: o.ts,
        end: o.ts,
        app: o.app,
        title: o.windowTitle,
        url: o.url,
        artifactId: o.artifactId,
        dwell: o.dwellMs,
        count: 1,
      };
    }
  }
  if (cur) blocks.push(cur);

  // Insert blocks that don't already exist for the same start/app/title
  let n = 0;
  const existing = db.select().from(activityBlocks).all();
  for (const b of blocks) {
    const dup = existing.find(
      (e) =>
        e.startAt === b.start &&
        e.app === b.app &&
        e.title === b.title,
    );
    if (dup) continue;
    const id = newId();
    const summary = [b.app, b.title].filter(Boolean).join(" · ") || "activity";
    db.insert(activityBlocks)
      .values({
        id,
        startAt: b.start,
        endAt: b.end,
        app: b.app,
        title: b.title,
        url: b.url,
        artifactId: b.artifactId,
        summary,
        dwellMs: b.dwell,
        obsCount: b.count,
      })
      .run();
    insertMemoryChunk({
      kind: "block",
      refId: id,
      text: summary,
      ts: b.start,
      dwellMs: b.dwell,
    });
    n++;
  }
  return n;
}

export function purgeStaleObservations(): {
  ocrPurged: number;
  observationsThinned: number;
} {
  const db = getDb();
  const days = config.capture.ocrRetentionDays;
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();

  const ocrOld = db
    .select()
    .from(observations)
    .all()
    .filter((o) => o.source === "ocr" && o.ts < cutoff);

  let ocrPurged = 0;
  for (const o of ocrOld) {
    // keep metadata, drop text
    if (o.text) {
      db.update(observations)
        .set({ text: null, redacted: true })
        .where(eq(observations.id, o.id))
        .run();
      ocrPurged++;
    }
  }

  // Thin window observations older than 7 days if many per hour
  const thinCutoff = new Date(Date.now() - 7 * 86400_000).toISOString();
  const oldWin = db
    .select()
    .from(observations)
    .all()
    .filter((o) => o.source === "window" && o.ts < thinCutoff);

  let observationsThinned = 0;
  // keep first/last of each app per day; delete middle
  const byDayApp = new Map<string, typeof oldWin>();
  for (const o of oldWin) {
    const day = o.ts.slice(0, 10);
    const k = `${day}|${o.app ?? "?"}`;
    const arr = byDayApp.get(k) ?? [];
    arr.push(o);
    byDayApp.set(k, arr);
  }
  for (const arr of byDayApp.values()) {
    if (arr.length <= 4) continue;
    arr.sort((a, b) => a.ts.localeCompare(b.ts));
    const keep = new Set([
      arr[0]!.id,
      arr[arr.length - 1]!.id,
      arr[Math.floor(arr.length / 2)]!.id,
    ]);
    for (const o of arr) {
      if (keep.has(o.id)) continue;
      db.delete(observations).where(eq(observations.id, o.id)).run();
      observationsThinned++;
    }
  }

  // Also delete orphan memory_chunks for purged OCR text empty
  void lt;
  void and;

  log.info("Purge complete", { ocrPurged, observationsThinned });
  return { ocrPurged, observationsThinned };
}

/**
 * Tail spool JSONL files written by the Tauri capture engine.
 * Cursor stored on sources.src-capture.
 */
export async function ingestSpool(): Promise<CaptureResult> {
  ensureDataDir();
  const spoolDir = config.spoolDir;
  const db = getDb();

  // Ensure capture source exists
  const src = db
    .select()
    .from(sources)
    .where(eq(sources.id, "src-capture"))
    .get();
  if (!src) {
    db.insert(sources)
      .values({
        id: "src-capture",
        kind: "capture",
        name: "PC Capture",
      })
      .run();
  }

  let cursor: Record<string, number> = {};
  try {
    const row = db
      .select()
      .from(sources)
      .where(eq(sources.id, "src-capture"))
      .get();
    if (row?.cursorJson) {
      cursor = JSON.parse(row.cursorJson) as Record<string, number>;
    }
  } catch {
    cursor = {};
  }

  if (!existsSync(spoolDir)) {
    return { files: 0, lines: 0, inserted: 0, blocks: 0, artifacts: 0 };
  }

  const files = readdirSync(spoolDir)
    .filter((f) => f.startsWith("obs-") && f.endsWith(".jsonl"))
    .sort();

  let lines = 0;
  let inserted = 0;
  let artCount = 0;
  const seenHashes = new Set<string>();
  try {
    const { getSqlite } = await import("@second-brain/core");
    const rows = getSqlite()
      .prepare(
        `SELECT text_hash FROM observations ORDER BY rowid DESC LIMIT 50000`,
      )
      .all() as Array<{ text_hash: string }>;
    for (const r of rows) seenHashes.add(r.text_hash);
  } catch {
    for (const h of db
      .select({ textHash: observations.textHash })
      .from(observations)
      .all()
      .slice(-50_000)
      .map((o) => o.textHash)) {
      seenHashes.add(h);
    }
  }

  for (const file of files) {
    const path = join(spoolDir, file);
    const offset = cursor[file] ?? 0;
    const { lines: newLines, newOffset } = readNewLines(path, offset);
    cursor[file] = newOffset;

    for (const line of newLines) {
      lines++;
      let obs: SpoolObservation;
      try {
        obs = JSON.parse(line) as SpoolObservation;
      } catch {
        continue;
      }
      if (!obs.ts || !obs.source) continue;

      const text = obs.text ?? obs.window_title ?? obs.url ?? "";
      const surfaceBlob = `${obs.app ?? ""} ${obs.exe ?? ""} ${obs.window_title ?? ""} ${obs.url ?? ""}`;
      // Chat apps are out of scope — never ingest their screen content.
      const chat =
        obs.chat === true ||
        /whatsapp|slack|discord|telegram|teams|signal/i.test(surfaceBlob);
      if (chat) continue;
      const trading =
        obs.trading === true ||
        /trench|tradingview|binance|bybit|hyperliquid|robinhood|webull|okx|coinbase pro|ibkr/i.test(
          surfaceBlob,
        ) ||
        (/\b(unrealized pn[l]|tp\/sl|open interest|cross margin|stop[- ]?loss|take[- ]?profit)\b/i.test(
          text,
        ) &&
          /\b(long|short|positions?|ondo|ticker)\b/i.test(text));
      // Trading desks are opt-in — skip so TP/SL OCR cannot become tasks.
      if (trading) continue;
      if (
        /\b(tp\/?sl|take[- _]?profit|stop[- _]?loss|set_stop_loss|set tp)\b/i.test(
          `${text} ${surfaceBlob}`,
        )
      ) {
        continue;
      }
      if (
        isSpam({
          title: obs.window_title,
          body: text,
          url: obs.url,
          kind: obs.source,
        })
      ) {
        continue;
      }
      const hash = contentHash([
        obs.ts.slice(0, 16),
        obs.source,
        obs.app ?? "",
        obs.exe ?? "",
        obs.window_title ?? "",
        obs.url ?? "",
        text.slice(0, 200),
      ]);
      if (seenHashes.has(hash)) continue;
      seenHashes.add(hash);

      let artifactId: string | null = null;
      const ak = artifactKey(obs);
      if (ak) {
        artifactId = touchArtifact(ak.kind, ak.key, ak.title, obs.ts);
        artCount++;
      }

      const id = newId();
      db.insert(observations)
        .values({
          id,
          ts: obs.ts,
          source: obs.source,
          app: obs.app ?? null,
          exe: obs.exe ?? null,
          windowTitle: obs.window_title ?? null,
          url: obs.url ?? null,
          domain: obs.domain ?? domainFromUrl(obs.url),
          text: text || null,
          textHash: hash,
          dwellMs: obs.dwell_ms ?? 0,
          redacted: obs.redacted ?? false,
          artifactId,
          metaJson: JSON.stringify({
            ...(obs.meta ?? {}),
            ...(chat ? { chat: true } : {}),
            ...(trading ? { trading: true } : {}),
          }),
        })
        .run();

      insertMemoryChunk({
        kind: "observation",
        refId: id,
        text: [obs.app, obs.window_title, obs.url, text]
          .filter(Boolean)
          .join("\n"),
        ts: obs.ts,
        dwellMs: obs.dwell_ms ?? 0,
      });
      inserted++;
    }
  }

  db.update(sources)
    .set({
      cursorJson: JSON.stringify(cursor),
      lastRunAt: new Date().toISOString(),
      lastError: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(sources.id, "src-capture"))
    .run();

  const blocks = sessionizeRecent(36);
  log.info("Capture ingest", { files: files.length, lines, inserted, blocks });
  return {
    files: files.length,
    lines,
    inserted,
    blocks,
    artifacts: artCount,
  };
}
