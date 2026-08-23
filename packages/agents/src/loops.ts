import {
  getDb,
  items,
  openLoops,
  loopEvidence,
  observations,
  settings,
  reminders,
  newId,
  log,
  isSpam,
  classifySpam,
  isBlockedByUserRules,
  linkLearnCard,
  looksLikeMarket,
} from "@second-brain/core";
import { eq } from "drizzle-orm";
import { runLlm, parseJsonFromText } from "./llm.js";
import { cosine, embedText } from "@second-brain/enrich";
import {
  isChatSurface,
  parseChatPeer,
  scoreChatAction,
  detectChatApp,
} from "./chat-actions.js";
import { getLoopLlmBudget } from "./loop-budget.js";
import { parseDueAt, parseDueHint } from "./due.js";
import { computePriority } from "./priority.js";
import {
  loopsAreDuplicate,
  sourceThreadKey,
  adjudicateSameTask,
  DEDUPE_COSINE_MERGE,
  DEDUPE_COSINE_BORDER_LOW,
  type DedupeInput,
} from "./loop-dedupe.js";
import {
  classifyMailLoop,
  parseCategory,
  type LoopCategory,
} from "./categories.js";
import { isWeakLoopTitle } from "./loop-validate.js";
import { extractLoopCandidates } from "./loop-extract.js";

export type LoopCandidate = {
  title: string;
  description?: string;
  kind:
    | "promise"
    | "awaiting_reply"
    | "unfinished"
    | "decision"
    | "deadline";
  who?: string;
  dueHint?: string;
  dueAt?: string | null;
  /** Recall pre-filter score (regex). Not an accept confidence. */
  recallScore: number;
  /** Detector certainty — set from LLM after structure; recall before that. */
  confidence: number;
  itemId?: string;
  observationId?: string;
  snippet: string;
  sourceUrl?: string;
  /** item (email/issue/PR) | ocr | chat (window title only) */
  source?: "item" | "ocr" | "chat";
  category?: string;
  tags?: string[];
  fromMe?: boolean;
  /** Raw chat OCR for local LLM polish */
  ocrText?: string;
  /** Set false by chat OCR polish to drop idle threads */
  keep?: boolean;
  audience?: "me" | "other" | "neither";
  topic?: "actionable" | "idle" | "market";
  learnEpisodeId?: string;
  evidenceQuote?: string;
  org?: string;
  subjectTopic?: string;
};

const WEEK_MS = 7 * 24 * 3600_000;
/** Regex scorers are recall only — pass this floor to reach LLM */
const RECALL_THRESHOLD = 0.35;

function collapseItemsByThread<
  T extends {
    url: string | null;
    publishedAt: string | null;
    createdAt: string;
    title: string;
    body: string | null;
  },
>(list: T[]): T[] {
  const groups = new Map<string, T[]>();
  const unmatched: T[] = [];
  for (const it of list) {
    const key = sourceThreadKey(it.url);
    if (!key) {
      unmatched.push(it);
      continue;
    }
    const arr = groups.get(key) ?? [];
    arr.push(it);
    groups.set(key, arr);
  }
  const out: T[] = [...unmatched];
  for (const arr of groups.values()) {
    arr.sort((a, b) =>
      (b.publishedAt ?? b.createdAt).localeCompare(
        a.publishedAt ?? a.createdAt,
      ),
    );
    const newest = arr[0];
    if (arr.length === 1) {
      out.push(newest);
      continue;
    }
    const others = arr
      .slice(1)
      .map((x) => x.title)
      .filter((t) => t && t !== newest.title);
    out.push({
      ...newest,
      body: `${newest.body ?? ""}${
        others.length ? `\n\nEarlier in thread: ${others.join(" | ")}` : ""
      }`.slice(0, 20_000),
    });
  }
  return out;
}

const COMMITMENT_RE =
  /\b(i('ll| will)|let me|i can|i should|by (friday|monday|tuesday|wednesday|thursday|saturday|sunday|eod|eow|tomorrow)|waiting on|waiting for|can you|please (send|review|confirm|fix|update)|todo|follow[- ]?up|action item|i promised|need to|don't forget|please reply|looking for|suggest)\b/i;

function readGoogleUserEmail(): string | null {
  const db = getDb();
  const row = db
    .select()
    .from(settings)
    .all()
    .find((r) => r.key === "google.userEmail");
  if (!row) return null;
  try {
    const v = JSON.parse(row.valueJson) as unknown;
    return typeof v === "string" && v.includes("@") ? v : null;
  } catch {
    const raw = row.valueJson.replace(/"/g, "").trim();
    return raw.includes("@") ? raw : null;
  }
}

function itemMailMeta(it: { metaJson: string; author: string | null }): {
  to?: string;
  labels: string[];
  fromMe: boolean;
} {
  let to: string | undefined;
  let labels: string[] = [];
  let fromMe = false;
  try {
    const meta = JSON.parse(it.metaJson || "{}") as {
      to?: string;
      labelIds?: string[];
      fromMe?: boolean;
    };
    to = meta.to;
    labels = Array.isArray(meta.labelIds) ? meta.labelIds.map(String) : [];
    fromMe = meta.fromMe === true;
  } catch {
    /* */
  }
  return { to, labels, fromMe };
}

function blockedForLoops(input: {
  kind?: string | null;
  title?: string | null;
  body?: string | null;
  author?: string | null;
  url?: string | null;
  labels?: string[] | null;
}): boolean {
  if (isBlockedByUserRules(input)) return true;
  return isSpam(input);
}

/**
 * Cheap heuristic candidates: items (email/issue/PR) + chat OCR.
 * Regex scores are RECALL only; the LLM verifies everything.
 */
export function collectLoopCandidates(
  limit = 40,
  opts: { obsOnly?: boolean; sinceMinutes?: number } = {},
): LoopCandidate[] {
  const db = getDb();
  const out: LoopCandidate[] = [];
  const weekAgo = new Date(Date.now() - WEEK_MS).toISOString();
  const sinceIso = opts.sinceMinutes
    ? new Date(Date.now() - opts.sinceMinutes * 60_000).toISOString()
    : weekAgo;

  if (!opts.obsOnly) {
    const recentItems = db
      .select()
      .from(items)
      .all()
      .filter((it) => {
        const ts = it.publishedAt ?? it.createdAt;
        if (ts < weekAgo) return false;
        let labels: string[] | null = null;
        try {
          const meta = JSON.parse(it.metaJson || "{}") as { labelIds?: string[] };
          labels = meta.labelIds ?? null;
        } catch {
          /* */
        }
        return !blockedForLoops({
          kind: it.kind,
          title: it.title,
          body: it.body,
          author: it.author,
          url: it.url,
          labels,
        });
      })
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )
      .slice(0, 80);

    const userEmail = readGoogleUserEmail();
    for (const it of collapseItemsByThread(recentItems)) {
      const body = `${it.title}\n${it.body ?? ""}`;
      const mailMeta = itemMailMeta(it);
      const classified = classifyMailLoop({
        subject: it.title,
        body: it.body,
        from: it.author,
        to: mailMeta.to,
        labels: mailMeta.labels,
        userEmail,
        kind: it.kind,
      });

      const actionableKind =
        it.kind === "issue" || it.kind === "pr" || it.kind === "email";
      if (it.kind === "email" || it.kind === "notification") {
        if (!classified.keep) continue;
      } else if (!COMMITMENT_RE.test(body) && !actionableKind) {
        continue;
      }
      if (
        it.kind === "notification" &&
        !classified.keep &&
        !COMMITMENT_RE.test(body)
      ) {
        continue;
      }

      const kind = classified.kind;
      const seedTitle = classified.title;
      const recall = actionableKind || classified.keep ? 0.55 : 0.45;
      if (recall < RECALL_THRESHOLD) continue;

      const dueAt = parseDueAt(body);
      out.push({
        title: seedTitle,
        description: (it.body ?? it.title).slice(0, 400),
        kind,
        who: classified.who ?? it.author ?? undefined,
        dueHint: dueAt ?? undefined,
        dueAt,
        recallScore: recall,
        confidence: recall,
        itemId: it.id,
        // Full body for LOOP_EXTRACT (capped in extract)
        snippet: body.slice(0, 2500),
        sourceUrl: it.url ?? undefined,
        source: "item",
        category: classified.category,
        tags: classified.tags,
        fromMe: classified.fromMe,
      });
    }
  }

  const chatObs = db
    .select()
    .from(observations)
    .all()
    .filter(
      (o) =>
        o.ts >= sinceIso &&
        o.source === "ocr" &&
        isChatSurface(o.app, o.exe, o.windowTitle, o.url),
    )
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 40);

  const seenChat = new Set<string>();
  for (const o of chatObs) {
    const scored = scoreChatAction({
      windowTitle: o.windowTitle,
      app: o.app,
      exe: o.exe,
      url: o.url,
      text: o.text,
    });
    if (!scored) continue;
    const hit = parseChatPeer(
      o.windowTitle ?? "",
      o.app,
      o.exe,
      o.url,
      o.text,
    );
    const peer =
      scored.peer ??
      (hit?.peer && hit.peer !== "this chat" ? hit.peer : undefined);
    const appName = hit?.app ?? detectChatApp(o.app, o.exe, o.windowTitle, o.url);
    if (!appName) continue;
    if (
      blockedForLoops({
        title: scored.actionTitle,
        body: scored.snippet,
        kind: "chat",
      })
    ) {
      continue;
    }
    const key = `${appName}:${(peer ?? "chat").toLowerCase()}:${scored.actionTitle.toLowerCase().slice(0, 40)}`;
    if (seenChat.has(key)) continue;
    seenChat.add(key);
    out.push({
      title: scored.actionTitle,
      description: scored.snippet,
      kind: scored.fromMe ? "promise" : "unfinished",
      who: peer,
      dueAt: parseDueAt(scored.actionTitle, new Date(), { relativeOnly: true }),
      recallScore: scored.score,
      confidence: scored.score,
      observationId: o.id,
      snippet: (o.text ?? scored.snippet).slice(0, 2500),
      ocrText: o.text ?? undefined,
      source: "chat",
      category: "follow_up",
      tags: ["chat", appName.toLowerCase()],
      fromMe: scored.fromMe,
    });
  }

  out.sort((a, b) => {
    const srcRank = (s?: string) =>
      s === "item" ? 0 : s === "chat" ? 1 : 2;
    const d = srcRank(a.source) - srcRank(b.source);
    if (d !== 0) return d;
    return b.recallScore - a.recallScore;
  });
  return out.slice(0, limit);
}

function asDedupeInput(c: {
  title: string;
  who?: string | null;
  sourceUrl?: string | null;
  itemId?: string | null;
}): DedupeInput {
  return {
    title: c.title,
    who: c.who,
    sourceUrl: c.sourceUrl,
    itemId: c.itemId,
  };
}

/**
 * Dedupe by Gmail/GitHub thread, sender+topic, title similarity, then embedding.
 * Borderline cosine (0.6–0.85) goes to LLM adjudication.
 */
async function findSimilarOpenLoop(
  candidate: DedupeInput & { description?: string | null },
  emb: number[] | null,
): Promise<string | null> {
  const db = getDb();
  const open = db
    .select()
    .from(openLoops)
    .all()
    .filter((l) => l.status === "open" || l.status === "snoozed");

  const allEv = db.select().from(loopEvidence).all();
  const border: Array<{ id: string; cos: number; loop: (typeof open)[0] }> = [];

  for (const l of open) {
    const ev = allEv.filter((e) => e.loopId === l.id);
    const urls = ev
      .map((e) => e.note?.match(/https?:\/\/\S+/)?.[0] ?? null)
      .filter((u): u is string => Boolean(u));
    const itemIds = ev.map((e) => e.itemId).filter(Boolean) as string[];

    if (candidate.itemId && itemIds.includes(candidate.itemId)) {
      return l.id;
    }

    const againstBase: DedupeInput = {
      title: l.title,
      who: l.who,
      itemId: itemIds[0] ?? null,
    };
    if (loopsAreDuplicate(candidate, againstBase)) return l.id;
    for (const url of urls) {
      if (loopsAreDuplicate(candidate, { ...againstBase, sourceUrl: url })) {
        return l.id;
      }
    }

    if (emb && l.embeddingJson) {
      try {
        const other = JSON.parse(l.embeddingJson) as number[];
        if (other.length === emb.length) {
          const cos = cosine(emb, other);
          if (cos > DEDUPE_COSINE_MERGE) return l.id;
          if (cos >= DEDUPE_COSINE_BORDER_LOW && cos <= DEDUPE_COSINE_MERGE) {
            border.push({ id: l.id, cos, loop: l });
          }
        }
      } catch {
        /* */
      }
    }
  }

  border.sort((a, b) => b.cos - a.cos);
  for (const hit of border.slice(0, 3)) {
    const verdict = await adjudicateSameTask(
      candidate,
      {
        title: hit.loop.title,
        who: hit.loop.who,
        description: hit.loop.description,
      },
      hit.cos,
    );
    if (verdict.sameTask) return hit.id;
  }
  return null;
}

/**
 * Merge open/snoozed loops that are the same task (already-created duplicates).
 */
export function collapseDuplicateOpenLoops(): { merged: number } {
  const db = getDb();
  const active = db
    .select()
    .from(openLoops)
    .all()
    .filter((l) => l.status === "open" || l.status === "snoozed");
  if (active.length < 2) return { merged: 0 };

  const allEv = db.select().from(loopEvidence).all();
  const evByLoop = new Map<string, typeof allEv>();
  for (const e of allEv) {
    const arr = evByLoop.get(e.loopId) ?? [];
    arr.push(e);
    evByLoop.set(e.loopId, arr);
  }

  const sigs = active.map((l) => {
    const ev = evByLoop.get(l.id) ?? [];
    const urls = ev
      .map((e) => e.note?.match(/https?:\/\/\S+/)?.[0] ?? null)
      .filter((u): u is string => Boolean(u));
    const itemIds = ev.map((e) => e.itemId).filter(Boolean) as string[];
    return { loop: l, urls, itemIds };
  });

  const parent = sigs.map((_, i) => i);
  const find = (i: number): number => {
    let x = i;
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const unite = (i: number, j: number) => {
    const a = find(i);
    const b = find(j);
    if (a !== b) parent[b] = a;
  };

  const pairDup = (i: number, j: number): boolean => {
    const a = sigs[i];
    const b = sigs[j];
    const aItems = new Set(a.itemIds);
    if (b.itemIds.some((id) => aItems.has(id))) return true;

    const aInputs: DedupeInput[] =
      a.urls.length > 0
        ? a.urls.map((sourceUrl) => ({
            title: a.loop.title,
            who: a.loop.who,
            sourceUrl,
          }))
        : [{ title: a.loop.title, who: a.loop.who }];
    const bInputs: DedupeInput[] =
      b.urls.length > 0
        ? b.urls.map((sourceUrl) => ({
            title: b.loop.title,
            who: b.loop.who,
            sourceUrl,
          }))
        : [{ title: b.loop.title, who: b.loop.who }];

    for (const ai of aInputs) {
      for (const bi of bInputs) {
        if (loopsAreDuplicate(ai, bi)) return true;
      }
    }
    return false;
  };

  for (let i = 0; i < sigs.length; i++) {
    for (let j = i + 1; j < sigs.length; j++) {
      if (pairDup(i, j)) unite(i, j);
    }
  }

  const clusters = new Map<number, number[]>();
  for (let i = 0; i < sigs.length; i++) {
    const r = find(i);
    const arr = clusters.get(r) ?? [];
    arr.push(i);
    clusters.set(r, arr);
  }

  const now = new Date().toISOString();
  let merged = 0;
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    members.sort((ia, ib) => {
      const a = sigs[ia];
      const b = sigs[ib];
      const snooze =
        Number(b.loop.status === "snoozed") - Number(a.loop.status === "snoozed");
      if (snooze !== 0) return snooze;
      const ev =
        b.itemIds.length + b.urls.length - (a.itemIds.length + a.urls.length);
      if (ev !== 0) return ev;
      return a.loop.detectedAt.localeCompare(b.loop.detectedAt);
    });
    const keeper = sigs[members[0]].loop;
    for (const idx of members.slice(1)) {
      const loser = sigs[idx].loop;
      if (loser.id === keeper.id) continue;
      db.update(loopEvidence)
        .set({ loopId: keeper.id })
        .where(eq(loopEvidence.loopId, loser.id))
        .run();
      try {
        db.update(reminders)
          .set({ loopId: keeper.id })
          .where(eq(reminders.loopId, loser.id))
          .run();
      } catch {
        /* */
      }
      db.update(openLoops)
        .set({
          status: "dismissed",
          closedAt: now,
          closeReason: `duplicate:${keeper.id}`,
          updatedAt: now,
        })
        .where(eq(openLoops.id, loser.id))
        .run();
      merged++;
    }
  }
  if (merged > 0) {
    log.info("Collapsed duplicate open loops", { merged });
  }
  return { merged };
}

function recategorizeOpenLoops(): void {
  const db = getDb();
  const userEmail = readGoogleUserEmail();
  const open = db
    .select()
    .from(openLoops)
    .all()
    .filter((l) => l.status === "open" || l.status === "snoozed");
  if (open.length === 0) return;
  const allEv = db.select().from(loopEvidence).all();
  const allItems = db.select().from(items).all();
  const now = new Date().toISOString();
  let n = 0;
  for (const loop of open) {
    const ev = allEv.find((e) => e.loopId === loop.id && e.itemId);
    if (!ev?.itemId) continue;
    const linked = allItems.find((x) => x.id === ev.itemId);
    if (!linked) continue;
    const threadKey = sourceThreadKey(linked.url);
    const it = threadKey
      ? allItems
          .filter((x) => sourceThreadKey(x.url) === threadKey)
          .sort((a, b) =>
            (b.publishedAt ?? b.createdAt).localeCompare(
              a.publishedAt ?? a.createdAt,
            ),
          )[0] ?? linked
      : linked;
    const mailMeta = itemMailMeta(it);
    const classified = classifyMailLoop({
      subject: it.title,
      body: it.body,
      from: it.author,
      to: mailMeta.to,
      labels: mailMeta.labels,
      userEmail,
      kind: it.kind,
    });
    const weak = isWeakLoopTitle(loop.title, loop.who);
    if (
      !classified.keep &&
      loop.origin !== "manual" &&
      (weak || classified.fromMe || loop.category === "billing")
    ) {
      db.update(openLoops)
        .set({
          status: "dismissed",
          closedAt: now,
          closeReason: classified.fromMe
            ? "not_a_task:sent_close_out"
            : "not_a_task:sent_or_noise",
          updatedAt: now,
        })
        .where(eq(openLoops.id, loop.id))
        .run();
      n++;
      continue;
    }
    if (!classified.keep) continue;
    const nextTitle = weak ? classified.title : loop.title;
    const nextCategory =
      !loop.category || loop.category === "other"
        ? classified.category
        : loop.category;
    db.update(openLoops)
      .set({
        title: nextTitle,
        category: nextCategory,
        tagsJson: JSON.stringify(classified.tags),
        who: classified.who ?? loop.who,
        kind: weak ? classified.kind : loop.kind,
        updatedAt: now,
      })
      .where(eq(openLoops.id, loop.id))
      .run();
    n++;
  }
  if (n > 0) log.info("Recategorized open loops", { updated: n });
}

function persistCandidate(
  c: LoopCandidate & { keep?: boolean },
  existingId: string | null,
  emb: number[] | null,
  now: string,
): "created" | "updated" | "skipped" {
  const db = getDb();
  if (c.keep === false) return "skipped";
  const title = c.title;

  if (existingId) {
    const existing = db
      .select()
      .from(openLoops)
      .where(eq(openLoops.id, existingId))
      .get();
    const garbageTitle = /["']{2,}|N"\s*v"|bi["']|tonwrrow|to you by/i.test(
      existing?.title ?? "",
    );
    const nextTitle =
      c.source === "chat"
        ? title
        : existing &&
            isWeakLoopTitle(existing.title, existing.who) &&
            !isWeakLoopTitle(title)
          ? title
          : garbageTitle
            ? title
            : existing?.title ?? title;
    const nextDue =
      c.source === "chat"
        ? (c.dueAt ?? existing?.dueAt ?? null)
        : (c.dueAt ?? existing?.dueAt ?? null);
    db.update(openLoops)
      .set({
        lastSeenAt: now,
        confidence: Math.max(c.confidence, 0.4),
        updatedAt: now,
        title: nextTitle,
        description:
          c.source === "chat" || garbageTitle
            ? (c.description ?? existing?.description ?? null)
            : (existing?.description ?? c.description ?? null),
        category: c.category ?? existing?.category ?? "other",
        tagsJson: JSON.stringify(c.tags ?? []),
        who: c.who ?? existing?.who ?? null,
        dueAt: nextDue,
        dueHint: null,
        priority: computePriority({
          dueAt: nextDue,
          kind: c.kind,
          confidence: c.confidence,
        }),
      })
      .where(eq(openLoops.id, existingId))
      .run();
    db.insert(loopEvidence)
      .values({
        id: newId(),
        loopId: existingId,
        observationId: c.observationId ?? null,
        itemId: c.itemId ?? null,
        role: "progressed",
        note: c.sourceUrl
          ? `re-detected · ${c.sourceUrl}`
          : c.evidenceQuote
            ? `re-detected · ${c.evidenceQuote.slice(0, 200)}`
            : "re-detected",
      })
      .run();
    if (c.learnEpisodeId) {
      linkLearnCard(c.learnEpisodeId, existingId, nextTitle);
    }
    return "updated";
  }

  const dueAt =
    c.dueAt ??
    (c.dueHint ? parseDueHint(c.dueHint) : null) ??
    parseDueAt(c.title) ??
    parseDueAt(c.snippet);
  const priority = computePriority({
    dueAt,
    kind: c.kind,
    confidence: c.confidence,
  });

  const id = newId();
  db.insert(openLoops)
    .values({
      id,
      title,
      description: c.description ?? null,
      kind: c.kind,
      status: "open",
      confidence: c.confidence,
      detectedAt: now,
      dueHint: null,
      dueAt: dueAt ?? null,
      priority,
      lastSeenAt: now,
      origin: "detected",
      who: c.who ?? null,
      embeddingJson: emb ? JSON.stringify(emb) : null,
      category: c.category ?? "other",
      tagsJson: JSON.stringify(c.tags ?? []),
    })
    .run();
  db.insert(loopEvidence)
    .values({
      id: newId(),
      loopId: id,
      observationId: c.observationId ?? null,
      itemId: c.itemId ?? null,
      role: "opened",
      note: c.sourceUrl
        ? `${(c.evidenceQuote ?? c.snippet).slice(0, 200)} · ${c.sourceUrl}`
        : (c.evidenceQuote ?? c.snippet).slice(0, 300),
    })
    .run();
  if (c.learnEpisodeId) {
    linkLearnCard(c.learnEpisodeId, id, title);
  }
  return "created";
}

export async function detectOpenLoops(
  opts: { mode?: "full" | "fast" } = {},
): Promise<{
  candidates: number;
  created: number;
  updated: number;
}> {
  const fast = opts.mode === "fast";
  const collapsed = collapseDuplicateOpenLoops();
  if (collapsed.merged > 0) {
    log.info("Pre-detect duplicate collapse", collapsed);
  }
  recategorizeOpenLoops();

  const candidates = collectLoopCandidates(fast ? 24 : 40, {
    sinceMinutes: fast ? 20 : undefined,
  });

  const recalled = candidates.filter((c) => c.recallScore >= RECALL_THRESHOLD);
  const budget = getLoopLlmBudget();
  const slots = Math.min(budget.maxPerRun, budget.remainingToday);
  const canLlm = slots > 0;

  let created = 0;
  let updated = 0;
  const now = new Date().toISOString();
  const db = getDb();

  if (!fast) {
    let spamClosed = 0;
    for (const l of db
      .select()
      .from(openLoops)
      .all()
      .filter((x) => x.status === "open")) {
      const input = {
        title: l.title,
        body: l.description,
        author: l.who,
        kind: l.kind,
      };
      let tags: string[] = [];
      try {
        const parsed = JSON.parse(l.tagsJson || "[]") as unknown;
        if (Array.isArray(parsed)) tags = parsed.map(String);
      } catch {
        /* */
      }
      if (tags.some((t) => t.toLowerCase() === "chat")) continue;
      const userHit = isBlockedByUserRules(input);
      if (userHit) {
        db.update(openLoops)
          .set({
            status: "dismissed",
            closedAt: now,
            closeReason:
              userHit.intent === "not_tracking"
                ? `not_tracking:${userHit.id}`
                : `spam_filter:user_rule:${userHit.id}`,
            updatedAt: now,
          })
          .where(eq(openLoops.id, l.id))
          .run();
        spamClosed++;
        continue;
      }
      const verdict = classifySpam(input);
      if (verdict.spam) {
        db.update(openLoops)
          .set({
            status: "dismissed",
            closedAt: now,
            closeReason: `spam_filter:${verdict.reason ?? "score"}`,
            updatedAt: now,
          })
          .where(eq(openLoops.id, l.id))
          .run();
        spamClosed++;
      }
    }
    if (spamClosed > 0) {
      log.info("Internal spam filter dismissed open loops", { spamClosed });
    }
  }

  if (!canLlm) {
    log.info("Loop LLM budget exhausted — skipping extract", {
      recalled: recalled.length,
      usedToday: budget.usedToday,
      maxPerDay: budget.maxPerDay,
    });
    return { candidates: candidates.length, created: 0, updated: 0 };
  }

  const forLlm = recalled.slice(0, slots);
  if (recalled.length > forLlm.length) {
    log.info("Loop LLM capped candidates", {
      recalled: recalled.length,
      sent: forLlm.length,
      maxPerRun: budget.maxPerRun,
      remainingToday: budget.remainingToday,
    });
  }

  const extracted = await extractLoopCandidates(forLlm);

  for (const c of extracted) {
    if (c.keep === false) continue;
    let emb: number[] | null = null;
    try {
      emb = await embedText(c.title);
    } catch {
      emb = null;
    }

    const existingId = await findSimilarOpenLoop(
      { ...asDedupeInput(c), description: c.description },
      emb,
    );
    const result = persistCandidate(c, existingId, emb, now);
    if (result === "created") created++;
    else if (result === "updated") updated++;
  }

  log.info("Open loop detect", {
    mode: fast ? "fast" : "full",
    candidates: candidates.length,
    created,
    updated,
  });
  return { candidates: candidates.length, created, updated };
}

/** Observations from our own UI / IDE must never close loops. */
export function isSelfGeneratedObservation(o: {
  app?: string | null;
  exe?: string | null;
  windowTitle?: string | null;
  url?: string | null;
}): boolean {
  const blob = `${o.app ?? ""} ${o.exe ?? ""} ${o.windowTitle ?? ""} ${o.url ?? ""}`.toLowerCase();
  if (/\bcursor\b/.test(blob)) return true;
  if (/\bsecond[- ]?brain\b/.test(blob)) return true;
  if (
    /\bwidget\b/.test(blob) &&
    /127\.0\.0\.1:3000|localhost:3000/.test(blob)
  ) {
    return true;
  }
  if (/code\.exe|devenv\.exe|windsurf|vs ?code/.test(blob)) return true;
  return false;
}

const RESOLVE_SCHEMA = {
  type: "object",
  properties: {
    resolved: { type: "boolean" },
    quote: { type: "string" },
    confidence: { type: "number" },
    reason: { type: "string" },
  },
  required: ["resolved", "confidence", "reason"],
};

type EvidenceHit = {
  kind: "item" | "observation";
  id: string;
  title: string;
  body: string;
  score: number;
};

/**
 * LLM resolution judge — replaces regex auto-close.
 */
export async function autoCloseLoops(): Promise<{ closed: number }> {
  const db = getDb();
  const open = db
    .select()
    .from(openLoops)
    .all()
    .filter((l) => l.status === "open");

  const weekAgo = new Date(Date.now() - WEEK_MS).toISOString();
  const recentItems = db
    .select()
    .from(items)
    .all()
    .filter((it) => (it.publishedAt ?? it.createdAt) >= weekAgo)
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
    .slice(0, 100);

  const recentObs = db
    .select()
    .from(observations)
    .all()
    .filter(
      (o) =>
        o.ts >= weekAgo &&
        !isSelfGeneratedObservation(o),
    )
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 200);

  let closed = 0;
  const now = new Date().toISOString();

  for (const loop of open) {
    let loopEmb: number[] | null = null;
    try {
      if (loop.embeddingJson) {
        loopEmb = JSON.parse(loop.embeddingJson) as number[];
      } else {
        loopEmb = await embedText(loop.title);
      }
    } catch {
      loopEmb = null;
    }

    const hits: EvidenceHit[] = [];

    for (const it of recentItems) {
      const body = `${it.title}\n${it.body ?? ""}`;
      let score = 0;
      if (loopEmb) {
        try {
          const e = await embedText(`${it.title}\n${(it.body ?? "").slice(0, 400)}`);
          score = cosine(loopEmb, e);
        } catch {
          score = titleTokenOverlap(loop.title, body);
        }
      } else {
        score = titleTokenOverlap(loop.title, body);
      }
      if (score >= 0.45) {
        hits.push({
          kind: "item",
          id: it.id,
          title: it.title,
          body: body.slice(0, 1200),
          score,
        });
      }
    }

    for (const o of recentObs) {
      const body = `${o.windowTitle ?? ""}\n${o.text ?? ""}`;
      let score = 0;
      if (loopEmb) {
        try {
          const e = await embedText(body.slice(0, 500));
          score = cosine(loopEmb, e);
        } catch {
          score = titleTokenOverlap(loop.title, body);
        }
      } else {
        score = titleTokenOverlap(loop.title, body);
      }
      if (score >= 0.5) {
        hits.push({
          kind: "observation",
          id: o.id,
          title: o.windowTitle ?? o.app ?? "observation",
          body: body.slice(0, 1200),
          score,
        });
      }
    }

    hits.sort((a, b) => b.score - a.score);
    const top = hits.slice(0, 4);
    if (top.length === 0) continue;

    const prompt = `LOOP_RESOLVE
Decide if this open loop is ALREADY DONE based on recent evidence.

Loop: ${JSON.stringify({
      title: loop.title,
      who: loop.who,
      kind: loop.kind,
      category: loop.category,
      due: loop.dueAt,
    })}

Evidence candidates (may be unrelated — judge carefully):
${JSON.stringify(
  top.map((h, i) => ({
    i,
    kind: h.kind,
    title: h.title,
    body: h.body.slice(0, 600),
    sim: Number(h.score.toFixed(3)),
  })),
)}

resolved=true ONLY if evidence clearly shows the user completed this exact task
(sent the thing, got the reply, merged the PR, paid the bill, etc.).
Unrelated emails, browser pages, or developer IDE windows → resolved=false.
quote = verbatim substring from evidence proving resolution (required if resolved).
confidence 0-1. Close threshold is high — prefer false negatives.

Return JSON only.`;

    const res = await runLlm({
      prompt,
      model: "smart",
      purpose: "loop_resolve",
      skipHosted: true,
      temperature: 0,
      format: RESOLVE_SCHEMA,
    });
    if (res.provider === "stub") continue;
    const parsed = parseJsonFromText<{
      resolved?: boolean;
      quote?: string;
      confidence?: number;
      reason?: string;
    }>(res.text);
    if (!parsed || parsed.resolved !== true) continue;
    const conf = parsed.confidence ?? 0;
    if (conf < 0.8) {
      // Soft nudge — do not close
      log.info("Loop likely done (nudge only)", {
        loopId: loop.id,
        title: loop.title,
        confidence: conf,
        reason: parsed.reason,
      });
      continue;
    }

    const best = top[0];
    db.update(openLoops)
      .set({
        status: "closed",
        closedAt: now,
        closeReason: "auto_llm",
        updatedAt: now,
      })
      .where(eq(openLoops.id, loop.id))
      .run();
    db.insert(loopEvidence)
      .values({
        id: newId(),
        loopId: loop.id,
        itemId: best.kind === "item" ? best.id : null,
        observationId: best.kind === "observation" ? best.id : null,
        role: "closed",
        note: `auto_llm (${conf.toFixed(2)}): ${parsed.reason ?? ""} · quote: ${(parsed.quote ?? "").slice(0, 200)}`,
      })
      .run();
    closed++;
  }

  log.info("Auto-close loops (LLM judge)", { closed });
  return { closed };
}

function titleTokenOverlap(title: string, body: string): number {
  const tokens = title
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 3)
    .slice(0, 8);
  if (tokens.length === 0) return 0;
  const bodyL = body.toLowerCase();
  const hit = tokens.filter((t) => bodyL.includes(t)).length;
  return hit / tokens.length;
}

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["still_relevant", "needs_nudge", "expired"],
    },
    reason: { type: "string" },
    title: { type: "string" },
  },
  required: ["verdict", "reason"],
};

/**
 * Daily aging pass: overdue or untouched 5+ days.
 */
export async function reviewStaleLoops(): Promise<{
  reviewed: number;
  expired: number;
  rewritten: number;
}> {
  const db = getDb();
  const now = new Date();
  const nowIso = now.toISOString();
  const fiveDaysAgo = new Date(now.getTime() - 5 * 86_400_000).toISOString();

  const open = db
    .select()
    .from(openLoops)
    .all()
    .filter((l) => l.status === "open");

  let expired = 0;
  let rewritten = 0;

  // Market chatter can sit on open loops that aren't yet "stale" by age —
  // dismiss them here so noise like "Conclude my bull run" doesn't linger.
  for (const loop of open) {
    if (looksLikeMarket(loop.title) || looksLikeMarket(loop.description ?? "")) {
      db.update(openLoops)
        .set({
          status: "dismissed",
          closedAt: nowIso,
          closeReason: "stale_review:market_noise",
          updatedAt: nowIso,
        })
        .where(eq(openLoops.id, loop.id))
        .run();
      expired++;
    }
  }

  const stillOpen = open.filter(
    (l) =>
      !looksLikeMarket(l.title) && !looksLikeMarket(l.description ?? ""),
  );

  const stale = stillOpen.filter((l) => {
    const overdue = l.dueAt && Date.parse(l.dueAt) < now.getTime();
    const untouched =
      (l.lastSeenAt ?? l.detectedAt) < fiveDaysAgo;
    return overdue || untouched;
  });

  for (const loop of stale.slice(0, 30)) {
    if (looksLikeMarket(loop.title) || looksLikeMarket(loop.description ?? "")) {
      continue;
    }

    const prompt = `LOOP_REVIEW
Age this open loop. Today is ${nowIso.slice(0, 10)}.

Loop: ${JSON.stringify({
      title: loop.title,
      who: loop.who,
      kind: loop.kind,
      category: loop.category,
      dueAt: loop.dueAt,
      detectedAt: loop.detectedAt,
      lastSeenAt: loop.lastSeenAt,
      description: (loop.description ?? "").slice(0, 300),
    })}

verdict:
- still_relevant — keep as-is (or lightly rewrite stale framing like "by tomorrow" when that day passed)
- needs_nudge — still open but title should reflect overdue / waiting status
- expired — no longer actionable (courtesy already done, opportunity gone, market noise)

If rewriting, put the new title in "title" (must still name person/company + topic).
Return JSON only.`;

    const res = await runLlm({
      prompt,
      model: "smart",
      purpose: "loop_review",
      skipHosted: true,
      temperature: 0,
      format: REVIEW_SCHEMA,
    });
    if (res.provider === "stub") continue;
    const parsed = parseJsonFromText<{
      verdict?: string;
      reason?: string;
      title?: string;
    }>(res.text);
    if (!parsed?.verdict) continue;

    if (parsed.verdict === "expired") {
      db.update(openLoops)
        .set({
          status: "dismissed",
          closedAt: nowIso,
          closeReason: `stale_review:${parsed.reason ?? "expired"}`,
          updatedAt: nowIso,
        })
        .where(eq(openLoops.id, loop.id))
        .run();
      expired++;
      continue;
    }

    const nextTitle =
      parsed.title &&
      parsed.title.trim().length >= 12 &&
      !isWeakLoopTitle(parsed.title, loop.who)
        ? parsed.title.trim().slice(0, 160)
        : null;
    if (nextTitle && nextTitle !== loop.title) {
      db.update(openLoops)
        .set({
          title: nextTitle,
          updatedAt: nowIso,
          lastSeenAt: nowIso,
        })
        .where(eq(openLoops.id, loop.id))
        .run();
      rewritten++;
    } else {
      db.update(openLoops)
        .set({ updatedAt: nowIso })
        .where(eq(openLoops.id, loop.id))
        .run();
    }
  }

  log.info("Stale loop review", {
    reviewed: stale.length,
    expired,
    rewritten,
  });
  return { reviewed: stale.length, expired, rewritten };
}

/**
 * One-off / boot backfill: re-extract weak open loops; reopen bad auto_evidence closes.
 */
export async function backfillLoopQuality(): Promise<{
  reextracted: number;
  reopened: number;
}> {
  const db = getDb();
  const now = new Date().toISOString();
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  let reextracted = 0;
  let reopened = 0;

  // Reopen false auto_evidence closes from last 14 days when evidence looks self-generated
  const badClosed = db
    .select()
    .from(openLoops)
    .all()
    .filter(
      (l) =>
        l.status === "closed" &&
        l.closeReason === "auto_evidence" &&
        (l.closedAt ?? "") >= since,
    );

  const allEv = db.select().from(loopEvidence).all();
  const allObs = db.select().from(observations).all();

  for (const loop of badClosed) {
    const closeEv = allEv.find(
      (e) => e.loopId === loop.id && e.role === "closed",
    );
    let reject = false;
    if (closeEv?.observationId) {
      const o = allObs.find((x) => x.id === closeEv.observationId);
      if (o && isSelfGeneratedObservation(o)) reject = true;
    }
    if (
      closeEv?.note &&
      /cursor agents|graph engineering guide|intimation regarding remittance/i.test(
        closeEv.note,
      )
    ) {
      reject = true;
    }
    if (!reject) continue;
    db.update(openLoops)
      .set({
        status: "open",
        closedAt: null,
        closeReason: null,
        updatedAt: now,
        lastSeenAt: now,
      })
      .where(eq(openLoops.id, loop.id))
      .run();
    db.insert(loopEvidence)
      .values({
        id: newId(),
        loopId: loop.id,
        role: "progressed",
        note: "reopened: rejected auto_evidence (self/unrelated)",
      })
      .run();
    reopened++;
  }

  // Re-extract currently open weak titles through new pipeline
  const weakOpen = db
    .select()
    .from(openLoops)
    .all()
    .filter(
      (l) =>
        l.status === "open" && isWeakLoopTitle(l.title, l.who),
    );

  for (const loop of weakOpen.slice(0, 20)) {
    const ev = allEv.find((e) => e.loopId === loop.id && (e.itemId || e.observationId));
    let cand: LoopCandidate | null = null;
    if (ev?.itemId) {
      const it = db.select().from(items).all().find((x) => x.id === ev.itemId);
      if (it) {
        const mailMeta = itemMailMeta(it);
        const classified = classifyMailLoop({
          subject: it.title,
          body: it.body,
          from: it.author,
          to: mailMeta.to,
          labels: mailMeta.labels,
          userEmail: readGoogleUserEmail(),
          kind: it.kind,
        });
        cand = {
          title: classified.title || loop.title,
          description: (it.body ?? "").slice(0, 400),
          kind: classified.kind,
          who: classified.who ?? loop.who ?? undefined,
          recallScore: 0.7,
          confidence: 0.7,
          itemId: it.id,
          snippet: `${it.title}\n${it.body ?? ""}`.slice(0, 2500),
          sourceUrl: it.url ?? undefined,
          source: "item",
          category: classified.category,
          tags: classified.tags,
          fromMe: classified.fromMe,
        };
      }
    } else if (ev?.observationId) {
      const o = allObs.find((x) => x.id === ev.observationId);
      if (o) {
        cand = {
          title: loop.title,
          description: (o.text ?? "").slice(0, 400),
          kind: (loop.kind as LoopCandidate["kind"]) || "unfinished",
          who: loop.who ?? undefined,
          recallScore: 0.7,
          confidence: 0.7,
          observationId: o.id,
          snippet: (o.text ?? "").slice(0, 2500),
          ocrText: o.text ?? undefined,
          source: "chat",
          category: loop.category,
          tags: (() => {
            try {
              return JSON.parse(loop.tagsJson || "[]") as string[];
            } catch {
              return ["chat"];
            }
          })(),
        };
      }
    }
    if (!cand) continue;
    const [extracted] = await extractLoopCandidates([cand]);
    if (!extracted || extracted.keep === false) {
      // Weak + model says drop → dismiss
      if (isWeakLoopTitle(loop.title, loop.who)) {
        db.update(openLoops)
          .set({
            status: "dismissed",
            closedAt: now,
            closeReason: "backfill:not_a_task",
            updatedAt: now,
          })
          .where(eq(openLoops.id, loop.id))
          .run();
        reextracted++;
      }
      continue;
    }
    const dueAt = extracted.dueAt ?? null;
    db.update(openLoops)
      .set({
        title: extracted.title,
        description: extracted.description ?? loop.description,
        who: extracted.who ?? loop.who,
        category: extracted.category ?? loop.category,
        tagsJson: JSON.stringify(extracted.tags ?? []),
        kind: extracted.kind,
        confidence: extracted.confidence,
        dueAt,
        dueHint: null,
        priority: computePriority({
          dueAt,
          kind: extracted.kind,
          confidence: extracted.confidence,
        }),
        updatedAt: now,
        lastSeenAt: now,
      })
      .where(eq(openLoops.id, loop.id))
      .run();
    reextracted++;
  }

  log.info("Loop quality backfill", { reextracted, reopened });
  return { reextracted, reopened };
}

/** Loops closed with closeReason starting with auto_ in the last 48h */
export function listRecentlyAutoClosed(limit = 20) {
  const db = getDb();
  const since = new Date(Date.now() - 48 * 3600_000).toISOString();
  return db
    .select()
    .from(openLoops)
    .all()
    .filter(
      (l) =>
        l.status === "closed" &&
        !!l.closeReason?.startsWith("auto_") &&
        (l.closedAt ?? "") >= since,
    )
    .sort((a, b) =>
      (b.closedAt ?? b.updatedAt).localeCompare(a.closedAt ?? a.updatedAt),
    )
    .slice(0, limit);
}

function readDailyKey(key: string): string | null {
  try {
    const row = getDb()
      .select()
      .from(settings)
      .all()
      .find((r) => r.key === key);
    if (!row) return null;
    return JSON.parse(row.valueJson) as string;
  } catch {
    return null;
  }
}

function writeSetting(key: string, value: unknown): void {
  const db = getDb();
  const valueJson = JSON.stringify(value);
  const existing = db
    .select()
    .from(settings)
    .all()
    .find((r) => r.key === key);
  if (existing) {
    db.update(settings)
      .set({ valueJson })
      .where(eq(settings.key, key))
      .run();
  } else {
    db.insert(settings).values({ key, valueJson }).run();
  }
}

function readBackfillDone(): boolean {
  try {
    const row = getDb()
      .select()
      .from(settings)
      .all()
      .find((r) => r.key === "loops.aiFirstBackfillDone.v2");
    if (!row) return false;
    return JSON.parse(row.valueJson) === true;
  } catch {
    return false;
  }
}

function markBackfillDone(): void {
  writeSetting("loops.aiFirstBackfillDone.v2", true);
}

export async function runLoopsPipeline(): Promise<{
  detect: { candidates: number; created: number; updated: number };
  close: { closed: number };
  review?: { reviewed: number; expired: number; rewritten: number };
  backfill?: { reextracted: number; reopened: number };
}> {
  let backfill: { reextracted: number; reopened: number } | undefined;
  if (!readBackfillDone()) {
    backfill = await backfillLoopQuality();
    markBackfillDone();
  }
  const detect = await detectOpenLoops();
  const close = await autoCloseLoops();

  let review: { reviewed: number; expired: number; rewritten: number } | undefined;
  const today = new Date().toISOString().slice(0, 10);
  if (readDailyKey("loops.lastStaleReviewDay") !== today) {
    review = await reviewStaleLoops();
    writeSetting("loops.lastStaleReviewDay", today);
  }
  return { detect, close, review, backfill };
}

export async function generateDigest(): Promise<string> {
  const db = getDb();
  const open = db
    .select()
    .from(openLoops)
    .all()
    .filter((l) => l.status === "open")
    .slice(0, 30);
  const prompt = `DIGEST
Write a short markdown daily digest of the user's open loops. Be concrete.
Loops:
${JSON.stringify(
  open.map((l) => ({
    title: l.title,
    kind: l.kind,
    who: l.who,
    due: l.dueAt ?? l.dueHint,
    priority: l.priority,
    confidence: l.confidence,
  })),
)}
`;
  const res = await runLlm({ prompt, model: "smart" });
  return res.text;
}

// Re-export category type for callers
export type { LoopCategory };
