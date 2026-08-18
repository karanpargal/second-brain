/**
 * Task categories + sent-mail handling.
 *
 * Outbound mail (you sent it) is never a "reply". A real application or an
 * ask they still owe you becomes a follow-up. Courtesy close-outs ("thanks,
 * happy to reconnect if something comes up") are not tasks — even if the
 * quoted thread talks about hiring.
 */

export const LOOP_CATEGORIES = [
  "follow_up",
  "reply",
  "billing",
  "career",
  "review",
  "deadline",
  "calendar",
  "github",
  "other",
] as const;

export type LoopCategory = (typeof LOOP_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<LoopCategory, string> = {
  follow_up: "Follow up",
  reply: "Reply",
  billing: "Billing",
  career: "Career",
  review: "Review",
  deadline: "Deadline",
  calendar: "Calendar",
  github: "GitHub",
  other: "Task",
};

const GENERIC_TITLE_RE =
  /^(re(ply|spond)?|follow[- ]?up|update|send|review|check|action|todo|task)$/i;

const CAREER_RE =
  /\b(interested in|applying|application|resume|cv\b|hiring|open role|job (at|application)|engineering (role|position|at)|interview)\b/i;

const BILLING_RE =
  /\b(stripe|invoice|billing|failed[- ]payment|payment failed|update (your )?(card|payment|billing)|past due)\b/i;

/** SaaS "subscription" — not IPO "over-subscription". */
const SAAS_SUBSCRIPTION_RE = /\b(?<!over-)subscription\b/i;

/** Registrar FYI: allotment / unblock / regret. Not a card-update task. */
const IPO_STATUS_RE =
  /\b(ipo\b|allotment|shares allotted|amount unblocked|over[- ]subscription|public issue|bid cum application|registrar to the (issue|offer)|kfintech|linkintime|bigshare)\b/i;

const ASK_THEM_RE =
  /\b(can you|could you|please (send|review|confirm|share|let me know)|when (can|will) you|looking forward to (hearing|your))\b/i;

const APPLICATION_RE =
  /\b(resume attached|please find (attached )?(my )?(resume|cv)|i('d| would) love to (work|join|apply)|i am applying|applying for|interested in (the |this )?(role|position|job))\b/i;

const CLOSE_OUT_RE =
  /\b(appreciate you taking the time|thanks for (your time|taking the time|looking|considering)|i('d| would) be happy to reconnect if|if something (else )?comes up|wishing you( and the team)? all the best|all the best[.!]?\s*$|no (further|hard) feelings|i('ll| will) pass( this time)?)\b/i;

/**
 * User-written part of a reply. Quoted hiring-platform footers must not
 * decide whether this is still an open loop.
 */
export function ownMailText(body: string): string {
  const cut = body.split(
    /\nOn .{8,200}wrote:|\n-{2,}\s*Original Message\s*-{2,}|\n-- Reply above this line --|\nFrom: .+\nSent: |\n\nEarlier in thread:/i,
  )[0];
  return (cut ?? body).replace(/^(>+.*\n)+/gm, "").trim();
}

export function isSentCloseOut(body: string): boolean {
  const mine = ownMailText(body);
  if (!mine) return false;
  if (ASK_THEM_RE.test(mine) || APPLICATION_RE.test(mine)) return false;
  if (CLOSE_OUT_RE.test(mine)) return true;
  const stripped = mine
    .replace(/--+\s*[\s\S]*$/m, "")
    .replace(/\bregards,?\s+\S+[\s\S]*$/i, "")
    .trim();
  if (stripped.length > 0 && stripped.length < 80) {
    return /^(thanks|thank you|cheers|got it|sounds good)\b/i.test(stripped);
  }
  return false;
}

/** A person is waiting on the user — not a marketing "Action Required" subject. */
const PERSONAL_ASK_RE =
  /\b(can you|could you|please (reply|review|sign|confirm|send|fix|approve|merge|share|let me know)|waiting (on|for)|assigned to you|requested your review|need(s)? (your|a) (response|decision|review)|looking for your|don'?t forget to (send|sign|return))\b/i;

/** Keep in sync with packages/core/src/spam.ts HARD_RE marketing clauses. */
const MARKETING_BLAST_RE =
  /\b(promote your|claim your (ens |)?(domain|nft|username|handle)|upgrade your (ens |)?domain)\b/i;

export type MailClassifyInput = {
  subject: string;
  body?: string | null;
  from?: string | null;
  to?: string | null;
  labels?: string[] | null;
  userEmail?: string | null;
  kind?: string | null;
};

export type MailClassifyResult = {
  keep: boolean;
  category: LoopCategory;
  tags: string[];
  title: string;
  who?: string;
  kind: "promise" | "awaiting_reply" | "unfinished" | "decision" | "deadline";
  fromMe: boolean;
};

export function isGenericTitle(title: string): boolean {
  const t = title.trim();
  if (t.length < 8) return true;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 3) return true;
  return GENERIC_TITLE_RE.test(t);
}

export function parseCategory(raw: unknown): LoopCategory {
  const s = String(raw ?? "")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if ((LOOP_CATEGORIES as readonly string[]).includes(s)) {
    return s as LoopCategory;
  }
  if (s === "followup") return "follow_up";
  return "other";
}

export function isFromMe(input: {
  from?: string | null;
  labels?: string[] | null;
  userEmail?: string | null;
}): boolean {
  const labels = (input.labels ?? []).map((l) => l.toUpperCase());
  if (labels.includes("SENT")) return true;
  const email = (input.userEmail ?? "").trim().toLowerCase();
  if (!email) return false;
  return (input.from ?? "").toLowerCase().includes(email);
}

function displayName(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const angle = raw.match(/^"?([^"<]+)"?\s*</);
  const name = (angle?.[1] ?? raw.split("@")[0] ?? "").trim();
  if (!name || /noreply|no-reply|notifications?|mailer-daemon/i.test(name)) {
    return undefined;
  }
  return name.slice(0, 80);
}

function orgFrom(subject: string, to?: string | null): string | undefined {
  const at = subject.match(
    /\b(?:at|@)\s+([A-Z][A-Za-z0-9][A-Za-z0-9.&' -]{1,40})/,
  );
  if (at?.[1]) return at[1].trim();
  const domain = (to ?? "").match(/@([a-z0-9-]+)\./i)?.[1];
  if (
    domain &&
    !["gmail", "googlemail", "outlook", "hotmail", "yahoo", "icloud"].includes(
      domain.toLowerCase(),
    )
  ) {
    return domain.charAt(0).toUpperCase() + domain.slice(1);
  }
  return displayName(to);
}

export function classifyMailLoop(input: MailClassifyInput): MailClassifyResult {
  const subject = input.subject || "(no subject)";
  const rawBody = input.body ?? "";
  const mine = ownMailText(rawBody);
  const blob = `${subject}\n${rawBody}`;
  const ownBlob = `${subject}\n${mine}`;
  let fromMe = isFromMe(input);
  if (
    !fromMe &&
    CAREER_RE.test(ownBlob) &&
    /\bhiring\b/i.test(input.to ?? "") &&
    /\b(i['’]m|i am|i'd love|my resume)\b/i.test(mine)
  ) {
    fromMe = true;
  }
  const tags: string[] = [];

  if (input.kind === "pr" || input.kind === "issue") {
    return {
      keep: true,
      category: "github",
      tags: ["github", input.kind],
      title:
        input.kind === "pr"
          ? `Review PR: ${subject}`.slice(0, 160)
          : `Work on issue: ${subject}`.slice(0, 160),
      who: displayName(input.from),
      kind: "unfinished",
      fromMe: false,
    };
  }

  const stripe = /stripe\.com/i.test(input.from ?? "");
  const billingHit =
    stripe || BILLING_RE.test(blob) || SAAS_SUBSCRIPTION_RE.test(blob);
  const ipoStatus = IPO_STATUS_RE.test(blob) || /kfintech\.com/i.test(input.from ?? "");

  if (ipoStatus && !stripe && !/\b(update (your )?(card|payment|billing)|payment failed|failed[- ]payment)\b/i.test(blob)) {
    return {
      keep: false,
      category: "other",
      tags: ["ipo_status"],
      title: subject,
      who: displayName(input.from),
      kind: "unfinished",
      fromMe,
    };
  }

  if (billingHit) {
    tags.push("billing");
    return {
      keep: true,
      category: "billing",
      tags,
      title: `Update billing${displayName(input.from) ? ` for ${displayName(input.from)}` : ""}`.slice(
        0,
        160,
      ),
      who: displayName(input.from),
      kind: "deadline",
      fromMe,
    };
  }

  const career = fromMe ? CAREER_RE.test(ownBlob) : CAREER_RE.test(blob);
  if (fromMe) {
    const org = orgFrom(subject, input.to);
    const who = org ? `${org} hiring` : displayName(input.to);
    if (isSentCloseOut(rawBody)) {
      return {
        keep: false,
        category: "other",
        tags: ["sent", "close_out"],
        title: subject,
        who,
        kind: "unfinished",
        fromMe: true,
      };
    }
    if (career || APPLICATION_RE.test(mine)) {
      tags.push("career", "follow_up");
      const topic = /engineer/i.test(subject)
        ? "the engineering role"
        : subject.replace(/^re:\s*/i, "").slice(0, 60);
      return {
        keep: true,
        category: "follow_up",
        tags,
        title: `Follow up with ${org ?? who ?? "them"} on ${topic}`.slice(
          0,
          160,
        ),
        who,
        kind: "awaiting_reply",
        fromMe: true,
      };
    }
    if (ASK_THEM_RE.test(mine) || ASK_THEM_RE.test(ownBlob)) {
      tags.push("follow_up");
      return {
        keep: true,
        category: "follow_up",
        tags,
        title: `Follow up with ${who ?? "them"}: ${subject}`.slice(0, 160),
        who,
        kind: "awaiting_reply",
        fromMe: true,
      };
    }
    return {
      keep: false,
      category: "other",
      tags: ["sent"],
      title: subject,
      who,
      kind: "unfinished",
      fromMe: true,
    };
  }

  if (career) {
    tags.push("career");
    return {
      keep: true,
      category: "career",
      tags,
      title: `Reply about ${subject}`.slice(0, 160),
      who: displayName(input.from),
      kind: "awaiting_reply",
      fromMe: false,
    };
  }

  if (MARKETING_BLAST_RE.test(blob)) {
    return {
      keep: false,
      category: "other",
      tags: ["marketing"],
      title: subject,
      who: displayName(input.from),
      kind: "unfinished",
      fromMe: false,
    };
  }

  if (PERSONAL_ASK_RE.test(blob)) {
    const review = /review|pr\b|pull request|diff\b/i.test(blob);
    return {
      keep: true,
      category: review ? "review" : "reply",
      tags: review ? ["review"] : ["reply"],
      title: review
        ? `Review: ${subject}`.slice(0, 160)
        : `Reply to ${displayName(input.from) ?? "them"} about ${subject}`.slice(
            0,
            160,
          ),
      who: displayName(input.from),
      kind: review ? "unfinished" : "awaiting_reply",
      fromMe: false,
    };
  }

  return {
    keep: false,
    category: "other",
    tags: [],
    title: subject,
    who: displayName(input.from),
    kind: "unfinished",
    fromMe: false,
  };
}

export function polishLoopTitle(
  llmTitle: string | undefined,
  fallback: string,
): string {
  const t = (llmTitle ?? "").trim();
  if (!t || isGenericTitle(t)) return fallback.slice(0, 160);
  return t.slice(0, 160);
}
