/**
 * Local-Ollama rewrite of noisy chat OCR into a short action title.
 * Never hosted. Heuristic title stays if the model is down or returns junk.
 */
import { parseDueAt, parseDueHint } from "./due.js";
import { parseJsonFromText, runLlm } from "./llm.js";
import type { LoopCandidate } from "./loops.js";

export type ChatPolishLoop = {
  i: number;
  keep: boolean;
  title?: string;
  who?: string | null;
  dueHint?: string | null;
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
    from_me: Boolean(r.fromMe),
    contact: r.who ?? null,
    header: headerFromOcr(r.ocr) || null,
    ocr: r.ocr.slice(0, 700),
  }));
  return `POLISH_CHAT_OCR
Today is ${weekday} ${todayDmy}. Tomorrow is ${tomorrowDmy}.
You clean noisy screen-OCR from WhatsApp/Telegram into one open-loop card.
Never send a message. Local only.

Return JSON only:
{"loops":[{"i":0,"keep":true,"title":"Share the revenue details to Wini by ${tomorrowDmy}","who":"Wini","dueHint":"${tomorrowDmy}"}]}

Rules:
- OCR misspellings: tonwrrow/tornorrow/tommorow → tomorrow, paymen → payment, wod → good.
- HEADER / contact is the person at the top of the chat. Use that name. "to you" / "You" means that person, not the word you.
- Title: short action, 8–90 chars. Verb + topic + to <Name> + by <D/M/YYYY>.
  Good: "Share the revenue details to Wini by ${tomorrowDmy}"
  Bad: "Share the revenue details to you by tonwrrow 11:58am"
- Resolve tomorrow/today/tonight/Friday to D/M/YYYY using the dates above. dueHint is that same date.
- Drop clock times from bubbles (11:58am). They are not due dates.
- from_me:true is the user's own promise — keep:true. Do not drop it.
- Idle chat (ok, lol, thanks, stickers) → keep:false.
- who is the contact given, or parsed from HEADER, never "you" / "WhatsApp".

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

export function applyChatPolish(
  c: LoopCandidate,
  p: ChatPolishLoop | undefined,
  now: Date = new Date(),
): LoopCandidate {
  if (!p) return c;
  if (p.keep === false && !c.fromMe) {
    return { ...c, keep: false };
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
    title: title ?? c.title,
    who,
    dueHint: dueHint || c.dueHint,
    dueAt,
    confidence: Math.max(c.confidence, 0.82),
    description: title ?? c.description,
  };
}

/**
 * One local Ollama call for a batch of chat loops. No-op if the model is stub/down.
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
  if (res.provider === "stub") return candidates;
  const loops = parseChatPolishResponse(res.text);
  if (loops.length === 0) return candidates;
  return candidates.map((c, i) => {
    if (i >= batch.length) return c;
    const p = loops.find((x) => x.i === i);
    return applyChatPolish(c, p, now);
  });
}
