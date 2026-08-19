/**
 * Live Ollama evals for STRUCTURE_LOOPS. Skipped when the model is a stub.
 */
import { parseJsonFromText, runLlm } from "@second-brain/agents";

export type AiGolden = {
  id: string;
  title: string;
  snippet: string;
  source?: "item" | "chat";
  fromMe?: boolean;
  categoryHint?: string;
  expectKeep: boolean;
  titleContains?: string;
  category?: string;
};

export const AI_GOLDENS: AiGolden[] = [
  {
    id: "ai-mail-review",
    title: "Can you review the Q3 hiring plan?",
    snippet: "Please review the attached doc and confirm by Friday. Thanks.",
    expectKeep: true,
    titleContains: "review",
    category: "reply",
  },
  {
    id: "ai-mail-promo",
    title: "Flash sale 50% off everything",
    snippet: "Shop now. Unsubscribe anytime. Limited time coupon code.",
    expectKeep: false,
  },
  {
    id: "ai-sent-job",
    title: "Interested in engineering at Rivet",
    snippet:
      "Hi, I'd love to work on Rust and actors at Rivet. Resume attached.",
    fromMe: true,
    categoryHint: "follow_up",
    expectKeep: true,
    titleContains: "rivet",
    category: "follow_up",
  },
  {
    id: "ai-close-out",
    title: "Re: engineering role",
    snippet:
      "Thanks for taking the time. I'd be happy to reconnect if something comes up. Wishing you all the best!",
    fromMe: true,
    expectKeep: false,
  },
  {
    id: "ai-ipo-fyi",
    title: "IPO allotment — shares allotted",
    snippet:
      "KFin Technologies: shares allotted, amount unblocked, over-subscription status.",
    expectKeep: false,
  },
  {
    id: "ai-dependabot",
    title: "[dependabot] bump lodash",
    snippet: "automated dependency update, no review requested from a human.",
    expectKeep: false,
  },
  {
    id: "ai-billing",
    title: "Stripe: payment failed",
    snippet: "Your card was declined. Update your payment method to keep service.",
    expectKeep: true,
    titleContains: "stripe",
    category: "billing",
  },
  {
    id: "ai-chat-ask",
    title: "Follow up with Farhan on WhatsApp",
    snippet: "Farhan: can you send the deck tonight? Type a message",
    source: "chat",
    expectKeep: true,
    titleContains: "farhan",
    category: "follow_up",
  },
  {
    id: "ai-chat-idle",
    title: "Follow up with Farhan on WhatsApp",
    snippet: "ok lol haha thanks Type a message",
    source: "chat",
    expectKeep: false,
  },
];

export type AiEvalReport = {
  skipped: boolean;
  reason?: string;
  n: number;
  ok: number;
  f1: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  misses: Array<{ id: string; note: string }>;
};

function emptyAi(skipped: boolean, reason?: string): AiEvalReport {
  return {
    skipped,
    reason,
    n: 0,
    ok: 0,
    f1: 0,
    tp: 0,
    fp: 0,
    fn: 0,
    tn: 0,
    misses: [],
  };
}

function f1From(tp: number, fp: number, fn: number): number {
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  return precision + recall === 0
    ? 0
    : (2 * precision * recall) / (precision + recall);
}

async function scoreOne(g: AiGolden): Promise<{
  provider: string;
  keep: boolean;
  title?: string;
  category?: string;
}> {
  const prompt = `STRUCTURE_LOOPS
You extract open loops — unfinished commitments the user should ACT on.
Return JSON only:
{"loops":[{"i":0,"title":"...","action":"...","kind":"promise|awaiting_reply|unfinished|decision|deadline","category":"follow_up|reply|billing|career|review|deadline|calendar|github|other","tags":[],"who":null,"dueHint":null,"confidence":0.0,"keep":true}]}

Rules:
- "title" MUST name the person/company AND the topic. Never a single verb.
- from_me:true means the USER SENT this. That is NEVER "reply". Use follow_up or keep:false.
- Close-outs (thanks / reconnect if something comes up / all the best) with no ask → keep:false.
- IPO allotment / registrar status is FYI, not billing. keep:false.
- Inbound billing / Stripe / failed payment → category billing, keep:true.
- Inbound mail that asks the user to respond → category reply.
- Drop spam, newsletters, marketing, bots (keep:false).
- Chat follow-ups from window titles: keep:true, category follow_up, tags ["chat"] when a named person.

Candidates:
${JSON.stringify(
    [
      {
        i: 0,
        title: g.title,
        kind_hint: "unfinished",
        category_hint: g.categoryHint ?? "other",
        from_me: Boolean(g.fromMe),
        who: null,
        snippet: g.snippet,
        source: g.source ?? "item",
      },
    ],
    null,
    0,
  )}
`;

  const res = await runLlm({
    prompt,
    model: "fast",
    purpose: "eval_structure_loops",
    skipHosted: true,
  });
  const parsed = parseJsonFromText<{
    loops: Array<{
      i?: number;
      keep?: boolean;
      title?: string;
      action?: string;
      category?: string;
    }>;
  }>(res.text);
  const loop = parsed?.loops?.[0];
  return {
    provider: res.provider,
    keep: Boolean(loop?.keep),
    title: loop?.action || loop?.title,
    category: loop?.category,
  };
}

export async function evaluateAiGoldens(): Promise<AiEvalReport> {
  const first = AI_GOLDENS[0];
  if (!first) return emptyAi(true, "no goldens");

  const probe = await scoreOne(first);
  if (probe.provider !== "ollama") {
    return emptyAi(true, `llm provider=${probe.provider}`);
  }

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let ok = 0;
  const misses: AiEvalReport["misses"] = [];

  const rest = AI_GOLDENS.slice(1);
  const rows = [{ g: first, scored: probe }];
  for (const g of rest) {
    rows.push({ g, scored: await scoreOne(g) });
  }

  for (const { g, scored } of rows) {
    if (scored.provider !== "ollama") {
      return emptyAi(true, `llm provider=${scored.provider}`);
    }
    const actual = g.expectKeep;
    const predicted = scored.keep;
    if (actual && predicted) tp++;
    else if (!actual && predicted) fp++;
    else if (!actual && !predicted) tn++;
    else fn++;

    let titleOk = true;
    if (
      predicted &&
      g.titleContains &&
      !(scored.title ?? "").toLowerCase().includes(g.titleContains.toLowerCase())
    ) {
      titleOk = false;
    }
    let catOk = true;
    if (predicted && g.category && scored.category && scored.category !== g.category) {
      catOk = false;
    }
    const rowOk = actual === predicted && titleOk && catOk;
    if (rowOk) ok++;
    else {
      const bits = [
        `keep want=${actual} got=${predicted}`,
        scored.title ? `title="${scored.title}"` : "",
        g.titleContains && !titleOk ? `missing "${g.titleContains}"` : "",
        !catOk ? `cat want=${g.category} got=${scored.category}` : "",
      ].filter(Boolean);
      misses.push({ id: g.id, note: bits.join("; ") });
    }
  }

  return {
    skipped: false,
    n: AI_GOLDENS.length,
    ok,
    f1: f1From(tp, fp, fn),
    tp,
    fp,
    fn,
    tn,
    misses,
  };
}
