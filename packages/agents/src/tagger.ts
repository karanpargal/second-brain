import {
  getDb,
  items,
  annotations,
  config,
  newId,
  log,
} from "@second-brain/core";
import { eq } from "drizzle-orm";
import { runClaude, parseJsonFromText } from "./llm.js";

export async function annotateTopItems(limit?: number): Promise<number> {
  const n = limit ?? config.scoring.topNForLlm;
  const db = getDb();
  const candidates = db
    .select()
    .from(items)
    .all()
    .filter((i) => !i.annotated)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, n);

  if (candidates.length === 0) {
    log.info("No items to annotate");
    return 0;
  }

  const payload = candidates.map((c) => ({
    id: c.id,
    kind: c.kind,
    title: c.title,
    body: (c.body ?? "").slice(0, 800),
    relevance: c.relevance,
  }));

  const prompt = `TAG_ITEMS_JSON
Annotate each item for a personal second brain.
Fields per item: horizon (content|dev|startup|life|null), topics (string[]), salience (0-1), summary (1 sentence), why_it_matters (1 sentence).

Return ONLY valid JSON (no markdown fences):
{"annotations":[{"id":"...","horizon":"...","topics":[],"salience":0.5,"summary":"...","why_it_matters":"..."}]}

Items:
${JSON.stringify(payload, null, 2)}
`;

  const res = await runClaude({ prompt, model: "haiku", maxTurns: 1 });
  const parsed = parseJsonFromText<{
    annotations: Array<{
      id: string;
      horizon?: string;
      topics?: string[];
      salience?: number;
      summary?: string;
      why_it_matters?: string;
    }>;
  }>(res.text);

  let count = 0;
  if (parsed?.annotations?.length) {
    for (const a of parsed.annotations) {
      const item = candidates.find((c) => c.id === a.id);
      if (!item) continue;
      db.insert(annotations)
        .values({
          id: newId(),
          itemId: a.id,
          horizon: a.horizon ?? null,
          topicsJson: JSON.stringify(a.topics ?? []),
          salience: a.salience ?? item.relevance,
          summary: a.summary ?? item.title,
          whyItMatters: a.why_it_matters ?? null,
          model: res.model,
        })
        .run();
      db.update(items)
        .set({ annotated: true, updatedAt: new Date().toISOString() })
        .where(eq(items.id, a.id))
        .run();
      count++;
    }
  } else {
    // fallback local annotations
    for (const c of candidates) {
      db.insert(annotations)
        .values({
          id: newId(),
          itemId: c.id,
          horizon: guessHorizon(c.title + " " + (c.body ?? "")),
          topicsJson: "[]",
          salience: c.relevance,
          summary: c.title,
          whyItMatters: null,
          model: res.model,
        })
        .run();
      db.update(items)
        .set({ annotated: true, updatedAt: new Date().toISOString() })
        .where(eq(items.id, c.id))
        .run();
      count++;
    }
  }
  return count;
}

function guessHorizon(text: string): string | null {
  const t = text.toLowerCase();
  if (/startup|founder|customer|mrr|pmf|fundraising/.test(t)) return "startup";
  if (/code|github|typescript|api|deploy|bug|pr\b/.test(t)) return "dev";
  if (/content|youtube|tweet|newsletter|write|video/.test(t)) return "content";
  return null;
}
