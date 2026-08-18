/**
 * Decide whether two loop candidates / open loops are the same task.
 *
 * Exact title match is not enough: the LLM rewrites subjects into different
 * action lines ("Update billing information…" vs "update billing info") and
 * Gmail threads produce one item per message.
 */

const STOP = new Set([
  "the",
  "and",
  "for",
  "you",
  "your",
  "about",
  "with",
  "from",
  "this",
  "that",
  "reply",
  "follow",
  "update",
  "send",
  "review",
  "answer",
  "please",
  "need",
  "action",
  "email",
  "mail",
  "continue",
  "work",
  "open",
  "todo",
  "task",
  "re",
  "fwd",
  "fw",
  "can",
  "will",
  "are",
  "was",
  "have",
  "has",
  "not",
  "any",
  "all",
  "our",
  "their",
  "but",
  "get",
  "set",
  "let",
  "ask",
  "two",
  "one",
  "new",
]);

export type DedupeInput = {
  title: string;
  who?: string | null;
  sourceUrl?: string | null;
  itemId?: string | null;
};

export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/^(re|fw|fwd|follow[- ]?up)\s*:\s*/i, "")
    .replace(/^(re|fw|fwd|follow[- ]?up)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function sourceThreadKey(url?: string | null): string | null {
  if (!url) return null;
  const u = url.trim();
  if (!u) return null;

  const gmailHash = u.split("#")[1];
  if (/mail\.google\.com/i.test(u) && gmailHash) {
    const threadId = gmailHash.split("/").filter(Boolean).pop();
    if (threadId && threadId.length >= 8) return `gmail:${threadId}`;
  }

  try {
    const parsed = new URL(u);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "github.com") {
      const path = parsed.pathname.replace(/\/+$/, "");
      const issue = path.match(/^\/([^/]+\/[^/]+)\/(issues|pull)\/(\d+)/);
      if (issue) return `gh:${issue[1]}/${issue[2]}/${issue[3]}`;
      return `gh:${path}`;
    }
    if (host === "mail.google.com") {
      return null;
    }
    return `url:${host}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return `url:${u.split("?")[0]}`;
  }
}

export function senderKey(who?: string | null): string | null {
  if (!who) return null;
  const angle = who.match(/<([^>]+)>/);
  const raw = (angle?.[1] ?? who).trim().toLowerCase();
  const email = raw.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  if (email) {
    const [local, domain] = email[0].split("@");
    const plus = local.split("+")[0];
    return `${plus}@${domain}`;
  }
  const name = raw.replace(/["']/g, "").trim();
  if (name.length < 3) return null;
  return `name:${name}`;
}

function stemToken(t: string): string {
  if (t.length <= 4) return t;
  return t
    .replace(/ational$/, "ate")
    .replace(/tion$/, "")
    .replace(/sion$/, "")
    .replace(/ness$/, "")
    .replace(/ment$/, "")
    .replace(/ing$/, "")
    .replace(/ied$/, "y")
    .replace(/ies$/, "y")
    .replace(/es$/, "")
    .replace(/s$/, "");
}

export function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of normalizeTitle(text).split(/\W+/)) {
    if (raw.length < 3 || STOP.has(raw)) continue;
    out.add(stemToken(raw));
  }
  return out;
}

function tokensOverlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  const used = new Set<string>();
  for (const x of a) {
    if (b.has(x)) {
      n++;
      used.add(x);
      continue;
    }
    for (const y of b) {
      if (used.has(y)) continue;
      const short = x.length <= y.length ? x : y;
      const long = x.length <= y.length ? y : x;
      if (short.length >= 4 && long.startsWith(short)) {
        n++;
        used.add(y);
        break;
      }
    }
  }
  return n;
}

/** Jaccard on content tokens (stopwords stripped, titles normalized). */
export function titleSim(a: string, b: string): number {
  const ta = contentTokens(a);
  const tb = contentTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  const inter = tokensOverlap(ta, tb);
  const union = ta.size + tb.size - inter;
  return union <= 0 ? 0 : inter / union;
}

export function loopsAreDuplicate(a: DedupeInput, b: DedupeInput): boolean {
  if (a.itemId && b.itemId && a.itemId === b.itemId) return true;

  const threadA = sourceThreadKey(a.sourceUrl);
  const threadB = sourceThreadKey(b.sourceUrl);
  if (threadA && threadB && threadA === threadB) return true;

  const sim = titleSim(a.title, b.title);
  if (sim >= 0.5) return true;

  const overlap = tokensOverlap(contentTokens(a.title), contentTokens(b.title));
  const sameSender =
    Boolean(senderKey(a.who)) && senderKey(a.who) === senderKey(b.who);

  // Same person/mailbox + shared topic words (Kling billing, KOSH card).
  if (sameSender && overlap >= 2) return true;

  // Strong topic overlap even when "who" is a display name / missing.
  if (overlap >= 3 && sim >= 0.28) return true;

  return false;
}
