import {

  getDb,

  items,

  annotations,

  briefs,

  plans,

  tasks,

  calendarBlocks,

  horizons,

  goals,

  
  config,

  newId,

  log,

} from "@second-brain/core";

import { eq } from "drizzle-orm";

import { runClaude } from "./llm.js";
import { getUserProfile } from "./feedback.js";



function todayStr(): string {

  // Prefer local calendar date in configured TZ when possible

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



function localTimeLabel(iso: string): string {

  try {

    return new Intl.DateTimeFormat("en-IN", {

      timeZone: config.tz,

      hour: "2-digit",

      minute: "2-digit",

      hour12: true,

    }).format(new Date(iso));

  } catch {

    return new Date(iso).toLocaleTimeString();

  }

}



export async function generateMorningBrief(

  date = todayStr(),

): Promise<string> {

  const db = getDb();

  const top = db

    .select()

    .from(items)

    .all()

    .sort((a, b) => b.relevance - a.relevance)

    .slice(0, 12);



  const ann = db.select().from(annotations).all();

  const annByItem = Object.fromEntries(ann.map((a) => [a.itemId, a]));



  const plan = db.select().from(plans).where(eq(plans.date, date)).get();

  const proposed = db

    .select()

    .from(tasks)

    .all()

    .filter((t) => t.origin === "extracted" && !t.approvedAt && !t.rejectedAt);



  const approvedOpen = db

    .select()

    .from(tasks)

    .all()

    .filter(

      (t) =>

        (t.status === "todo" || t.status === "doing") &&

        (t.origin === "manual" || t.approvedAt) &&

        !t.rejectedAt,

    );



  const needsReply = top.filter(

    (i) =>

      i.kind === "email" &&

      !/noreply|no-reply|newsletter/i.test(i.author ?? ""),

  );



  const cal = db

    .select()

    .from(calendarBlocks)

    .all()

    .filter((b) => b.startAt.startsWith(date) || b.startAt.includes(date));



  const hs = db.select().from(horizons).all();

  const goalRows = db.select().from(goals).all();

  const user = getUserProfile();
  const profile = {
    topicsJson: JSON.stringify(user.interests ?? []),
    notes: [user.role, ...(user.goals ?? [])].filter(Boolean).join(". ") || undefined,
  } as { topicsJson?: string; notes?: string } | null;



  const planBlocks = plan

    ? (JSON.parse(plan.blocksJson) as Array<{

        start: string;

        end: string;

        title: string;

        kind: string;

        minutes: number;

      }>)

    : [];



  const context = {

    date,

    timezone: config.tz,

    personality: {

      horizons: hs.map((h) => ({

        name: h.name,

        weight: h.weight,

        description: h.description,

      })),

      goals: goalRows.map((g) => ({

        title: g.title,

        description: g.description,

        horizonId: g.horizonId,

      })),

      interests: profile

        ? {

            topics: JSON.parse(profile.topicsJson || "[]"),

            notes: profile.notes,

          }

        : null,

    },

    topSignals: top.map((i) => ({

      title: i.title,

      kind: i.kind,

      relevance: Number(i.relevance.toFixed(3)),

      why: annByItem[i.id]?.whyItMatters,

      summary: annByItem[i.id]?.summary,

      horizon: annByItem[i.id]?.horizon,

      url: i.url,

    })),

    planRationale: plan?.rationale,

    planBlocks: planBlocks.map((b) => ({

      ...b,

      startLocal: localTimeLabel(b.start),

      endLocal: localTimeLabel(b.end),

    })),

    calendar: cal.map((c) => ({

      title: c.title,

      startLocal: localTimeLabel(c.startAt),

      endLocal: localTimeLabel(c.endAt),

    })),

    needsReply: needsReply.map((i) => i.title),

    proposedTasks: proposed.map((t) => t.title),

    openTodos: approvedOpen.map((t) => t.title),

  };



  const prompt = `MORNING_BRIEF

Write a crisp, well-formatted markdown morning brief for a builder who juggles Content, Dev, and Startup.



Timezone for all times: ${config.tz}. Use local times from planBlocks.*.startLocal (never raw UTC unless labeled).



## Required sections (exact headings)



## Focus

3–5 short bullets. Bold the action verb / theme.



## Calendar

Bullets with times, or "*No scheduled events*" if empty.



## Signals

A markdown table with columns: Signal | Why it matters

Max 8 rows. Keep "Why it matters" to one short sentence.



## Needs reply

Bullets, or "*None today*".



## Proposed tasks awaiting approval

Numbered list of proposedTasks (or "*None*").



## Plan notes

Timeline bullets using local times, e.g. **9:00–9:45 AM** — task.



## Suggestions

At least **3** growth ideas tailored to this person's personality, horizons, goals, interests, and today's signals/needs.

Each suggestion MUST use this shape:



### 1. Title

- **Type:** project | content | skill | experiment

- **Horizon:** Content | Dev | Startup

- **Why you:** 1 sentence tying to their profile / today's signals

- **Next step:** one concrete action they can do in ≤60 minutes

- **Payoff:** how it helps them grow (audience, craft, product, leverage)



Make suggestions specific (not generic "learn AI"). Prefer ideas that compound: build in public, ship a tiny tool, turn a signal into a post, validate a startup angle, deepen a recurring interest (tech + entertainment/culture if present).



Formatting rules:

- Valid GitHub-flavored markdown only

- No HTML

- No walls of text; scannable bullets and short paragraphs

- Do not invent calendar events that are not in context



Context JSON:

${JSON.stringify(context, null, 2)}

`;



  const res = await runClaude({ prompt, model: "sonnet" });

  const existing = db

    .select()

    .from(briefs)

    .all()

    .find((b) => b.date === date && b.kind === "morning");



  if (existing) {

    db.update(briefs)

      .set({

        markdown: res.text,

        topItemsJson: JSON.stringify(top.map((t) => t.id)),

        model: res.model,

      })

      .where(eq(briefs.id, existing.id))

      .run();

    log.info("Morning brief updated", { date, model: res.model });

    return existing.id;

  }



  const id = newId();

  db.insert(briefs)

    .values({

      id,

      date,

      kind: "morning",

      markdown: res.text,

      topItemsJson: JSON.stringify(top.map((t) => t.id)),

      model: res.model,

    })

    .run();

  log.info("Morning brief saved", { date, model: res.model });

  return id;

}



export async function generateWeeklyReview(

  date = todayStr(),

): Promise<string> {

  const db = getDb();

  const allTasks = db.select().from(tasks).all();

  const done = allTasks.filter((t) => t.status === "done");

  const open = allTasks.filter(

    (t) => t.status === "todo" || t.status === "doing",

  );

  const top = db

    .select()

    .from(items)

    .all()

    .sort((a, b) => b.relevance - a.relevance)

    .slice(0, 20);

  const hs = db.select().from(horizons).all();

  const goalRows = db.select().from(goals).all();

  const user = getUserProfile();
  const profile = {
    topicsJson: JSON.stringify(user.interests ?? []),
    notes: [user.role, ...(user.goals ?? [])].filter(Boolean).join(". ") || undefined,
  } as { topicsJson?: string; notes?: string } | null;



  const prompt = `WEEKLY_REVIEW

Write a weekly review in clean GitHub-flavored markdown.



## Wins

## Horizon progress (Content / Dev / Startup)

## Goal drift risks

## Next week focus

Exactly 3 bullets.



## Growth suggestions

At least 3 ideas (project / content / skill) tied to personality + open work:

### 1. Title

- **Type:** ...

- **Horizon:** ...

- **Why you:** ...

- **Next step:** ...

- **Payoff:** ...



Horizons: ${JSON.stringify(hs.map((h) => h.name))}

Goals: ${JSON.stringify(goalRows.map((g) => g.title))}

Interests: ${profile?.topicsJson ?? "[]"}

Tasks done: ${JSON.stringify(done.map((t) => t.title))}

Open tasks: ${JSON.stringify(open.map((t) => t.title))}

Top signals: ${JSON.stringify(top.map((t) => t.title))}

`;



  const res = await runClaude({ prompt, model: "sonnet" });

  const id = newId();

  const week = `week-${date}`;

  const existing = db

    .select()

    .from(briefs)

    .all()

    .find((b) => b.date === week && b.kind === "weekly");

  if (existing) {

    db.update(briefs)

      .set({ markdown: res.text, model: res.model })

      .where(eq(briefs.id, existing.id))

      .run();

    return existing.id;

  }

  db.insert(briefs)

    .values({

      id,

      date: week,

      kind: "weekly",

      markdown: res.text,

      topItemsJson: "[]",

      model: res.model,

    })

    .run();

  log.info("Weekly review saved", { date: week });

  return id;

}


