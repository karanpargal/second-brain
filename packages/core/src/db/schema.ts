import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const ts = (name: string) =>
  text(name)
    .notNull()
    .default(sql`(datetime('now'))`);

export const sources = sqliteTable("sources", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(), // gmail | gcal | github | capture
  name: text("name").notNull(),
  configJson: text("config_json").notNull().default("{}"),
  cursorJson: text("cursor_json").notNull().default("{}"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastRunAt: text("last_run_at"),
  lastError: text("last_error"),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
});

export const rawEvents = sqliteTable(
  "raw_events",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    externalId: text("external_id").notNull(),
    payloadJson: text("payload_json").notNull(),
    fetchedAt: ts("fetched_at"),
  },
  (t) => ({
    srcExt: uniqueIndex("raw_events_src_ext").on(t.sourceId, t.externalId),
  }),
);

export const items = sqliteTable(
  "items",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    rawEventId: text("raw_event_id").references(() => rawEvents.id),
    externalId: text("external_id").notNull(),
    kind: text("kind").notNull(), // email | event | issue | pr | observation
    title: text("title").notNull(),
    body: text("body"),
    url: text("url"),
    author: text("author"),
    contentHash: text("content_hash").notNull(),
    publishedAt: text("published_at"),
    relevance: real("relevance").notNull().default(0),
    embedded: integer("embedded", { mode: "boolean" }).notNull().default(false),
    annotated: integer("annotated", { mode: "boolean" })
      .notNull()
      .default(false),
    metaJson: text("meta_json").notNull().default("{}"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    hashIdx: index("items_hash").on(t.contentHash),
    relIdx: index("items_relevance").on(t.relevance),
    srcExt: uniqueIndex("items_src_ext").on(t.sourceId, t.externalId),
    pubIdx: index("items_published").on(t.publishedAt),
  }),
);

export const annotations = sqliteTable("annotations", {
  id: text("id").primaryKey(),
  itemId: text("item_id")
    .notNull()
    .references(() => items.id),
  horizon: text("horizon"),
  topicsJson: text("topics_json").notNull().default("[]"),
  salience: real("salience").notNull().default(0),
  summary: text("summary"),
  whyItMatters: text("why_it_matters"),
  model: text("model"),
  createdAt: ts("created_at"),
});

export const entities = sqliteTable(
  "entities",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type").notNull().default("person"), // person | org | topic | project
    aliasesJson: text("aliases_json").notNull().default("[]"),
    weight: real("weight").notNull().default(1),
    createdAt: ts("created_at"),
  },
  (t) => ({
    nameIdx: uniqueIndex("entities_name").on(t.name),
  }),
);

export const horizons = sqliteTable("horizons", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  weight: real("weight").notNull().default(1),
  color: text("color").notNull().default("#6366f1"),
  description: text("description"),
  createdAt: ts("created_at"),
});

export const goals = sqliteTable("goals", {
  id: text("id").primaryKey(),
  horizonId: text("horizon_id")
    .notNull()
    .references(() => horizons.id),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull().default("active"),
  targetDate: text("target_date"),
  progress: real("progress").notNull().default(0),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
});

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  horizonId: text("horizon_id")
    .notNull()
    .references(() => horizons.id),
  goalId: text("goal_id").references(() => goals.id),
  title: text("title").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
});

/** Ambient capture rows from desktop spool */
export const observations = sqliteTable(
  "observations",
  {
    id: text("id").primaryKey(),
    ts: text("ts").notNull(),
    source: text("source").notNull(), // window | browser | ocr | file
    app: text("app"),
    exe: text("exe"),
    windowTitle: text("window_title"),
    url: text("url"),
    domain: text("domain"),
    text: text("text"),
    textHash: text("text_hash").notNull(),
    dwellMs: integer("dwell_ms").notNull().default(0),
    redacted: integer("redacted", { mode: "boolean" }).notNull().default(false),
    artifactId: text("artifact_id"),
    metaJson: text("meta_json").notNull().default("{}"),
    createdAt: ts("created_at"),
  },
  (t) => ({
    tsIdx: index("observations_ts").on(t.ts),
    hashIdx: index("observations_hash").on(t.textHash),
    appIdx: index("observations_app").on(t.app),
    domainIdx: index("observations_domain").on(t.domain),
  }),
);

/** Contiguous activity sessions */
export const activityBlocks = sqliteTable(
  "activity_blocks",
  {
    id: text("id").primaryKey(),
    startAt: text("start_at").notNull(),
    endAt: text("end_at").notNull(),
    app: text("app"),
    title: text("title"),
    url: text("url"),
    artifactId: text("artifact_id"),
    summary: text("summary"),
    dwellMs: integer("dwell_ms").notNull().default(0),
    obsCount: integer("obs_count").notNull().default(0),
    createdAt: ts("created_at"),
  },
  (t) => ({
    rangeIdx: index("activity_blocks_range").on(t.startAt, t.endAt),
  }),
);

/** Things you work on — files, URLs, repos, threads */
export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(), // file | url | repo | thread | window
    key: text("key").notNull(), // stable identity (path, url, owner/repo)
    title: text("title").notNull(),
    lastTouchedAt: text("last_touched_at").notNull(),
    touchCount: integer("touch_count").notNull().default(1),
    metaJson: text("meta_json").notNull().default("{}"),
    createdAt: ts("created_at"),
  },
  (t) => ({
    keyIdx: uniqueIndex("artifacts_key").on(t.kind, t.key),
    touchedIdx: index("artifacts_touched").on(t.lastTouchedAt),
  }),
);

/** Open loops — replaces legacy tasks as the primary work unit */
export const openLoops = sqliteTable(
  "open_loops",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description"),
    kind: text("kind").notNull().default("unfinished"), // promise | awaiting_reply | unfinished | decision | deadline
    status: text("status").notNull().default("open"), // open | closed | snoozed | dismissed
    confidence: real("confidence").notNull().default(0.5),
    detectedAt: text("detected_at").notNull(),
    dueHint: text("due_hint"),
    lastSeenAt: text("last_seen_at"),
    closedAt: text("closed_at"),
    closeReason: text("close_reason"), // auto_evidence | manual
    horizonId: text("horizon_id").references(() => horizons.id),
    artifactId: text("artifact_id"),
    origin: text("origin").notNull().default("detected"), // detected | manual
    who: text("who"),
    embeddingJson: text("embedding_json"),
    dueAt: text("due_at"),
    priority: real("priority").notNull().default(0.5),
    category: text("category").notNull().default("other"),
    tagsJson: text("tags_json").notNull().default("[]"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    statusIdx: index("open_loops_status").on(t.status),
    kindIdx: index("open_loops_kind").on(t.kind),
  }),
);

export const loopEvidence = sqliteTable(
  "loop_evidence",
  {
    id: text("id").primaryKey(),
    loopId: text("loop_id")
      .notNull()
      .references(() => openLoops.id),
    observationId: text("observation_id"),
    itemId: text("item_id"),
    role: text("role").notNull().default("progressed"), // opened | progressed | closed
    note: text("note"),
    createdAt: ts("created_at"),
  },
  (t) => ({
    loopIdx: index("loop_evidence_loop").on(t.loopId),
  }),
);

/** Unified embedding store (observations, items, loops excerpts) */
export const memoryChunks = sqliteTable(
  "memory_chunks",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(), // observation | item | loop | block
    refId: text("ref_id").notNull(),
    text: text("text").notNull(),
    embeddingJson: text("embedding_json"),
    dims: integer("dims").notNull().default(768),
    model: text("model"),
    embedded: integer("embedded", { mode: "boolean" }).notNull().default(false),
    dwellMs: integer("dwell_ms").notNull().default(0),
    ts: text("ts"),
    createdAt: ts("created_at"),
  },
  (t) => ({
    refIdx: index("memory_chunks_ref").on(t.kind, t.refId),
    embIdx: index("memory_chunks_embedded").on(t.embedded),
  }),
);

export const captureRules = sqliteTable(
  "capture_rules",
  {
    id: text("id").primaryKey(),
    ruleType: text("rule_type").notNull(), // block_exe | block_domain | allow_exe
    pattern: text("pattern").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    note: text("note"),
    createdAt: ts("created_at"),
  },
  (t) => ({
    typeIdx: index("capture_rules_type").on(t.ruleType),
  }),
);

/** User-trained spam / not-tracking filters (widget Mark as spam / Not tracking) */
export const userSpamRules = sqliteTable(
  "user_spam_rules",
  {
    id: text("id").primaryKey(),
    matchType: text("match_type").notNull(), // sender | domain | title_pattern | source
    pattern: text("pattern").notNull(),
    /** spam | not_tracking */
    intent: text("intent").notNull().default("spam"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    sourceLoopId: text("source_loop_id"),
    sourceItemId: text("source_item_id"),
    note: text("note"),
    hitCount: integer("hit_count").notNull().default(0),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    typeIdx: index("user_spam_rules_type").on(t.matchType),
  }),
);

/**
 * Classification graph for OCR → card decisions.
 * Later RL: (state=ocr node, action=class node, reward=outcome node).
 */
export const learnNodes = sqliteTable(
  "learn_nodes",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(), // ocr | class | card | outcome | market
    label: text("label").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    reward: real("reward"),
    createdAt: ts("created_at"),
  },
  (t) => ({
    kindIdx: index("learn_nodes_kind").on(t.kind),
    createdIdx: index("learn_nodes_created").on(t.createdAt),
  }),
);

export const learnEdges = sqliteTable(
  "learn_edges",
  {
    id: text("id").primaryKey(),
    fromId: text("from_id")
      .notNull()
      .references(() => learnNodes.id),
    toId: text("to_id")
      .notNull()
      .references(() => learnNodes.id),
    rel: text("rel").notNull(), // classified | carded | rewarded | corrected
    weight: real("weight").notNull().default(1),
    createdAt: ts("created_at"),
  },
  (t) => ({
    fromIdx: index("learn_edges_from").on(t.fromId),
    toIdx: index("learn_edges_to").on(t.toId),
    relIdx: index("learn_edges_rel").on(t.rel),
  }),
);

/** Legacy tasks table kept for gmail-extracted proposals during transition */
export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    horizonId: text("horizon_id").references(() => horizons.id),
    projectId: text("project_id").references(() => projects.id),
    goalId: text("goal_id").references(() => goals.id),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("todo"),
    priority: integer("priority").notNull().default(3),
    energy: text("energy").notNull().default("medium"),
    estimateMin: integer("estimate_min").notNull().default(30),
    deadline: text("deadline"),
    origin: text("origin").notNull().default("manual"),
    confidence: real("confidence"),
    sourceItemId: text("source_item_id").references(() => items.id),
    approvedAt: text("approved_at"),
    rejectedAt: text("rejected_at"),
    completedAt: text("completed_at"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    statusIdx: index("tasks_status").on(t.status),
    horizonIdx: index("tasks_horizon").on(t.horizonId),
  }),
);

export const plans = sqliteTable(
  "plans",
  {
    id: text("id").primaryKey(),
    date: text("date").notNull(),
    blocksJson: text("blocks_json").notNull().default("[]"),
    rationale: text("rationale"),
    model: text("model"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    dateIdx: uniqueIndex("plans_date").on(t.date),
  }),
);

export const briefs = sqliteTable(
  "briefs",
  {
    id: text("id").primaryKey(),
    date: text("date").notNull(),
    kind: text("kind").notNull().default("morning"),
    markdown: text("markdown").notNull(),
    topItemsJson: text("top_items_json").notNull().default("[]"),
    model: text("model"),
    createdAt: ts("created_at"),
  },
  (t) => ({
    dateKind: uniqueIndex("briefs_date_kind").on(t.date, t.kind),
  }),
);

export const jobRuns = sqliteTable(
  "job_runs",
  {
    id: text("id").primaryKey(),
    job: text("job").notNull(),
    status: text("status").notNull(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    statsJson: text("stats_json").notNull().default("{}"),
    error: text("error"),
  },
  (t) => ({
    jobIdx: index("job_runs_job").on(t.job),
    startedIdx: index("job_runs_started").on(t.startedAt),
  }),
);

export const usageEvents = sqliteTable("usage_events", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  model: text("model"),
  inputTokens: integer("input_tokens").default(0),
  outputTokens: integer("output_tokens").default(0),
  metaJson: text("meta_json").notNull().default("{}"),
  createdAt: ts("created_at"),
});

export const calendarBlocks = sqliteTable(
  "calendar_blocks",
  {
    id: text("id").primaryKey(),
    externalId: text("external_id").notNull(),
    title: text("title").notNull(),
    startAt: text("start_at").notNull(),
    endAt: text("end_at").notNull(),
    allDay: integer("all_day", { mode: "boolean" }).notNull().default(false),
    status: text("status").notNull().default("confirmed"),
    metaJson: text("meta_json").notNull().default("{}"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    extIdx: uniqueIndex("calendar_blocks_ext").on(t.externalId),
    rangeIdx: index("calendar_blocks_range").on(t.startAt, t.endAt),
  }),
);

/** App-level settings (capture pause, toggles) */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull().default("null"),
  updatedAt: ts("updated_at"),
});

export const reminders = sqliteTable(
  "reminders",
  {
    id: text("id").primaryKey(),
    loopId: text("loop_id").references(() => openLoops.id),
    title: text("title").notNull(),
    fireAt: text("fire_at").notNull(),
    firedAt: text("fired_at"),
    status: text("status").notNull().default("pending"), // pending | fired | cancelled
    metaJson: text("meta_json").notNull().default("{}"),
    createdAt: ts("created_at"),
  },
  (t) => ({
    fireStatusIdx: index("reminders_fire_status").on(t.fireAt, t.status),
  }),
);

export const insights = sqliteTable("insights", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  score: real("score").notNull().default(0),
  metaJson: text("meta_json").notNull().default("{}"),
  createdAt: ts("created_at"),
  weekKey: text("week_key"), // e.g. 2026-W32
});

export const feedbackEvents = sqliteTable("feedback_events", {
  id: text("id").primaryKey(),
  loopId: text("loop_id"),
  signal: text("signal").notNull(), // positive | negative | spam | dismiss
  embeddingJson: text("embedding_json"),
  createdAt: ts("created_at"),
});

/** Single-row local profile (id = 'local') — onboarding + preferences */
export const userProfiles = sqliteTable("user_profiles", {
  id: text("id").primaryKey(),
  role: text("role"),
  goalsJson: text("goals_json").notNull().default("[]"),
  workHoursJson: text("work_hours_json")
    .notNull()
    .default('{"start":"09:00","end":"18:00"}'),
  timezone: text("timezone"),
  interestsJson: text("interests_json").notNull().default("[]"),
  interestPacksJson: text("interest_packs_json").notNull().default("[]"),
  contactsJson: text("contacts_json").notNull().default("[]"),
  onboardingDone: integer("onboarding_done", { mode: "boolean" })
    .notNull()
    .default(false),
  updatedAt: ts("updated_at"),
});

/** Multi-turn Ask-your-agent sessions (text or voice) */
export const askSessions = sqliteTable("ask_sessions", {
  id: text("id").primaryKey(),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
});

export const askTurns = sqliteTable(
  "ask_turns",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => askSessions.id),
    role: text("role").notNull(), // user | assistant
    text: text("text").notNull(),
    createdAt: ts("created_at"),
  },
  (t) => ({
    sessionIdx: index("ask_turns_session").on(t.sessionId, t.createdAt),
  }),
);
