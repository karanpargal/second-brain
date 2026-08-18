/**
 * Shared internal spam filter — used at ingest and loop detection.
 * Gmail query filters are complementary; this catches what slips through.
 */

import { matchUserSpamRule } from "./user-spam.js";

export type SpamInput = {
  kind?: string | null;
  title?: string | null;
  body?: string | null;
  author?: string | null;
  url?: string | null;
  /** Gmail / source labels when available */
  labels?: string[] | null;
  meta?: Record<string, unknown> | null;
};

export type SpamVerdict = {
  spam: boolean;
  reason?: string;
  score: number; // 0..1, higher = more spammy
};

const HARD_KIND = new Set(["newsletter", "spam"]);

const HARD_LABELS = new Set([
  "SPAM",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_FORUMS",
]);

/** Strong promo / marketing / mailer noise */
const HARD_RE =
  /\b(unsubscribe|email preferences|view in browser|manage (your )?preferences|one[- ]click unsubscribe|% off|\$\d+\s*off|limited[- ]time|flash sale|act now|buy now|shop now|free shipping|coupon code|promo code|newsletter|digest for you|weekly roundup|marketing@|mailer-daemon|bounce@|donotreply@|do-not-reply@|no[- ]?reply@|noreply@|notifications?@|reminder:\s*your (cart|bag)|complete your purchase|start riding|come back and (save|ride)|professional network|join my network|connections in common|people you may know|sponsored|advertisement|promote your|claim your (ens |)?(domain|nft|username|handle)|upgrade your (ens |)?domain)\b/i;

/** Weaker signals — need stacking or noreply author */
const SOFT_RE =
  /\b(deal|discount|offer|sale|subscribe|broadcast|campaign|announcement|we miss you|it's been a while|win a|giveaway|lottery|crypto|nft|digest is ready|your tuesday|your weekly)\b/i;

/** Personal asks — "Action Required:" alone is marketing, not a human waiting. */
const ACTIONABLE_RE =
  /\b(can you|could you|please (reply|review|sign|confirm|send|fix|approve|merge)|waiting (on|for)|action item|need(s)? (your|a) (response|decision|review)|assigned to you|requested your review|conflict|blocker|deadline|by (eod|eow|friday|monday|tomorrow)|tp\/?sl|take[- ]?profit|stop[- ]?loss|unrealized pn[l]|set (tp|sl|stop))\b/i;

const NOREPLY_AUTHOR_RE =
  /noreply|no[- ]?reply|do[- ]?not[- ]?reply|donotreply|notifications?@|mailer[- ]?daemon|bounce@|marketing@|newsletter@|news@|promo@|deals@|offers@/i;

const SOCIAL_HOST_RE =
  /(linkedin\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|tiktok\.com|redditmail\.com|medium\.com\/.*\/digest)/i;

const CHAT_HOST_ALLOW_RE =
  /(whatsapp\.com|web\.whatsapp\.com|slack\.com|discord\.com|telegram\.org|teams\.microsoft\.com)/i;

const TRADING_HOST_ALLOW_RE =
  /(trench\.ag|tradingview\.com|binance\.com|bybit\.com|okx\.com|hyperliquid\.xyz|dydx\.exchange|coinbase\.com|kraken\.com|robinhood\.com|webull\.com|tastytrade\.com|ibkr\.com|jupiter\.ag|gmgn\.ai)/i;

function blobOf(input: SpamInput): string {
  return [
    input.kind ?? "",
    input.title ?? "",
    input.body ?? "",
    input.author ?? "",
    input.url ?? "",
  ].join("\n");
}

/**
 * Score and classify content as spam / promo / social noise.
 * Actionable personal asks can override weaker signals.
 */
export function classifySpam(input: SpamInput): SpamVerdict {
  const userHit = matchUserSpamRule(input);
  if (userHit) {
    return { spam: true, reason: `user_rule:${userHit}`, score: 1 };
  }

  const kind = (input.kind ?? "").toLowerCase();
  const labels = input.labels ?? [];
  const blob = blobOf(input);
  const actionable = ACTIONABLE_RE.test(blob);

  if (HARD_KIND.has(kind) && kind !== "chat" && kind !== "trading" && !actionable) {
    return { spam: true, reason: `kind:${kind}`, score: 0.95 };
  }

  // Messaging apps are never "social spam" — they feed chat actions
  if (kind === "chat" || (input.url && CHAT_HOST_ALLOW_RE.test(input.url))) {
    if (HARD_RE.test(blob) && !actionable) {
      return { spam: true, reason: "promo_in_chat", score: 0.8 };
    }
    return { spam: false, score: 0.05 };
  }

  // Trading desks — allow crypto/position UI through (soft "crypto" must not kill them)
  if (kind === "trading" || (input.url && TRADING_HOST_ALLOW_RE.test(input.url))) {
    if (HARD_RE.test(blob) && !actionable && !/\btp\/?sl|stop[- ]?loss|unrealized/i.test(blob)) {
      return { spam: true, reason: "promo_in_trading", score: 0.8 };
    }
    return { spam: false, score: 0.05 };
  }

  for (const lab of labels) {
    if (HARD_LABELS.has(lab) && !actionable) {
      return { spam: true, reason: `label:${lab}`, score: 0.95 };
    }
  }

  if (HARD_RE.test(blob)) {
    const personalAsk =
      /please (review|confirm|approve|merge|sign)|assigned to you|requested your review|can you/i.test(
        blob,
      ) && !NOREPLY_AUTHOR_RE.test(input.author ?? "");
    if (actionable && personalAsk && !/\bpromote your\b/i.test(blob)) {
      return { spam: false, score: 0.35, reason: "hard_signal_but_actionable" };
    }
    return { spam: true, reason: "promo_pattern", score: 0.9 };
  }

  let score = 0;
  const reasons: string[] = [];

  if (SOFT_RE.test(blob)) {
    score += 0.35;
    reasons.push("soft_promo");
  }
  if (NOREPLY_AUTHOR_RE.test(input.author ?? "")) {
    score += 0.4;
    reasons.push("noreply_author");
  }
  if (input.url && SOCIAL_HOST_RE.test(input.url) && !actionable) {
    score += 0.35;
    reasons.push("social_url");
  }
  if (kind === "notification" && !actionable) {
    score += 0.25;
    reasons.push("notification");
  }

  // GitHub bot noise
  if (
    /\[?(dependabot|renovate|github-actions|codecov|sonarcloud)\]?/i.test(
      `${input.author ?? ""} ${input.title ?? ""}`,
    ) &&
    !actionable
  ) {
    score += 0.5;
    reasons.push("bot");
  }

  if (actionable) score -= 0.45;

  score = Math.max(0, Math.min(1, score));
  const spam = score >= 0.55;
  return {
    spam,
    score,
    reason: spam ? reasons.join("+") || "score" : reasons[0],
  };
}

export function isSpam(input: SpamInput): boolean {
  return classifySpam(input).spam;
}

/** Convenience for items / observations */
export function isSpamText(
  title: string,
  body = "",
  author?: string | null,
  kind?: string | null,
): boolean {
  return isSpam({ title, body, author, kind });
}
