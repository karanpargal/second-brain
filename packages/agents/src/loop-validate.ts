/**
 * Deterministic validation + one LLM repair pass for extracted open loops.
 */
import { isSelfName } from "@second-brain/core";
import { parseDueAt, parseDueHint, startOfLocalDay } from "./due.js";
import { parseJsonFromText, runLlm } from "./llm.js";
import type { LoopCategory } from "./categories.js";

/** Titles that looked fine to the model but carry no actionable info. */
export const BANNED_GENERIC_TITLES = [
  "check application status",
  "submit application or follow up",
  "respond to invitation",
  "update billing information",
  "submit profile for review",
  "update billing",
  "follow up",
  "reply",
  "check status",
  "send follow-up",
  "follow up email",
];

export type ExtractedLoopFields = {
  title: string;
  who?: string | null;
  org?: string | null;
  subject?: string | null;
  due?: string | null;
  dueHint?: string | null;
  evidenceQuote?: string | null;
  keep: boolean;
  kind?: string;
  category?: LoopCategory | string;
  tags?: string[];
  confidence?: number;
  notTaskReason?: string | null;
  audience?: "me" | "other" | "neither";
  topic?: "actionable" | "idle" | "market";
  /** Who wrote the source line. Set from the capture, not from the model. */
  direction?: "from_me" | "from_them" | "unknown";
  /** Lowercased names belonging to the user. */
  selfNames?: string[];
};

export type ValidateResult = {
  ok: boolean;
  errors: string[];
  /** Normalised fields (due as ISO or null, cleaned who, etc.) */
  fields: ExtractedLoopFields;
};

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function hasProperNounOrEntity(
  title: string,
  who?: string | null,
  org?: string | null,
): boolean {
  const t = title;
  if (who && who.length >= 2 && t.toLowerCase().includes(who.toLowerCase())) {
    return true;
  }
  if (org && org.length >= 2 && t.toLowerCase().includes(org.toLowerCase())) {
    return true;
  }
  // Capitalised word that is not the first word of a sentence-start verb phrase
  const words = t.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const w = words[i].replace(/[^A-Za-z0-9]/g, "");
    if (w.length < 2) continue;
    if (/^[A-Z][a-z]+/.test(w) || /^[A-Z]{2,}$/.test(w)) {
      // Skip leading verbs like "Send", "Follow", "Reply", "Update", "Check"
      if (
        i === 0 &&
        /^(Send|Follow|Reply|Update|Check|Submit|Respond|Review|Share|Call|Confirm|Work)$/i.test(
          w,
        )
      ) {
        continue;
      }
      return true;
    }
  }
  return false;
}

/** Browser, app and tab chrome that a window title can smuggle into a title. */
export const CHROME_IN_TITLE_RE =
  /\b(google chrome|chromium|microsoft edge|mozilla firefox|telegram web|whatsapp web|new chats|memory usage)\b/i;

function isOcrGarbageTitle(title: string): boolean {
  const q = (title.match(/["']/g) ?? []).length;
  if (q >= 2) return true;
  if (/N"\s*v"|bi["']|tonwrrow|tornorrow|ton-xyrow/i.test(title)) return true;
  if (/\bto you\b/i.test(title)) return true;
  if (/\d{1,2}:\d{2}\s*[ap]m/i.test(title)) return true;
  return false;
}

function isBannedGeneric(title: string): boolean {
  const norm = title.toLowerCase().replace(/[.!?]+$/, "").trim();
  return BANNED_GENERIC_TITLES.some((b) => {
    // Short seeds like "follow up" / "reply" only match exact title
    if (b.split(/\s+/).length <= 2) return norm === b;
    return (
      norm === b ||
      norm.startsWith(`${b} `) ||
      norm.endsWith(` ${b}`)
    );
  });
}

function quoteInSource(quote: string, source: string): boolean {
  const q = normalizeWhitespace(quote).toLowerCase();
  const s = normalizeWhitespace(source).toLowerCase();
  if (q.length < 8) return false;
  if (s.includes(q)) return true;
  // Allow soft match: first 40 chars of quote
  const head = q.slice(0, Math.min(40, q.length));
  return head.length >= 8 && s.includes(head);
}

function sanitizeWho(
  who?: string | null,
  selfNames: string[] = [],
): string | undefined {
  const s = normalizeWhitespace(who ?? "");
  if (s.length < 2 || s.length > 60) return undefined;
  // Role/thread strings belong in the title, not who
  if (/\b(senior|junior|engineer|bengaluru|bangalore|role|position|hiring)\b/i.test(s) && s.includes("/")) {
    return undefined;
  }
  if (
    /^(you|me|them|chat|this chat|header|whatsapp|telegram|whatsapp web|telegram web|new chats|google chrome|chrome|microsoft edge|firefox|safari)$/i.test(
      s,
    )
  ) {
    return undefined;
  }
  // The Chrome profile name in a window title is the user, not the contact.
  if (isSelfName(s, selfNames)) return undefined;
  return s;
}

/**
 * A chat capture prints each message's own send time beside it
 * ("4 September 2026, 21:54:39"). Copied into `due`, that reads as a deadline
 * of the moment the message was sent.
 */
function isSendTimestamp(iso: string, sourceText?: string): boolean {
  if (!sourceText) return false;
  const d = new Date(Date.parse(iso));
  if (Number.isNaN(d.getTime())) return false;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  if (hh === "12" && mm === "00" && ss === "00") return false; // our own local noon
  return sourceText.includes(`${hh}:${mm}:${ss}`) || sourceText.includes(`${hh}:${mm}`);
}

function normalizeDue(
  due?: string | null,
  dueHint?: string | null,
  title?: string,
  now: Date = new Date(),
  sourceText?: string,
): { dueAt: string | null; dueHint: string | null } {
  /**
   * Models misread day-first dates: told "tomorrow is 5/9/2026" they answer
   * 2026-05-09, which lands in the past and renders as "Overdue by 118 days".
   * When the text says tomorrow/today but the model's date is already behind
   * us, trust the relative word over the model's arithmetic. The title is not
   * enough — the model is told to write dates into it, so the relative word
   * usually survives only in the source.
   */
  const relativeRescue = (iso: string): string | null => {
    if (Date.parse(iso) >= startOfLocalDay(now).getTime()) return iso;
    return (
      (title ? parseDueAt(title, now, { relativeOnly: true }) : null) ??
      (sourceText ? parseDueAt(sourceText, now, { relativeOnly: true }) : null) ??
      (title ? parseDueHint(title, now) : null) ??
      iso
    );
  };
  const accept = (iso: string): { dueAt: string | null; dueHint: null } => {
    if (isSendTimestamp(iso, sourceText)) return { dueAt: null, dueHint: null };
    return { dueAt: relativeRescue(iso), dueHint: null };
  };

  const candidates = [due, dueHint].filter(Boolean) as string[];
  for (const c of candidates) {
    const trimmed = c.trim();
    if (!trimmed || /^(soon|asap|later|sometime|tbd|n\/?a)$/i.test(trimmed)) {
      continue;
    }
    // Already ISO. A bare date is local noon, matching every other writer here —
    // `new Date("2026-09-05")` is UTC midnight and renders a day early west of UTC.
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed) && !Number.isNaN(Date.parse(trimmed))) {
      const stamped = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
        ? `${trimmed}T12:00:00`
        : trimmed;
      return accept(new Date(Date.parse(stamped)).toISOString());
    }
    const fromHint = parseDueHint(trimmed, now);
    if (fromHint) return accept(fromHint);
    const fromText = parseDueAt(trimmed, now);
    if (fromText) return accept(fromText);
  }
  if (title) {
    const fromTitle = parseDueAt(title, now);
    if (fromTitle) return accept(fromTitle);
  }
  return { dueAt: null, dueHint: null };
}

/**
 * Validate extracted loop fields against source text.
 */
export function validateExtractedLoop(
  fields: ExtractedLoopFields,
  sourceText: string,
): ValidateResult {
  const errors: string[] = [];
  const selfNames = fields.selfNames ?? [];
  const title = normalizeWhitespace(fields.title ?? "");
  const who = sanitizeWho(fields.who, selfNames);
  const org =
    sanitizeWho(fields.org, selfNames) ?? (fields.org?.trim() || undefined);
  const { dueAt, dueHint } = normalizeDue(
    fields.due,
    fields.dueHint,
    title,
    new Date(),
    sourceText,
  );

  const next: ExtractedLoopFields = {
    ...fields,
    title,
    who: who ?? null,
    org: org ?? null,
    due: dueAt,
    dueHint,
    evidenceQuote: fields.evidenceQuote
      ? normalizeWhitespace(fields.evidenceQuote)
      : null,
  };

  if (!fields.keep) {
    return { ok: true, errors: [], fields: next };
  }

  if (title.length < 12) {
    errors.push("title too short — must name person/company AND topic");
  }
  const words = title.split(/\s+/).filter(Boolean);
  if (words.length < 4) {
    errors.push("title needs at least 4 words (person/company + topic)");
  }
  if (isBannedGeneric(title)) {
    errors.push(
      `title is banned generic phrase "${title}" — rewrite with company/person and concrete topic`,
    );
  }
  if (isOcrGarbageTitle(title)) {
    errors.push("title looks like OCR garbage (quotes, to you, bubble clocks)");
  }
  if (!hasProperNounOrEntity(title, who, org)) {
    errors.push(
      "title must include a capitalised person/company name (or who/org)",
    );
  }
  if (fields.direction === "from_me" && /^follow up with /i.test(title)) {
    errors.push(
      'the user wrote this line, so they owe it — title must be an imperative ("Send <person> the ..."), not "Follow up with <person>"',
    );
  }
  if (CHROME_IN_TITLE_RE.test(title)) {
    errors.push(
      "title names a browser, app or tab instead of a person — use the contact from the thread",
    );
  }
  if (fields.who && isSelfName(fields.who, selfNames)) {
    errors.push(
      `"${fields.who}" is the user, not the other party — who must be the contact or null`,
    );
  }
  if (fields.evidenceQuote) {
    if (!quoteInSource(fields.evidenceQuote, sourceText)) {
      errors.push("evidence_quote not found in source text");
    }
  } else {
    errors.push("missing evidence_quote copied verbatim from source");
  }
  // Vague due strings already nulled; "soon" etc. are errors if still present
  if (fields.dueHint && /^(soon|asap|later)$/i.test(fields.dueHint.trim())) {
    errors.push('due must be a real date or null — not "soon"');
  }

  return { ok: errors.length === 0, errors, fields: next };
}

export function isWeakLoopTitle(
  title: string,
  who?: string | null,
  org?: string | null,
): boolean {
  const t = normalizeWhitespace(title);
  if (t.length < 12) return true;
  if (t.split(/\s+/).length < 4) return true;
  if (isBannedGeneric(t)) return true;
  if (isOcrGarbageTitle(t)) return true;
  if (CHROME_IN_TITLE_RE.test(t)) return true;
  if (!hasProperNounOrEntity(t, who, org)) return true;
  return false;
}

const REPAIR_SCHEMA = {
  type: "object",
  properties: {
    keep: { type: "boolean" },
    title: { type: "string" },
    who: { type: ["string", "null"] },
    org: { type: ["string", "null"] },
    subject: { type: ["string", "null"] },
    due: { type: ["string", "null"] },
    evidence_quote: { type: "string" },
    kind: { type: "string" },
    category: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
    not_task_reason: { type: ["string", "null"] },
  },
  required: ["keep", "title"],
};

/**
 * One repair call when validation fails. Returns null on stub/parse failure.
 */
export async function repairExtractedLoop(
  fields: ExtractedLoopFields,
  sourceText: string,
  errors: string[],
): Promise<ExtractedLoopFields | null> {
  const prompt = `LOOP_REPAIR
Your previous extraction failed validation. Fix it.

Failures:
${errors.map((e) => `- ${e}`).join("\n")}

Previous JSON:
${JSON.stringify({
  keep: fields.keep,
  title: fields.title,
  who: fields.who,
  org: fields.org,
  subject: fields.subject,
  due: fields.due,
  evidence_quote: fields.evidenceQuote,
  kind: fields.kind,
  category: fields.category,
  tags: fields.tags,
  confidence: fields.confidence,
})}

Source (verbatim):
${sourceText.slice(0, 2500)}

direction: ${fields.direction ?? "unknown"}

Rules:
- title MUST name the person or company AND the concrete topic (4+ words).
  Good: "Follow up with Rivet hiring on the Senior Engineer role"
  Bad: "Check application status"
- direction=from_me — the USER wrote the line, so the USER owes it. Write an
  imperative naming the other person ("Send Wini the revenue deck").
  NEVER "Follow up with <person>".
- direction=from_them — they owe it: "Follow up with <person> on <what they owe>".
- direction=unknown — do not guess. Write a neutral imperative or keep=false.
- who = the other party's name only (not a job title string). It is NEVER the
  user, and never a browser, app or tab name ("Google Chrome", "Telegram Web").
- org = company if known.
- due = absolute ISO date (YYYY-MM-DD) or null. Never "soon". A message's own
  send time ("4 September 2026, 21:54:39", "09:54 PM") is not a deadline.
- evidence_quote = short verbatim substring from Source.
- If this is not a real task (market chatter, spam, courtesy close-out), keep=false.

Return JSON only.`;

  const res = await runLlm({
    prompt,
    model: "smart",
    purpose: "loop_repair",
    skipHosted: true,
    temperature: 0,
    format: REPAIR_SCHEMA,
  });
  if (res.provider === "stub") return null;
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
  }>(res.text);
  if (!parsed || typeof parsed.title !== "string") return null;
  return {
    title: parsed.title,
    who: parsed.who,
    org: parsed.org,
    subject: parsed.subject,
    due: parsed.due,
    evidenceQuote: parsed.evidence_quote,
    keep: parsed.keep !== false,
    kind: parsed.kind,
    category: parsed.category,
    tags: parsed.tags,
    confidence: parsed.confidence,
    notTaskReason: parsed.not_task_reason,
    // Direction and self names come from the capture, not the model — carry
    // them through so the second validation applies the same rules.
    direction: fields.direction,
    selfNames: fields.selfNames,
    audience: fields.audience,
    topic: fields.topic,
  };
}

/**
 * Validate; if fail, repair once and re-validate. Drops if still invalid.
 */
export async function validateOrRepair(
  fields: ExtractedLoopFields,
  sourceText: string,
): Promise<ExtractedLoopFields | null> {
  let first = validateExtractedLoop(fields, sourceText);
  if (first.ok) return first.fields;
  if (!fields.keep) return first.fields;

  const repaired = await repairExtractedLoop(fields, sourceText, first.errors);
  if (!repaired) return null;
  const second = validateExtractedLoop(repaired, sourceText);
  if (second.ok) return second.fields;
  if (!repaired.keep) return second.fields;
  // Still weak after repair — drop
  return null;
}
