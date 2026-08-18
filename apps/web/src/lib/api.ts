const BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

declare global {
  interface Window {
    __BRAIN_API_TOKEN__?: string;
  }
}

let cachedToken: string | null = null;

/**
 * Tried in order so a stale bundle, a missed injection or a dev-server origin
 * can each still authenticate. The core also sets a same-origin cookie, which
 * covers the case where every one of these comes up empty.
 */
async function resolveApiToken(): Promise<string | null> {
  if (cachedToken) return cachedToken;
  if (typeof window === "undefined") return null;

  if (window.__BRAIN_API_TOKEN__) {
    cachedToken = window.__BRAIN_API_TOKEN__;
    return cachedToken;
  }

  const meta = document
    .querySelector('meta[name="brain-api-token"]')
    ?.getAttribute("content");
  if (meta) {
    cachedToken = meta;
    return cachedToken;
  }

  try {
    const tauri = (window as { __TAURI__?: { core?: { invoke?: (c: string) => Promise<string> } } })
      .__TAURI__;
    const token = await tauri?.core?.invoke?.("api_token");
    if (token) {
      cachedToken = token;
      return cachedToken;
    }
  } catch {
    /* not running inside Tauri */
  }

  return null;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await resolveApiToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers["X-Brain-Token"] = token;
  }
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: "include",
    headers,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => req<Health>("/api/health"),
  now: () => req<NowPayload>("/api/now"),
  timeline: (date?: string) =>
    req<TimelinePayload>(
      `/api/timeline${date ? `?date=${encodeURIComponent(date)}` : ""}`,
    ),
  loops: (status = "open") =>
    req<{ loops: OpenLoop[] }>(`/api/loops?status=${status}`),
  loop: (id: string) =>
    req<{ loop: OpenLoop; evidence: LoopEvidence[] }>(`/api/loops/${id}`),
  createLoop: (body: {
    title: string;
    kind?: string;
    description?: string;
    dueHint?: string;
    tags?: string[];
    category?: string;
  }) =>
    req<{ id: string }>("/api/loops", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  patchLoop: (id: string, status: string) =>
    req(`/api/loops/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),
  markSpam: (id: string) =>
    req<{ ok: boolean; rules: string[]; error?: string }>(
      `/api/loops/${id}/spam`,
      { method: "POST" },
    ),
  markNotTracking: (id: string) =>
    req<{ ok: boolean; rules: string[]; error?: string }>(
      `/api/loops/${id}/not-tracking`,
      { method: "POST" },
    ),
  spamRules: () =>
    req<{
      rules: Array<{
        id: string;
        matchType: string;
        pattern: string;
        intent?: string;
        note: string | null;
      }>;
    }>("/api/tracking-rules"),
  deleteSpamRule: (id: string) =>
    req(`/api/tracking-rules/${id}`, { method: "DELETE" }),
  ask: (question: string) =>
    req<AskResult>("/api/ask", {
      method: "POST",
      body: JSON.stringify({ question }),
    }),
  search: (q: string) =>
    req<{ hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}`),
  settings: () => req<SettingsPayload>("/api/settings"),
  patchSetting: (key: string, value: unknown) =>
    req("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ key, value }),
    }),
  addRule: (ruleType: string, pattern: string, note?: string) =>
    req<{ id: string }>("/api/settings/rules", {
      method: "POST",
      body: JSON.stringify({ ruleType, pattern, note }),
    }),
  deleteRule: (id: string) =>
    req(`/api/settings/rules/${id}`, { method: "DELETE" }),
  pause: (minutes = 60) =>
    req<{ paused_until: string }>("/api/capture/pause", {
      method: "POST",
      body: JSON.stringify({ minutes }),
    }),
  jobs: () => req<JobsPayload>("/api/jobs"),
  connectGoogle: () =>
    req<{ ok: boolean; message?: string; error?: string }>("/api/auth/google", {
      method: "POST",
    }),
  connectGithub: () =>
    req<{
      ok: boolean;
      message?: string;
      error?: string;
      needsInstall?: boolean;
      commands?: string[];
      github?: GithubStatus;
    }>("/api/auth/github", { method: "POST" }),
  installGithubCli: () =>
    req<{
      ok: boolean;
      message?: string;
      commands?: string[];
      github?: GithubStatus;
    }>("/api/auth/github/install", { method: "POST" }),
  syncNow: () =>
    req<{ ok: boolean; ingest?: unknown; loops?: unknown; error?: string }>(
      "/api/sync",
      { method: "POST" },
    ),
  insights: () => req<{ insights: Insight[] }>("/api/insights"),
  generateInsights: () =>
    req<{ created: number; weekKey: string }>("/api/insights/generate", {
      method: "POST",
    }),
  trackInsight: (body: { insightId?: string; topic?: string }) =>
    req<{ ok: boolean; id?: string; topic?: string; error?: string }>(
      "/api/insights/track",
      { method: "POST", body: JSON.stringify(body) },
    ),
  dismissInsight: (id: string) =>
    req<{ ok: boolean }>(`/api/insights/${id}`, { method: "DELETE" }),
  buckets: () =>
    req<{
      urgent: OpenLoop[];
      today: OpenLoop[];
      todo: OpenLoop[];
      improve: Insight[];
    }>("/api/buckets"),
  recentlyAutoClosed: () =>
    req<{ loops: OpenLoop[] }>("/api/loops?status=closed&auto=1"),
  undoClose: (id: string) =>
    req(`/api/loops/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "open" }),
    }),
  profile: () => req<{ profile: UserProfile | null }>("/api/profile"),
  saveProfile: (profile: Partial<UserProfile>) =>
    req<{ ok: boolean }>("/api/profile", {
      method: "PATCH",
      body: JSON.stringify(profile),
    }),
  licenseStatus: () =>
    req<{
      licensed: boolean;
      trial: boolean;
      expiresAt: string | null;
    }>("/api/license"),
  activateLicense: (key: string) =>
    req<{ ok: boolean; error?: string }>("/api/license", {
      method: "POST",
      body: JSON.stringify({ key }),
    }),
};

export type InsightSuggestion = {
  title: string;
  url: string;
  kind: "article" | "video";
};

export type Insight = {
  id: string;
  kind: string;
  title: string;
  body: string;
  score: number;
  createdAt: string;
  topic?: string;
  suggestions?: InsightSuggestion[];
  ollamaOffline?: boolean;
};

export type UserProfile = {
  role?: string | null;
  goals?: string[];
  workHours?: { start: string; end: string };
  timezone?: string;
  interests?: string[];
  interestPacks?: string[];
  onboardingDone?: boolean;
  contacts?: Array<{ name: string; weight: number }>;
};

export type OpenLoop = {
  id: string;
  title: string;
  description: string | null;
  kind: string;
  status: string;
  confidence: number;
  priority?: number;
  detectedAt: string;
  dueHint: string | null;
  dueAt?: string | null;
  who: string | null;
  origin: string;
  closeReason: string | null;
  closedAt: string | null;
  lastSeenAt?: string | null;
  sourceUrl?: string | null;
  sourceKind?: string | null;
  sourceLabel?: string | null;
  category?: string | null;
  tags?: string[];
};

export type LoopEvidence = {
  id: string;
  loopId: string;
  role: string;
  note: string | null;
  observationId: string | null;
  itemId: string | null;
  createdAt: string;
};

export type Artifact = {
  id: string;
  kind: string;
  key: string;
  title: string;
  lastTouchedAt: string;
  touchCount: number;
};

export type ActivityBlock = {
  id: string;
  startAt: string;
  endAt: string;
  app: string | null;
  title: string | null;
  url: string | null;
  summary: string | null;
  dwellMs: number;
  obsCount: number;
};

export type Observation = {
  id: string;
  ts: string;
  source: string;
  app: string | null;
  windowTitle: string | null;
  url: string | null;
  text: string | null;
  dwellMs: number;
};

export type NowPayload = {
  loops: OpenLoop[];
  resume: Array<{ artifact: Artifact; openLoops: OpenLoop[] }>;
  calendar: Array<{ id: string; title: string; startAt: string; endAt: string }>;
  brief?: { date: string; markdown: string; voice?: string | null } | null;
};

export type TimelinePayload = {
  date: string;
  blocks: ActivityBlock[];
  observations: Observation[];
};

export type AskResult = {
  answer: string;
  sources: Array<{ text: string; score: number }>;
};

export type SearchHit = {
  chunkId: string;
  text: string;
  score: number;
  kind: string;
  ts: string | null;
};

export type SettingsPayload = {
  settings: Record<string, unknown>;
  rules: Array<{
    id: string;
    ruleType: string;
    pattern: string;
    enabled: boolean;
    note: string | null;
  }>;
};

export type JobsPayload = {
  jobs: Array<{
    id: string;
    job: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    error: string | null;
    statsJson: string;
  }>;
  sources: Array<{
    id: string;
    kind: string;
    name: string;
    lastRunAt: string | null;
    lastError: string | null;
    enabled: boolean;
  }>;
  usage: Array<{ kind: string; model: string | null; createdAt: string }>;
  counts: { items: number; observations: number; openLoops: number };
  spool: { files: number; bytes: number };
  ollama: { ok: boolean; models: string[] };
};

export type GithubStatus = {
  connected: boolean;
  source: "env" | "secret" | "gh" | "none";
  ghInstalled: boolean;
};

export type Health = {
  ok: boolean;
  dataDir: string;
  google?: {
    connected: boolean;
    hasRefresh: boolean;
    expiry?: number | null;
    needsReauth?: boolean;
    lastError?: string | null;
  };
  github?: GithubStatus & { lastError?: string | null };
  ollama: { ok: boolean; models: string[] };
  spool: { files: number; bytes: number };
};
