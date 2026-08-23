/**
 * Improve-yourself: last week's searches → topic cards, local suggestions, track/progress.
 */
import {
  getDb,
  observations,
  insights,
  openLoops,
  newId,
  log,
} from "@second-brain/core";
import { eq } from "drizzle-orm";
import { runLlm, parseJsonFromText } from "./llm.js";
import { createManualLoop, listOpenLoops } from "./tools.js";
import {
  isAllowedSuggestionUrl,
  isCoachCardText,
  normalizeLearningTopic,
  rankLearningTopics,
  redactPii,
  topicMatches,
} from "./insight-quality.js";

const TELEMETRY_KINDS = new Set(["focus", "deep_work", "artifacts", "skills"]);
const IMPROVE_KINDS = new Set(["learn", "progress", "action"]);

export type InsightSuggestion = {
  title: string;
  url: string;
  kind: "article" | "video";
};

export type InsightSourceRef = {
  server: string;
  tool: string;
  ref: string;
  url?: string;
};

type InsightMeta = {
  dismissed?: boolean;
  topic?: string;
  suggestions?: InsightSuggestion[];
  ollamaOffline?: boolean;
  nextStep?: string;
  effortMin?: number;
  sources?: InsightSourceRef[];
  confidence?: number;
};

function weekKey(d = new Date()): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(
    ((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function metaOf(raw: string | null | undefined): InsightMeta {
  try {
    return JSON.parse(raw || "{}") as InsightMeta;
  } catch {
    return {};
  }
}

function isUpskillLoop(l: { tags?: string[]; title: string }): boolean {
  if (l.tags?.some((t) => t.toLowerCase() === "upskill")) return true;
  return /^learn:\s+/i.test(l.title);
}

function topicFromLoop(title: string): string {
  const m = title.match(/^learn:\s+(.+)/i);
  return (m?.[1] ?? title).trim();
}

export function parseSuggestions(text: string): InsightSuggestion[] {
  const parsed = parseJsonFromText<{ items?: unknown }>(text);
  if (!parsed || !Array.isArray(parsed.items)) return [];
  const out: InsightSuggestion[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.items) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    const title = redactPii(String(rec.title ?? "")).slice(0, 120);
    const url = String(rec.url ?? "").trim();
    const kind = rec.kind === "video" ? "video" : "article";
    if (!title || !isAllowedSuggestionUrl(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ title, url, kind });
    if (out.length >= 2) break;
  }
  return out;
}

async function suggestResources(
  topic: string,
): Promise<{ items: InsightSuggestion[]; offline: boolean }> {
  const res = await runLlm({
    purpose: "improve-suggest",
    skipHosted: true,
    model: "fast",
    system:
      "You recommend well-known public learning resources. Reply with ONLY a JSON object. Only https:// URLs on Wikipedia, YouTube, GitHub, MDN, official docs, or similar well-known public sites. Never invent private, credentialed, localhost, or lookalike-host URLs. Prefer real overview pages (e.g. Wikipedia Graph theory) — do not guess Wikipedia slugs.",
    prompt: `LEARN_TOPIC: ${topic}

Propose 1 or 2 well-known public articles or videos to go one layer deeper on this topic. JSON:
{"items":[{"title":"short title","url":"https://...","kind":"article"|"video"}]}`,
  });
  if (res.provider !== "ollama") {
    return { items: [], offline: true };
  }
  return { items: parseSuggestions(res.text), offline: false };
}

export async function generateWeeklyInsights(opts?: {
  replace?: boolean;
}): Promise<{ created: number; weekKey: string }> {
  const db = getDb();
  const wk = weekKey();
  const existing = db
    .select()
    .from(insights)
    .all()
    .filter((i) => i.weekKey === wk);

  if (
    !opts?.replace &&
    existing.some((i) => IMPROVE_KINDS.has(i.kind) && isCoachCardText(i.body))
  ) {
    return { created: 0, weekKey: wk };
  }

  for (const row of db.select().from(insights).all()) {
    const dropWeek = Boolean(opts?.replace) && row.weekKey === wk;
    if (dropWeek || TELEMETRY_KINDS.has(row.kind)) {
      db.delete(insights).where(eq(insights.id, row.id)).run();
    }
  }

  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
  const recentObs = db
    .select()
    .from(observations)
    .all()
    .filter((o) => o.ts >= weekAgo);

  const ranked = rankLearningTopics(
    recentObs.map((o) => ({
      title: o.windowTitle ?? "",
      url: o.url,
      key: o.url,
    })),
  );
  const tracked = listOpenLoops("open").filter(isUpskillLoop);
  const trackedTopics = tracked.map((l) => ({
    id: l.id,
    topic: topicFromLoop(l.title),
  }));

  const created: string[] = [];
  const insert = (
    kind: string,
    title: string,
    body: string,
    score: number,
    meta: InsightMeta,
  ) => {
    const safeBody = redactPii(body);
    const safeTitle = redactPii(title);
    if (!isCoachCardText(safeBody) || !isCoachCardText(safeTitle)) return;
    if (meta.topic && !normalizeLearningTopic(meta.topic)) return;
    const id = newId();
    db.insert(insights)
      .values({
        id,
        kind,
        title: safeTitle,
        body: safeBody,
        score,
        weekKey: wk,
        metaJson: JSON.stringify(meta),
      })
      .run();
    created.push(id);
  };

  const now = new Date().toISOString();
  for (const t of trackedTopics) {
    const hit = ranked.find((r) => topicMatches(t.topic, r.topic));
    if (!hit) continue;
    db.update(openLoops)
      .set({ lastSeenAt: now, updatedAt: now })
      .where(eq(openLoops.id, t.id))
      .run();
    insert(
      "progress",
      `Still on ${t.topic}`,
      "You looked this up again this week.",
      0.85,
      { topic: t.topic },
    );
  }

  const learnTopics = ranked
    .filter(
      (r) => !trackedTopics.some((t) => topicMatches(t.topic, r.topic)),
    )
    .slice(0, 2);

  const suggested = await Promise.all(
    learnTopics.map(async (r) => {
      const s = await suggestResources(r.topic);
      return { topic: r.topic, ...s };
    }),
  );

  for (const s of suggested) {
    const offlineBit = s.offline
      ? " I can't pick articles until Ollama is running on this PC."
      : "";
    insert(
      "learn",
      `You were into ${s.topic}`,
      `Last week you looked this up a lot. Track it if you want to go deeper.${offlineBit}`,
      0.8,
      {
        topic: s.topic,
        suggestions: s.items,
        ollamaOffline: s.offline,
      },
    );
  }

  log.info("Weekly insights generated", {
    weekKey: wk,
    created: created.length,
  });
  return { created: created.length, weekKey: wk };
}

export function listInsights(limit = 20) {
  return getDb()
    .select()
    .from(insights)
    .all()
    .filter((i) => IMPROVE_KINDS.has(i.kind))
    .filter((i) => !metaOf(i.metaJson).dismissed)
    .map((i) => {
      const meta = metaOf(i.metaJson);
      const suggestions = (meta.suggestions ?? [])
        .filter((s) => isAllowedSuggestionUrl(s.url))
        .slice(0, 2);
      return {
        ...i,
        title: redactPii(i.title),
        body: redactPii(i.body),
        topic: meta.topic,
        suggestions,
        ollamaOffline: Boolean(meta.ollamaOffline),
        nextStep: meta.nextStep ? redactPii(meta.nextStep) : undefined,
        effortMin: meta.effortMin,
        sources: meta.sources ?? [],
        confidence: meta.confidence,
      };
    })
    .filter((i) => isCoachCardText(i.title) && isCoachCardText(i.body))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

export function insightVoice(limit = 2): string | null {
  const lines = listInsights(8)
    .slice(0, limit)
    .map((i) => i.title)
    .filter((t) => isCoachCardText(t));
  if (!lines.length) return null;
  return lines.join(" · ");
}

export function dismissInsight(id: string): { ok: boolean } {
  const db = getDb();
  const row = db.select().from(insights).where(eq(insights.id, id)).get();
  if (!row) return { ok: false };
  db.delete(insights).where(eq(insights.id, id)).run();
  return { ok: true };
}

export function trackLearningTopic(input: {
  insightId?: string;
  topic?: string;
}): { ok: boolean; id?: string; topic?: string; error?: string } {
  let raw = (input.topic ?? "").trim();
  if (!raw && input.insightId) {
    const row = getDb()
      .select()
      .from(insights)
      .where(eq(insights.id, input.insightId))
      .get();
    if (!row) return { ok: false, error: "not found" };
    raw = metaOf(row.metaJson).topic ?? "";
  }
  const topic = normalizeLearningTopic(raw);
  if (!topic) return { ok: false, error: "invalid topic" };

  const existing = listOpenLoops("open").find(
    (l) =>
      isUpskillLoop(l) && topicMatches(topicFromLoop(l.title), topic),
  );
  if (existing) return { ok: true, id: existing.id, topic };

  const r = createManualLoop({
    title: `Learn: ${topic}`,
    description: "Learning target from Improve.",
    kind: "unfinished",
    tags: ["upskill"],
    category: "other",
  });
  return { ok: true, id: r.id, topic };
}
