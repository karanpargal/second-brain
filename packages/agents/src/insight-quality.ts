/**
 * Pure insight quality helpers — denylist, PII redact, app sessions.
 * No DB. Used by generateWeeklyInsights and evals.
 */

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

const NOISE_RE =
  /\b(google search|bing search|youtube|gmail|mail\.google|outlook\.live|x\.com|twitter\.com|facebook|instagram|tiktok|reddit\.com|spotify|claim your|one[- ]time pack|unsubscribe)\b/i;

const SEARCH_HOST_RE =
  /(google\.com\/search|bing\.com\/search|duckduckgo\.com|search\.yahoo)/i;

const WORK_SURFACE_RE =
  /\b(cursor|code|vscode|visual studio|notion|figma|linear|github|gitlab|second-brain)\b|\.(ts|tsx|js|jsx|rs|py|go|md|toml)\b/i;

const WORK_URL_RE =
  /(github\.com|notion\.so|figma\.com|linear\.app|docs\.google|gitlab\.com)/i;

export function redactPii(text: string): string {
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s*[-–—]\s*$/g, "")
    .replace(/^\s*[-–—]\s*/g, "")
    .trim();
}

export function isNoiseSurface(blob: string): boolean {
  const t = blob.toLowerCase();
  if (NOISE_RE.test(t)) return true;
  if (SEARCH_HOST_RE.test(t)) return true;
  if (/\/\s*x\s*$/.test(t) || /\bx\.com\b/.test(t)) return true;
  return false;
}

export function isSafeInsightText(text: string): boolean {
  if (!text.trim()) return false;
  if (EMAIL_RE.test(text)) return false;
  if (isNoiseSurface(text)) return false;
  if (/activity blocks|pinning or scripting|notifications paused/i.test(text)) {
    return false;
  }
  return true;
}

/** Coach cards we write ourselves — allow a topic like "youtube api". */
export function isCoachCardText(text: string): boolean {
  if (!text.trim()) return false;
  if (EMAIL_RE.test(text)) return false;
  if (/activity blocks|pinning or scripting|notifications paused/i.test(text)) {
    return false;
  }
  if (/\bgmail\b/i.test(text)) return false;
  return true;
}

const ENTERTAINMENT_RE =
  /\b(netflix|spotify|official music|lyric video|movie trailer|gameplay|tiktok)\b/i;

function isEntertainmentTitle(t: string): boolean {
  if (ENTERTAINMENT_RE.test(t)) return true;
  if (/\|\s*friends\b/i.test(t)) return true;
  if (/\bfriends\b.*\b(season|episode|s\d+e\d+)\b/i.test(t)) return true;
  if (/^friends$/i.test(t.trim())) return true;
  return false;
}

function cleanTopic(q: string): string | null {
  let s = q
    .replace(/["'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(/\s+\|\s+.*$/, "").trim();
  if (/\bgmail\b/i.test(s)) return null;
  if (/^(friends|netflix|spotify)$/i.test(s)) return null;
  const words = s.split(" ").filter(Boolean);
  if (words.length >= 3 && /^ai$/i.test(words[words.length - 1]!)) {
    s = words.slice(0, -1).join(" ");
  }
  if (s.length < 3 || s.length > 80) return null;
  if (/^(https?:|www\.)/i.test(s)) return null;
  if (EMAIL_RE.test(s)) return null;
  if (/^\d+$/.test(s)) return null;
  return s;
}

/**
 * On-box parser: window/search titles → a learning topic.
 * Does not invert isNoiseSurface (Gmail/Friends stay out).
 */
export function extractLearningTopic(
  title: string,
  key?: string | null,
): string | null {
  if (EMAIL_RE.test(title)) return null;
  if (!title.trim()) return extractSearchQueryFromUrl(key);
  let t = redactPii(title);
  if (!t) return null;
  t = t.replace(
    /\s+[-–—]\s+(Google Chrome|Microsoft Edge|Mozilla Firefox)$/i,
    "",
  );
  if (/\bgmail\b/i.test(t)) return null;
  if (/\b(claim your|one-time pack|unsubscribe)\b/i.test(t)) return null;

  const search = t.match(
    /^(.+?)\s+[-–—]\s+(Google Search|Bing|DuckDuckGo)$/i,
  );
  if (search?.[1]) return cleanTopic(search[1]);

  if (SEARCH_HOST_RE.test(key ?? "")) {
    const stripped = t.replace(
      /\s+[-–—]\s+(Google Search|Bing|DuckDuckGo).*$/i,
      "",
    );
    const fromTitle = cleanTopic(stripped || t);
    if (fromTitle) return fromTitle;
  }

  const wiki = t.match(/^(.+?)\s+[-–—]\s+Wikipedia$/i);
  if (wiki?.[1]) return cleanTopic(wiki[1]);

  const yt = t.match(/^(.+?)\s+[-–—]\s+YouTube$/i);
  if (yt?.[1] && !isEntertainmentTitle(yt[1])) {
    return cleanTopic(yt[1]);
  }

  return extractSearchQueryFromUrl(key);
}

/** Browser-history URLs keep `q=` even when artifact keys drop the query. */
export function extractSearchQueryFromUrl(url?: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const blob = `${u.hostname}${u.pathname}`;
    const q =
      u.searchParams.get("q") ??
      u.searchParams.get("p") ??
      u.searchParams.get("query") ??
      u.searchParams.get("search_query");
    if (!q?.trim()) return null;
    const isSearch =
      SEARCH_HOST_RE.test(blob) || /youtube\.com\/results/i.test(blob);
    if (!isSearch) return null;
    return cleanTopic(q.replace(/\+/g, " "));
  } catch {
    return null;
  }
}

export function normalizeLearningTopic(input: string): string | null {
  const extracted = extractLearningTopic(input);
  if (extracted) return extracted;
  return cleanTopic(redactPii(input));
}

/**
 * Rank by distinct events (one observation / history visit = 1).
 * Do not use collapsed artifact `touchCount` — that attributes every Google
 * search to the last title on `google.com/search`.
 */
export function rankLearningTopics(
  events: Array<{
    title?: string | null;
    key?: string | null;
    url?: string | null;
    touchCount?: number | null;
  }>,
): Array<{ topic: string; count: number }> {
  const map = new Map<string, { topic: string; count: number }>();
  for (const a of events) {
    const topic = extractLearningTopic(a.title ?? "", a.url ?? a.key);
    if (!topic) continue;
    const k = topic.toLowerCase();
    const prev = map.get(k);
    if (prev) prev.count += 1;
    else map.set(k, { topic, count: 1 });
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

export function topicMatches(saved: string, candidate: string): boolean {
  const a = saved.toLowerCase().trim();
  const b = candidate.toLowerCase().trim();
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (longer.includes(shorter) && shorter.length >= 8) return true;
  const aw = a.split(/\s+/).filter((w) => w.length > 2);
  const bw = new Set(b.split(/\s+/));
  if (aw.length >= 2 && aw.every((w) => bw.has(w))) return true;
  return false;
}

export function isHttpsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    if (u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    if (!host.includes(".")) return false;
    if (host === "localhost" || host.endsWith(".local")) return false;
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

/** Public learning hosts only — fail closed on unknown / lookalike sites. */
const SUGGESTION_HOST_ALLOW = [
  "wikipedia.org",
  "wikimedia.org",
  "youtube.com",
  "youtu.be",
  "github.com",
  "gitlab.com",
  "developer.mozilla.org",
  "stackoverflow.com",
  "stackexchange.com",
  "arxiv.org",
  "learn.microsoft.com",
  "docs.python.org",
  "docs.oracle.com",
  "nodejs.org",
  "react.dev",
  "pytorch.org",
  "tensorflow.org",
  "huggingface.co",
  "medium.com",
  "dev.to",
  "web.dev",
  "cloud.google.com",
  "developers.google.com",
  "aws.amazon.com",
  "openai.com",
  "anthropic.com",
  "cursor.com",
  "tauri.app",
  "rust-lang.org",
  "go.dev",
  "kotlinlang.org",
  "swift.org",
  "npmjs.com",
  "pypi.org",
  "crates.io",
  "neo4j.com",
  "langchain.com",
  "llamaindex.ai",
  "freecodecamp.org",
  "khanacademy.org",
  "coursera.org",
  "edx.org",
  "ocw.mit.edu",
  "w3.org",
  "ietf.org",
  "css-tricks.com",
];

function hostAllowedForSuggestion(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^www\./, "");
  return SUGGESTION_HOST_ALLOW.some((a) => h === a || h.endsWith(`.${a}`));
}

export function isAllowedSuggestionUrl(url: string): boolean {
  if (!isHttpsUrl(url)) return false;
  try {
    return hostAllowedForSuggestion(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function isWorkArtifact(a: {
  kind?: string | null;
  key?: string | null;
  title?: string | null;
}): boolean {
  const blob = `${a.kind ?? ""} ${a.key ?? ""} ${a.title ?? ""}`;
  if (isNoiseSurface(blob)) return false;
  if (EMAIL_RE.test(a.title ?? "")) return false;
  const kind = (a.kind ?? "").toLowerCase();
  if (kind === "file" || kind === "repo") return true;
  if (WORK_SURFACE_RE.test(blob)) return true;
  if (kind === "url" && WORK_URL_RE.test(blob)) return true;
  return false;
}

export function prettyApp(app: string): string {
  const a = app.trim();
  if (!a) return "Unknown";
  const k = a.toLowerCase();
  if (k === "chrome" || k === "msedge" || k === "brave" || k === "firefox") {
    return "Chrome";
  }
  if (k.includes("cursor")) return "Cursor";
  if (k === "code" || k.includes("vscode")) return "VS Code";
  if (k === "explorer") return "Explorer";
  if (k.includes("spotify")) return "Spotify";
  if (k.includes("snipping")) return "Snipping Tool";
  return a.charAt(0).toUpperCase() + a.slice(1);
}

export type InsightBlock = {
  app?: string | null;
  startAt: string;
  dwellMs: number;
};

export type AppSession = { app: string; dwellMs: number };

export function sessionizeByApp(blocks: InsightBlock[]): AppSession[] {
  const timed = [...blocks].sort((a, b) => a.startAt.localeCompare(b.startAt));
  const sessions: AppSession[] = [];
  for (const b of timed) {
    const app = (b.app ?? "unknown").toLowerCase();
    const last = sessions[sessions.length - 1];
    if (last && last.app === app) {
      last.dwellMs += b.dwellMs;
    } else {
      sessions.push({ app, dwellMs: b.dwellMs });
    }
  }
  return sessions;
}

export type FocusStats = {
  switches: number;
  topApps: Array<[string, number]>;
  deepWorkMs: number;
  totalMs: number;
  timedSessions: number;
};

export function focusStats(blocks: InsightBlock[]): FocusStats {
  const sessions = sessionizeByApp(blocks).filter((s) => s.dwellMs > 0);
  const byApp = new Map<string, number>();
  for (const s of sessions) {
    byApp.set(s.app, (byApp.get(s.app) ?? 0) + s.dwellMs);
  }
  const topApps = [...byApp.entries()].sort((a, b) => b[1] - a[1]);
  let deepWorkMs = 0;
  for (const s of sessions) {
    if (s.dwellMs >= 25 * 60_000) deepWorkMs += s.dwellMs;
  }
  return {
    switches: Math.max(0, sessions.length - 1),
    topApps,
    deepWorkMs,
    totalMs: sessions.reduce((n, s) => n + s.dwellMs, 0),
    timedSessions: sessions.length,
  };
}

export function extractSkillHint(input: {
  artifacts: Array<{ title: string; key?: string | null; kind?: string | null }>;
  github: Array<{ title: string; url?: string | null }>;
}): string | null {
  for (const g of input.github) {
    const fromUrl = g.url?.match(/github\.com\/([^/]+\/[^/]+)/i)?.[1];
    if (fromUrl) return fromUrl.replace(/\.git$/, "");
    const fromTitle = g.title.match(/\b([\w.-]+\/[\w.-]+)\b/);
    if (fromTitle?.[1] && fromTitle[1].includes("/")) return fromTitle[1];
  }
  for (const a of input.artifacts) {
    if (!isWorkArtifact(a)) continue;
    const t = redactPii(a.title);
    const dash = t.match(/\s[-–—]\s+([^|]+)$/);
    const proj = dash?.[1]?.trim();
    if (proj && !/cursor|visual studio|chrome/i.test(proj)) {
      return proj.slice(0, 60);
    }
    const file = t.match(/([\w.-]+\.(ts|tsx|js|jsx|rs|py|go|md))\b/i);
    if (file?.[1]) return file[1];
  }
  return null;
}

export const INSIGHT_KIND_LABEL: Record<string, string> = {
  learn: "Learn",
  progress: "Progress",
};
