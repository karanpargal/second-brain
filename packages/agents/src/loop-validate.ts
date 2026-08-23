/**
 * Deterministic validation + one LLM repair pass for extracted open loops.
 */
import { parseDueAt, parseDueHint } from "./due.js";
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

function sanitizeWho(who?: string | null): string | undefined {
  const s = normalizeWhitespace(who ?? "");
  if (s.length < 2 || s.length > 60) return undefined;
  // Role/thread strings belong in the title, not who
  if (/\b(senior|junior|engineer|bengaluru|bangalore|role|position|hiring)\b/i.test(s) && s.includes("/")) {
    return undefined;
  }
  if (/^(you|me|them|chat|this chat|header|whatsapp|telegram)$/i.test(s)) {
    return undefined;
  }
  return s;
}

function normalizeDue(
  due?: string | null,
  dueHint?: string | null,
  title?: string,
): { dueAt: string | null; dueHint: string | null } {
  const candidates = [due, dueHint].filter(Boolean) as string[];
  for (const c of candidates) {
    const trimmed = c.trim();
    if (!trimmed || /^(soon|asap|later|sometime|tbd|n\/?a)$/i.test(trimmed)) {
      continue;
    }
    // Already ISO
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed) && !Number.isNaN(Date.parse(trimmed))) {
      const iso = new Date(trimmed).toISOString();
      return { dueAt: iso, dueHint: null };
    }
    const fromHint = parseDueHint(trimmed);
    if (fromHint) return { dueAt: fromHint, dueHint: null };
    const fromText = parseDueAt(trimmed);
    if (fromText) return { dueAt: fromText, dueHint: null };
  }
  if (title) {
    const fromTitle = parseDueAt(title);
    if (fromTitle) return { dueAt: fromTitle, dueHint: null };
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
  const title = normalizeWhitespace(fields.title ?? "");
  const who = sanitizeWho(fields.who);
  const org = sanitizeWho(fields.org) ?? (fields.org?.trim() || undefined);
  const { dueAt, dueHint } = normalizeDue(fields.due, fields.dueHint, title);

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

Rules:
- title MUST name the person or company AND the concrete topic (4+ words).
  Good: "Follow up with Rivet hiring on the Senior Engineer role"
  Bad: "Check application status"
- who = person name only (not a job title string).
- org = company if known.
- due = absolute ISO date (YYYY-MM-DD) or null. Never "soon".
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
