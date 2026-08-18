import { runLlm } from "./llm.js";
import { retrieveMemory } from "@second-brain/enrich";
import {
  getDb,
  openLoops,
  artifacts,
  activityBlocks,
} from "@second-brain/core";

export async function askMemory(
  question: string,
): Promise<{ answer: string; sources: Array<{ text: string; score: number }> }> {
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

  const context = {
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
  };

  const prompt = `You answer questions about the user's personal local memory.
Use only the provided CONTEXT. If unknown, say so.
Be concise and concrete.

QUESTION: ${question}

CONTEXT:
${JSON.stringify(context, null, 2)}
`;

  const res = await runLlm({
    prompt,
    model: "smart",
    system:
      "You are a personal memory assistant with local-only context. Never invent facts not in CONTEXT.",
  });

  return {
    answer: res.text,
    sources: hits.slice(0, 6).map((h) => ({
      text: h.text.slice(0, 200),
      score: h.score,
    })),
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
