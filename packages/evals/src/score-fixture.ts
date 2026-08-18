/**
 * Pure fixture scorer — mirrors collectLoopCandidates heuristics without DB.
 */
import {
  scoreTradingAction,
  isTradingSurface,
  classifyMailLoop,
} from "@second-brain/agents";

/** Copied from packages/agents/src/loops.ts */
const COMMITMENT_RE =
  /\b(i('ll| will)|let me|i can|i should|by (friday|monday|tuesday|wednesday|thursday|saturday|sunday|eod|eow|tomorrow)|waiting on|waiting for|can you|please (send|review|confirm|fix|update)|todo|follow[- ]?up|action item|i promised|need to|don't forget|please reply|looking for|suggest)\b/i;

/** Promo / newsletter noise — subset of core spam HARD_RE (no DB / user rules) */
const PROMO_RE =
  /\b(unsubscribe|email preferences|view in browser|manage (your )?preferences|one[- ]click unsubscribe|% off|\$\d+\s*off|limited[- ]time|flash sale|act now|buy now|shop now|free shipping|coupon code|promo code|newsletter|digest for you|weekly roundup|marketing@|mailer-daemon|bounce@|donotreply@|do-not-reply@|no[- ]?reply@|noreply@|notifications?@|reminder:\s*your (cart|bag)|complete your purchase|sponsored|advertisement|promote your|claim your)\b/i;

const BOT_AUTHOR_RE =
  /\[?(dependabot|renovate|github-actions|codecov|sonarcloud)\]?/i;

export type FixtureSource = "email" | "github" | "trading" | "ocr";
export type FixtureLabel = "is_loop" | "not_loop";

export type EvalFixture = {
  id: string;
  source: FixtureSource;
  label: FixtureLabel;
  expectedTitleContains?: string;
  input: {
    app?: string;
    windowTitle?: string;
    url?: string;
    text?: string;
    kind?: string;
    title?: string;
    body?: string;
    author?: string;
  };
};

export type ScoreResult = {
  predicted: boolean;
  confidence: number;
  title?: string;
};

function looksLikePromo(input: EvalFixture["input"]): boolean {
  const blob = [input.title, input.body, input.text, input.author, input.kind]
    .filter(Boolean)
    .join("\n");
  if (PROMO_RE.test(blob)) return true;
  if (BOT_AUTHOR_RE.test(`${input.author ?? ""} ${input.title ?? ""}`)) {
    return true;
  }
  const kind = (input.kind ?? "").toLowerCase();
  if (kind === "newsletter" || kind === "spam") return true;
  return false;
}

function scoreItemHeuristic(input: EvalFixture["input"]): ScoreResult {
  if (looksLikePromo(input)) {
    return { predicted: false, confidence: 0 };
  }

  const kind = (input.kind ?? "").toLowerCase();
  if (kind === "email" || kind === "notification" || kind === "pr" || kind === "issue") {
    const r = classifyMailLoop({
      subject: input.title ?? "",
      body: input.body ?? input.text,
      from: input.author,
      kind,
    });
    if (!r.keep) return { predicted: false, confidence: 0 };
    return { predicted: true, confidence: 0.6, title: r.title };
  }

  const body = `${input.title ?? ""}\n${input.body ?? input.text ?? ""}`;
  if (!COMMITMENT_RE.test(body)) {
    return { predicted: false, confidence: 0 };
  }

  return {
    predicted: true,
    confidence: 0.5,
    title: (input.title ?? "Follow up").slice(0, 160),
  };
}

/**
 * Score one fixture the same way L1 loop detection would (no LLM, no DB).
 */
export function scoreFixture(fixture: EvalFixture): ScoreResult {
  const { source, input } = fixture;
  const surface = {
    app: input.app,
    windowTitle: input.windowTitle,
    url: input.url,
    text: input.text ?? input.body ?? "",
  };

  if (source === "trading" || (source === "ocr" && isTradingSurface(surface))) {
    const hit = scoreTradingAction({
      ...surface,
      text: surface.text,
    });
    if (hit) {
      return {
        predicted: true,
        confidence: Math.min(0.95, hit.score),
        title: hit.actionTitle,
      };
    }
    if (source === "trading") {
      return { predicted: false, confidence: 0 };
    }
  }

  if (source === "email" || source === "github") {
    return scoreItemHeuristic({
      ...input,
      kind:
        input.kind ??
        (source === "github"
          ? /\bpr\b|pull request/i.test(`${input.title ?? ""} ${input.body ?? ""}`)
            ? "pr"
            : "issue"
          : "email"),
    });
  }

  // Generic OCR: not a loop source (memory / timeline only)
  if (source === "ocr") {
    return { predicted: false, confidence: 0 };
  }
  if (looksLikePromo(input)) {
    return { predicted: false, confidence: 0 };
  }
  const text = input.text ?? input.body ?? "";
  if (COMMITMENT_RE.test(text)) {
    return {
      predicted: true,
      confidence: 0.45,
      title: `Continue: ${(input.windowTitle || text).slice(0, 120)}`,
    };
  }
  return { predicted: false, confidence: 0 };
}
