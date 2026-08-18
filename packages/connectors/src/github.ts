import {
  getSource,
  readCursor,
  writeCursor,
  setSourceError,
  upsertItems,
  type ConnectorResult,
  type NormalizedItem,
  log,
  withBackoff,
} from "./base.js";
import { resolveGithubToken, tryLoadGhCliToken } from "./github-auth.js";

const GH = "https://api.github.com";

async function ensureToken(): Promise<string | undefined> {
  let token = resolveGithubToken();
  if (!token) token = (await tryLoadGhCliToken()) ?? undefined;
  return token;
}

async function ghFetch(path: string, etag?: string) {
  const token = await ensureToken();
  if (!token) throw new Error("GitHub not connected — use Connect GitHub in the widget");
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "second-brain",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (etag) headers["If-None-Match"] = etag;
  const res = await fetch(`${GH}${path}`, { headers });
  return res;
}

export async function syncGithub(): Promise<ConnectorResult> {
  const sourceId = "src-github";
  getSource(sourceId);
  const token = await ensureToken();
  if (!token) {
    log.warn("GitHub not connected — skip github");
    return { fetched: 0, upserted: 0 };
  }

  const cursor = readCursor(sourceId);
  const items: NormalizedItem[] = [];

  try {
    // Notifications
    const notifRes = await withBackoff(
      () =>
        ghFetch(
          "/notifications?all=false&participating=false&per_page=50",
          cursor.notifEtag as string | undefined,
        ),
      { label: "github.notifications" },
    );
    if (notifRes.status !== 304) {
      const notifs = (await notifRes.json()) as Array<{
        id: string;
        reason: string;
        subject: { title: string; url?: string; type: string; latest_comment_url?: string };
        repository: { full_name: string; html_url: string };
        updated_at: string;
        unread: boolean;
      }>;
      if (Array.isArray(notifs)) {
        const weekAgo = Date.now() - 7 * 86400_000;
        for (const n of notifs) {
          const updated = new Date(n.updated_at).getTime();
          if (!Number.isNaN(updated) && updated < weekAgo) continue;
          // Prefer html subject URL when present
          const subjectUrl =
            typeof n.subject.url === "string"
              ? n.subject.url.replace(
                  "api.github.com/repos",
                  "github.com",
                ).replace(/\/pulls\//, "/pull/")
              : null;
          items.push({
            externalId: `notif-${n.id}`,
            kind: "notification",
            title: `[${n.repository.full_name}] ${n.subject.title}`,
            body: `Reason: ${n.reason} · ${n.subject.type}`,
            url: subjectUrl ?? n.repository.html_url,
            publishedAt: n.updated_at,
            author: n.repository.full_name,
            meta: { reason: n.reason, type: n.subject.type, unread: n.unread },
            raw: n,
          });
        }
      }
      const etag = notifRes.headers.get("etag");
      if (etag) cursor.notifEtag = etag;
    }

    // Issues assigned to me
    const issuesRes = await withBackoff(
      () => ghFetch("/issues?filter=assigned&state=open&per_page=30"),
      { label: "github.issues" },
    );
    if (issuesRes.ok) {
      const issues = (await issuesRes.json()) as Array<{
        id: number;
        number: number;
        title: string;
        body?: string;
        html_url: string;
        user?: { login: string };
        updated_at: string;
        pull_request?: unknown;
        repository?: { full_name: string };
        repository_url?: string;
      }>;
      for (const iss of issues) {
        const isPr = Boolean(iss.pull_request);
        items.push({
          externalId: `${isPr ? "pr" : "issue"}-${iss.id}`,
          kind: isPr ? "pr" : "issue",
          title: iss.title,
          body: (iss.body ?? "").slice(0, 10_000),
          url: iss.html_url,
          author: iss.user?.login,
          publishedAt: iss.updated_at,
          meta: {
            number: iss.number,
            repo: iss.repository?.full_name ?? iss.repository_url,
          },
          raw: iss,
        });
      }
    }

    const upserted = upsertItems(sourceId, items);
    writeCursor(sourceId, { ...cursor, since: new Date().toISOString() });
    return { fetched: items.length, upserted, cursor };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setSourceError(sourceId, msg);
    throw e;
  }
}
