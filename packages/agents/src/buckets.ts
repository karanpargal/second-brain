/**
 * Bucket loops into Urgent / Today / Todo using dueAt + priority (not confidence).
 */
import { getDb, calendarBlocks } from "@second-brain/core";
import { listOpenLoops } from "./tools.js";
import { listInsights } from "./insights.js";

function startOfLocalDay(d = new Date()): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfLocalDay(d = new Date()): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

export function isUrgentLoop(loop: {
  dueAt?: string | null;
  kind?: string;
  priority?: number | null;
}): boolean {
  if (loop.dueAt) {
    const due = Date.parse(loop.dueAt);
    if (!Number.isNaN(due) && due - Date.now() <= 24 * 3600_000 && due >= Date.now() - 3600_000) {
      return true;
    }
  }
  if (loop.kind === "deadline" && (loop.priority ?? 0) >= 0.75) return true;
  return (loop.priority ?? 0) >= 0.9;
}

export function isTodayLoop(loop: {
  dueAt?: string | null;
  priority?: number | null;
  detectedAt?: string;
}): boolean {
  if (isUrgentLoop(loop)) return false;
  const start = startOfLocalDay().getTime();
  const end = endOfLocalDay().getTime();
  if (loop.dueAt) {
    const due = Date.parse(loop.dueAt);
    if (!Number.isNaN(due) && due >= start && due <= end) return true;
  }
  return (loop.priority ?? 0) >= 0.7;
}

export function bucketOpenLoops() {
  const open = listOpenLoops("open").sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
  );
  const urgent = open.filter(isUrgentLoop);
  const urgentIds = new Set(urgent.map((l) => l.id));
  const today = open.filter((l) => !urgentIds.has(l.id) && isTodayLoop(l));
  const todayIds = new Set(today.map((l) => l.id));
  const todo = open.filter((l) => !urgentIds.has(l.id) && !todayIds.has(l.id));

  const day = new Date().toISOString().slice(0, 10);
  const cal = getDb()
    .select()
    .from(calendarBlocks)
    .all()
    .filter((b) => b.startAt.startsWith(day) && b.status !== "cancelled");

  const improve = listInsights(12);

  return { urgent, today, todo, calendarToday: cal, improve };
}

export function sortOpenByPriority() {
  return listOpenLoops("open").sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
  );
}
