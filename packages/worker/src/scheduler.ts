import cron from "node-cron";
import {
  config,
  ensureDataDir,
  migrate,
  seed,
  runJob,
  backupDb,
  log,
  type JobResult,
} from "@second-brain/core";
import {
  connectors,
  ingestAll,
  runGoogleAuthFlow,
  googleStatus,
} from "@second-brain/connectors";
import { runEnrichPipeline } from "@second-brain/enrich";
import { ingestSpool, purgeStaleObservations } from "@second-brain/capture";
import {
  annotateTopItems,
  extractTasksFromTopItems,
  generateDailyPlan,
  generateMorningBrief,
  runLoopsPipeline,
  fireDueReminders,
  ensureCalendarLeadReminders,
  generateWeeklyInsights,
  listInsights,
} from "@second-brain/agents";
import { runFullEval } from "@second-brain/evals";
import { startApiServer } from "./api.js";
import { scheduleFastLoopDetect } from "./fast-loops.js";

export async function jobIngest(source?: string): Promise<JobResult> {
  return runJob(source ? `ingest:${source}` : "ingest:all", async () => {
    if (source) {
      const fn = connectors[source];
      if (!fn) throw new Error(`Unknown source: ${source}`);
      const r = await fn();
      return { stats: r as unknown as Record<string, unknown> };
    }
    const all = await ingestAll();
    return { stats: all as unknown as Record<string, unknown> };
  });
}

export async function jobCapture(): Promise<JobResult> {
  return runJob("capture", async () => {
    const r = await ingestSpool();
    if ((r.inserted ?? 0) > 0) {
      scheduleFastLoopDetect("spool");
    }
    return { stats: r as unknown as Record<string, unknown> };
  });
}

export async function jobEnrich(): Promise<JobResult> {
  return runJob("enrich", async () => {
    const r = await runEnrichPipeline();
    return { stats: r };
  });
}

export async function jobTag(): Promise<JobResult> {
  return runJob("tag", async () => {
    const n = await annotateTopItems();
    return { stats: { annotated: n } };
  });
}

export async function jobExtract(): Promise<JobResult> {
  return runJob("extract", async () => {
    const n = await extractTasksFromTopItems();
    return { stats: { proposed: n } };
  });
}

export async function jobLoops(): Promise<JobResult> {
  return runJob("loops", async () => {
    const r = await runLoopsPipeline();
    return { stats: r as unknown as Record<string, unknown> };
  });
}

export async function jobPlan(): Promise<JobResult> {
  return runJob("plan", async () => {
    const id = await generateDailyPlan();
    return { stats: { planId: id } };
  });
}

export async function jobBrief(): Promise<JobResult> {
  return runJob("brief", async () => {
    const id = await generateMorningBrief();
    return { stats: { briefId: id } };
  });
}

export async function jobPurge(): Promise<JobResult> {
  return runJob("purge", async () => {
    const r = purgeStaleObservations();
    return { stats: r as unknown as Record<string, unknown> };
  });
}

export async function jobBackup(): Promise<JobResult> {
  return runJob("backup", async () => {
    const path = backupDb();
    return { stats: { path } };
  });
}

export async function jobReminders(): Promise<JobResult> {
  return runJob("reminders", async () => {
    ensureCalendarLeadReminders();
    const r = fireDueReminders();
    return { stats: r as unknown as Record<string, unknown> };
  });
}

export async function jobInsights(): Promise<JobResult> {
  return runJob("insights", async () => {
    const r = await generateWeeklyInsights({ replace: true });
    return { stats: r as unknown as Record<string, unknown> };
  });
}

export async function jobEval(): Promise<JobResult> {
  return runJob("evals", async () => {
    const r = await runFullEval({ persist: true });
    return {
      stats: {
        heuristicF1: r.heuristic.overall.f1,
        heuristicN: r.fixtureCount,
        aiSkipped: r.ai.skipped,
        aiF1: r.ai.skipped ? null : r.ai.f1,
        aiN: r.ai.n,
        aiMisses: r.ai.misses.length,
      },
    };
  });
}

export async function catchUpOnBoot() {
  log.info("Catch-up on boot starting");
  await jobCapture().catch((e) =>
    log.error("capture catch-up failed", { err: String(e) }),
  );
  await jobIngest().catch((e) =>
    log.error("ingest catch-up failed", { err: String(e) }),
  );
  await jobEnrich().catch((e) =>
    log.error("enrich catch-up failed", { err: String(e) }),
  );
  await jobLoops().catch((e) =>
    log.error("loops catch-up failed", { err: String(e) }),
  );
  try {
    if (listInsights().length === 0) {
      await generateWeeklyInsights();
    }
  } catch (e) {
    log.error("insights catch-up failed", { err: String(e) });
  }
  void jobBrief().catch((e) =>
    log.error("brief catch-up failed", { err: String(e) }),
  );
  void jobPlan().catch((e) =>
    log.error("plan catch-up failed", { err: String(e) }),
  );
  log.info("Catch-up on boot complete");
}

export function startScheduler() {
  ensureDataDir();
  migrate();
  seed();
  startApiServer();

  const s = config.schedule;
  const safe = (name: string, fn: () => Promise<unknown>) => {
    cron.schedule(s[name as keyof typeof s] as string, () => {
      fn().catch((e) =>
        log.error(`Scheduled ${name} failed`, { err: String(e) }),
      );
    });
    log.info(`Scheduled ${name}`, { cron: s[name as keyof typeof s] });
  };

  safe("gmail", () => jobIngest("gmail"));
  safe("gcal", () => jobIngest("gcal"));
  safe("github", () => jobIngest("github"));
  safe("capture", () => jobCapture());
  safe("enrich", () => jobEnrich());
  safe("loops", async () => {
    await jobTag();
    await jobLoops();
  });
  safe("brief", () => jobBrief());
  safe("plan", () => jobPlan());
  safe("purge", () => jobPurge());
  safe("backup", () => jobBackup());
  safe("reminders", () => jobReminders());
  safe("insights", () => jobInsights());
  safe("evals", () => jobEval());

  setTimeout(() => {
    catchUpOnBoot().catch((e) =>
      log.error("catch-up failed", { err: String(e) }),
    );
  }, 2000);

  setTimeout(() => {
    jobEval().catch((e) => log.error("eval on boot failed", { err: String(e) }));
  }, 45_000);

  log.info("Worker scheduler running", {
    dataDir: config.dataDir,
    host: config.host,
    port: config.port,
  });
}

export async function runCli(argv: string[]) {
  const [cmd, ...rest] = argv;
  ensureDataDir();
  migrate();

  switch (cmd) {
    case "daemon":
    case "start":
      startScheduler();
      break;
    case "ingest":
      await jobIngest(rest[0]);
      break;
    case "capture":
      await jobCapture();
      break;
    case "enrich":
      await jobEnrich();
      break;
    case "tag":
      await jobTag();
      break;
    case "extract":
      await jobExtract();
      break;
    case "loops":
      await jobLoops();
      break;
    case "plan":
      await jobPlan();
      break;
    case "brief":
    case "digest":
      await jobBrief();
      break;
    case "purge":
      await jobPurge();
      break;
    case "backup":
      await jobBackup();
      break;
    case "seed":
      seed();
      break;
    case "auth":
      if (rest[0] === "google") {
        await runGoogleAuthFlow();
      } else {
        console.log("Usage: brain auth google");
      }
      break;
    case "status": {
      const g = await googleStatus();
      console.log(
        JSON.stringify({ google: g, dataDir: config.dataDir }, null, 2),
      );
      break;
    }
    case "eval":
    case "evals":
      await jobEval();
      break;
    case "help":
    default:
      console.log(`second-brain CLI

Usage:
  brain daemon              Start API + scheduler
  brain ingest [source]     gmail | gcal | github
  brain capture             Ingest PC capture spool
  brain enrich              Embed + score
  brain loops               Detect + auto-close open loops
  brain tag                 Annotate signals
  brain brief               Morning brief (also: digest)
  brain plan                Daily plan
  brain purge               Retention purge
  brain backup              VACUUM INTO backup
  brain eval                Heuristic + local Ollama eval (self-improve)
  brain auth google         OAuth (read-only)
  brain status
  brain seed
`);
      if (cmd && cmd !== "help") process.exitCode = 1;
  }
}
