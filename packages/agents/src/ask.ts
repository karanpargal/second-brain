import { runLlm } from "./llm.js";
import { getUserProfile } from "./feedback.js";
import { retrieveMemory } from "@second-brain/enrich";
import {
  getDb,
  openLoops,
  artifacts,
  activityBlocks,
  memoryChunks,
  askSessions,
  askTurns,
  newId,
  config,
} from "@second-brain/core";
import { eq } from "drizzle-orm";

import { hostedLlmStatus } from "./hosted-llm.js";

const ASK_SYSTEM =
  "You are a warm, concise personal assistant speaking out loud to a friend. " +
  "Answer in 2 to 4 short spoken sentences. Sound natural and helpful, not like a report. " +
  "Say First, Second, Third if you list steps — never markdown, never bullet characters, never URLs. " +
  "Do not mention context, models, or that you are reasoning. Do not start with We need to. " +
  "If they ask what to do today, pick the three most useful next steps and say them conversationally.";

function looksLikeScratchpad(text: string): boolean {
  const t = text.trim();
  if (!t || t === "(empty response)") return true;
  if (
    /^(we need to|let's think|let us think|the user (asked|wants)|i need to (answer|figure)|first,? i should|step \d)/i.test(
      t,
    )
  ) {
    return true;
  }
  if (/\buse (only )?(the )?context\b/i.test(t) && /\b(open loops?|we need to)\b/i.test(t)) {
    return true;
  }
  if (/\bprovide top \d+\b/i.test(t) && /\bconcrete next actions\b/i.test(t)) {
    return true;
  }
  return false;
}

/** Prefer an explicit final-answer suffix; drop chain-of-thought. */
function finalizeAskAnswer(text: string): string | null {
  let t = text.trim();
  if (!t || t === "(empty response)") return null;
  const marked = t.match(
    /(?:final answer|answer|here(?:'s| is) what to do)\s*[:\-]\s*([\s\S]+)$/i,
  );
  if (marked?.[1]) t = marked[1].trim();
  if (looksLikeScratchpad(t)) return null;
  return t;
}

/** Make the answer easy to hear: no markdown, no links, spoken list words. */
export function forListening(text: string): string {
  let t = text
    .replace(/\*\*/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/`+/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/^\s*(\d+)[.)]\s+/gm, (_, n: string) => {
      const words = ["First, ", "Second, ", "Third, ", "Fourth, "];
      const i = Number(n) - 1;
      return words[i] ?? "";
    })
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 95) {
    t = words.slice(0, 95).join(" ");
    const last = Math.max(t.lastIndexOf("."), t.lastIndexOf("!"), t.lastIndexOf("?"));
    if (last > 50) t = t.slice(0, last + 1);
  }
  return t;
}

const HISTORY_LIMIT = 12;

export type AskSource = { text: string; score: number };

export type AskResult = {
  answer: string;
  sources: AskSource[];
  sessionId: string;
};

export type AskTurn = { role: "user" | "assistant"; text: string };

export type AskContextInput = {
  question: string;
  memory: Array<{
    score: number;
    kind: string;
    text: string;
    ts: string | null;
  }>;
  openLoops: Array<{
    title: string;
    kind: string | null;
    who: string | null;
    due: string | null;
  }>;
  recentArtifacts: Array<{
    title: string;
    kind: string | null;
    lastTouchedAt: string;
  }>;
  todayTimeline: Array<{
    app: string | null;
    title: string | null;
    startAt: string;
    endAt: string;
  }>;
  whereLeftOff: Array<{
    title: string;
    kind: string | null;
    lastTouchedAt: string;
    openLoopTitles: string[];
  }>;
  profile: {
    role: string | null;
    goals: string[];
  };
  recentTurns: AskTurn[];
};

/** Pure helper — builds the CONTEXT object the LLM sees (testable). */
export function buildAskContext(input: AskContextInput): Record<string, unknown> {
  return {
    memory: input.memory,
    openLoops: input.openLoops,
    recentArtifacts: input.recentArtifacts,
    todayTimeline: input.todayTimeline,
    whereLeftOff: input.whereLeftOff,
    profile: input.profile,
    recentTurns: input.recentTurns,
  };
}

function ensureSession(sessionId?: string | null): string {
  const db = getDb();
  const now = new Date().toISOString();
  if (sessionId) {
    const existing = db
      .select()
      .from(askSessions)
      .where(eq(askSessions.id, sessionId))
      .get();
    if (existing) {
      db.update(askSessions)
        .set({ updatedAt: now })
        .where(eq(askSessions.id, sessionId))
        .run();
      return sessionId;
    }
  }
  const id = sessionId?.trim() || newId();
  db.insert(askSessions)
    .values({ id, createdAt: now, updatedAt: now })
    .run();
  return id;
}

function loadRecentTurns(sessionId: string, limit = HISTORY_LIMIT): AskTurn[] {
  const rows = getDb()
    .select()
    .from(askTurns)
    .where(eq(askTurns.sessionId, sessionId))
    .all()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return rows.slice(-limit).map((r) => ({
    role: r.role === "assistant" ? ("assistant" as const) : ("user" as const),
    text: r.text.slice(0, 800),
  }));
}

function appendTurn(sessionId: string, role: "user" | "assistant", text: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.insert(askTurns)
    .values({
      id: newId(),
      sessionId,
      role,
      text: text.slice(0, 8000),
      createdAt: now,
    })
    .run();
  db.update(askSessions)
    .set({ updatedAt: now })
    .where(eq(askSessions.id, sessionId))
    .run();
}

function persistAskMemory(sessionId: string, question: string, answer: string): void {
  const ts = new Date().toISOString();
  const text = `Q: ${question.slice(0, 1500)}\nA: ${answer.slice(0, 2000)}`;
  getDb()
    .insert(memoryChunks)
    .values({
      id: newId(),
      kind: "ask",
      refId: sessionId,
      text,
      embedded: false,
      dwellMs: 0,
      ts,
    })
    .run();
}

export async function askMemory(
  question: string,
  sessionId?: string | null,
): Promise<AskResult> {
  const sid = ensureSession(sessionId);
  const priorTurns = loadRecentTurns(sid);
  const hits = await retrieveMemory(question, 12);
  const db = getDb();
  const loops = db
    .select()
    .from(openLoops)
    .all()
    .filter((l) => l.status === "open")
    .slice(0, 15);
  const recentArtifacts = db
    .select()
    .from(artifacts)
    .all()
    .sort((a, b) => b.lastTouchedAt.localeCompare(a.lastTouchedAt))
    .slice(0, 10);
  const timeline = todayTimeline().slice(-20);
  const leftOff = whereDidILeaveOff(6);
  const profile = getUserProfile();

  const context = buildAskContext({
    question,
    memory: hits.map((h) => ({
      score: Number(h.score.toFixed(3)),
      kind: h.kind,
      text: h.text.slice(0, 400),
      ts: h.ts,
    })),
    openLoops: loops.map((l) => ({
      title: l.title,
      kind: l.kind,
      who: l.who,
      due: l.dueHint,
    })),
    recentArtifacts: recentArtifacts.map((a) => ({
      title: a.title,
      kind: a.kind,
      lastTouchedAt: a.lastTouchedAt,
    })),
    todayTimeline: timeline.map((b) => ({
      app: b.app,
      title: b.title,
      startAt: b.startAt,
      endAt: b.endAt,
    })),
    whereLeftOff: leftOff.map((row) => ({
      title: row.artifact.title,
      kind: row.artifact.kind,
      lastTouchedAt: row.artifact.lastTouchedAt,
      openLoopTitles: row.openLoops.map((l) => l.title),
    })),
    profile: {
      role: profile.role,
      goals: profile.goals.slice(0, 8),
    },
    recentTurns: priorTurns,
  });

  const prompt = `Speak the answer to this question using only the notes below. Sound like you're talking, not writing a memo.

QUESTION: ${question}

NOTES:
${JSON.stringify(context, null, 2)}
`;

  const hosted = hostedLlmStatus();
  const useHosted = hosted.useForAsk && hosted.configured;
  const res = await runLlm({
    prompt,
    model: config.ollama.models.fallback || "smart",
    purpose: "ask",
    system: ASK_SYSTEM,
    temperature: 0.5,
    preferHosted: useHosted,
  });

  let answer = forListening(finalizeAskAnswer(res.text) ?? "");
  if (!answer) {
    const retry = await runLlm({
      prompt,
      model: "fast",
      purpose: "ask",
      system: ASK_SYSTEM,
      temperature: 0.5,
      preferHosted: useHosted,
    });
    answer = forListening(finalizeAskAnswer(retry.text) ?? "");
  }
  if (!answer) {
    answer =
      "I couldn't put that together just now. Ask me again in a moment.";
  }
  appendTurn(sid, "user", question);
  appendTurn(sid, "assistant", answer);
  persistAskMemory(sid, question, answer);

  return {
    answer,
    sources: hits.slice(0, 6).map((h) => ({
      text: h.text.slice(0, 200),
      score: h.score,
    })),
    sessionId: sid,
  };
}

export function whereDidILeaveOff(limit = 8) {
  const db = getDb();
  return db
    .select()
    .from(artifacts)
    .all()
    .sort((a, b) => b.lastTouchedAt.localeCompare(a.lastTouchedAt))
    .slice(0, limit)
    .map((a) => {
      const loops = db
        .select()
        .from(openLoops)
        .all()
        .filter(
          (l) =>
            l.status === "open" &&
            (l.artifactId === a.id ||
              l.title.toLowerCase().includes(a.title.toLowerCase().slice(0, 20))),
        )
        .slice(0, 5);
      return {
        artifact: a,
        openLoops: loops,
      };
    });
}

export function todayTimeline() {
  const db = getDb();
  const day = new Date().toISOString().slice(0, 10);
  return db
    .select()
    .from(activityBlocks)
    .all()
    .filter((b) => b.startAt.startsWith(day) || b.startAt.includes(day))
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
}
