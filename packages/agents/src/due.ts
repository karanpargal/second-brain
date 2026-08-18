/**
 * Lightweight due-date parsing from chat / message text.
 * Returns an ISO datetime string, or null if nothing reliable is found.
 */

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function atLocalNoon(d: Date): Date {
  const out = new Date(d);
  out.setHours(12, 0, 0, 0);
  return out;
}

function nextWeekday(from: Date, targetDow: number): Date {
  const d = atLocalNoon(from);
  const cur = d.getDay();
  let add = (targetDow - cur + 7) % 7;
  if (add === 0) add = 7; // "friday" on Friday → next Friday
  d.setDate(d.getDate() + add);
  return d;
}

/**
 * Parse a simple due date from free text.
 * Supports: tomorrow, today, weekday names, ISO YYYY-MM-DD, common US dates.
 */
export function parseDueAt(text: string, now: Date = new Date()): string | null {
  const t = text.trim();
  if (!t) return null;

  const iso = t.match(/\b(20\d{2}-\d{2}-\d{2})(?:[T\s]\d{2}:\d{2}(?::\d{2})?)?\b/);
  if (iso) {
    const parsed = Date.parse(iso[0].includes("T") || iso[0].includes(" ") ? iso[0] : `${iso[1]}T12:00:00`);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }

  const us = t.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](20\d{2})\b/);
  if (us) {
    const a = Number(us[1]);
    const b = Number(us[2]);
    const y = Number(us[3]);
    // Prefer MDY when first > 12 is impossible; else assume MDY
    const month = a > 12 ? b : a;
    const day = a > 12 ? a : b;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const d = new Date(y, month - 1, day, 12, 0, 0, 0);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }

  if (/\b(today|aaj)\b/i.test(t) || /\bby\s+eod\b/i.test(t)) {
    return atLocalNoon(now).toISOString();
  }

  if (/\b(tomorrow|kal)\b/i.test(t)) {
    const d = atLocalNoon(now);
    d.setDate(d.getDate() + 1);
    return d.toISOString();
  }

  const wd = t.match(
    /\b(by\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i,
  );
  if (wd) {
    const name = wd[2].toLowerCase();
    const target = WEEKDAYS[name];
    if (target != null) {
      return nextWeekday(now, target).toISOString();
    }
  }

  return null;
}
