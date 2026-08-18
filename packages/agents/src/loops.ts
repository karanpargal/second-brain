import {
  getDb,
  items,
  openLoops,
  loopEvidence,
  observations,
  userProfiles,
  settings,
  reminders,
  newId,
  log,
  isSpam,
  classifySpam,
  isBlockedByUserRules,
  formatUserRulesForPrompt,
} from "@second-brain/core";
import { eq } from "drizzle-orm";
import { runLlm, parseJsonFromText } from "./llm.js";
import { cosine, embedText } from "@second-brain/enrich";
import {
  isTradingSurface,
  scoreTradingAction,
  tradingExitEvidence,
} from "./trading-actions.js";
import { getLoopLlmBudget } from "./loop-budget.js";
import { parseDueAt } from "./due.js";
import { computePriority } from "./priority.js";
import {
  loopsAreDuplicate,
  sourceThreadKey,
  type DedupeInput,
} from "./loop-dedupe.js";
import {
  classifyMailLoop,
  isGenericTitle,
  parseCategory,
  polishLoopTitle,
  type LoopCategory,
} from "./categories.js";

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
  /** item (email/issue/PR) | ocr (screen capture) */
  source?: "item" | "ocr";
  category?: string;
  tags?: string[];
  fromMe?: boolean;
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

/** Trading is opt-in. Empty profile / missing setting must not create TP/SL tasks. */
export function isTradingInterestEnabled(): boolean {
  const db = getDb();
  try {
    const row = db
      .select()
      .from(settings)
      .all()
      .find((r) => r.key === "interests.trading");
    if (row) {
      const v = JSON.parse(row.valueJson);
      if (v === true || v === "true" || v === 1) return true;
      if (v === false || v === "false" || v === 0) return false;
    }
  } catch {
    /* */
  }

  const profile = db
    .select()
    .from(userProfiles)
    .all()
    .find((p) => p.id === "local");
  if (!profile) return false;

  try {
    const packs = JSON.parse(profile.interestPacksJson || "[]") as unknown;
    if (Array.isArray(packs)) {
      return packs.map(String).includes("trading");
    }
  } catch {
    /* */
  }
  return false;
}

/**
 * Cheap heuristic candidates: items (email/issue/PR) + OCR observations.
 * Regex scores are RECALL only (threshold ~0.35); the LLM verifies everything.
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
  const obsLimit = opts.obsOnly ? 40 : 120;
  const tradingOk = isTradingInterestEnabled();

  // --- 1) Items (email / issue / PR) ---
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

    // One candidate per Gmail/GitHub thread — messages in a thread are
    // separate items and otherwise become duplicate tasks.
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
      if (it.kind === "notification" && !classified.keep && !COMMITMENT_RE.test(body)) {
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
        snippet: body.slice(0, 500),
        sourceUrl: it.url ?? undefined,
        source: "item",
        category: classified.category,
        tags: classified.tags,
        fromMe: classified.fromMe,
      });
    }
  }

  // --- 2) OCR / observations (screen capture; chat surfaces are skipped) ---
  const recentObs = db
    .select()
    .from(observations)
    .all()
    .filter((o) => o.ts >= sinceIso && o.text && o.text.length >= 8)
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, obsLimit);

  for (const o of recentObs) {
    const surface = {
      app: o.app,
      exe: o.exe,
      windowTitle: o.windowTitle,
      url: o.url,
      text: o.text ?? "",
    };
    const trading = isTradingSurface(surface);
    if (trading && !tradingOk) continue;
    if (
      /\b(tp\/?sl|take[- _]?profit|stop[- _]?loss|set_stop_loss|set tp)\b/i.test(
        `${o.windowTitle ?? ""} ${o.text ?? ""}`,
      ) &&
      !tradingOk
    ) {
      continue;
    }
    if (
      blockedForLoops({
        title: o.windowTitle,
        body: o.text,
        url: o.url,
        kind: trading ? "trading" : "pc",
      })
    ) {
      continue;
    }

    if (tradingOk) {
      const tradeHit = scoreTradingAction(surface);
      if (tradeHit && tradeHit.score >= RECALL_THRESHOLD) {
        const venueBit = tradeHit.venue ? ` on ${tradeHit.venue}` : "";
        const recall = Math.min(0.9, tradeHit.score);
        out.push({
          title: tradeHit.actionTitle,
          description: `${tradeHit.actionTitle}${venueBit}. ${
            tradeHit.reason.includes("missing_tp_sl")
              ? "Open position looks unprotected (no TP/SL)."
              : "Trading risk spotted from your screen."
          } ${(o.text ?? "").slice(0, 280)}`.slice(0, 400),
          kind: tradeHit.kind,
          who: tradeHit.who,
          recallScore: recall,
          confidence: recall,
          observationId: o.id,
          snippet: (o.text ?? "").slice(0, 500),
          sourceUrl: o.url ?? undefined,
          source: "ocr",
        });
        continue;
      }
    }

    // OCR is memory, not a loop source. Chat/docs "Continue:" cards were noise.
    continue;
  }

  // Prefer items, then higher recall
  out.sort((a, b) => {
    const srcRank = (s?: string) => (s === "item" ? 0 : 1);
    const d = srcRank(a.source) - srcRank(b.source);
    if (d !== 0) return d;
    return b.recallScore - a.recallScore;
  });
  return out.slice(0, limit);
}

type StructuredLoop = {
  title: string;
  kind: LoopCandidate["kind"];
  who?: string;
  dueHint?: string;
  confidence: number;
  keep: boolean;
  action?: string;
  category?: LoopCategory;
  tags?: string[];
};

async function structureCandidates(
  candidates: LoopCandidate[],
): Promise<Array<LoopCandidate & { structured?: StructuredLoop }>> {
  if (candidates.length === 0) return [];

  const payload = candidates.map((c, i) => ({
    i,
    title: c.title,
    kind_hint: c.kind,
    category_hint: c.category ?? "other",
    from_me: Boolean(c.fromMe),
    who: c.who ?? null,
    snippet: c.snippet.slice(0, 300),
    source: c.source ?? "ocr",
  }));

  const userRules = formatUserRulesForPrompt(40);

  const prompt = `STRUCTURE_LOOPS
You extract open loops — unfinished commitments the user should ACT on.
Return JSON only:
{"loops":[{"i":0,"title":"...","action":"...","kind":"promise|awaiting_reply|unfinished|decision|deadline","category":"follow_up|reply|billing|career|review|deadline|calendar|github|other","tags":[],"who":null,"dueHint":null,"confidence":0.0,"keep":true}]}

Rules:
- "title" MUST name the person/company AND the topic. Never a single verb ("reply", "update", "follow up").
  Good: "Follow up with Rivet hiring on the engineering role"
  Bad: "reply"
- from_me:true means the USER SENT this mail. That is NEVER "reply". Use category follow_up (wait for them) or keep:false.
- Job applications / "interested in a role" that the user sent and is still waiting on → keep:true, category follow_up, tags ["career"], kind awaiting_reply.
- Close-outs the user already sent (thanks / appreciate your time / happy to reconnect if something comes up / all the best) with no question and no ask → keep:false. The thread is done.
- Quoted hiring-platform mail (Work at a Startup, "X sent you a message", YC relay) is not an application to follow up on if the user's own text already closed it.
- Inbound billing / Stripe / failed payment → category billing.
- IPO allotment / registrar status (KFin, shares allotted, amount unblocked, over-subscription) is FYI, not billing. keep:false.
- Inbound mail that asks the user to respond → category reply, title "Reply to <name> about <topic>".
- Drop spam, newsletters, marketing, noreply blasts (keep:false).
- Drop anything matching USER_RULES below — keep:false.
- Drop noise with no clear human action (keep:false).
- Never emit two loops for the same email thread, sender+topic, or billing notice.

USER_RULES (do not track / never surface):
${userRules}

Candidates:
${JSON.stringify(payload, null, 0)}
`;

  const res = await runLlm({
    prompt,
    model: "fast",
    purpose: "structure_loops",
  });
  const parsed = parseJsonFromText<{
    loops: Array<StructuredLoop & { i: number }>;
  }>(res.text);

  if (!parsed?.loops) {
    // Parse failure: drop everything — nothing is verified without the LLM
    return candidates.map((c) => asAccepted(c, false));
  }

  return candidates.map((c, i) => {
    const s = parsed.loops.find((x) => x.i === i);
    if (!s || s.keep === false)
      return { ...c, structured: { ...s, keep: false } as StructuredLoop };
    if (c.fromMe) {
      const cat = parseCategory(s.category);
      if (cat === "reply" || cat === "career") s.category = "follow_up";
    }
    const actionTitle = polishLoopTitle(s.action || s.title, c.title);
    const confidence = s.confidence ?? c.confidence;
    const category = parseCategory(s.category ?? c.category);
    const tags = Array.isArray(s.tags) && s.tags.length > 0 ? s.tags.map(String) : (c.tags ?? []);
    return {
      ...c,
      title: actionTitle,
      description: c.description,
      kind: s.kind || c.kind,
      who: s.who ?? c.who,
      dueHint: s.dueHint ?? c.dueHint,
      confidence,
      category,
      tags,
      structured: { ...s, confidence, category, title: actionTitle },
    };
  });
}

function asAccepted(
  c: LoopCandidate,
  keep: boolean,
): LoopCandidate & { structured: StructuredLoop } {
  return {
    ...c,
    structured: {
      title: c.title,
      kind: c.kind,
      who: c.who,
      dueHint: c.dueHint,
      confidence: c.confidence,
      keep,
      action: c.title,
    },
  };
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
 */
async function findSimilarOpenLoop(
  candidate: DedupeInput,
  emb: number[] | null,
): Promise<string | null> {
  const db = getDb();
  const open = db
    .select()
    .from(openLoops)
    .all()
    .filter((l) => l.status === "open" || l.status === "snoozed");

  const allEv = db.select().from(loopEvidence).all();

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
        if (other.length === emb.length && cosine(emb, other) > 0.82) {
          return l.id;
        }
      } catch {
        /* */
      }
    }
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
      const snooze = Number(b.loop.status === "snoozed") - Number(a.loop.status === "snoozed");
      if (snooze !== 0) return snooze;
      const ev = b.itemIds.length + b.urls.length - (a.itemIds.length + a.urls.length);
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
        /* reminders table may be unused */
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
    const generic = isGenericTitle(loop.title);
    if (
      !classified.keep &&
      loop.origin !== "manual" &&
      (generic || classified.fromMe || loop.category === "billing")
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
    const nextTitle = generic ? classified.title : loop.title;
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
        kind: generic ? classified.kind : loop.kind,
        updatedAt: now,
      })
      .where(eq(openLoops.id, loop.id))
      .run();
    n++;
  }
  if (n > 0) log.info("Recategorized open loops", { updated: n });
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
  // Fast wake scans recent items + OCR; full runs look back a week. No L1 bypass.
  const candidates = collectLoopCandidates(fast ? 24 : 40, {
    sinceMinutes: fast ? 20 : undefined,
  });

  // All recall-pass candidates — no L1 accept bypass
  const recalled = candidates.filter((c) => c.recallScore >= RECALL_THRESHOLD);

  const budget = getLoopLlmBudget();
  const slots = Math.min(budget.maxPerRun, budget.remainingToday);
  const canLlm = slots > 0;

  let structured: Array<LoopCandidate & { structured?: StructuredLoop }>;

  if (canLlm) {
    const forLlm = recalled.slice(0, slots);
    if (recalled.length > forLlm.length) {
      log.info("Loop LLM capped candidates", {
        recalled: recalled.length,
        sent: forLlm.length,
        maxPerRun: budget.maxPerRun,
        remainingToday: budget.remainingToday,
      });
    }
    structured = await structureCandidates(forLlm);

    // Overflow beyond the LLM budget is dropped — nothing is kept unverified
    const overflow = recalled.slice(forLlm.length);
    for (const c of overflow) {
      structured.push(asAccepted(c, false));
    }
  } else {
    log.info("Loop LLM budget exhausted — skipping unverified candidates", {
      recalled: recalled.length,
      usedToday: budget.usedToday,
      maxPerDay: budget.maxPerDay,
    });
    structured = recalled.map((c) => asAccepted(c, false));
  }

  const db = getDb();
  let created = 0;
  let updated = 0;
  const now = new Date().toISOString();

  // Drop existing open loops that match spam / not_tracking / promo (full runs only)
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

  for (const c of structured) {
    if (c.structured && c.structured.keep === false) continue;
    const title = c.title;
    let emb: number[] | null = null;
    try {
      emb = await embedText(title);
    } catch {
      emb = null;
    }

    const existingId = await findSimilarOpenLoop(asDedupeInput(c), emb);
    if (existingId) {
      const existing = db
        .select()
        .from(openLoops)
        .where(eq(openLoops.id, existingId))
        .get();
      const nextTitle =
        existing && isGenericTitle(existing.title) && !isGenericTitle(title)
          ? title
          : existing?.title ?? title;
      db.update(openLoops)
        .set({
          lastSeenAt: now,
          confidence: Math.max(c.confidence, 0.4),
          updatedAt: now,
          title: nextTitle,
          category: c.category ?? existing?.category ?? "other",
          tagsJson: JSON.stringify(c.tags ?? []),
          who: c.who ?? existing?.who ?? null,
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
            : "re-detected",
        })
        .run();
      updated++;
      continue;
    }

    const dueAt =
      c.dueAt ??
      (c.dueHint && !Number.isNaN(Date.parse(c.dueHint))
        ? new Date(c.dueHint).toISOString()
        : parseDueAt(c.snippet));
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
        dueHint: c.dueHint ?? dueAt ?? null,
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
          ? `${c.snippet.slice(0, 200)} · ${c.sourceUrl}`
          : c.snippet.slice(0, 300),
      })
      .run();
    created++;
  }

  log.info("Open loop detect", {
    mode: fast ? "fast" : "full",
    candidates: candidates.length,
    created,
    updated,
  });
  return { candidates: candidates.length, created, updated };
}

/**
 * Auto-close loops when new evidence suggests resolution.
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
    .filter((o) => o.ts >= weekAgo)
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 200);

  let closed = 0;
  const now = new Date().toISOString();

  const closePatterns =
    /\b(done|merged|shipped|sent|resolved|closed|completed|fixed|replied|no longer needed|position closed|flattened|tp hit|sl hit|stopped out)\b/i;

  for (const loop of open) {
    let closingItemId: string | undefined;
    let closingObsId: string | undefined;
    let closeReason = "auto_evidence";
    let note = "";

    const isTradeLoop =
      /\b(tp\/?sl|take[- ]?profit|stop[- ]?loss|open (trade|position)|set tp)\b/i.test(
        `${loop.title} ${loop.description ?? ""}`,
      ) ||
      (!!loop.who &&
        /^[A-Z]{2,6}$/.test(loop.who) &&
        /\b(set|review|tp|sl|position)\b/i.test(loop.title));

    // Trade loops: look for exit evidence on screen
    if (isTradeLoop) {
      for (const o of recentObs) {
        if (tradingExitEvidence(o.text ?? "", loop.who)) {
          closingObsId = o.id;
          closeReason = "auto_trade_exit";
          note = `Trade update: ${o.windowTitle ?? o.app}`;
          break;
        }
      }
    }

    // Evidence path: token overlap >= 3 with recent items / observations
    if (!closingObsId) {
      const tokens = loop.title
        .toLowerCase()
        .split(/\W+/)
        .filter((t) => t.length > 3)
        .slice(0, 8);
      if (tokens.length === 0) continue;
      const need = Math.min(3, tokens.length);

      for (const it of recentItems) {
        const body = `${it.title}\n${it.body ?? ""}`.toLowerCase();
        const hit = tokens.filter((t) => body.includes(t)).length;
        if (hit < need) continue;
        if (
          closePatterns.test(body) ||
          (it.kind === "pr" && /merged|closed/i.test(body))
        ) {
          closingItemId = it.id;
          note = `Item evidence: ${it.title}`;
          break;
        }
      }

      if (!closingItemId) {
        for (const o of recentObs) {
          const body = `${o.windowTitle ?? ""}\n${o.text ?? ""}`;
          const bodyL = body.toLowerCase();
          const hit = tokens.filter((t) => bodyL.includes(t)).length;
          if (hit < need) continue;
          if (closePatterns.test(body)) {
            closingObsId = o.id;
            note = `Observation: ${o.windowTitle ?? o.app}`;
            break;
          }
        }
      }

      if (
        !closingItemId &&
        !closingObsId &&
        loop.kind === "deadline" &&
        loop.dueHint
      ) {
        const due = Date.parse(loop.dueHint);
        if (!Number.isNaN(due) && due < Date.now() - 2 * 86400_000) {
          continue;
        }
      }

      if (!closingItemId && !closingObsId) continue;
    }

    db.update(openLoops)
      .set({
        status: "closed",
        closedAt: now,
        closeReason,
        updatedAt: now,
      })
      .where(eq(openLoops.id, loop.id))
      .run();
    db.insert(loopEvidence)
      .values({
        id: newId(),
        loopId: loop.id,
        itemId: closingItemId ?? null,
        observationId: closingObsId ?? null,
        role: "closed",
        note,
      })
      .run();
    closed++;
  }

  log.info("Auto-close loops", { closed });
  return { closed };
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

export async function runLoopsPipeline(): Promise<{
  detect: { candidates: number; created: number; updated: number };
  close: { closed: number };
}> {
  const detect = await detectOpenLoops();
  const close = await autoCloseLoops();
  return { detect, close };
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
