import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import {
  config,
  ensureDataDir,
  ensureApiToken,
  extractBearerToken,
  extractCookieToken,
  apiTokenCookieHeader,
  isValidApiToken,
  corsOriginFor,
  getDb,
  openLoops,
  activityBlocks,
  artifacts,
  observations,
  sources,
  jobRuns,
  usageEvents,
  captureRules,
  settings,
  calendarBlocks,
  items,
  briefs,
  newId,
  log,
  markLoopAsSpam,
  markLoopNotTracking,
  listUserSpamRules,
  deleteUserSpamRule,
  exportCaptureRulesFile,
} from "@second-brain/core";
import { eq } from "drizzle-orm";
import {
  askMemory,
  listOpenLoops,
  searchMemory,
  updateLoopStatus,
  createManualLoop,
  getLoopEvidence,
  whereDidILeaveOff,
  findArtifact,
  whatDidIDo,
  detectOpenLoops,
  extractFocusVoice,
} from "@second-brain/agents";
import {
  googleStatus,
  runGoogleAuthFlow,
  githubStatus,
  runGithubGhAuthLogin,
  tryLoadGhCliToken,
  installGithubCli,
  ingestAll,
} from "@second-brain/connectors";
import { ingestSpool } from "@second-brain/capture";
import { wakeFromCapture, scheduleFastLoopDetect } from "./fast-loops.js";

let syncLock: Promise<unknown> | null = null;
let authLock: Promise<unknown> | null = null;
let wakeLock: Promise<unknown> | null = null;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
  req?: IncomingMessage,
) {
  const origin = corsOriginFor(req?.headers.origin);
  const payload = body === null || body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...(origin
      ? {
          "Access-Control-Allow-Origin": origin,
          Vary: "Origin",
          "Access-Control-Allow-Credentials": "true",
        }
      : {}),
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Brain-Token",
    ...headers,
  });
  res.end(payload);
}

function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
  const token =
    extractBearerToken(
      req.headers.authorization,
      typeof req.headers["x-brain-token"] === "string"
        ? req.headers["x-brain-token"]
        : undefined,
    ) ?? extractCookieToken(req.headers.cookie);
  if (isValidApiToken(token)) return true;
  send(res, 401, { error: "unauthorized", hint: "Provide Authorization: Bearer <api-token>" }, {}, req);
  return false;
}

function tryServeStatic(req: IncomingMessage, res: ServerResponse): boolean {
  const dist = config.webDist;
  if (!existsSync(dist)) return false;

  const host = `http://${config.host}:${config.port}`;
  const u = new URL(req.url ?? "/", host);
  let pathname = decodeURIComponent(u.pathname);
  if (pathname === "/") pathname = "/index.html";

  const distNorm = normalize(dist);
  let filePath = normalize(join(dist, pathname.replace(/^\//, "")));
  if (!filePath.startsWith(distNorm)) {
    res.writeHead(403);
    res.end("Forbidden");
    return true;
  }

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(dist, "index.html");
    if (!existsSync(filePath)) return false;
  }

  try {
    let data: Buffer | string = readFileSync(filePath);
    const ext = extname(filePath).toLowerCase();
    const type = MIME[ext] ?? "application/octet-stream";
    const isHtml = ext === ".html";
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": pathname.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-store, no-cache, must-revalidate",
      ...(isHtml ? { "Set-Cookie": apiTokenCookieHeader() } : {}),
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

function getPath(req: IncomingMessage): { path: string; query: URLSearchParams } {
  const host = `http://${config.host}:${config.port}`;
  const u = new URL(req.url ?? "/", host);
  return { path: u.pathname, query: u.searchParams };
}

async function ollamaStatus() {
  try {
    const res = await fetch(
      `${config.ollama.baseUrl.replace(/\/$/, "")}/api/tags`,
      { signal: AbortSignal.timeout(2000) },
    );
    if (!res.ok) return { ok: false, models: [] as string[] };
    const data = (await res.json()) as {
      models?: Array<{ name: string }>;
    };
    return {
      ok: true,
      models: (data.models ?? []).map((m) => m.name),
    };
  } catch {
    return { ok: false, models: [] as string[] };
  }
}

function mergeCaptureControl(patch: Record<string, unknown>): void {
  const controlPath = join(config.dataDir, "capture-control.json");
  let map: Record<string, unknown> = {};
  if (existsSync(controlPath)) {
    try {
      map = JSON.parse(readFileSync(controlPath, "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      map = {};
    }
  }
  Object.assign(map, patch);
  writeFileSync(controlPath, JSON.stringify(map));
}

function spoolStats() {
  ensureDataDir();
  const dir = config.spoolDir;
  if (!existsSync(dir)) return { files: 0, bytes: 0 };
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  let bytes = 0;
  for (const f of files) {
    try {
      bytes += readFileSync(join(dir, f)).length;
    } catch {
      /* */
    }
  }
  return { files: files.length, bytes };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const reply = (
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => send(res, status, body, headers, req);

  if (req.method === "OPTIONS") {
    const origin = corsOriginFor(req.headers.origin);
    if (!origin && req.headers.origin) {
      res.writeHead(403);
      res.end();
      return;
    }
    reply(204, null);
    return;
  }

  const { path, query } = getPath(req);
  const method = req.method ?? "GET";

  if (!path.startsWith("/api") && (method === "GET" || method === "HEAD")) {
    if (tryServeStatic(req, res)) return;
    reply(404, {
      error: "Desktop UI is not available. Reopen the Second Brain app.",
      path,
    });
    return;
  }

  // Health is public on localhost so the desktop shell can probe readiness
  // without racing the api-token file write during cold start.
  if (method === "GET" && path === "/api/health") {
    const db = getDb();
    const g = await googleStatus();
    const gh = await githubStatus();
    const ollama = await ollamaStatus();
    const src = db.select().from(sources).all();
    const gmailErr = src.find((s) => s.id === "src-gmail")?.lastError ?? null;
    const githubErr = src.find((s) => s.id === "src-github")?.lastError ?? null;
    reply(200, {
      ok: true,
      dataDir: config.dataDir,
      apiVersion: 7,
      features: ["spam", "wake", "fast-loops", "api-auth", "improve-learn"],
      google: {
        ...g,
        needsReauth: Boolean(
          gmailErr && /invalid_grant|unauthorized|invalid_token/i.test(gmailErr),
        ),
        lastError: gmailErr,
      },
      github: {
        ...gh,
        lastError: githubErr,
      },
      ollama,
      spool: spoolStats(),
      port: config.port,
      ui: existsSync(join(config.webDist, "index.html")),
    });
    return;
  }

  // All other /api/* routes require the per-install token
  if (path.startsWith("/api") && !requireAuth(req, res)) {
    return;
  }

  const db = getDb();

  try {
    if (method === "POST" && path === "/api/auth/google") {
      if (authLock) {
        reply(409, { error: "auth already in progress" });
        return;
      }
      authLock = runGoogleAuthFlow()
        .then(() => ({ ok: true }))
        .finally(() => {
          authLock = null;
        });
      try {
        await authLock;
        reply(200, {
          ok: true,
          message: "Google connected. Click Sync to pull Gmail.",
          google: await googleStatus(),
        });
      } catch (e) {
        reply(500, {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      return;
    }

    if (method === "POST" && path === "/api/auth/github") {
      if (authLock) {
        reply(409, { error: "auth already in progress" });
        return;
      }
      authLock = (async () => {
        const existing = await tryLoadGhCliToken();
        if (existing) return { ok: true, message: "GitHub connected via existing gh session" };
        return runGithubGhAuthLogin();
      })().finally(() => {
        authLock = null;
      });
      try {
        const result = (await authLock) as {
          ok: boolean;
          message: string;
          needsInstall?: boolean;
          commands?: string[];
        };
        reply(200, {
          ...result,
          github: await githubStatus(),
        });
      } catch (e) {
        reply(500, {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      return;
    }

    if (method === "POST" && path === "/api/auth/github/install") {
      if (authLock) {
        reply(409, { error: "auth already in progress" });
        return;
      }
      authLock = installGithubCli().finally(() => {
        authLock = null;
      });
      try {
        const result = (await authLock) as {
          ok: boolean;
          message: string;
          commands?: string[];
        };
        reply(200, { ...result, github: await githubStatus() });
      } catch (e) {
        reply(500, {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      return;
    }

    if (method === "POST" && path === "/api/sync") {
      if (syncLock) {
        reply(409, { error: "sync already running" });
        return;
      }
      syncLock = (async () => {
        await tryLoadGhCliToken();
        const spool = await ingestSpool();
        if ((spool.inserted ?? 0) > 0) scheduleFastLoopDetect("sync");
        const ingest = await ingestAll();
        const loops = await detectOpenLoops();
        return { spool, ingest, loops };
      })().finally(() => {
        syncLock = null;
      });
      try {
        const result = await syncLock;
        reply(200, { ok: true, ...(result as object) });
      } catch (e) {
        reply(500, {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      return;
    }

    if (method === "POST" && path === "/api/capture/wake") {
      if (wakeLock) {
        reply(200, { ok: true, deduped: true });
        return;
      }
      wakeLock = wakeFromCapture().finally(() => {
        wakeLock = null;
      });
      try {
        const result = await wakeLock;
        reply(200, { ok: true, ...(result as object) });
      } catch (e) {
        reply(500, {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      return;
    }

    if (method === "GET" && path === "/api/now") {
      const loops = listOpenLoops("open").slice(0, 20);
      const resume = whereDidILeaveOff(6).map((a) => {
        const attached = db
          .select()
          .from(openLoops)
          .all()
          .filter(
            (l) =>
              l.status === "open" &&
              (l.artifactId === a.id ||
                a.title
                  .toLowerCase()
                  .split(/\W+/)
                  .filter((t) => t.length > 3)
                  .some((t) => l.title.toLowerCase().includes(t))),
          )
          .slice(0, 5);
        return { artifact: a, openLoops: attached };
      });
      const day = new Date().toISOString().slice(0, 10);
      const cal = db
        .select()
        .from(calendarBlocks)
        .all()
        .filter((b) => b.startAt.startsWith(day));
      const brief = db
        .select()
        .from(briefs)
        .all()
        .filter((b) => b.date === day && b.kind === "morning")
        .at(-1);
      reply(200, {
        loops,
        resume,
        calendar: cal,
        brief: brief
          ? {
              date: brief.date,
              markdown: brief.markdown,
              voice: extractFocusVoice(brief.markdown),
            }
          : null,
      });
      return;
    }

    if (method === "GET" && path === "/api/timeline") {
      const date = query.get("date") ?? new Date().toISOString().slice(0, 10);
      const blocks = db
        .select()
        .from(activityBlocks)
        .all()
        .filter((b) => b.startAt.startsWith(date))
        .sort((a, b) => a.startAt.localeCompare(b.startAt));
      const obs = db
        .select()
        .from(observations)
        .all()
        .filter((o) => o.ts.startsWith(date))
        .sort((a, b) => a.ts.localeCompare(b.ts))
        .slice(0, 200);
      reply(200, { date, blocks, observations: obs });
      return;
    }

    if (method === "GET" && path === "/api/loops") {
      if (query.get("auto") === "1") {
        const { listRecentlyAutoClosed } = await import("@second-brain/agents");
        reply(200, { loops: listRecentlyAutoClosed(30) });
        return;
      }
      const status = query.get("status") ?? "open";
      const loops = listOpenLoops(status);
      reply(200, { loops });
      return;
    }

    if (method === "GET" && path.startsWith("/api/loops/")) {
      const id = path.slice("/api/loops/".length);
      const loop = db
        .select()
        .from(openLoops)
        .where(eq(openLoops.id, id))
        .get();
      if (!loop) {
        reply(404, { error: "not found" });
        return;
      }
      const evidence = getLoopEvidence(id);
      reply(200, { loop, evidence });
      return;
    }

    if (method === "POST" && path === "/api/loops") {
      const body = await readJson<{
        title: string;
        kind?: string;
        description?: string;
        dueHint?: string;
        tags?: string[];
        category?: string;
      }>(req);
      if (!body.title) {
        reply(400, { error: "title required" });
        return;
      }
      const r = createManualLoop(body);
      reply(201, r);
      return;
    }

    if (method === "PATCH" && path.startsWith("/api/loops/")) {
      const id = path.slice("/api/loops/".length);
      if (id.includes("/")) {
        /* fall through to spam subpath */
      } else {
        const body = await readJson<{
          status: "open" | "closed" | "snoozed" | "dismissed";
        }>(req);
        if (!body.status) {
          reply(400, { error: "status required" });
          return;
        }
        reply(200, updateLoopStatus(id, body.status));
        return;
      }
    }

    if (method === "POST" && path.match(/^\/api\/loops\/[^/]+\/spam$/)) {
      const id = path.split("/")[3];
      const result = markLoopAsSpam(id);
      if (!result.ok) {
        reply(404, result);
        return;
      }
      reply(200, result);
      return;
    }

    if (method === "POST" && path.match(/^\/api\/loops\/[^/]+\/not-tracking$/)) {
      const id = path.split("/")[3];
      const result = markLoopNotTracking(id);
      if (!result.ok) {
        reply(404, result);
        return;
      }
      reply(200, result);
      return;
    }

    if (method === "GET" && (path === "/api/spam-rules" || path === "/api/tracking-rules")) {
      const intent = query.get("intent") as "spam" | "not_tracking" | null;
      reply(200, {
        rules: listUserSpamRules(intent ?? undefined),
      });
      return;
    }

    if (
      method === "DELETE" &&
      (path.startsWith("/api/spam-rules/") || path.startsWith("/api/tracking-rules/"))
    ) {
      const id = path.startsWith("/api/spam-rules/")
        ? path.slice("/api/spam-rules/".length)
        : path.slice("/api/tracking-rules/".length);
      const ok = deleteUserSpamRule(id);
      reply(ok ? 200 : 404, { ok });
      return;
    }

    if (method === "POST" && path === "/api/ask") {
      const body = await readJson<{ question: string }>(req);
      if (!body.question) {
        reply(400, { error: "question required" });
        return;
      }
      const r = await askMemory(body.question);
      reply(200, r);
      return;
    }

    if (method === "GET" && path === "/api/search") {
      const q = query.get("q") ?? "";
      if (!q) {
        reply(400, { error: "q required" });
        return;
      }
      const hits = await searchMemory(q, Number(query.get("limit") ?? 15));
      reply(200, { hits });
      return;
    }

    if (method === "GET" && path === "/api/artifacts") {
      const q = query.get("q");
      if (q) {
        reply(200, { artifacts: findArtifact(q) });
        return;
      }
      const list = db
        .select()
        .from(artifacts)
        .all()
        .sort((a, b) => b.lastTouchedAt.localeCompare(a.lastTouchedAt))
        .slice(0, 50);
      reply(200, { artifacts: list });
      return;
    }

    if (method === "GET" && path === "/api/settings") {
      const rows = db.select().from(settings).all();
      const rules = db.select().from(captureRules).all();
      const map: Record<string, unknown> = {};
      for (const r of rows) {
        try {
          map[r.key] = JSON.parse(r.valueJson);
        } catch {
          map[r.key] = r.valueJson;
        }
      }
      reply(200, { settings: map, rules });
      return;
    }

    if (method === "PATCH" && path === "/api/settings") {
      const body = await readJson<{
        key: string;
        value: unknown;
      }>(req);
      if (!body.key) {
        reply(400, { error: "key required" });
        return;
      }
      const existing = db
        .select()
        .from(settings)
        .where(eq(settings.key, body.key))
        .get();
      const valueJson = JSON.stringify(body.value);
      if (existing) {
        db.update(settings)
          .set({
            valueJson,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(settings.key, body.key))
          .run();
      } else {
        db.insert(settings)
          .values({ key: body.key, valueJson })
          .run();
      }
      reply(200, { ok: true });
      // Mirror capture toggles into the Rust control file
      if (body.key === "capture.toggles") {
        try {
          mergeCaptureControl({ toggles: body.value });
        } catch {
          /* */
        }
      }
      return;
    }

    if (method === "POST" && path === "/api/settings/rules") {
      const body = await readJson<{
        ruleType: string;
        pattern: string;
        note?: string;
      }>(req);
      const id = newId();
      db.insert(captureRules)
        .values({
          id,
          ruleType: body.ruleType,
          pattern: body.pattern,
          note: body.note ?? null,
        })
        .run();
      try {
        exportCaptureRulesFile();
      } catch {
        /* */
      }
      reply(201, { id });
      return;
    }

    if (method === "DELETE" && path.startsWith("/api/settings/rules/")) {
      const id = path.slice("/api/settings/rules/".length);
      db.delete(captureRules).where(eq(captureRules.id, id)).run();
      try {
        exportCaptureRulesFile();
      } catch {
        /* */
      }
      reply(200, { ok: true });
      return;
    }

    if (method === "POST" && path === "/api/capture/pause") {
      const body = await readJson<{ minutes?: number }>(req);
      const minutes = body.minutes ?? 60;
      const until = new Date(Date.now() + minutes * 60_000).toISOString();
      const key = "capture.paused_until";
      const existing = db
        .select()
        .from(settings)
        .where(eq(settings.key, key))
        .get();
      if (existing) {
        db.update(settings)
          .set({
            valueJson: JSON.stringify(until),
            updatedAt: new Date().toISOString(),
          })
          .where(eq(settings.key, key))
          .run();
      } else {
        db.insert(settings)
          .values({ key, valueJson: JSON.stringify(until) })
          .run();
      }
      try {
        mergeCaptureControl({ paused_until: until });
      } catch {
        /* */
      }
      reply(200, { paused_until: until });
      return;
    }

    if (method === "GET" && path === "/api/jobs") {
      const jobs = db
        .select()
        .from(jobRuns)
        .all()
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, 50);
      const src = db.select().from(sources).all();
      const usage = db
        .select()
        .from(usageEvents)
        .all()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 30);
      const itemCount = db.select().from(items).all().length;
      const obsCount = db.select().from(observations).all().length;
      const loopCount = db
        .select()
        .from(openLoops)
        .all()
        .filter((l) => l.status === "open").length;
      reply(200, {
        jobs,
        sources: src,
        usage,
        counts: { items: itemCount, observations: obsCount, openLoops: loopCount },
        spool: spoolStats(),
        ollama: await ollamaStatus(),
      });
      return;
    }

    if (method === "GET" && path === "/api/activity") {
      reply(200, whatDidIDo({ hours: Number(query.get("hours") ?? 12) }));
      return;
    }

    // --- Phase 1–4 product APIs ---
    if (method === "GET" && path === "/api/buckets") {
      const { bucketOpenLoops } = await import("@second-brain/agents");
      reply(200, bucketOpenLoops());
      return;
    }

    if (method === "GET" && path === "/api/insights") {
      const { listInsights } = await import("@second-brain/agents");
      reply(200, { insights: listInsights() });
      return;
    }

    if (method === "GET" && path === "/api/brief") {
      const day = new Date().toISOString().slice(0, 10);
      const brief = db
        .select()
        .from(briefs)
        .all()
        .filter((b) => b.date === day && b.kind === "morning")
        .at(-1);
      reply(200, {
        date: day,
        markdown: brief?.markdown ?? null,
      });
      return;
    }

    if (method === "POST" && path === "/api/insights/generate") {
      const { generateWeeklyInsights } = await import("@second-brain/agents");
      reply(200, await generateWeeklyInsights({ replace: true }));
      return;
    }

    if (method === "POST" && path === "/api/insights/track") {
      const body = await readJson<{ insightId?: string; topic?: string }>(req);
      const { trackLearningTopic } = await import("@second-brain/agents");
      const r = trackLearningTopic(body);
      reply(r.ok ? 200 : 400, r);
      return;
    }

    if (method === "DELETE" && path.startsWith("/api/insights/")) {
      const id = path.slice("/api/insights/".length);
      const { dismissInsight } = await import("@second-brain/agents");
      reply(200, dismissInsight(id));
      return;
    }

    if (method === "GET" && path === "/api/profile") {
      const { getUserProfile } = await import("@second-brain/agents");
      reply(200, { profile: getUserProfile() });
      return;
    }

    if (method === "PATCH" && path === "/api/profile") {
      const body = await readJson<Record<string, unknown>>(req);
      const { saveUserProfile } = await import("@second-brain/agents");
      reply(200, { ok: true, profile: saveUserProfile(body as any) });
      return;
    }

    if (method === "GET" && path === "/api/license") {
      const { licenseStatus } = await import("@second-brain/agents");
      reply(200, await licenseStatus());
      return;
    }

    if (method === "POST" && path === "/api/license") {
      const body = await readJson<{ key: string }>(req);
      const { activateLicense } = await import("@second-brain/agents");
      reply(200, await activateLicense(body.key ?? ""));
      return;
    }

    if (method === "POST" && path.match(/^\/api\/loops\/[^/]+\/feedback$/)) {
      const id = path.split("/")[3];
      const body = await readJson<{ signal: "positive" | "negative" | "spam" | "dismiss" }>(req);
      const { recordLoopFeedback } = await import("@second-brain/agents");
      await recordLoopFeedback(id, body.signal ?? "positive");
      reply(200, { ok: true });
      return;
    }

    reply(404, { error: "not found", path });
  } catch (e) {
    log.error("API error", { err: String(e), path });
    reply(500, { error: e instanceof Error ? e.message : String(e) });
  }
}
export function startApiServer(): void {
  ensureDataDir();
  const token = ensureApiToken();
  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      log.error("Unhandled API error", { err: String(e) });
      try {
        send(res, 500, { error: "internal" }, {}, req);
      } catch {
        /* */
      }
    });
  });
  server.listen(config.port, config.host, () => {
    log.info("HTTP API + UI listening", {
      host: config.host,
      port: config.port,
      webDist: config.webDist,
      hasUi: existsSync(join(config.webDist, "index.html")),
      apiAuth: true,
      tokenFile: "api-token",
      tokenPrefix: token.slice(0, 6),
    });
  });
}
