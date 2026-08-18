import {
  getDb,
  items,
  tasks,
  horizons,
  newId,
  log,
} from "@second-brain/core";
import { eq } from "drizzle-orm";
import { runClaude, parseJsonFromText } from "./llm.js";

const ACTIONABLE_KINDS = new Set([
  "email",
  "issue",
  "pr",
  "notification",
  "newsletter",
  "event",
]);

/** Free models do better with fewer, clearer candidates. */
export async function extractTasksFromTopItems(
  limit = 20,
): Promise<number> {
  const db = getDb();
  const all = db.select().from(items).all();

  const actionable = all
    .filter((i) => ACTIONABLE_KINDS.has(i.kind))
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, Math.max(8, Math.floor(limit * 0.6)));

  const signalPool = all
    .filter((i) => !ACTIONABLE_KINDS.has(i.kind) || i.relevance > 0.15)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, limit);

  // Prefer actionable; pad with top signals so free models always have material
  const seen = new Set<string>();
  const candidates = [...actionable, ...signalPool]
    .filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    })
    .slice(0, limit);

  if (!candidates.length) return 0;

  const horizonRows = db.select().from(horizons).all();
  const horizonBySlug = Object.fromEntries(
    horizonRows.map((h) => [h.slug, h.id]),
  );

  const prompt = `EXTRACT_TASKS
You create a personal todo inbox from mixed signals (email, notifications, news, videos, posts).
Propose 5–8 concrete todos the user could do today or this week.
Rules:
- Prefer actions: reply, review, research, decide, ship, follow up
- Skip pure spam / bank alerts / social noise unless action is clear
- Map horizon to: content | dev | startup | life (or null)
- confidence 0–1; only include if confidence >= 0.4
- Use item_id when a task comes from a specific item
- Keep titles under 120 chars; descriptions under 200 chars
- Return at most 8 tasks so the JSON fits in one response

Return ONLY valid JSON (no markdown fences, no commentary):
{"tasks":[{"title":"...","description":"...","horizon":"content|dev|startup|life|null","priority":1-5,"estimate_min":30,"deadline":null,"item_id":"...","confidence":0.7}]}

Items:
${JSON.stringify(
  candidates.map((c) => ({
    id: c.id,
    kind: c.kind,
    title: c.title,
    body: (c.body ?? "").slice(0, 500),
    relevance: Number(c.relevance.toFixed(3)),
  })),
  null,
  2,
)}
`;

  const res = await runClaude({ prompt, model: "haiku" });
  const parsed = parseJsonFromText<{
    tasks: Array<{
      title: string;
      description?: string;
      horizon?: string | null;
      priority?: number;
      estimate_min?: number;
      deadline?: string | null;
      item_id?: string;
      confidence?: number;
    }>;
  }>(res.text);

  let n = 0;
  for (const t of parsed?.tasks ?? []) {
    if (!t.title) continue;
    if ((t.confidence ?? 0.6) < 0.4) continue;
    const exists = db
      .select()
      .from(tasks)
      .all()
      .some(
        (x) =>
          x.title.toLowerCase() === t.title.toLowerCase() &&
          x.status !== "rejected",
      );
    if (exists) continue;

    const slug = t.horizon && t.horizon !== "null" ? t.horizon : null;
    const horizonId = slug ? horizonBySlug[slug] : null;

    db.insert(tasks)
      .values({
        id: newId(),
        title: t.title.slice(0, 240),
        description: t.description ?? null,
        horizonId: horizonId ?? null,
        priority: Math.min(5, Math.max(1, t.priority ?? 3)),
        estimateMin: t.estimate_min ?? 30,
        deadline: t.deadline ?? null,
        origin: "extracted",
        confidence: t.confidence ?? 0.6,
        sourceItemId: t.item_id ?? null,
        status: "todo",
        approvedAt: null,
      })
      .run();
    n++;
  }

  // Heuristic fallback when free model returns empty / unparseable JSON
  if (!parsed?.tasks?.length) {
    log.warn("LLM extract empty — heuristic proposals", {
      model: res.model,
      preview: res.text.slice(0, 160),
    });
    for (const c of candidates.slice(0, 8)) {
      let title: string | null = null;
      let horizonSlug: string | null = null;
      let priority = 3;

      if (c.kind === "issue" || c.kind === "pr") {
        title = `Review ${c.kind}: ${c.title}`.slice(0, 200);
        horizonSlug = "dev";
        priority = 2;
      } else if (c.kind === "email" || c.kind === "notification") {
        if (/noreply|no-reply|unsubscribe|alert for your/i.test(c.title))
          continue;
        title = `Follow up: ${c.title}`.slice(0, 200);
        priority = 2;
      } else if (c.kind === "newsletter") {
        title = `Skim newsletter: ${c.title}`.slice(0, 200);
        horizonSlug = "content";
        priority = 4;
      } else if (c.relevance >= 0.35) {
        title = `Explore: ${c.title}`.slice(0, 200);
        horizonSlug =
          c.kind === "video"
            ? "content"
            : c.kind === "post" || c.kind === "news"
              ? "dev"
              : null;
        priority = 4;
      }
      if (!title) continue;

      const exists = db
        .select()
        .from(tasks)
        .all()
        .some((x) => x.title === title && x.status !== "rejected");
      if (exists) continue;

      db.insert(tasks)
        .values({
          id: newId(),
          title,
          description: c.url ?? undefined,
          horizonId: horizonSlug ? horizonBySlug[horizonSlug] ?? null : null,
          origin: "extracted",
          confidence: 0.45,
          sourceItemId: c.id,
          priority,
          estimateMin: 25,
          status: "todo",
        })
        .run();
      n++;
    }
  }

  log.info("Extracted task proposals", { count: n, model: res.model });
  return n;
}

export function approveTask(taskId: string): void {
  const db = getDb();
  db.update(tasks)
    .set({
      approvedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(tasks.id, taskId))
    .run();
}

export function rejectTask(taskId: string): void {
  const db = getDb();
  db.update(tasks)
    .set({
      status: "rejected",
      rejectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(tasks.id, taskId))
    .run();
}
