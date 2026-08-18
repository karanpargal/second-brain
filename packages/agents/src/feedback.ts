import {
  getDb,
  feedbackEvents,
  userProfiles,
  openLoops,
  newId,
} from "@second-brain/core";
import { eq } from "drizzle-orm";
import { embedText, cosine } from "@second-brain/enrich";

export type FeedbackSignal = "positive" | "negative" | "spam" | "dismiss";

export async function recordLoopFeedback(
  loopId: string,
  signal: FeedbackSignal,
): Promise<void> {
  const db = getDb();
  const loop = db.select().from(openLoops).where(eq(openLoops.id, loopId)).get();
  let embeddingJson: string | null = loop?.embeddingJson ?? null;
  if (!embeddingJson && loop?.title) {
    try {
      const emb = await embedText(loop.title);
      embeddingJson = emb ? JSON.stringify(emb) : null;
    } catch {
      embeddingJson = null;
    }
  }
  db.insert(feedbackEvents)
    .values({
      id: newId(),
      loopId,
      signal,
      embeddingJson,
    })
    .run();
}

function centroid(
  events: Array<{ embeddingJson: string | null }>,
): number[] | null {
  const vecs: number[][] = [];
  for (const e of events) {
    if (!e.embeddingJson) continue;
    try {
      const v = JSON.parse(e.embeddingJson) as number[];
      if (Array.isArray(v) && v.length) vecs.push(v);
    } catch {
      /* */
    }
  }
  if (vecs.length === 0) return null;
  const dims = vecs[0]!.length;
  const out = new Array(dims).fill(0);
  for (const v of vecs) {
    for (let i = 0; i < dims; i++) out[i] += v[i] ?? 0;
  }
  for (let i = 0; i < dims; i++) out[i] /= vecs.length;
  return out;
}

/** Score a candidate title against learned feedback. Positive boosts, negative penalizes. */
export async function feedbackAffinity(title: string): Promise<number> {
  const db = getDb();
  const events = db.select().from(feedbackEvents).all().slice(-500);
  const pos = centroid(events.filter((e) => e.signal === "positive"));
  const neg = centroid(
    events.filter(
      (e) =>
        e.signal === "negative" ||
        e.signal === "spam" ||
        e.signal === "dismiss",
    ),
  );
  if (!pos && !neg) return 0;
  let emb: number[] | null = null;
  try {
    emb = await embedText(title);
  } catch {
    return 0;
  }
  if (!emb) return 0;
  let score = 0;
  if (pos) score += cosine(emb, pos);
  if (neg) score -= cosine(emb, neg);
  return score;
}

export type Profile = {
  id: string;
  role: string | null;
  goals: string[];
  workHours: { start: string; end: string };
  timezone: string | null;
  interests: string[];
  interestPacks: string[];
  contacts: Array<{ name: string; weight: number }>;
  onboardingDone: boolean;
};

export function getUserProfile(): Profile {
  try {
    const row = getDb()
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.id, "local"))
      .get();
    const parse = <T>(raw: string | null | undefined, fallback: T): T => {
      try {
        return raw ? (JSON.parse(raw) as T) : fallback;
      } catch {
        return fallback;
      }
    };
    if (!row) {
      return {
        id: "local",
        role: null,
        goals: [],
        workHours: { start: "09:00", end: "18:00" },
        timezone: null,
        interests: [],
        interestPacks: [],
        contacts: [],
        onboardingDone: false,
      };
    }
    return {
      id: row.id,
      role: row.role,
      goals: parse(row.goalsJson, []),
      workHours: parse(row.workHoursJson, { start: "09:00", end: "18:00" }),
      timezone: row.timezone,
      interests: parse(row.interestsJson, []),
      interestPacks: parse(row.interestPacksJson, []),
      contacts: parse(row.contactsJson, []),
      onboardingDone: Boolean(row.onboardingDone),
    };
  } catch {
    return {
      id: "local",
      role: null,
      goals: [],
      workHours: { start: "09:00", end: "18:00" },
      timezone: null,
      interests: [],
      interestPacks: [],
      contacts: [],
      onboardingDone: false,
    };
  }
}

export function saveUserProfile(patch: Partial<Profile>): Profile {
  const db = getDb();
  const current = getUserProfile();
  const next: Profile = {
    ...current,
    ...patch,
    goals: patch.goals ?? current.goals,
    workHours: patch.workHours ?? current.workHours,
    interests: patch.interests ?? current.interests,
    interestPacks: patch.interestPacks ?? current.interestPacks,
    contacts: patch.contacts ?? current.contacts,
  };
  const now = new Date().toISOString();
  const existing = db
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.id, "local"))
    .get();
  const values = {
    role: next.role,
    goalsJson: JSON.stringify(next.goals),
    workHoursJson: JSON.stringify(next.workHours),
    timezone: next.timezone,
    interestsJson: JSON.stringify(next.interests),
    interestPacksJson: JSON.stringify(next.interestPacks),
    contactsJson: JSON.stringify(next.contacts),
    onboardingDone: next.onboardingDone,
    updatedAt: now,
  };
  if (existing) {
    db.update(userProfiles).set(values).where(eq(userProfiles.id, "local")).run();
  } else {
    db.insert(userProfiles).values({ id: "local", ...values }).run();
  }
  return getUserProfile();
}

export function hasInterestPack(pack: string): boolean {
  try {
    const p = getUserProfile();
    if (!p.onboardingDone && p.interestPacks.length === 0) {
      // Before onboarding, keep legacy behavior (packs on) so existing users aren't broken
      return true;
    }
    return p.interestPacks.map((x) => x.toLowerCase()).includes(pack.toLowerCase());
  } catch {
    return true;
  }
}
