import {
  getDb,
  tasks,
  horizons,
  plans,
  calendarBlocks,
  items,
  config,
  newId,
  log,
} from "@second-brain/core";
import { freeBlocksForDate } from "@second-brain/connectors";
import { eq } from "drizzle-orm";
import { runClaude, parseJsonFromText } from "./llm.js";

export type PlanBlock = {
  start: string;
  end: string;
  taskId?: string;
  title: string;
  kind: "task" | "calendar" | "break" | "focus" | "proposed";
  horizon?: string;
  minutes: number;
};

function todayStr(): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: config.tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function urgency(deadline: string | null): number {
  if (!deadline) return 0.4;
  const days =
    (new Date(deadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  if (days < 0) return 1;
  if (days < 1) return 0.95;
  if (days < 3) return 0.8;
  if (days < 7) return 0.6;
  return 0.35;
}

function energyFit(energy: string, hour: number): number {
  if (energy === "high") return hour < 12 ? 1 : hour < 15 ? 0.6 : 0.3;
  if (energy === "low") return hour >= 14 ? 1 : 0.7;
  return 0.8;
}

export function rankTasksForPlan(opts?: {
  /** Include AI-proposed (unapproved) tasks so free-tier planning still fills */
  includeProposed?: boolean;
}): Array<{
  task: typeof tasks.$inferSelect;
  score: number;
  horizonWeight: number;
  proposed: boolean;
}> {
  const includeProposed = opts?.includeProposed ?? true;
  const db = getDb();
  const hs = Object.fromEntries(
    db
      .select()
      .from(horizons)
      .all()
      .map((h) => [h.id, h]),
  );

  const open = db
    .select()
    .from(tasks)
    .all()
    .filter((t) => {
      if (t.status === "rejected" || t.status === "done" || t.rejectedAt)
        return false;
      if (!(t.status === "todo" || t.status === "doing")) return false;
      if (t.origin === "manual" || t.approvedAt) return true;
      if (includeProposed && t.origin === "extracted" && !t.approvedAt)
        return true;
      return false;
    });

  return open
    .map((task) => {
      const h = task.horizonId ? hs[task.horizonId] : null;
      const horizonWeight = h?.weight ?? 1;
      const pr = (6 - (task.priority ?? 3)) / 5;
      const urg = urgency(task.deadline);
      const hour = new Date().getHours();
      const en = energyFit(task.energy, hour);
      const proposed = task.origin === "extracted" && !task.approvedAt;
      // Slightly down-rank unapproved so approved work wins when both exist
      const score =
        (pr * 0.35 * horizonWeight + urg * 0.35 + en * 0.3) *
        (proposed ? 0.85 : 1);
      return { task, score, horizonWeight, proposed };
    })
    .sort((a, b) => b.score - a.score);
}

export function buildDeterministicPlan(date = todayStr()): PlanBlock[] {
  const free = freeBlocksForDate(date);
  const ranked = rankTasksForPlan({ includeProposed: true });
  const blocks: PlanBlock[] = [];

  const db = getDb();
  const dayStart = new Date(`${date}T00:00:00`).getTime();
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  for (const b of db.select().from(calendarBlocks).all()) {
    const s = new Date(b.startAt).getTime();
    const e = new Date(b.endAt).getTime();
    if (e < dayStart || s > dayEnd || b.allDay || b.status === "cancelled")
      continue;
    blocks.push({
      start: b.startAt,
      end: b.endAt,
      title: b.title,
      kind: "calendar",
      minutes: Math.round((e - s) / 60_000),
    });
  }

  let taskIdx = 0;
  const slots =
    free.length > 0
      ? free
      : [
          {
            start: new Date(`${date}T09:00:00`).toISOString(),
            end: new Date(`${date}T12:00:00`).toISOString(),
            minutes: 180,
          },
          {
            start: new Date(`${date}T14:00:00`).toISOString(),
            end: new Date(`${date}T17:00:00`).toISOString(),
            minutes: 180,
          },
        ];

  for (const slot of slots) {
    let remaining = slot.minutes;
    let cursor = new Date(slot.start).getTime();
    while (remaining >= 20 && taskIdx < ranked.length) {
      const { task, proposed } = ranked[taskIdx]!;
      taskIdx++;
      const mins = Math.min(task.estimateMin || 30, remaining, 90);
      const end = cursor + mins * 60_000;
      blocks.push({
        start: new Date(cursor).toISOString(),
        end: new Date(end).toISOString(),
        taskId: task.id,
        title: proposed ? `[proposed] ${task.title}` : task.title,
        kind: proposed ? "proposed" : "task",
        minutes: mins,
      });
      cursor = end;
      remaining -= mins;
    }
  }

  return blocks.sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
  );
}

export async function generateDailyPlan(date = todayStr()): Promise<string> {
  const db = getDb();
  let blocks = buildDeterministicPlan(date);
  const ranked = rankTasksForPlan({ includeProposed: true }).slice(0, 20);
  const topSignals = db
    .select()
    .from(items)
    .all()
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, 10)
    .map((i) => ({
      title: i.title,
      kind: i.kind,
      relevance: Number(i.relevance.toFixed(3)),
    }));

  const prompt = `DAILY_PLAN
Date: ${date}
You are a personal planner. A deterministic schedule was pre-computed from calendar free time + ranked todos (including AI-proposed ones marked kind=proposed).

Write:
1) rationale — 2–4 short sentences: focus for the day, energy advice, what to approve first
2) optional focusBlocks — ONLY if the schedule has fewer than 2 task/proposed blocks; suggest 2–4 timed focus blocks from top signals (titles only, no invented meetings)

Return ONLY valid JSON (no markdown):
{"rationale":"...","focusBlocks":[{"start":"ISO","end":"ISO","title":"...","minutes":45}]}

Precomputed blocks:
${JSON.stringify(blocks, null, 2)}

Open / proposed tasks (ranked):
${JSON.stringify(
  ranked.map((r) => ({
    id: r.task.id,
    title: r.task.title,
    priority: r.task.priority,
    energy: r.task.energy,
    estimate: r.task.estimateMin,
    proposed: r.proposed,
    score: Number(r.score.toFixed(3)),
  })),
  null,
  2,
)}

Top signals:
${JSON.stringify(topSignals, null, 2)}
`;

  const res = await runClaude({ prompt, model: "sonnet" });
  const parsed = parseJsonFromText<{
    rationale?: string;
    reorderHints?: string[];
    focusBlocks?: Array<{
      start: string;
      end: string;
      title: string;
      minutes?: number;
    }>;
  }>(res.text);

  const taskish = blocks.filter(
    (b) => b.kind === "task" || b.kind === "proposed",
  ).length;
  if (taskish < 2 && parsed?.focusBlocks?.length) {
    for (const fb of parsed.focusBlocks) {
      if (!fb.title || !fb.start || !fb.end) continue;
      blocks.push({
        start: fb.start,
        end: fb.end,
        title: fb.title,
        kind: "focus",
        minutes:
          fb.minutes ??
          Math.max(
            15,
            Math.round(
              (new Date(fb.end).getTime() - new Date(fb.start).getTime()) /
                60_000,
            ),
          ),
      });
    }
    blocks = blocks.sort(
      (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
    );
  }

  const rationale =
    parsed?.rationale ??
    (res.provider === "stub"
      ? "Offline plan: approve proposed tasks in /todos, then re-run plan."
      : res.text.slice(0, 800));

  const existing = db.select().from(plans).where(eq(plans.date, date)).get();
  if (existing) {
    db.update(plans)
      .set({
        blocksJson: JSON.stringify(blocks),
        rationale,
        model: res.model,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(plans.id, existing.id))
      .run();
    log.info("Daily plan updated", {
      date,
      blocks: blocks.length,
      model: res.model,
    });
    return existing.id;
  }

  const id = newId();
  db.insert(plans)
    .values({
      id,
      date,
      blocksJson: JSON.stringify(blocks),
      rationale,
      model: res.model,
    })
    .run();
  log.info("Daily plan saved", { date, blocks: blocks.length, model: res.model });
  return id;
}
