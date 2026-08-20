/**
 * User-trainable tracking rules — Spam + Not tracking from the widget.
 */

import { eq } from "drizzle-orm";
import { getDb } from "./db/client.js";
import {
  userSpamRules,
  items,
  observations,
  loopEvidence,
  openLoops,
} from "./db/schema.js";
import { newId } from "./jobs.js";
import type { SpamInput } from "./spam.js";
import { recordLearnReward } from "./learn-graph.js";

export type UserRuleMatchType =
  | "sender"
  | "domain"
  | "title_pattern"
  | "source";

export type UserRuleIntent = "spam" | "not_tracking";

/** @deprecated use UserRuleMatchType */
export type UserSpamMatchType = UserRuleMatchType;

export type UserTrackingRule = {
  id: string;
  matchType: UserRuleMatchType;
  pattern: string;
  intent: UserRuleIntent;
  enabled: boolean;
  sourceLoopId: string | null;
  sourceItemId: string | null;
  note: string | null;
  hitCount: number;
  createdAt: string;
  updatedAt: string;
};

/** @deprecated use UserTrackingRule */
export type UserSpamRule = UserTrackingRule;

export type UserRuleHit = {
  id: string;
  intent: UserRuleIntent;
};

let cache: UserTrackingRule[] | null = null;
let cacheAt = 0;
const CACHE_MS = 5_000;

export function invalidateUserSpamCache(): void {
  cache = null;
  cacheAt = 0;
}

export const invalidateUserRulesCache = invalidateUserSpamCache;

function loadRules(): UserTrackingRule[] {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_MS) return cache;
  try {
    const db = getDb();
    cache = db
      .select()
      .from(userSpamRules)
      .all()
      .filter((r) => r.enabled)
      .map((r) => ({
        id: r.id,
        matchType: r.matchType as UserRuleMatchType,
        pattern: r.pattern,
        intent: (r.intent === "not_tracking" ? "not_tracking" : "spam") as UserRuleIntent,
        enabled: r.enabled,
        sourceLoopId: r.sourceLoopId,
        sourceItemId: r.sourceItemId,
        note: r.note,
        hitCount: r.hitCount,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
    cacheAt = now;
  } catch {
    cache = [];
    cacheAt = now;
  }
  return cache;
}

const GENERIC_INBOX_DOMAINS = new Set([
  "mail.google.com",
  "gmail.com",
  "google.com",
  "outlook.live.com",
  "outlook.office.com",
  "office.com",
  "github.com",
  "notifications.github.com",
]);

function domainFromUrl(url?: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function isUsefulSpamDomain(dom: string | null): boolean {
  if (!dom) return false;
  const d = dom.toLowerCase().replace(/^www\./, "");
  if (GENERIC_INBOX_DOMAINS.has(d)) return false;
  if (d.endsWith(".google.com") || d.endsWith(".github.com")) return false;
  return true;
}

function senderDomain(author?: string | null): string | null {
  const s = senderKey(author);
  if (!s || !s.includes("@")) return null;
  const dom = s.split("@")[1]?.toLowerCase() ?? null;
  return isUsefulSpamDomain(dom) ? dom : null;
}

function senderKey(author?: string | null): string | null {
  if (!author) return null;
  const m = author.match(/[\w.+-]+@[\w.-]+\.\w+/);
  const email = (m?.[0] ?? author).trim().toLowerCase();
  return email.length > 2 ? email : null;
}

function ruleMatches(r: UserTrackingRule, input: SpamInput): boolean {
  const title = (input.title ?? "").toLowerCase();
  const body = (input.body ?? "").toLowerCase();
  const kind = (input.kind ?? "").toLowerCase();
  const author = senderKey(input.author);
  const domain = domainFromUrl(input.url);
  const pat = r.pattern.toLowerCase().trim();
  if (!pat) return false;

  switch (r.matchType) {
    case "sender":
      return !!(
        author &&
        (author === pat || author.includes(pat) || pat.includes(author))
      );
    case "domain":
      if (
        domain &&
        (domain === pat || domain.endsWith(`.${pat}`) || domain.includes(pat))
      ) {
        return true;
      }
      return !!(author && author.includes(pat));
    case "title_pattern":
      return title.includes(pat) || body.slice(0, 200).includes(pat);
    case "source":
      return kind === pat || kind.includes(pat);
    default:
      return false;
  }
}

/** Any user rule (spam or not_tracking) */
export function matchUserRule(input: SpamInput): UserRuleHit | null {
  const rules = loadRules();
  for (const r of rules) {
    if (!ruleMatches(r, input)) continue;
    bumpHit(r.id);
    return { id: r.id, intent: r.intent };
  }
  return null;
}

/** Spam-intent only (for ingest / classifySpam) */
export function matchUserSpamRule(input: SpamInput): string | null {
  const rules = loadRules().filter((r) => r.intent === "spam");
  for (const r of rules) {
    if (!ruleMatches(r, input)) continue;
    bumpHit(r.id);
    return r.id;
  }
  return null;
}

/** Block loop creation for spam OR not_tracking */
export function isBlockedByUserRules(input: SpamInput): UserRuleHit | null {
  return matchUserRule(input);
}

function bumpHit(id: string): void {
  try {
    const db = getDb();
    const row = db
      .select()
      .from(userSpamRules)
      .where(eq(userSpamRules.id, id))
      .get();
    if (!row) return;
    db.update(userSpamRules)
      .set({
        hitCount: (row.hitCount ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(userSpamRules.id, id))
      .run();
  } catch {
    /* ignore */
  }
}

export function listUserSpamRules(intent?: UserRuleIntent): UserTrackingRule[] {
  invalidateUserSpamCache();
  const db = getDb();
  return db
    .select()
    .from(userSpamRules)
    .all()
    .filter((r) => !intent || (r.intent ?? "spam") === intent)
    .map((r) => ({
      id: r.id,
      matchType: r.matchType as UserRuleMatchType,
      pattern: r.pattern,
      intent: (r.intent === "not_tracking" ? "not_tracking" : "spam") as UserRuleIntent,
      enabled: r.enabled,
      sourceLoopId: r.sourceLoopId,
      sourceItemId: r.sourceItemId,
      note: r.note,
      hitCount: r.hitCount,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
}

export const listUserTrackingRules = listUserSpamRules;

export function deleteUserSpamRule(id: string): boolean {
  const db = getDb();
  const r = db.delete(userSpamRules).where(eq(userSpamRules.id, id)).run();
  invalidateUserSpamCache();
  return (r.changes ?? 0) > 0;
}

export const deleteUserTrackingRule = deleteUserSpamRule;

export function addUserSpamRule(input: {
  matchType: UserRuleMatchType;
  pattern: string;
  intent?: UserRuleIntent;
  note?: string;
  sourceLoopId?: string;
  sourceItemId?: string;
}): string {
  const db = getDb();
  const id = newId();
  const now = new Date().toISOString();
  const pattern = input.pattern.trim().toLowerCase();
  const intent: UserRuleIntent = input.intent ?? "spam";
  const existing = db
    .select()
    .from(userSpamRules)
    .all()
    .find(
      (r) =>
        r.matchType === input.matchType &&
        r.pattern.toLowerCase() === pattern &&
        (r.intent ?? "spam") === intent,
    );
  if (existing) {
    db.update(userSpamRules)
      .set({
        enabled: true,
        intent,
        updatedAt: now,
        note: input.note ?? existing.note,
        sourceLoopId: input.sourceLoopId ?? existing.sourceLoopId,
      })
      .where(eq(userSpamRules.id, existing.id))
      .run();
    invalidateUserSpamCache();
    return existing.id;
  }
  db.insert(userSpamRules)
    .values({
      id,
      matchType: input.matchType,
      pattern,
      intent,
      enabled: true,
      sourceLoopId: input.sourceLoopId ?? null,
      sourceItemId: input.sourceItemId ?? null,
      note: input.note ?? null,
      hitCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  invalidateUserSpamCache();
  return id;
}

export const addUserTrackingRule = addUserSpamRule;

function deriveRulesFromLoop(
  loopId: string,
  intent: UserRuleIntent,
): { ok: boolean; rules: string[]; error?: string } {
  const db = getDb();
  const loopRow = db
    .select()
    .from(openLoops)
    .all()
    .find((l) => l.id === loopId);
  if (!loopRow) return { ok: false, rules: [], error: "not found" };

  recordLearnReward(loopId, intent);

  const evidence = db
    .select()
    .from(loopEvidence)
    .all()
    .filter((e) => e.loopId === loopId);

  const ruleIds: string[] = [];
  const label = intent === "spam" ? "spam" : "not tracking";
  const now = new Date().toISOString();

  for (const ev of evidence) {
    if (ev.itemId) {
      const it = db.select().from(items).all().find((i) => i.id === ev.itemId);
      if (it) {
        const sender = senderKey(it.author);
        if (sender) {
          ruleIds.push(
            addUserSpamRule({
              matchType: "sender",
              pattern: sender,
              intent,
              note: `${label}: ${loopRow.title.slice(0, 80)}`,
              sourceLoopId: loopId,
              sourceItemId: it.id,
            }),
          );
        }
        const fromAuthor = senderDomain(it.author);
        if (fromAuthor) {
          ruleIds.push(
            addUserSpamRule({
              matchType: "domain",
              pattern: fromAuthor,
              intent,
              note: `${label} sender domain: ${loopRow.title.slice(0, 80)}`,
              sourceLoopId: loopId,
              sourceItemId: it.id,
            }),
          );
        }
        const dom = domainFromUrl(it.url);
        if (dom && isUsefulSpamDomain(dom)) {
          ruleIds.push(
            addUserSpamRule({
              matchType: "domain",
              pattern: dom,
              intent,
              note: `${label}: ${loopRow.title.slice(0, 80)}`,
              sourceLoopId: loopId,
              sourceItemId: it.id,
            }),
          );
        }
      }
    }
    if (ev.observationId) {
      const o = db
        .select()
        .from(observations)
        .all()
        .find((x) => x.id === ev.observationId);
      if (o) {
        const dom = domainFromUrl(o.url) ?? o.domain?.toLowerCase() ?? null;
        if (dom && isUsefulSpamDomain(dom)) {
          ruleIds.push(
            addUserSpamRule({
              matchType: "domain",
              pattern: dom,
              intent,
              note: `${label}: ${loopRow.title.slice(0, 80)}`,
              sourceLoopId: loopId,
            }),
          );
        }
      }
    }
  }

  const phrase = distinctiveTitlePhrase(loopRow.title);
  if (phrase) {
    ruleIds.push(
      addUserSpamRule({
        matchType: "title_pattern",
        pattern: phrase,
        intent,
        note: `Marked ${label}: ${loopRow.title.slice(0, 80)}`,
        sourceLoopId: loopId,
      }),
    );
  }

  // Prefer who / ticker as title pattern for not_tracking (e.g. NVDA)
  if (loopRow.who && loopRow.who.trim().length >= 2 && loopRow.who.trim().length <= 40) {
    const whoPat = loopRow.who.trim().toLowerCase();
    if (!senderKey(loopRow.who)) {
      ruleIds.push(
        addUserSpamRule({
          matchType: "title_pattern",
          pattern: whoPat,
          intent,
          note: `${label} who: ${loopRow.title.slice(0, 60)}`,
          sourceLoopId: loopId,
        }),
      );
    }
  }

  const whoSender = senderKey(loopRow.who);
  if (whoSender) {
    ruleIds.push(
      addUserSpamRule({
        matchType: "sender",
        pattern: whoSender,
        intent,
        note: `${label} who: ${loopRow.title.slice(0, 60)}`,
        sourceLoopId: loopId,
      }),
    );
  }

  if (intent === "spam") {
    const blob = `${loopRow.title} ${loopRow.description ?? ""}`;
    const hostHit = blob.match(
      /@?([\w.-]+\.(?:com|net|org|io|co|mail\.[\w.-]+))/i,
    );
    if (hostHit?.[1]) {
      const raw = hostHit[1].toLowerCase().replace(/^mail\./, "");
      if (
        isUsefulSpamDomain(raw) ||
        raw.includes("modemobile") ||
        raw.includes("musescore")
      ) {
        ruleIds.push(
          addUserSpamRule({
            matchType: "domain",
            pattern: raw,
            intent,
            note: `From loop text: ${loopRow.title.slice(0, 60)}`,
            sourceLoopId: loopId,
          }),
        );
      }
    }
  }

  db.update(openLoops)
    .set({
      status: "dismissed",
      closedAt: now,
      closeReason: intent === "spam" ? "user_spam" : "user_not_tracking",
      updatedAt: now,
    })
    .where(eq(openLoops.id, loopId))
    .run();

  invalidateUserSpamCache();
  return { ok: true, rules: [...new Set(ruleIds)] };
}

export function markLoopAsSpam(loopId: string): {
  ok: boolean;
  rules: string[];
  error?: string;
} {
  return deriveRulesFromLoop(loopId, "spam");
}

export function markLoopNotTracking(loopId: string): {
  ok: boolean;
  rules: string[];
  error?: string;
} {
  return deriveRulesFromLoop(loopId, "not_tracking");
}

/** Compact rules for LLM prompts */
export function formatUserRulesForPrompt(limit = 40): string {
  const rules = listUserSpamRules()
    .filter((r) => r.enabled)
    .slice(0, limit);
  if (rules.length === 0) return "(none)";
  return rules
    .map(
      (r) =>
        `- [${r.intent}] ${r.matchType}=${r.pattern}${r.note ? ` (${r.note.slice(0, 40)})` : ""}`,
    )
    .join("\n");
}

function distinctiveTitlePhrase(title: string): string | null {
  const t = title
    .toLowerCase()
    .replace(
      /\b(follow up|continue|your|the|a|an|is|are|to|for|on|of|and|or|read|set|tp|sl)\b/g,
      " ",
    )
    .replace(/[^\w\s@.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length < 6) return null;
  const emailDom = t.match(/@([\w.-]+\.\w+)/);
  if (emailDom?.[1]) return emailDom[1];
  if (/\bscoop\b/.test(t)) return "scoop";
  if (/\bmuse\b/.test(t)) return "muse";
  if (/\blineup\b/.test(t)) return "lineup";
  const words = t.split(" ").filter((w) => w.length > 3);
  if (words.length >= 2) return words.slice(0, 4).join(" ");
  return t.slice(0, 48) || null;
}
