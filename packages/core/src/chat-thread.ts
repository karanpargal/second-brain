/**
 * Split a raw chat-surface capture into the open thread and everything else.
 *
 * macOS reads chat apps through the Accessibility tree, which returns the whole
 * window in one blob: the sidebar conversation list first, then the open thread,
 * then browser chrome. Storing the head of that blob keeps fifteen other
 * people's chat previews and throws the actual conversation away, so loops got
 * mined from the sidebar. Everything here runs before the capture is truncated.
 *
 * Windows crops the thread pane in pixels and prefixes a `HEADER:` line, so that
 * path is already clean and is passed through untouched.
 */

const HEADER_RE = /^HEADER:\s*(.+)$/im;

/**
 * "Wini 💕 " → "Wini". Rows carry emoji plus private-use glyphs from the
 * client's own icon font (Telegram draws its sent/read ticks as U+E9xx).
 */
const PICTOGRAPH_RE =
  /[\p{Extended_Pictographic}\p{Private_Use}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]/gu;

/**
 * A sidebar row: name, a time-ish token, then the last message preview.
 * Real Telegram rows range from `Hercules  10:27 PM bolta` to
 * `ICP HUB India > Crewsphere  11:01 PM Crossing Classes: We need a lot...`.
 * Thread lines never match — their timestamps sit on their own line.
 */
const SIDEBAR_ROW_RE =
  /^(.{1,60}?)\s+(\d{1,2}:\d{2}\s*[AP]M|Mon|Tue|Wed|Thu|Fri|Sat|Sun|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+(.{2,})$/;

/** The thread header prints the contact's presence right under their name. */
const PRESENCE_RE =
  /^(last seen\b|online$|typing\b|is typing\b|\d+\s+members?\b|\d+\s+subscribers?\b)/i;

/** Where the thread ends and the composer begins. */
const COMPOSER_RE =
  /^(message|message #.*|type a message|write a message|send a message|reply)$/i;

/** Browser and app chrome that trails the composer. */
const TRAILING_CHROME_RE =
  /^(tab search|close|new tab|open call|end|open gemini in chrome|this button also has an action.*|.*- memory usage - \d+ mb)$/i;

/** Sidebar chrome above the thread. */
const LIST_CHROME_RE =
  /^(search|new chats|update|updating\.\.\.|never miss a message!|enable notifications to stay updated\.|to get missing image descriptions.*|all|unread|favou?rites)$/i;

/** Telegram emits an element id line between a row and its expansion. */
const ELEMENT_ID_RE = /^\/[0-9a-f]{6,}-[0-9a-f-]{4,}$/i;

/** `09:54 PM` and `4 September 2026, 21:54:39` — printed next to every bubble. */
const BUBBLE_CLOCK_RE = /^\d{1,2}:\d{2}(:\d{2})?\s*[AP]M$/i;
const BUBBLE_STAMP_RE =
  /^\d{1,2}\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4},?\s*\d{1,2}:\d{2}(:\d{2})?$/i;
const DATE_SEPARATOR_RE =
  /^(today|yesterday|mon|tue|wed|thu|fri|sat|sun|(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2})$/i;

/**
 * Link-preview blocks. The AX tree emits a one-line summary of the card and
 * then every child again, so the whole block is recognisable from its first
 * line: it opens with the source label and the rest of it repeats as substrings.
 * These blurbs are the most action-shaped prose in a chat capture and none of
 * it is a message.
 */
const PREVIEW_SOURCE_RE =
  /^(x \(formerly twitter\)|twitter|devpost|youtube|github|linkedin|instagram|medium|notion|reddit|substack)(?=\s|$)/i;

const BARE_URL_RE = /^https?:\/\/\S+$/i;

const BROWSER_NAME =
  "Google Chrome|Chromium|Chrome|Microsoft Edge|Edge|Mozilla Firefox|Firefox|Safari|Arc|Brave|Opera|Vivaldi";

/** Chrome titles a profile window `<page> - Google Chrome – <profile>`. */
const BROWSER_TAIL_RE = new RegExp(
  `\\s*[-–—|]\\s*(?:${BROWSER_NAME})\\b([\\s\\S]*)$`,
  "i",
);

const BROWSER_SURFACE_RE =
  /chrome|chromium|edge|firefox|safari|arc\b|brave|opera|vivaldi/i;

export type ChatView = "thread" | "list" | "unknown";

export type ChatSegment = {
  /** thread = the open conversation was found; list = sidebar only; unknown = leave it alone. */
  view: ChatView;
  /** Display name of the other party, when the thread header gave one. */
  header: string | null;
  /** Messages only. Null when the capture held no conversation. */
  thread: string | null;
  /** The sidebar row for the open thread, when it could be matched. */
  peerRow: { name: string; fromMe: boolean } | null;
  /** Lowercased names that are the user, never a counterparty. */
  selfNames: string[];
};

export type ChatSurface = {
  app?: string | null;
  exe?: string | null;
  windowTitle?: string | null;
  url?: string | null;
  /** Extra self names, e.g. the local part of the signed-in mail account. */
  selfNames?: string[];
};

/** A web chat client titles its tab with the site, never with the contact. */
export function isBrowserSurface(ctx: ChatSurface): boolean {
  if (ctx.url && ctx.url.trim()) return true;
  return BROWSER_SURFACE_RE.test(`${ctx.app ?? ""} ${ctx.exe ?? ""}`);
}

function stripEmoji(s: string): string {
  return s.replace(PICTOGRAPH_RE, "").replace(/\s+/g, " ").trim();
}

function isEmojiOnly(s: string): boolean {
  const t = stripEmoji(s);
  return t.length === 0 && s.trim().length > 0;
}

/**
 * Names that belong to the user, harvested from the window title.
 * `Telegram Web - Google Chrome – Karan` ends with the Chrome profile name, and
 * that name was landing in `who` as if it were the person on the other side.
 */
export function selfNamesFromSurface(ctx: ChatSurface): string[] {
  const out = new Set<string>();
  const add = (raw?: string | null) => {
    const s = stripEmoji(raw ?? "").trim();
    if (s.length < 2 || s.length > 60) return;
    if (new RegExp(`^(?:${BROWSER_NAME})$`, "i").test(s)) return;
    out.add(s.toLowerCase());
    for (const tok of s.split(/[\s._-]+/)) {
      if (tok.length >= 3) out.add(tok.toLowerCase());
    }
  };

  const title = (ctx.windowTitle ?? "").trim();
  const tail = title.match(BROWSER_TAIL_RE)?.[1] ?? "";
  for (const bit of tail.split(/[-–—|]/)) add(bit);
  add(title.match(/^Telegram\s*@\s*(.+)$/i)?.[1]);
  add(title.match(/^WhatsApp\s*\((.+)\)$/i)?.[1]);
  for (const extra of ctx.selfNames ?? []) add(extra);
  return [...out];
}

export function isSelfName(name: string, selfNames: string[]): boolean {
  const s = stripEmoji(name).toLowerCase().trim();
  if (!s) return false;
  if (selfNames.includes(s)) return true;
  const tokens = s.split(/\s+/).filter((t) => t.length >= 3);
  return tokens.length > 0 && tokens.every((t) => selfNames.includes(t));
}

function isSidebarRow(line: string): RegExpMatchArray | null {
  const m = line.match(SIDEBAR_ROW_RE);
  if (!m) return null;
  // A message that happens to mention a clock ("Meeting at 10:30 AM tomorrow")
  // would match too; require the name side to look like a name, not a sentence.
  const name = m[1].trim();
  if (!name || name.length > 60) return null;
  if (name.split(/\s+/).length > 6) return null;
  return m;
}

/** Telegram prefixes your own last message with `You:` — present only sometimes. */
function rowFromMe(preview: string): boolean {
  return /^\s*you\s*:/i.test(preview);
}

function cleanThreadLines(lines: string[], windowTitle: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let previewSummary: string | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!/[\p{L}\p{N}]/u.test(line)) continue;
    if (previewSummary) {
      // Still inside a link-preview card: its children repeat its summary.
      if (previewSummary.includes(line)) continue;
      previewSummary = null;
    }
    if (line === windowTitle) continue;
    if (ELEMENT_ID_RE.test(line)) continue;
    if (LIST_CHROME_RE.test(line)) continue;
    if (TRAILING_CHROME_RE.test(line)) continue;
    if (BUBBLE_CLOCK_RE.test(line)) continue;
    if (BUBBLE_STAMP_RE.test(line)) continue;
    if (DATE_SEPARATOR_RE.test(line)) continue;
    if (PREVIEW_SOURCE_RE.test(line)) {
      previewSummary = line;
      continue;
    }
    if (BARE_URL_RE.test(line)) continue;
    if (isEmojiOnly(line)) continue;
    // The AX walk emits a row's summary and then each of its children, and the
    // same commitment can be repeated across bubbles. Keep the first copy only.
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

/**
 * Segment a chat capture. Never throws; falls back to `unknown` (leave the text
 * as it was) rather than dropping a surface it does not recognise.
 */
export function segmentChatCapture(
  text: string,
  ctx: ChatSurface = {},
): ChatSegment {
  const selfNames = selfNamesFromSurface(ctx);
  const empty: ChatSegment = {
    view: "unknown",
    header: null,
    thread: text || null,
    peerRow: null,
    selfNames,
  };
  if (!text || !text.trim()) return { ...empty, thread: null };

  // Windows already cropped the thread pane and named the contact.
  const headerLine = text.match(HEADER_RE)?.[1]?.trim();
  if (headerLine) {
    const body = text.replace(HEADER_RE, "").trim();
    return {
      view: "thread",
      header: stripEmoji(headerLine) || headerLine,
      thread: body || text,
      peerRow: null,
      selfNames,
    };
  }

  const windowTitle = (ctx.windowTitle ?? "").trim();
  const lines = text.split(/\r?\n/);

  const rowIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isSidebarRow(lines[i])) rowIdx.push(i);
  }

  const anchorIdx = lines.findIndex((l) => PRESENCE_RE.test(l.trim()));
  const composerIdx = lines.findIndex((l) => COMPOSER_RE.test(l.trim()));

  // Sidebar rows only count when they sit above the open thread.
  const rowsBeforeThread = rowIdx.filter(
    (i) => (anchorIdx < 0 || i < anchorIdx) && (composerIdx < 0 || i < composerIdx),
  );

  if (anchorIdx >= 0) {
    const header = headerAbove(lines, anchorIdx);
    const start = anchorIdx + 1;
    const end = composerIdx > start ? composerIdx : lines.length;
    const thread = cleanThreadLines(lines.slice(start, end), windowTitle);
    if (thread.length > 0 && thread.join("\n").trim().length >= 24) {
      return {
        view: "thread",
        header,
        thread: thread.join("\n"),
        peerRow: matchPeerRow(lines, rowsBeforeThread, header),
        selfNames,
      };
    }
  }

  // A capture of the conversation list alone tells us nothing about any thread.
  if (rowsBeforeThread.length >= 3 && anchorIdx < 0 && composerIdx < 0) {
    return { view: "list", header: null, thread: null, peerRow: null, selfNames };
  }

  return empty;
}

/** The contact's name is the last substantive line above their presence line. */
function headerAbove(lines: string[], anchorIdx: number): string | null {
  for (let i = anchorIdx - 1; i >= 0 && i >= anchorIdx - 8; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    if (ELEMENT_ID_RE.test(line)) continue;
    if (LIST_CHROME_RE.test(line)) continue;
    if (isEmojiOnly(line)) continue;
    if (isSidebarRow(line)) continue;
    const name = stripEmoji(line);
    if (name.length >= 2 && name.length <= 60) return name;
  }
  return null;
}

/**
 * Tie the open thread back to its sidebar row, which is the only place Telegram
 * ever writes a `You:` prefix. Absence of the prefix proves nothing — Telegram
 * omits it on the selected row — so this is a positive signal only.
 */
function matchPeerRow(
  lines: string[],
  rowIdx: number[],
  header: string | null,
): { name: string; fromMe: boolean } | null {
  if (!header) return null;
  const want = header.toLowerCase();
  for (const i of rowIdx) {
    const m = isSidebarRow(lines[i]);
    if (!m) continue;
    const name = stripEmoji(m[1]);
    if (name.toLowerCase() !== want) continue;
    return { name, fromMe: rowFromMe(m[3]) };
  }
  return null;
}
