import { google } from "googleapis";
import {
  getAuthedClient,
  googleStatus,
} from "./google-auth.js";
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
import { getDb, settings } from "@second-brain/core";
import { eq } from "drizzle-orm";

async function rememberGmailIdentity(
  gmail: ReturnType<typeof google.gmail>,
): Promise<void> {
  try {
    const profile = await gmail.users.getProfile({ userId: "me" });
    const email = profile.data.emailAddress?.trim();
    if (!email) return;
    const db = getDb();
    const key = "google.userEmail";
    const valueJson = JSON.stringify(email);
    const existing = db.select().from(settings).where(eq(settings.key, key)).get();
    const now = new Date().toISOString();
    if (existing) {
      db.update(settings)
        .set({ valueJson, updatedAt: now })
        .where(eq(settings.key, key))
        .run();
    } else {
      db.insert(settings).values({ key, valueJson, updatedAt: now }).run();
    }
  } catch {
    /* identity is optional for sync */
  }
}

function decodeBody(data?: string | null): string {
  if (!data) return "";
  try {
    const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return "";
  }
}

/**
 * HTML-only mail would otherwise store raw markup, which then leaks into loop
 * titles, descriptions, and LLM prompts as unreadable soup.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<!doctype[^>]*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractHeader(
  headers: { name?: string | null; value?: string | null }[] | undefined,
  name: string,
): string {
  return (
    headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())
      ?.value ?? ""
  );
}

function classifyEmail(from: string, subject: string, labels: string[]): string {
  const f = from.toLowerCase();
  const s = subject.toLowerCase();
  if (labels.includes("CATEGORY_PROMOTIONS") || /unsubscribe|newsletter|digest/i.test(s + f))
    return "newsletter";
  if (labels.includes("CATEGORY_UPDATES") || /notification|alert|noreply|no-reply/i.test(f))
    return "notification";
  return "email";
}

async function fetchMessage(
  gmail: ReturnType<typeof google.gmail>,
  id: string,
): Promise<NormalizedItem | null> {
  const res = await gmail.users.messages.get({
    userId: "me",
    id,
    format: "full",
  });
  const msg = res.data;
  const headers = msg.payload?.headers;
  const subject = extractHeader(headers, "Subject") || "(no subject)";
  const from = extractHeader(headers, "From");
  const to = extractHeader(headers, "To");
  const date = extractHeader(headers, "Date");
  const labels = msg.labelIds ?? [];

  let plain = "";
  let html = "";
  const walk = (part?: typeof msg.payload) => {
    if (!part) return;
    if (part.mimeType === "text/plain" && part.body?.data) {
      plain += decodeBody(part.body.data);
    } else if (part.mimeType === "text/html" && part.body?.data) {
      html += decodeBody(part.body.data);
    } else if (part.parts) {
      for (const p of part.parts) walk(p);
    } else if (part.body?.data && !plain && !html) {
      const raw = decodeBody(part.body.data);
      if (/<\/?(html|body|table|div|p)\b/i.test(raw)) html += raw;
      else plain += raw;
    }
  };
  walk(msg.payload);

  const body = plain.trim() || htmlToText(html);

  // Drop obvious spam / promo even if it slipped past the query
  if (
    labels.includes("SPAM") ||
    labels.includes("CATEGORY_PROMOTIONS") ||
    labels.includes("CATEGORY_SOCIAL")
  ) {
    return null;
  }

  const publishedAt = msg.internalDate
    ? new Date(Number(msg.internalDate)).toISOString()
    : date
      ? new Date(date).toISOString()
      : undefined;

  // First-run / general messages older than a week are ignored
  if (publishedAt && Date.now() - new Date(publishedAt).getTime() > 7 * 86400_000) {
    return null;
  }

  const subkind = classifyEmail(from, subject, labels);

  return {
    externalId: msg.id!,
    kind: subkind === "email" ? "email" : subkind,
    title: subject,
    body: body.slice(0, 20_000),
    author: from,
    url: `https://mail.google.com/mail/u/0/#inbox/${msg.threadId}`,
    publishedAt,
    meta: {
      threadId: msg.threadId,
      labelIds: labels,
      snippet: msg.snippet,
      subkind,
      to,
      fromMe: labels.includes("SENT"),
    },
    raw: {
      id: msg.id,
      threadId: msg.threadId,
      snippet: msg.snippet,
      labelIds: labels,
      headers: { subject, from, to, date },
    },
  };
}

export async function syncGmail(): Promise<ConnectorResult> {
  const sourceId = "src-gmail";
  getSource(sourceId);

  const status = await googleStatus();
  if (!status.connected) {
    throw new Error("Google not connected");
  }

  const auth = await getAuthedClient();
  const gmail = google.gmail({ version: "v1", auth });
  const cursor = readCursor(sourceId);
  let historyId = cursor.historyId as string | undefined;
  const items: NormalizedItem[] = [];

  try {
    if (!historyId) {
      // First sync / backfill: last 7 days, skip spam & promos
      log.info("Gmail full backfill (7 days, spam-filtered)");
      const list = await withBackoff(
        () =>
          gmail.users.messages.list({
            userId: "me",
            q: "newer_than:7d -in:spam -category:promotions -category:social -category:forums",
            maxResults: 50,
          }),
        { label: "gmail.list" },
      );
      const ids = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);
      for (const id of ids) {
        const item = await withBackoff(() => fetchMessage(gmail, id), {
          label: `gmail.get ${id}`,
        });
        if (item) items.push(item);
      }
      const profile = await gmail.users.getProfile({ userId: "me" });
      historyId = profile.data.historyId ?? undefined;
    } else {
      log.info("Gmail incremental sync", { historyId });
      try {
        const hist = await gmail.users.history.list({
          userId: "me",
          startHistoryId: historyId,
          historyTypes: ["messageAdded"],
          maxResults: 100,
        });
        const ids = new Set<string>();
        for (const h of hist.data.history ?? []) {
          for (const a of h.messagesAdded ?? []) {
            if (a.message?.id) ids.add(a.message.id);
          }
        }
        for (const id of ids) {
          try {
            const item = await fetchMessage(gmail, id);
            if (item) items.push(item);
          } catch {
            // deleted / permission
          }
        }
        if (hist.data.historyId) historyId = hist.data.historyId;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("404") || msg.includes("historyId")) {
          log.warn("Gmail history expired — full backfill next run");
          writeCursor(sourceId, {});
          return { fetched: 0, upserted: 0 };
        }
        throw e;
      }
    }

    const upserted = upsertItems(sourceId, items);
    await rememberGmailIdentity(gmail);
    writeCursor(sourceId, { historyId });
    return { fetched: items.length, upserted, cursor: { historyId } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setSourceError(sourceId, msg);
    throw e;
  }
}
