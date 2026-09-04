/**
 * Zero-friction chat follow-ups from the focused window.
 * OCR the visible thread to tell an ask from idle chat. Never send.
 * Contact names stay off Improve. Local LLM only (skipHosted).
 */

import {
  isBrowserSurface,
  isSelfName,
  looksLikeMarket,
  segmentChatCapture,
  selfNamesFromSurface,
} from "@second-brain/core";

export type ChatApp =
  | "WhatsApp"
  | "Telegram"
  | "Slack"
  | "Discord"
  | "Signal"
  | "Teams";

const GENERIC_PEER_RE =
  /^(whatsapp|whatsapp web|telegram|telegram web|telegram desktop|chats?|new chats|status|archived|settings|saved messages|calls?|communities|starred|unread|this chat|connecting|loading|never miss a message!?|\d+ notifications?)$/i;

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

/** WhatsApp / Telegram chrome that is not a message. */
const CHAT_CHROME_LINE_RE =
  /^(type a message|search or start new chat|search|chats|status|calls|communities|archived|starred|unread|online|last seen|click here for contact info|message yourself|today|yesterday|send a message|photo|video|gif|sticker|document|voice message|missed voice call|missed video call|whatsapp|telegram desktop|telegram)$/i;

const CHAT_CHROME_STRIP_RE =
  /\b(type a message|search or start new chat|click here for contact info|message yourself|missed voice call|missed video call|voice message|telegram desktop|whatsapp|telegram)\b/gi;

const ACTIONABLE_CHAT_RE =
  /\b(can you|could you|would you|please (send|share|call|confirm|check|review|reply|forward|ping)|send me|share (the|it|with)|call me|ping me|remind me|don't forget|do not forget|when (will|are|is)|are you (coming|free|around)|let'?s (meet|call|sync)|need you to|waiting (on|for)|confirm (the|by)|review (this|the)|by (tonight|tomorrow|tornorrow|eod|friday|monday|evening)|tomorrow at|meeting at|what time|free at|i('ll| will)|i (need|have) to|i send the|let me (send|check|ask)|action item|todo|follow[- ]?up|bhej|call kar|aa ?ja|kal (mil|call)|kab (tak|aa))\b/i;

/** The user committing to something, as opposed to being asked for it. */
export const MY_PROMISE_RE =
  /\b(i('ll| will)|i need to|i have to|i should|i send the|let me (send|share|check|ask))\b/i;

/**
 * An outgoing message. The macOS capture prefixes right-aligned bubbles with
 * `You: `; WhatsApp and Telegram print the same prefix on sidebar previews.
 */
export const OUTGOING_PREFIX_RE = /^\s*you\s*:/i;

const IDLE_CHAT_RE =
  /^(ok+|okay|k+|lol+|haha+|hehe+|thanks?|thx|ty|gm+|gn+|yes|yeah|yep|no|nah|hmm+|nice|cool|great|wow|👍|🙏|😂|❤️|ok sir|done|noted)\.?$/i;

export function detectChatApp(
  app?: string | null,
  exe?: string | null,
  title?: string | null,
  url?: string | null,
): ChatApp | null {
  const t = `${app ?? ""} ${exe ?? ""} ${title ?? ""} ${url ?? ""}`.toLowerCase();
  if (/whatsapp|web\.whatsapp/.test(t)) return "WhatsApp";
  if (/telegram|web\.telegram|\bt\.me\b/.test(t)) return "Telegram";
  if (/\bslack\b/.test(t)) return "Slack";
  if (/\bdiscord\b/.test(t)) return "Discord";
  if (/\bsignal\b/.test(t)) return "Signal";
  if (/\bteams\b/.test(t) || /ms-teams/.test(t)) return "Teams";
  return null;
}

export function isChatSurface(
  app?: string | null,
  exe?: string | null,
  title?: string | null,
  url?: string | null,
): boolean {
  return detectChatApp(app, exe, title, url) !== null;
}

/**
 * "Farhan - WhatsApp" / native app title "WhatsApp" + OCR header.
 */
export function parseChatPeer(
  title: string,
  app?: string | null,
  exe?: string | null,
  url?: string | null,
  ocrText?: string | null,
): { peer: string; app: ChatApp } | null {
  const chatApp = detectChatApp(app, exe, title, url);
  if (!chatApp) return null;
  const surface = { app, exe, windowTitle: title, url };
  const selfNames = selfNamesFromSurface(surface);

  // A web chat client titles its tab with the site and the browser profile —
  // "Telegram Web - Google Chrome – Karan" — never with the contact. Only a
  // native window ("Farhan - WhatsApp") carries the peer in its title.
  const fromTitle = isBrowserSurface(surface)
    ? null
    : peerFromWindowTitle(title, chatApp, selfNames);
  if (fromTitle) return { peer: fromTitle, app: chatApp };
  const fromOcr = peerFromChatOcr(ocrText ?? "", chatApp, surface, selfNames);
  if (fromOcr) return { peer: fromOcr, app: chatApp };
  return null;
}

function peerFromWindowTitle(
  title: string,
  chatApp: ChatApp,
  selfNames: string[],
): string | null {
  if (!title.trim()) return null;
  let t = title
    .replace(/^\(\d+\)\s+/, "")
    .replace(/\s+\(\d+\)$/, "")
    // Consume the browser name *and everything after it* — Chrome appends the
    // profile name ("… - Google Chrome – Karan"), which is the user, not a peer.
    .replace(
      /\s*[-–—|]\s*(Google Chrome|Chromium|Chrome|Microsoft Edge|Edge|Mozilla Firefox|Firefox|Safari|Arc|Brave|Opera|Vivaldi)\b[\s\S]*$/i,
      "",
    )
    .trim();
  t = t
    .replace(
      /\s+[-–—]\s+(WhatsApp|Telegram Desktop|Telegram|Slack|Discord|Signal|Microsoft Teams|Teams).*$/i,
      "",
    )
    // Native titles name the signed-in account, not the thread.
    .replace(/^(Telegram|WhatsApp|Signal)\s*[@(].*$/i, "")
    .trim();
  return sanitizePeer(t, chatApp, selfNames);
}

function sanitizePeer(
  t: string,
  _app: ChatApp,
  selfNames: string[] = [],
): string | null {
  const s = t.replace(/\s+/g, " ").trim();
  if (!s || GENERIC_PEER_RE.test(s)) return null;
  if (isSelfName(s, selfNames)) return null;
  if (/(google chrome|chromium|microsoft edge|mozilla firefox|safari|brave|vivaldi)/i.test(s)) {
    return null;
  }
  if (s.length < 2 || s.length > 60) return null;
  if (EMAIL_RE.test(s)) return null;
  if (/^(https?:|www\.)/i.test(s)) return null;
  if (/^[0-9+\s()-]{6,}$/.test(s)) return null;
  if (/\.pdf\b/i.test(s) || /^0x[0-9a-f]/i.test(s)) return null;
  if (/^\d{1,2}\/\d{1,2}/.test(s)) return null;
  if (
    /^(you|me|type a message|click here|all|unread|favorites|search|header)$/i.test(
      s,
    )
  ) {
    return null;
  }
  if (/click here|contact info|start a new chat|type a message/i.test(s)) {
    return null;
  }
  if (/["']/.test(s) || /N"\s*v"/.test(s)) return null;
  if (/^(i will|i send|can you|could you|please |you:)/i.test(s)) return null;
  // A name is not a sentence. Without this the fallback line scan happily made
  // "I need to complete Trench changes by tomorrow" the person to follow up with.
  if (s.split(/\s+/).length > 5) return null;
  if (MY_PROMISE_RE.test(s) || ACTIONABLE_CHAT_RE.test(s)) return null;
  return s;
}

/** Native WhatsApp.Root / Telegram Desktop: OS title is just the app name. */
function headerNameBits(headerLine: string): string[] {
  const cleaned = headerLine
    .replace(/\b(click here( for contact info)?|video call|voice call|search)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const withoutYou = cleaned.replace(/\bYou\b/g, " ").replace(/\s+/g, " ").trim();
  return [withoutYou, ...cleaned.split(/\s{2,}| · /)]
    .map((s) => s.replace(/\bYou\b/gi, "").replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 2);
}

function peerFromChatOcr(
  text: string,
  chatApp: ChatApp,
  surface: Parameters<typeof segmentChatCapture>[1] = {},
  selfNames: string[] = [],
): string | null {
  if (!text.trim()) return null;
  const headerLine = text.match(/^HEADER:\s*(.+)$/im)?.[1] ?? "";
  for (const bit of headerNameBits(headerLine)) {
    const peer = sanitizePeer(bit, chatApp, selfNames);
    if (peer) return peer;
  }

  // The thread header names the contact; the sidebar names fifteen other people.
  const segment = segmentChatCapture(text, surface);
  if (segment.header) {
    const peer = sanitizePeer(segment.header, chatApp, selfNames);
    if (peer) return peer;
  }

  const blob = text.replace(/\s+/g, " ").trim();
  if (chatApp === "WhatsApp") {
    const header = blob.match(
      /start a new chat\s+(.+?)\s+(click here|all\b|unread|favorites|favou?rites|type a)/i,
    );
    if (header?.[1]) {
      const peer = sanitizePeer(header[1].trim(), chatApp, selfNames);
      if (peer) return peer;
    }
  }
  // Scanning the top of the blob only makes sense when nothing above told us
  // where the thread starts — otherwise it picks up window and sidebar chrome.
  if (segment.view !== "unknown") return null;
  const lines = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^HEADER:/i.test(l));
  for (const line of lines.slice(0, 6)) {
    const peer = sanitizePeer(line, chatApp, selfNames);
    if (peer) return peer;
  }
  return null;
}

export function chatFollowUpTitle(peer: string, app: ChatApp, topic?: string): string {
  const hint = (topic ?? "").trim();
  if (hint.length >= 4 && hint.length <= 80) {
    return `Follow up with ${peer} on ${app} about ${hint}`;
  }
  return `Follow up with ${peer} on ${app}`;
}

function softenOcr(s: string): string {
  return s
    .replace(/tornorrow/gi, "tomorrow")
    .replace(/tonwrrow/gi, "tomorrow")
    .replace(/tommorow/gi, "tomorrow")
    .replace(/tommorrow/gi, "tomorrow")
    .replace(/ton-?xyrow/gi, "tomorrow")
    .replace(/\bto[mn][a-z]{0,4}r+[a-z]{0,2}o?w+\b/gi, "tomorrow")
    .replace(/\bpaymen\b/gi, "payment");
}

function selfNoteTitle(topic: string): string {
  const t = softenOcr(topic)
    .replace(/^you:\s*/i, "")
    .replace(/^i('ll| will)\s+/i, "")
    .replace(/^i send the\s+/i, "Send the ")
    .replace(/^please\s+/i, "")
    .trim();
  if (t.length >= 4 && t.length <= 80) {
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  return softenOcr(topic).slice(0, 80);
}

export type ChatActionHit = {
  score: number;
  actionTitle: string;
  snippet: string;
  topic?: string;
  /**
   * Who wrote the line this came from. `undefined` means the capture does not
   * say — screen text alone often cannot, and guessing inverts the task.
   */
  fromMe?: boolean;
  peer?: string;
};

function stripChatChrome(text: string): string {
  return text
    .replace(CHAT_CHROME_STRIP_RE, " ")
    .replace(/\b\d{1,2}:\d{2}(\s?[ap]m)?\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isOcrGarbage(s: string): boolean {
  const q = (s.match(/["']/g) ?? []).length;
  if (q >= 2) return true;
  if (/N"\s*v"|bi["']|ton-xyrow/i.test(s)) return true;
  return false;
}

/** The newest commitment wins — a thread repeats and supersedes itself. */
function lastMatch(body: string, re: RegExp): string | undefined {
  const all = [...body.matchAll(new RegExp(re.source, `${re.flags.replace(/g/g, "")}g`))];
  return all.length > 0 ? all[all.length - 1][0] : undefined;
}

function topicFromSnippet(text: string): string | undefined {
  const body = softenOcr(text.replace(/^HEADER:.*$/im, " "));
  const patterns = [
    /\bi will send[\s\S]{0,70}?(tomorrow|tornorrow|tonwrrow|tonight|friday|monday|eod)\b/i,
    /\bi('ll| will) [\s\S]{0,70}?(tomorrow|tornorrow|tonwrrow|tonight|friday|monday)\b/i,
    /\bi (need|have) to [\s\S]{0,70}?(tomorrow|tonight|today|friday|monday|eod)\b/i,
    /\bi send the[\s\S]{0,50}?(tomorrow|tornorrow|tonight)\b/i,
    /\bcan you [\s\S]{0,70}?(tomorrow|tonight|\?)/i,
    /\bplease [\s\S]{0,60}?(tomorrow|tonight|confirm|send)\b/i,
  ];
  for (const re of patterns) {
    const hit = lastMatch(body, re);
    if (!hit || isOcrGarbage(hit)) continue;
    let chunk = softenOcr(hit)
      .replace(/\s+\d{1,2}:\d{2}\b[\s\S]*$/i, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    chunk = chunk.replace(/["']+/g, "").replace(/\s+/g, " ").trim();
    if (chunk.length >= 10 && chunk.length <= 80) return chunk;
  }
  const m = ACTIONABLE_CHAT_RE.exec(body);
  if (!m || m.index == null) return undefined;
  let chunk = body
    .slice(m.index, m.index + 70)
    .replace(/\btype a message\b[\s\S]*/i, "")
    .replace(/\s+\d{1,2}:\d{2}\b[\s\S]*/i, "")
    .replace(/["']+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (chunk.length < 10 || IDLE_CHAT_RE.test(chunk) || isOcrGarbage(chunk)) {
    return undefined;
  }
  return softenOcr(chunk).slice(0, 72);
}

/**
 * A named chat is not a loop by itself. Visible messages must contain an ask
 * or commitment; idle "ok / lol" threads are dropped.
 */
export function scoreChatAction(input: {
  windowTitle?: string | null;
  app?: string | null;
  exe?: string | null;
  url?: string | null;
  text?: string | null;
}): ChatActionHit | null {
  const chatApp = detectChatApp(
    input.app,
    input.exe,
    input.windowTitle,
    input.url,
  );
  if (!chatApp) return null;
  const raw = (input.text ?? "").trim();
  if (raw.length < 12) return null;
  if (looksLikeMarket(raw)) return null;

  const cleaned = stripChatChrome(raw);
  if (cleaned.length < 8) return null;

  if (!ACTIONABLE_CHAT_RE.test(cleaned) && !ACTIONABLE_CHAT_RE.test(raw)) {
    return null;
  }

  const parsed = parseChatPeer(
    input.windowTitle ?? "",
    input.app,
    input.exe,
    input.url,
    input.text,
  );
  const peer = parsed?.peer;

  const lines = raw
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 1 && !CHAT_CHROME_LINE_RE.test(l) && !IDLE_CHAT_RE.test(l));

  const topic = topicFromSnippet(raw) ?? topicFromSnippet(cleaned);
  const fromMe = directionOf(raw, topic, input);
  const snippet = softenOcr(
    (topic ?? lines.slice(-2).join(" · ") ?? cleaned)
      .replace(/["']+/g, "")
      .slice(0, 200),
  );
  // Only claim "follow up with <peer>" when we know both the peer and that the
  // commitment was theirs. Otherwise the topic seeds the extractor and the model
  // names the person from the thread.
  const actionTitle =
    fromMe === true && topic
      ? selfNoteTitle(topic)
      : peer
        ? chatFollowUpTitle(peer, chatApp, topic ? softenOcr(topic) : undefined)
        : topic
          ? softenOcr(topic)
          : null;
  if (!actionTitle) return null;
  return { score: 0.78, actionTitle, snippet, topic, fromMe, peer };
}

/**
 * `true` the user wrote it, `false` the other person did, `undefined` unknown.
 *
 * A first-person line is not evidence — the other person's messages read
 * "I will …" too, and treating that as the user's own promise is what turned
 * their commitment into the user's task. Only an explicit outgoing marker
 * counts: the capture's `You: ` prefix, or the sidebar row for this thread.
 */
function directionOf(
  raw: string,
  topic: string | undefined,
  input: { app?: string | null; exe?: string | null; windowTitle?: string | null; url?: string | null },
): boolean | undefined {
  const markedLines = raw.split(/\n/).some((l) => OUTGOING_PREFIX_RE.test(l));
  if (raw.includes("\n") && markedLines && topic) {
    const needle = softenOcr(topic).slice(0, 24).toLowerCase();
    const line = raw
      .split(/\n/)
      .find((l) => softenOcr(l).toLowerCase().includes(needle));
    if (line) return OUTGOING_PREFIX_RE.test(line);
  }
  const row = segmentChatCapture(raw, {
    app: input.app,
    exe: input.exe,
    windowTitle: input.windowTitle,
    url: input.url,
  }).peerRow;
  if (row?.fromMe) return true;
  // Single-line OCR carries no line structure; fall back to the pairing that
  // has always worked there — an outgoing marker plus a first-person promise.
  if (/\byou\s*:/i.test(raw) && MY_PROMISE_RE.test(raw)) return true;
  return undefined;
}
