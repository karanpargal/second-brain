/**
 * Rich-context per-candidate loop extraction (mail + chat).
 * Requires a verbatim evidence_quote so the model cannot invent vague titles.
 */
import { formatUserRulesForPrompt, looksLikeMarket, recordLearnClassify } from "@second-brain/core";
import { evalFewShotForPrompt } from "./eval-learn.js";
import { parseJsonFromText, runLlm } from "./llm.js";
import { chatDateContext } from "./polish-chat.js";
import {
  parseCategory,
  type LoopCategory,
} from "./categories.js";
import {
  validateOrRepair,
  type ExtractedLoopFields,
} from "./loop-validate.js";
import type { LoopCandidate } from "./loops.js";

export type ExtractResult = LoopCandidate & {
  keep: boolean;
  evidenceQuote?: string;
  org?: string;
  subjectTopic?: string;
};

const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    keep: { type: "boolean" },
    title: { type: "string" },
    who: { type: ["string", "null"] },
    org: { type: ["string", "null"] },
    subject: { type: ["string", "null"] },
    due: { type: ["string", "null"] },
    evidence_quote: { type: "string" },
    kind: {
      type: "string",
      enum: [
        "promise",
        "awaiting_reply",
        "unfinished",
        "decision",
        "deadline",
      ],
    },
    category: {
      type: "string",
      enum: [
        "follow_up",
        "reply",
        "billing",
        "career",
        "review",
        "deadline",
        "calendar",
        "github",
        "other",
      ],
    },
    tags: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
    not_task_reason: { type: ["string", "null"] },
    audience: { type: "string", enum: ["me", "other", "neither"] },
    topic: { type: "string", enum: ["actionable", "idle", "market"] },
  },
  required: ["keep", "title", "evidence_quote", "confidence"],
};

function sourceBlob(c: LoopCandidate): string {
  if (c.source === "chat") {
    return (c.ocrText || c.snippet || c.title || "").slice(0, 2500);
  }
  return (c.snippet || c.description || c.title || "").slice(0, 2500);
}

function buildExtractPrompt(c: LoopCandidate, now: Date): string {
  const { todayDmy, tomorrowDmy, weekday } = chatDateContext(now);
  const userRules = formatUserRulesForPrompt(40);
  const evalHints = evalFewShotForPrompt();
  const blob = sourceBlob(c);
  const isChat = c.source === "chat";

  return `LOOP_EXTRACT
Today is ${weekday} ${todayDmy}. Tomorrow is ${tomorrowDmy}.
You extract ONE open loop — an unfinished commitment the user should ACT on.
Never send. Local only. Return JSON only.

Source type: ${isChat ? "chat_ocr" : "mail_or_item"}
from_me: ${Boolean(c.fromMe)}
seed_title: ${JSON.stringify(c.title)}
category_hint: ${c.category ?? "other"}
kind_hint: ${c.kind}
who_hint: ${JSON.stringify(c.who ?? null)}

SOURCE TEXT:
${blob}

Output fields:
- keep: true only if this is a real unfinished action for the user
- title: MUST name the person/company AND the topic. 4+ words.
  Good: "Follow up with Rivet hiring on the Senior Engineer role"
  Good: "Send the bill to Wini by ${tomorrowDmy}"
  Bad: "Check application status"
  Bad: "Submit application or follow up"
  Bad: "Respond to invitation"
  Bad: "update billing information"
- who: person display name only (never a job title like "CLANX/Senior AI Engineer")
- org: company/org if known
- subject: role, thread topic, or product name if relevant
- due: absolute ISO date YYYY-MM-DD (or with time) OR null. Never "soon" / "asap".
- evidence_quote: short verbatim substring copied from SOURCE TEXT that proves the task
- kind, category, tags, confidence (0-1)
- not_task_reason: why keep=false (if so)
${
  isChat
    ? `- audience: me | other | neither
- topic: actionable | idle | market
Keep chat only if audience=me AND topic=actionable.`
    : ""
}

Hard drops (keep=false):
- Spam, newsletters, marketing, noreply blasts
- IPO allotment / registrar FYI (KFin, shares allotted)
- Courtesy close-outs the user already sent (thanks / all the best) with no ask
- Market/trading chatter (PnL, bull run, long/short, fills, margin)
- Idle chat (ok, lol, thanks, stickers)
- OCR garbage without a clear ask
- Anything matching USER_RULES

from_me:true is NEVER category "reply". Use follow_up (waiting on them) or keep=false.
Job applications the user sent → keep:true, category follow_up, tags ["career"], kind awaiting_reply.
Inbound asks → category reply, title "Reply to <name> about <topic>".
Billing / Stripe failed payment → category billing, title names the product/vendor.

USER_RULES:
${userRules}

SELF_EVAL_CORRECTIONS:
${evalHints}
`;
}

function mapParsed(
  parsed: {
    keep?: boolean;
    title?: string;
    who?: string | null;
    org?: string | null;
    subject?: string | null;
    due?: string | null;
    evidence_quote?: string;
    kind?: string;
    category?: string;
    tags?: string[];
    confidence?: number;
    not_task_reason?: string | null;
    audience?: string;
    topic?: string;
  },
  c: LoopCandidate,
): ExtractedLoopFields {
  return {
    keep: parsed.keep !== false,
    title: (parsed.title ?? c.title).trim(),
    who: parsed.who,
    org: parsed.org,
    subject: parsed.subject,
    due: parsed.due,
    evidenceQuote: parsed.evidence_quote,
    kind: parsed.kind ?? c.kind,
    category: parseCategory(parsed.category ?? c.category),
    tags:
      Array.isArray(parsed.tags) && parsed.tags.length > 0
        ? parsed.tags.map(String)
        : (c.tags ?? []),
    confidence: parsed.confidence ?? c.confidence,
    notTaskReason: parsed.not_task_reason,
    audience:
      parsed.audience === "me" ||
      parsed.audience === "other" ||
      parsed.audience === "neither"
        ? parsed.audience
        : undefined,
    topic:
      parsed.topic === "actionable" ||
      parsed.topic === "idle" ||
      parsed.topic === "market"
        ? parsed.topic
        : undefined,
  };
}

function applyFields(
  c: LoopCandidate,
  f: ExtractedLoopFields,
): ExtractResult {
  const tags = [...(f.tags ?? c.tags ?? [])];
  if (f.org && !tags.includes("org")) {
    /* keep tags as model set them */
  }
  const who =
    (f.who && f.who.trim()) ||
    (f.org && f.org.trim()) ||
    c.who ||
    undefined;
  // Fold subject into title if title is weak on topic — already validated
  let title = f.title;
  if (f.subject && f.subject.length > 3 && !title.toLowerCase().includes(f.subject.toLowerCase().slice(0, 12))) {
    // subject already should be in a good title; don't double-append
  }
  return {
    ...c,
    keep: f.keep,
    title,
    who,
    org: f.org ?? undefined,
    subjectTopic: f.subject ?? undefined,
    evidenceQuote: f.evidenceQuote ?? undefined,
    dueAt: f.due ?? c.dueAt ?? null,
    dueHint: f.dueHint ?? undefined,
    kind: (f.kind as LoopCandidate["kind"]) || c.kind,
    category: (f.category as string) ?? c.category,
    tags,
    confidence: f.confidence ?? c.confidence,
    audience: f.audience,
    topic: f.topic,
    description: f.evidenceQuote
      ? f.evidenceQuote.slice(0, 400)
      : c.description,
  };
}

/**
 * Extract + validate/repair one candidate. Returns keep:false on drop.
 */
export async function extractLoop(
  c: LoopCandidate,
  now: Date = new Date(),
): Promise<ExtractResult> {
  const blob = sourceBlob(c);
  if (looksLikeMarket(blob) || looksLikeMarket(c.title)) {
    return {
      ...c,
      keep: false,
      audience: "neither",
      topic: "market",
      confidence: 0.1,
    };
  }

  const prompt = buildExtractPrompt(c, now);
  const res = await runLlm({
    prompt,
    model: "smart",
    purpose: "loop_extract",
    skipHosted: true,
    temperature: 0,
    format: EXTRACT_SCHEMA,
  });

  if (res.provider === "stub") {
    return { ...c, keep: false };
  }

  const parsed = parseJsonFromText<{
    keep?: boolean;
    title?: string;
    who?: string | null;
    org?: string | null;
    subject?: string | null;
    due?: string | null;
    evidence_quote?: string;
    kind?: string;
    category?: string;
    tags?: string[];
    confidence?: number;
    not_task_reason?: string | null;
    audience?: string;
    topic?: string;
  }>(res.text);

  if (!parsed) {
    return { ...c, keep: false };
  }

  const fields = mapParsed(parsed, c);
  if (c.fromMe) {
    const cat = parseCategory(fields.category);
    if (cat === "reply" || cat === "career") fields.category = "follow_up";
  }
  if (c.source === "chat") {
    const forMe =
      fields.audience === "me" &&
      fields.topic === "actionable" &&
      fields.keep;
    if (!forMe && fields.keep) {
      // Model said keep but audience/topic contradict — drop
      if (fields.audience && fields.audience !== "me") fields.keep = false;
      if (fields.topic && fields.topic !== "actionable") fields.keep = false;
    }
  }

  const validated = await validateOrRepair(fields, blob);
  if (!validated) {
    return { ...c, keep: false };
  }
  const applied = applyFields(c, validated);
  if (c.source === "chat") {
    const classId = recordLearnClassify({
      ocr: blob,
      audience: applied.audience ?? "neither",
      topic: applied.topic ?? (applied.keep === false ? "idle" : "actionable"),
      keep: applied.keep !== false,
      title: applied.title,
      who: applied.who,
      observationId: applied.observationId,
    });
    if (classId) applied.learnEpisodeId = classId;
  }
  return applied;
}

/**
 * Extract a batch of candidates serially (queue is inside runLlm).
 */
export async function extractLoopCandidates(
  candidates: LoopCandidate[],
  now: Date = new Date(),
): Promise<ExtractResult[]> {
  const out: ExtractResult[] = [];
  for (const c of candidates) {
    out.push(await extractLoop(c, now));
  }
  return out;
}

export type { LoopCategory };
