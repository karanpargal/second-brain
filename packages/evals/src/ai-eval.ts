/**
 * Live Ollama evals for LOOP_EXTRACT. Skipped when the model is a stub.
 * Goldens include real DB failures (generic titles, market noise).
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
  /** Title must NOT contain these (generic junk) */
  titleAvoid?: string[];
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
    titleAvoid: ["check application status", "submit application or follow up"],
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
    titleAvoid: ["update billing information"],
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
  // Real DB failures — must not keep market chatter or emit banned titles
  {
    id: "ai-market-bull-run",
    title: "Conclude my bull run",
    snippet:
      "HEADER: Trading room\nYou: conclude my bull run tomorrow, take profit on the long",
    source: "chat",
    expectKeep: false,
  },
  {
    id: "ai-clanx-generic-seed",
    title: "Check application status",
    snippet:
      "Subject: CLANX/Senior AI Engineer - Bengaluru - Confirmation of your application\nThanks for applying to the Senior AI Engineer role at CLANX in Bengaluru. We received your application.",
    fromMe: false,
    categoryHint: "career",
    expectKeep: true,
    titleContains: "clanx",
    titleAvoid: ["check application status"],
  },
  {
    id: "ai-rivet-generic-seed",
    title: "Submit application or follow up",
    snippet:
      "Hi Rivet hiring, I'm interested in the engineering role. Resume attached. Looking forward to hearing from you.",
    fromMe: true,
    categoryHint: "follow_up",
    expectKeep: true,
    titleContains: "rivet",
    titleAvoid: ["submit application or follow up"],
  },
  {
    id: "ai-kling-billing",
    title: "update billing information",
    snippet:
      "From: Kling AI <billing@kling.ai>\nYour payment method failed. Please update billing information for Kling AI to avoid interruption.",
    expectKeep: true,
    titleContains: "kling",
    category: "billing",
    titleAvoid: ["update billing information"],
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
  const isChat = g.source === "chat";
  const prompt = `LOOP_EXTRACT
You extract ONE open loop — an unfinished commitment the user should ACT on.
Return JSON only:
{"keep":true,"title":"...","who":null,"org":null,"subject":null,"due":null,"evidence_quote":"...","kind":"unfinished","category":"follow_up","tags":[],"confidence":0.8,"not_task_reason":null${isChat ? ',"audience":"me","topic":"actionable"' : ""}}

Rules:
- title MUST name the person/company AND the topic. 4+ words.
  Bad: "Check application status", "Submit application or follow up", "update billing information"
- evidence_quote must be copied from SOURCE TEXT.
- from_me:true is NEVER category "reply". Use follow_up or keep:false.
- Market/trading (bull run, PnL, long/short) → keep:false.
- Idle chat → keep:false.
- Close-outs with no ask → keep:false.

from_me: ${Boolean(g.fromMe)}
seed_title: ${JSON.stringify(g.title)}
category_hint: ${g.categoryHint ?? "other"}
source: ${g.source ?? "item"}

SOURCE TEXT:
${g.snippet}
`;

  const res = await runLlm({
    prompt,
    model: "smart",
    purpose: "eval_structure_loops",
    skipHosted: true,
    temperature: 0,
    format: "json",
  });
  const parsed = parseJsonFromText<{
    keep?: boolean;
    title?: string;
    category?: string;
    loops?: Array<{ keep?: boolean; title?: string; category?: string }>;
  }>(res.text);
  // Support both LOOP_EXTRACT object and legacy {loops:[...]} shape
  const loop = parsed?.loops?.[0] ?? parsed;
  return {
    provider: res.provider,
    keep: Boolean(loop?.keep),
    title: loop?.title,
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
    const titleL = (scored.title ?? "").toLowerCase();
    if (
      predicted &&
      g.titleContains &&
      !titleL.includes(g.titleContains.toLowerCase())
    ) {
      titleOk = false;
    }
    if (predicted && g.titleAvoid) {
      for (const avoid of g.titleAvoid) {
        if (titleL === avoid.toLowerCase() || titleL.includes(avoid.toLowerCase())) {
          titleOk = false;
        }
      }
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
        g.titleAvoid && !titleOk ? `hit banned title` : "",
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
