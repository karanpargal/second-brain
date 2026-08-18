/**
 * Priority is separate from detector confidence.
 * due soon / deadline / awaiting_reply boost urgency; confidence is a mild nudge only.
 */
export function computePriority(input: {
  dueAt?: string | null;
  kind: string;
  confidence: number;
}): number {
  let p = 0.45;
  const conf = Number.isFinite(input.confidence)
    ? Math.max(0, Math.min(1, input.confidence))
    : 0.5;

  if (input.dueAt) {
    const due = Date.parse(input.dueAt);
    if (!Number.isNaN(due)) {
      const days = (due - Date.now()) / 86_400_000;
      if (days <= 0) p = Math.max(p, 0.98);
      else if (days <= 1) p = Math.max(p, 0.95);
      else if (days <= 3) p = Math.max(p, 0.85);
      else if (days <= 7) p = Math.max(p, 0.72);
      else p = Math.max(p, 0.55);
    }
  }

  if (input.kind === "deadline") p = Math.max(p, 0.82);
  else if (input.kind === "awaiting_reply") p = Math.max(p, 0.72);
  else if (input.kind === "promise") p = Math.max(p, 0.6);

  // Confidence is detector certainty — only a small boost, never the main signal
  p = Math.min(1, p + conf * 0.08);
  return Math.round(p * 1000) / 1000;
}
