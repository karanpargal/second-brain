/**
 * Classify-then-card layer over noisy chat OCR (local Ollama only).
 * 1) Whose action is this — me, someone else, or neither (idle/market)?
 * 2) Only if it is for me, write a short card title.
 */
import {
  learnGraphFewShot,
  looksLikeMarket,
  recordLearnClassify,
  type ChatAudience,
  type ChatTopic,
} from "@second-brain/core";
import { parseDueAt, parseDueHint } from "./due.js";
import { parseJsonFromText, runLlm } from "./llm.js";
import type { LoopCandidate } from "./loops.js";

export type ChatPolishLoop = {
  i: number;
  keep: boolean;
  audience?: ChatAudience;
  topic?: ChatTopic;
  title?: string;
  who?: string | null;
  dueHint?: string | null;
  reason?: string;
};

export function chatDateContext(now: Date = new Date()): {
  todayDmy: string;
  tomorrowDmy: string;
  weekday: string;
} {
  const fmt = (d: Date) =>
    `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
  const tmr = new Date(now);
  tmr.setDate(tmr.getDate() + 1);
  return {
    todayDmy: fmt(now),
    tomorrowDmy: fmt(tmr),
    weekday: now.toLocaleDateString("en-IN", { weekday: "long" }),
  };
}

export function headerFromOcr(ocr: string): string {
  return (ocr.match(/^HEADER:\s*(.+)$/im)?.[1] ?? "").trim();
}

export function heuristicChatClass(
  ocr: string,
  fromMe?: boolean,
): { audience: ChatAudience; topic: ChatTopic; keep: boolean } {
  if (looksLikeMarket(ocr)) {
    return { audience: "neither", topic: "market", keep: false };
  }
  const youLine = /\byou:\s/i.test(ocr) || Boolean(fromMe);
  const askOfMe =
    /\b(can you|could you|would you|please (send|share|call|confirm)|need you to|remind me)\b/i.test(
      ocr,
    );
  const myPromise = /\b(i('ll| will)|i send the|let me (send|share))\b/i.test(ocr);
  if (youLine && (myPromise || askOfMe)) {
    return { audience: "me", topic: "actionable", keep: true };
  }
  if (askOfMe) {
    return { audience: "me", topic: "actionable", keep: true };
  }
  if (myPromise && !youLine) {
    return { audience: "other", topic: "actionable", keep: false };
  }
  return { audience: "neither", topic: "idle", keep: false };
}

export function buildChatPolishPrompt(
  rows: Array<{
    i: number;
    app?: string;
    fromMe?: boolean;
    who?: string | null;
    ocr: string;
  }>,
  now: Date = new Date(),
): string {
  const { todayDmy, tomorrowDmy, weekday } = chatDateContext(now);
  const payload = rows.map((r) => ({
    i: r.i,
    app: r.app ?? "chat",
    outgoing_you_prefix: /\byou:\s/i.test(r.ocr) || Boolean(r.fromMe),
    contact: r.who ?? null,
    header: headerFromOcr(r.ocr) || null,
    ocr: r.ocr.slice(0, 700),
  }));
  const learned = learnGraphFewShot();
  return `CLASSIFY_CHAT_OCR
Today is ${weekday} ${todayDmy}. Tomorrow is ${tomorrowDmy}.
You read noisy screen-OCR from WhatsApp/Telegram/Slack. Never send. Local only.

Do this IN ORDER for each item:
1) CLASSIFY audience: me | other | neither
   - me = the USER must act (their own promise, or an ask aimed at them).
   - other = someone else must act (their promise, their trade, their chore).
   - neither = idle chat, stickers, or market/trading tape (PnL, long/short, fills, margin).
2) CLASSIFY topic: actionable | idle | market
3) CARD only if audience=me AND topic=actionable. Otherwise keep=false and omit a title.

WhatsApp "You:" / outgoing_you_prefix=true is the USER. Incoming "I will…" is the other person.

Return JSON only:
{"loops":[{"i":0,"audience":"me","topic":"actionable","keep":true,"title":"Share the revenue details to Wini by ${tomorrowDmy}","who":"Wini","dueHint":"${tomorrowDmy}","reason":"user promised"}]}

Card title rules (only when keep=true):
- Fix OCR: tonwrrow→tomorrow, paymen→payment.
- HEADER/contact is the person. "to you" means that person.
- Verb + topic + to <Name> + by <D/M/YYYY>. No bubble clocks (11:58am).
  Good: "Share the revenue details to Wini by ${tomorrowDmy}"
  Bad: "Share the revenue details to you by tonwrrow"

Drop (keep=false): ok/lol/thanks, group noise, PnL/orders/charts, other people's todos.

LEARNED_MISSES (do not repeat; especially market cards):
${learned}

Input:
${JSON.stringify(payload)}
`;
}

export function parseChatPolishResponse(text: string): ChatPolishLoop[] {
  const parsed = parseJsonFromText<{ loops?: ChatPolishLoop[] }>(text);
  if (!Array.isArray(parsed?.loops)) return [];
  return parsed.loops.filter((x) => typeof x?.i === "number");
}

function saneTitle(t: string): string | null {
  const s = t.replace(/\s+/g, " ").trim();
  if (s.length < 8 || s.length > 100) return null;
  if (/tonwrrow|tornorrow|N"\s*v"|bi["']/i.test(s)) return null;
  if (/^(ok+|lol+|thanks?|type a message)$/i.test(s)) return null;
  if (looksLikeMarket(s)) return null;
  return s;
}

function saneWho(w: string | null | undefined): string | undefined {
  const s = (w ?? "").replace(/\s+/g, " ").trim();
  if (s.length < 2 || s.length > 40) return undefined;
  if (/^(you|me|whatsapp|telegram|chat|this chat|header)$/i.test(s)) {
    return undefined;
  }
  return s;
}

function normalizeAudience(v: unknown): ChatAudience | undefined {
  if (v === "me" || v === "other" || v === "neither") return v;
  return undefined;
}

function normalizeTopic(v: unknown): ChatTopic | undefined {
  if (v === "actionable" || v === "idle" || v === "market") return v;
  return undefined;
}

export function applyChatPolish(
  c: LoopCandidate,
  p: ChatPolishLoop | undefined,
  now: Date = new Date(),
): LoopCandidate {
  const ocr = c.ocrText || c.snippet || c.title;
  if (looksLikeMarket(ocr)) {
    return { ...c, keep: false, audience: "neither", topic: "market" };
  }
  if (!p) {
    const h = heuristicChatClass(ocr, c.fromMe);
    return {
      ...c,
      keep: h.keep,
      audience: h.audience,
      topic: h.topic,
    };
  }
  const audience =
    normalizeAudience(p.audience) ??
    (p.keep === false ? "neither" : "me");
  const topic =
    normalizeTopic(p.topic) ??
    (looksLikeMarket(ocr) ? "market" : p.keep === false ? "idle" : "actionable");
  const forMe = audience === "me" && topic === "actionable" && p.keep !== false;
  if (!forMe) {
    return {
      ...c,
      keep: false,
      audience,
      topic,
    };
  }
  const title = p.title ? saneTitle(p.title) : null;
  const who = saneWho(p.who) ?? c.who;
  const dueHint = (p.dueHint ?? "").trim() || undefined;
  const dueAt =
    (dueHint ? parseDueHint(dueHint, now) : null) ??
    (title ? parseDueAt(title, now) : null) ??
    c.dueAt ??
    null;
  return {
    ...c,
    keep: true,
    audience,
    topic,
    title: title ?? c.title,
    who,
    dueHint: dueHint || c.dueHint,
    dueAt,
    confidence: Math.max(c.confidence, 0.82),
    description: title ?? c.description,
  };
}

/**
 * One local Ollama call: classify then card. Heuristic if the model is stub/down.
 */
export async function polishChatCandidates(
  candidates: LoopCandidate[],
  now: Date = new Date(),
): Promise<LoopCandidate[]> {
  if (candidates.length === 0) return candidates;
  const batch = candidates.slice(0, 8);
  const prompt = buildChatPolishPrompt(
    batch.map((c, i) => ({
      i,
      app: c.tags?.find((t) => t !== "chat"),
      fromMe: c.fromMe,
      who: c.who ?? null,
      ocr: c.ocrText || c.snippet || c.title,
    })),
    now,
  );
  const res = await runLlm({
    prompt,
    model: "fast",
    purpose: "polish_chat",
    skipHosted: true,
  });
  const loops =
    res.provider === "stub" ? [] : parseChatPolishResponse(res.text);

  return candidates.map((c, i) => {
    if (i >= batch.length) return c;
    const p = loops.find((x) => x.i === i);
    const next = applyChatPolish(c, p, now);
    const ocr = next.ocrText || next.snippet || next.title;
    const classId = recordLearnClassify({
      ocr,
      audience: next.audience ?? "neither",
      topic: next.topic ?? (next.keep === false ? "idle" : "actionable"),
      keep: next.keep !== false,
      title: next.title,
      who: next.who,
      observationId: next.observationId,
    });
    return { ...next, learnEpisodeId: classId ?? undefined };
  });
}
