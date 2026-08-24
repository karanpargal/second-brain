import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { api, type Health, type Insight, type OpenLoop } from "../lib/api";
import {
  blobToBase64,
  getAskSessionId,
  MIN_VOICE_MS,
  MIN_VOICE_PEAK,
  playAskAudioBase64,
  setAskSessionId,
  startVoiceSession,
  stopAskAudio,
  voiceErrorHint,
  type AskThreadTurn,
  type VoiceSession,
} from "../lib/ask-voice";
import clsx from "clsx";

type Filter =
  | "today"
  | "todo"
  | "improve"
  | "ask"
  | "open"
  | "resolved"
  | "all"
  | "urgent"
  | "gmail"
  | "github"
  | "pc"
  | "manual"
  | "chat";

type SourceFilter = Exclude<
  Filter,
  | "today"
  | "todo"
  | "improve"
  | "ask"
  | "open"
  | "resolved"
  | "all"
  | "urgent"
>;

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const mins = Math.round((Date.now() - t) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}

function startOfLocalDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

/** Human-friendly due from dueAt — never print raw ISO / "soon". */
function formatDue(dueAt?: string | null): {
  label: string;
  overdue: boolean;
} | null {
  if (!dueAt) return null;
  const ms = Date.parse(dueAt);
  if (Number.isNaN(ms)) return null;
  const dueDay = startOfLocalDay(new Date(ms));
  const today = startOfLocalDay(new Date());
  const daysUntil = Math.round(
    (dueDay.getTime() - today.getTime()) / 86_400_000,
  );
  if (daysUntil < 0) {
    const n = Math.abs(daysUntil);
    return {
      label: n === 1 ? "Overdue by 1 day" : `Overdue by ${n} days`,
      overdue: true,
    };
  }
  if (daysUntil === 0) return { label: "Due today", overdue: false };
  if (daysUntil === 1) return { label: "Due tomorrow", overdue: false };
  if (daysUntil < 7) {
    const weekday = dueDay.toLocaleDateString(undefined, { weekday: "short" });
    const day = dueDay.getDate();
    const month = dueDay.toLocaleDateString(undefined, { month: "short" });
    return { label: `Due ${weekday} ${day} ${month}`, overdue: false };
  }
  const day = dueDay.getDate();
  const month = dueDay.toLocaleDateString(undefined, { month: "short" });
  return { label: `Due ${day} ${month}`, overdue: false };
}

/** Person/company only — hide job-title strings that used to leak into who. */
function displayWho(who?: string | null): string | null {
  if (!who) return null;
  const s = who.trim();
  if (s.length < 2) return null;
  if (
    /\b(senior|junior|engineer|bengaluru|bangalore|role|position)\b/i.test(s) &&
    s.includes("/")
  ) {
    return null;
  }
  return s;
}

function isTodayIso(iso?: string | null): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function sourceMeta(loop: OpenLoop): {
  label: string;
  filter: SourceFilter;
  badge: string;
  color: string;
} {
  const blob = `${loop.title} ${loop.description ?? ""} ${loop.origin} ${loop.who ?? ""} ${loop.sourceKind ?? ""} ${loop.sourceLabel ?? ""} ${(loop.tags ?? []).join(" ")}`.toLowerCase();
  const url = (loop.sourceUrl ?? "").toLowerCase();
  const kind = (loop.sourceKind ?? "").toLowerCase();
  if (
    kind === "chat" ||
    (loop.tags ?? []).some((t) => t.toLowerCase() === "chat") ||
    /\bwhatsapp\b|\btelegram\b|\bfollow up with .+ on (whatsapp|telegram|slack|discord|signal|teams)\b/.test(
      blob,
    )
  )
    return {
      label: loop.who || loop.sourceLabel || "Chat",
      filter: "chat",
      badge: /telegram/.test(blob) ? "TG" : /whatsapp/.test(blob) ? "WA" : "CH",
      color: "bg-emerald-600 text-white",
    };
  if (
    kind === "pr" ||
    kind === "issue" ||
    url.includes("github.com") ||
    /\bgithub\b/.test(blob)
  )
    return {
      label: "GitHub",
      filter: "github",
      badge: "GH",
      color: "bg-zinc-900 text-white",
    };
  if (
    kind === "email" ||
    kind === "notification" ||
    url.includes("mail.google.com") ||
    blob.includes("gmail") ||
    blob.includes("email") ||
    blob.includes("@")
  )
    return {
      label: loop.who || "Gmail",
      filter: "gmail",
      badge: "M",
      color: "bg-red-500 text-white",
    };
  if (loop.origin === "manual")
    return {
      label: "Manual",
      filter: "manual",
      badge: "·",
      color: "bg-zinc-200 text-zinc-700",
    };
  return {
    label: loop.who || "PC",
    filter: "pc",
    badge: "PC",
    color: "bg-indigo-500 text-white",
  };
}

function categoryChip(category?: string | null): {
  label: string;
  className: string;
} {
  switch (category) {
    case "follow_up":
      return { label: "Follow up", className: "bg-indigo-100 text-indigo-800" };
    case "reply":
      return { label: "Reply", className: "bg-sky-100 text-sky-800" };
    case "billing":
      return { label: "Billing", className: "bg-amber-100 text-amber-900" };
    case "career":
      return { label: "Career", className: "bg-violet-100 text-violet-800" };
    case "review":
      return { label: "Review", className: "bg-zinc-200 text-zinc-800" };
    case "deadline":
      return { label: "Deadline", className: "bg-rose-100 text-rose-800" };
    case "calendar":
      return { label: "Calendar", className: "bg-teal-100 text-teal-800" };
    case "github":
      return { label: "GitHub", className: "bg-zinc-900 text-white" };
    default:
      return { label: "Task", className: "bg-zinc-100 text-zinc-600" };
  }
}

function insightKindLabel(kind: string): string {
  switch (kind) {
    case "learn":
      return "Learn";
    case "progress":
      return "Progress";
    case "action":
      return "Do this";
    default:
      return kind.replace(/_/g, " ");
  }
}

function relativeAgo(iso?: string | null): string {
  if (!iso) return "never";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "unknown";
  const mins = Math.round((Date.now() - ms) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 36) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function isHttpsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password;
  } catch {
    return false;
  }
}

function suggestionHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isUpskillLoop(loop: OpenLoop): boolean {
  if ((loop.tags ?? []).some((t) => t.toLowerCase() === "upskill")) return true;
  return /^learn:\s+/i.test(loop.title);
}

function learnTopicLabel(title: string): string {
  return title.replace(/^learn:\s+/i, "").trim() || title;
}

function extraTagLabel(tag: string): string | null {
  const t = tag.toLowerCase().replace(/[\s-]+/g, "_");
  if (t === "career") return "Career";
  if (t === "follow_up" || t === "followup") return null;
  if (t === "billing") return null;
  if (t === "github") return "GitHub";
  if (t === "sent") return "Sent";
  return tag.length > 1 ? tag.replace(/_/g, " ") : null;
}

function isUrgent(loop: OpenLoop): boolean {
  if (loop.dueAt) {
    const due = Date.parse(loop.dueAt);
    if (!Number.isNaN(due) && due - Date.now() <= 24 * 3600_000 && due >= Date.now() - 3600_000) {
      return true;
    }
  }
  if (loop.kind === "deadline" && (loop.priority ?? 0) >= 0.75) return true;
  return (loop.priority ?? 0) >= 0.9;
}

function viewBadge(id: Filter): string {
  switch (id) {
    case "today":
      return "TD";
    case "todo":
      return "TO";
    case "improve":
      return "↑";
    case "ask":
      return "AI";
    case "open":
      return "OP";
    case "resolved":
      return "✓";
    case "urgent":
      return "!";
    case "gmail":
      return "M";
    case "github":
      return "GH";
    case "chat":
      return "CH";
    case "manual":
      return "·";
    case "all":
      return "ALL";
    default:
      return "PC";
  }
}

function isTodaysActionable(loop: OpenLoop): boolean {
  if (loop.status !== "open" && loop.status !== "snoozed") return false;
  if (isUrgent(loop)) return false;
  if (loop.dueAt) {
    const due = Date.parse(loop.dueAt);
    if (!Number.isNaN(due)) {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date();
      end.setHours(23, 59, 59, 999);
      if (due >= start.getTime() && due <= end.getTime()) return true;
    }
  }
  return (loop.priority ?? 0) >= 0.7;
}

type TauriWindow = {
  core?: { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> };
  window?: {
    getCurrentWindow?: () => {
      startDragging: () => Promise<void>;
      hide?: () => Promise<void>;
    };
  };
  webviewWindow?: {
    getCurrentWebviewWindow?: () => {
      startDragging: () => Promise<void>;
      hide?: () => Promise<void>;
    };
  };
};

function tauriApi(): TauriWindow | null {
  const w = window as unknown as { __TAURI__?: TauriWindow };
  return w.__TAURI__ ?? null;
}

/** Tauri optional APIs — no-op in pure browser */
async function tauriInvoke(cmd: string, args?: Record<string, unknown>) {
  try {
    const api = tauriApi();
    if (api?.core?.invoke) {
      return await api.core.invoke(cmd, args);
    }
  } catch {
    /* browser / denied */
  }
  return null;
}

async function hideWidget() {
  try {
    const api = tauriApi();
    const win =
      api?.webviewWindow?.getCurrentWebviewWindow?.() ??
      api?.window?.getCurrentWindow?.();
    if (win?.hide) {
      await win.hide();
      return;
    }
  } catch {
    /* fall through */
  }
  await tauriInvoke("hide_widget");
  await tauriInvoke("plugin:window|hide");
}

async function quitApp() {
  await tauriInvoke("quit_app");
}

async function startWindowDrag() {
  try {
    const api = tauriApi();
    const win =
      api?.webviewWindow?.getCurrentWebviewWindow?.() ??
      api?.window?.getCurrentWindow?.();
    if (win?.startDragging) {
      await win.startDragging();
      return;
    }
    await tauriInvoke("plugin:window|start_dragging");
  } catch {
    /* ignore */
  }
}

async function openExternal(url: string) {
  if (!isHttpsUrl(url)) return;
  try {
    const api = tauriApi() as TauriWindow & {
      shell?: { open?: (u: string) => Promise<void> };
    };
    if (api?.shell?.open) {
      await api.shell.open(url);
      return;
    }
    await tauriInvoke("plugin:shell|open", { path: url });
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function onDragPointerDown(e: ReactPointerEvent) {
  // Only primary button; ignore interactive controls
  if (e.button !== 0) return;
  const t = e.target as HTMLElement | null;
  if (t?.closest("button, a, input, textarea, select, [data-no-drag]")) return;
  void startWindowDrag();
}

/** Mini orb: drag if pointer moves; click (no move) expands */
function useMiniOrbGesture(onExpand: () => void) {
  const origin = useRef<{ x: number; y: number } | null>(null);
  const dragging = useRef(false);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    origin.current = { x: e.clientX, y: e.clientY };
    dragging.current = false;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (!origin.current || dragging.current) return;
    const dx = e.clientX - origin.current.x;
    const dy = e.clientY - origin.current.y;
    if (dx * dx + dy * dy > 16) {
      dragging.current = true;
      void startWindowDrag();
    }
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    if (!origin.current) return;
    const wasDrag = dragging.current;
    origin.current = null;
    dragging.current = false;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    } catch {
      /* */
    }
    if (!wasDrag) onExpand();
  };

  return { onPointerDown, onPointerMove, onPointerUp };
}

export function WidgetPage() {
  const [open, setOpen] = useState<OpenLoop[]>([]);
  const [closed, setClosed] = useState<OpenLoop[]>([]);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [filter, setFilter] = useState<Filter>("open");
  const [compact, setCompact] = useState(false);
  const [pinned, setPinned] = useState(true);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [viewOpen, setViewOpen] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const viewRef = useRef<HTMLDivElement | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [connectMsg, setConnectMsg] = useState<string | null>(null);
  const [googleOk, setGoogleOk] = useState<boolean | null>(null);
  const [githubOk, setGithubOk] = useState<boolean | null>(null);
  const [healthInfo, setHealthInfo] = useState<Health | null>(null);
  const [axTrusted, setAxTrusted] = useState<boolean | null>(null);
  const [captureMethod, setCaptureMethod] = useState<string | null>(null);
  const [voice, setVoice] = useState<string | null>(null);
  const [learnWant, setLearnWant] = useState("");
  const [askQ, setAskQ] = useState("");
  const [askThread, setAskThread] = useState<AskThreadTurn[]>([]);
  const [askBusy, setAskBusy] = useState(false);
  const [voiceReady, setVoiceReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [askHint, setAskHint] = useState<string | null>(null);
  const [micLevel, setMicLevel] = useState(0);
  const voiceSessionRef = useRef<VoiceSession | null>(null);
  const sendingVoiceRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const [o, c, health, ins, now] = await Promise.all([
        api.loops("open"),
        api.loops("resolved"),
        api.health().catch(() => null),
        api.insights().catch(() => ({ insights: [] as Insight[] })),
        api.now().catch(() => null),
      ]);
      setOpen(o.loops);
      setClosed(c.loops.slice(0, 40));
      setInsights(ins.insights ?? []);
      const briefVoice = now?.brief?.voice?.trim() || null;
      const insightVoice = (ins.insights ?? [])
        .filter((i) => i.kind === "learn" || i.kind === "progress")
        .slice(0, 2)
        .map((i) => i.title.trim())
        .filter(Boolean)
        .join(" · ");
      if (briefVoice) {
        setVoice(briefVoice);
      } else if (insightVoice) {
        setVoice(insightVoice);
      } else if (o.loops.length > 0) {
        const picks = [
          ...o.loops.filter(isUrgent),
          ...o.loops.filter(isTodaysActionable),
          ...o.loops,
        ];
        const seen = new Set<string>();
        const titles: string[] = [];
        for (const l of picks) {
          if (seen.has(l.id)) continue;
          seen.add(l.id);
          titles.push(l.title);
          if (titles.length >= 3) break;
        }
        setVoice(titles.join(" · "));
      } else {
        setVoice("Connect Gmail when you want mail turned into today's work.");
      }
      setUpdatedAt(new Date());
      setErr(null);
      if (health) {
        setHealthInfo(health);
        setGoogleOk(
          Boolean(health.google?.connected) && !health.google?.needsReauth,
        );
        setGithubOk(Boolean(health.github?.connected));
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 20_000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    const refreshAx = async () => {
      try {
        const s = (await tauriInvoke("capture_status")) as {
          accessibility_trusted?: boolean;
          capture_method?: string;
        } | null;
        if (cancelled || !s) return;
        if (typeof s.accessibility_trusted === "boolean") {
          setAxTrusted(s.accessibility_trusted);
        }
        if (typeof s.capture_method === "string") {
          setCaptureMethod(s.capture_method);
        }
      } catch {
        /* browser / non-Tauri */
      }
    };
    void refreshAx();
    const id = setInterval(() => void refreshAx(), 8_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (!viewOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!viewRef.current?.contains(e.target as Node)) setViewOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setViewOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [viewOpen]);

  const todayCount = useMemo(
    () => open.filter(isTodaysActionable).length,
    [open],
  );

  const sourceCounts = useMemo(() => {
    const c: Record<string, number> = {
      urgent: 0,
      gmail: 0,
      github: 0,
      chat: 0,
      pc: 0,
      manual: 0,
    };
    for (const l of open) {
      if (isUrgent(l)) c.urgent++;
      const f = sourceMeta(l).filter;
      if (f in c) c[f]++;
    }
    return c;
  }, [open]);

  const todoCount = useMemo(
    () =>
      open.filter((l) => !isUrgent(l) && !isTodaysActionable(l)).length,
    [open],
  );

  const filtered = useMemo(() => {
    if (filter === "resolved") {
      return closed;
    }
    if (filter === "improve" || filter === "ask") {
      return [];
    }
    const base = open;
    return base.filter((l) => {
      if (filter === "today") return isTodaysActionable(l);
      if (filter === "todo") return !isUrgent(l) && !isTodaysActionable(l);
      if (filter === "open" || filter === "all") return true;
      if (filter === "urgent") return isUrgent(l);
      return sourceMeta(l).filter === filter;
    });
  }, [open, closed, filter]);

  const showingResolved = filter === "resolved";
  const showingImprove = filter === "improve";
  const showingAsk = filter === "ask";
  const showingOpenEmpty =
    !showingResolved && !showingImprove && !showingAsk && open.length === 0;
  const trackingLearn = open.filter(isUpskillLoop);

  const trackTopic = async (body: { insightId?: string; topic?: string }) => {
    const key = body.insightId ? `track:${body.insightId}` : "track-custom";
    setBusy(key);
    try {
      const r = await api.trackInsight(body);
      if (!r.ok) {
        setConnectMsg(r.error === "invalid topic" ? "That isn't a topic I can track." : "Couldn't track that.");
        return;
      }
      setLearnWant("");
      await load();
    } finally {
      setBusy(null);
    }
  };

  const act = async (id: string, status: string) => {
    await api.patchLoop(id, status);
    await load();
  };

  const markSpam = async (id: string) => {
    // Optimistic hide so the click always feels instant
    setOpen((prev) => prev.filter((l) => l.id !== id));
    setClosed((prev) => prev.filter((l) => l.id !== id));
    try {
      await api.markSpam(id);
      await load();
    } catch (e) {
      setConnectMsg(
        e instanceof Error
          ? `Spam failed: ${e.message}`
          : `Spam failed: ${String(e)}`,
      );
      await load();
    }
  };

  const markNotTracking = async (id: string) => {
    setOpen((prev) => prev.filter((l) => l.id !== id));
    setClosed((prev) => prev.filter((l) => l.id !== id));
    try {
      await api.markNotTracking(id);
      await load();
    } catch (e) {
      setConnectMsg(
        e instanceof Error
          ? `Not tracking failed: ${e.message}`
          : `Not tracking failed: ${String(e)}`,
      );
      await load();
    }
  };

  const setCompactMode = async (next: boolean) => {
    setCompact(next);
    await tauriInvoke("set_widget_mode", { compact: next });
  };

  const miniGesture = useMiniOrbGesture(() => {
    void setCompactMode(false);
  });

  const togglePin = async () => {
    const next = !pinned;
    setPinned(next);
    await tauriInvoke("set_always_on_top", { pinned: next });
  };

  const runConnectGoogle = async () => {
    setBusy("google");
    setConnectMsg("Opening Google sign-in in your browser…");
    try {
      const r = await api.connectGoogle();
      setConnectMsg(r.message ?? "Google connected");
      setGoogleOk(true);
    } catch (e) {
      setConnectMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      void load();
    }
  };

  const runConnectGithub = async () => {
    setBusy("github");
    setConnectMsg("Connecting GitHub…");
    try {
      const r = await api.connectGithub();
      setConnectMsg(r.message ?? (r.ok ? "GitHub connected" : "Could not connect"));
      setGithubOk(Boolean(r.ok || r.github?.connected));
    } catch (e) {
      setConnectMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      void load();
    }
  };

  const runSync = async () => {
    setBusy("sync");
    setConnectMsg("Syncing Gmail / GitHub / open loops…");
    try {
      const r = await api.syncNow();
      const created =
        r.loops && typeof r.loops === "object" && "created" in (r.loops as object)
          ? (r.loops as { created: number }).created
          : null;
      setConnectMsg(
        created != null
          ? `Sync done — ${created} new open loop(s)`
          : "Sync done",
      );
      await load();
    } catch (e) {
      setConnectMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    void api
      .voiceStatus()
      .then((r) => setVoiceReady(!!r.configured))
      .catch(() => setVoiceReady(false));
    return () => {
      stopAskAudio();
      void voiceSessionRef.current?.stop();
    };
  }, []);

  const pushTurns = (userText: string, assistantText: string) => {
    setAskThread((prev) => [
      ...prev.slice(-40),
      { id: `u-${Date.now()}`, role: "user", text: userText },
      { id: `a-${Date.now()}`, role: "assistant", text: assistantText },
    ]);
  };

  const submitAsk = async (e?: { preventDefault(): void }) => {
    e?.preventDefault();
    const q = askQ.trim() || "What should I focus on right now?";
    setAskBusy(true);
    setAskHint(null);
    stopAskAudio();
    try {
      const r = await api.ask(q, getAskSessionId());
      setAskSessionId(r.sessionId);
      pushTurns(q, r.answer);
      setAskQ("");
      setFilter("ask");
    } catch (err) {
      setAskHint(err instanceof Error ? err.message : String(err));
    } finally {
      setAskBusy(false);
    }
  };

  const cleanupMic = () => {
    voiceSessionRef.current = null;
    setMicLevel(0);
    setRecording(false);
  };

  const stopRecordingAndSend = async () => {
    if (sendingVoiceRef.current) return;
    const session = voiceSessionRef.current;
    if (!session) {
      cleanupMic();
      return;
    }
    sendingVoiceRef.current = true;
    let clip: { blob: Blob; mimeType: string; durationMs: number; peak: number };
    try {
      clip = await session.stop();
    } catch {
      cleanupMic();
      sendingVoiceRef.current = false;
      setAskHint("Could not finish the recording — try again.");
      return;
    }
    cleanupMic();

    if (clip.durationMs < MIN_VOICE_MS) {
      setAskHint("Press and hold Mic while you speak, then release.");
      sendingVoiceRef.current = false;
      return;
    }
    if (clip.peak < MIN_VOICE_PEAK) {
      setAskHint(
        "No speech in the clip (level bar stayed flat). Check Windows mic privacy for Second Brain, then hold Mic and watch the bar bounce.",
      );
      sendingVoiceRef.current = false;
      return;
    }
    setAskBusy(true);
    setAskHint(null);
    stopAskAudio();
    try {
      const audioBase64 = await blobToBase64(clip.blob);
      const r = await api.askVoice({
        audioBase64,
        mimeType: clip.mimeType,
        sessionId: getAskSessionId(),
      });
      setAskSessionId(r.sessionId);
      pushTurns(r.transcript, r.answer);
      if (r.audioBase64) playAskAudioBase64(r.audioBase64, r.audioMime);
      if (filter !== "ask") {
        setAskHint("Answer playing — full chat is in Ask.");
        window.setTimeout(() => setAskHint(null), 4500);
      }
    } catch (err) {
      setAskHint(voiceErrorHint(err));
    } finally {
      setAskBusy(false);
      sendingVoiceRef.current = false;
    }
  };

  const startRecording = async () => {
    if (askBusy || recording || sendingVoiceRef.current) return;
    if (!voiceReady) {
      setAskHint("Add a Cartesia API key in Settings → Voice to talk.");
      return;
    }
    setAskHint("Listening… release Mic when done.");
    stopAskAudio();
    try {
      const session = await startVoiceSession(setMicLevel);
      voiceSessionRef.current = session;
      setRecording(true);
    } catch (err) {
      cleanupMic();
      setAskHint(
        err instanceof Error
          ? `Microphone blocked: ${err.message}`
          : "Microphone unavailable",
      );
    }
  };

  const onMicPointerDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    void startRecording();
  };

  const onMicPointerUp = (e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (recording || voiceSessionRef.current) {
      void stopRecordingAndSend();
    }
  };

  if (compact) {
    return (
      <div
        className="widget-root widget-mini"
        data-tauri-drag-region
        {...miniGesture}
        title="Drag to move · click to expand"
      >
        <div
          className="flex h-14 w-14 items-center justify-center rounded-full bg-zinc-950 text-sm font-semibold text-white shadow-[0_8px_30px_rgba(0,0,0,0.28)]"
          data-tauri-drag-region
        >
          SB
        </div>
      </div>
    );
  }

  const viewGroups: {
    label: string;
    options: { id: Filter; title: string; hint?: string; count?: number; tone?: string }[];
  }[] = [
    {
      label: "Focus",
      options: [
        {
          id: "urgent",
          title: "Urgent",
          hint: "Due within 24h",
          count: sourceCounts.urgent,
          tone: "bg-rose-500 text-white",
        },
        {
          id: "today",
          title: "Today",
          hint: "Due today / top priority",
          count: todayCount,
          tone: "bg-zinc-900 text-white",
        },
        {
          id: "todo",
          title: "To-do",
          hint: "Everything else open",
          count: todoCount,
        },
        {
          id: "improve",
          title: "Improve yourself",
          hint: "Learn from last week's searches",
          count: insights.length,
          tone: "bg-violet-600 text-white",
        },
        {
          id: "ask",
          title: "Ask",
          hint: "Voice + text chat with your agent",
          count: askThread.filter((t) => t.role === "user").length || undefined,
          tone: "bg-sky-600 text-white",
        },
        {
          id: "open",
          title: "Open",
          hint: "All open loops",
          count: open.length,
        },
        {
          id: "resolved",
          title: "Resolved",
          hint: "Done or dismissed",
          count: closed.length,
        },
      ],
    },
    {
      label: "Sources",
      options: [
        { id: "gmail", title: "Gmail", count: sourceCounts.gmail, tone: "bg-red-500 text-white" },
        { id: "github", title: "GitHub", count: sourceCounts.github, tone: "bg-zinc-900 text-white" },
        { id: "chat", title: "Chats", count: sourceCounts.chat, tone: "bg-emerald-600 text-white" },
        { id: "pc", title: "PC", count: sourceCounts.pc, tone: "bg-indigo-500 text-white" },
        { id: "manual", title: "Manual", count: sourceCounts.manual, tone: "bg-zinc-200 text-zinc-700" },
        { id: "all", title: "All open", count: open.length },
      ],
    },
  ];

  const activeView = viewGroups
    .flatMap((g) => g.options)
    .find((o) => o.id === filter);

  return (
    <div className="widget-root widget-expanded">
      <div
        className="widget-card relative flex h-full w-full flex-col overflow-hidden bg-[#f7f7f8] text-zinc-900"
        data-tauri-drag-region
        onPointerDown={onDragPointerDown}
      >
        {/* header / drag */}
        <header className="widget-drag shrink-0 px-4 pb-2 pt-3" data-tauri-drag-region>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0" data-tauri-drag-region>
              <div className="flex items-center gap-2" data-tauri-drag-region>
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-zinc-950 text-[11px] font-bold text-white">
                  SB
                </span>
                <span className="text-[15px] font-semibold tracking-tight">
                  second brain
                </span>
              </div>
              <div className="mt-1 pl-9 text-[11px] text-zinc-500">
                <button
                  type="button"
                  className="widget-no-drag hover:text-zinc-700"
                  data-no-drag
                  onClick={() => setFilter("open")}
                >
                  {open.length} open
                </button>
                {todayCount > 0 && (
                  <>
                    {" · "}
                    <button
                      type="button"
                      className="widget-no-drag font-medium text-zinc-800 hover:text-zinc-950"
                      data-no-drag
                      onClick={() => setFilter("today")}
                    >
                      {todayCount} today
                    </button>
                  </>
                )}
                {closed.length > 0 && (
                  <>
                    {" · "}
                    <button
                      type="button"
                      className="widget-no-drag hover:text-zinc-700"
                      data-no-drag
                      onClick={() => setFilter("resolved")}
                    >
                      {closed.length} resolved
                    </button>
                  </>
                )}
                {updatedAt
                  ? ` · updated ${relativeTime(updatedAt.toISOString())}`
                  : ""}
              </div>
            </div>
            <div className="widget-no-drag flex items-center gap-1" data-no-drag>
              <button
                type="button"
                className={clsx(
                  "rounded-lg px-2 py-1 text-[11px] font-medium",
                  pinned
                    ? "bg-zinc-900 text-white"
                    : "bg-white text-zinc-600 ring-1 ring-black/5",
                )}
                onClick={() => void togglePin()}
                title="Always on top"
              >
                pin
              </button>
              <button
                type="button"
                className="rounded-lg bg-white px-2 py-1 text-[11px] font-medium text-zinc-600 ring-1 ring-black/5"
                onClick={() => void setCompactMode(true)}
                title="Compact"
              >
                mini
              </button>
              <div className="relative">
                <button
                  type="button"
                  className="rounded-lg bg-white px-2 py-1 text-zinc-600 ring-1 ring-black/5"
                  onClick={() => {
                    setViewOpen(false);
                    setMenu((m) => !m);
                  }}
                >
                  ···
                </button>
                {menu && (
                  <div className="absolute right-0 z-20 mt-1 w-52 overflow-hidden rounded-xl bg-white py-1 text-[12px] shadow-lg ring-1 ring-black/10">
                    <button
                      type="button"
                      className="block w-full px-3 py-2 text-left hover:bg-zinc-50"
                      onClick={() => {
                        setMenu(false);
                        void runSync();
                      }}
                    >
                      Sync now
                    </button>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-zinc-50"
                      onClick={() => {
                        setMenu(false);
                        void runConnectGoogle();
                      }}
                    >
                      <span
                        className={`inline-block h-1.5 w-1.5 rounded-full ${
                          googleOk
                            ? "bg-emerald-500"
                            : healthInfo?.google?.needsReauth
                              ? "bg-amber-500"
                              : "bg-zinc-300"
                        }`}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {googleOk
                          ? `Google · synced ${relativeAgo(healthInfo?.google?.lastRunAt)}`
                          : healthInfo?.google?.needsReauth
                            ? "Google · reconnect needed"
                            : "Connect Google"}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-zinc-50"
                      onClick={() => {
                        setMenu(false);
                        void runConnectGithub();
                      }}
                    >
                      <span
                        className={`inline-block h-1.5 w-1.5 rounded-full ${
                          githubOk ? "bg-emerald-500" : "bg-zinc-300"
                        }`}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {githubOk
                          ? `GitHub · synced ${relativeAgo(healthInfo?.github?.lastRunAt)}`
                          : "Connect GitHub"}
                      </span>
                    </button>
                    {(healthInfo?.mcp ?? []).map((s) => (
                      <div
                        key={s.id}
                        className="flex items-center gap-2 px-3 py-1.5 text-left text-zinc-600"
                      >
                        <span
                          className={`inline-block h-1.5 w-1.5 rounded-full ${
                            s.enabled ? "bg-sky-500" : "bg-zinc-300"
                          }`}
                        />
                        <span className="truncate">
                          {s.label}
                          {s.enabled ? "" : " · off"}
                        </span>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="block w-full px-3 py-2 text-left hover:bg-zinc-50"
                      onClick={() => {
                        setMenu(false);
                        void load();
                      }}
                    >
                      Refresh
                    </button>
                    <a
                      className="block w-full px-3 py-2 text-left hover:bg-zinc-50"
                      href="/"
                      target="_blank"
                      rel="noreferrer"
                      onClick={() => setMenu(false)}
                    >
                      Full dashboard
                    </a>
                    <button
                      type="button"
                      className="block w-full px-3 py-2 text-left hover:bg-zinc-50"
                      onClick={() => {
                        setMenu(false);
                        void hideWidget();
                      }}
                    >
                      Hide to tray
                    </button>
                    <button
                      type="button"
                      className="block w-full px-3 py-2 text-left font-medium text-red-600 hover:bg-red-50"
                      onClick={() => {
                        setMenu(false);
                        void quitApp();
                      }}
                    >
                      Quit Second Brain
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="widget-no-drag relative mt-3" data-no-drag ref={viewRef}>
            <button
              type="button"
              id="sb-view-filter"
              aria-haspopup="listbox"
              aria-expanded={viewOpen}
              onClick={() => {
                setMenu(false);
                setViewOpen((v) => !v);
              }}
              className={clsx(
                "flex w-full items-center gap-3 rounded-2xl bg-white px-3 py-2.5 text-left transition",
                "ring-1 ring-black/[0.08] hover:ring-black/15",
                viewOpen && "ring-2 ring-zinc-900/15",
              )}
            >
              <span
                className={clsx(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-[10px] font-bold tracking-wide",
                  activeView?.tone ?? "bg-zinc-100 text-zinc-600",
                )}
              >
                {viewBadge(filter)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold tracking-tight text-zinc-900">
                  {activeView?.title ?? "View"}
                </span>
                <span className="block truncate text-[11px] text-zinc-500">
                  {activeView?.hint ??
                    (typeof activeView?.count === "number"
                      ? `${activeView.count} in view`
                      : "Choose what to focus on")}
                </span>
              </span>
              {typeof activeView?.count === "number" && (
                <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-zinc-700">
                  {activeView.count}
                </span>
              )}
              <svg
                className={clsx(
                  "h-4 w-4 shrink-0 text-zinc-400 transition-transform duration-200",
                  viewOpen && "rotate-180",
                )}
                viewBox="0 0 20 20"
                fill="currentColor"
                aria-hidden
              >
                <path
                  fillRule="evenodd"
                  d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                  clipRule="evenodd"
                />
              </svg>
            </button>

            {viewOpen && (
              <div
                role="listbox"
                aria-labelledby="sb-view-filter"
                className="widget-view-menu absolute left-0 right-0 z-30 mt-1.5 max-h-[min(320px,52vh)] overflow-y-auto rounded-2xl bg-white py-1.5 shadow-[0_12px_40px_rgba(0,0,0,0.14)] ring-1 ring-black/10"
              >
                {viewGroups.map((group, gi) => (
                  <div key={group.label} className={gi > 0 ? "mt-1 border-t border-black/[0.05] pt-1" : ""}>
                    <div className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-zinc-400">
                      {group.label}
                    </div>
                    {group.options.map((o) => {
                      const selected = filter === o.id;
                      return (
                        <button
                          key={o.id}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          onClick={() => {
                            setFilter(o.id);
                            setViewOpen(false);
                          }}
                          className={clsx(
                            "flex w-full items-center gap-2.5 px-2.5 py-2 text-left transition",
                            selected
                              ? "bg-zinc-950 text-white"
                              : "text-zinc-800 hover:bg-zinc-50",
                          )}
                        >
                          <span
                            className={clsx(
                              "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[9px] font-bold",
                              selected
                                ? "bg-white/15 text-white"
                                : o.tone ?? "bg-zinc-100 text-zinc-600",
                            )}
                          >
                            {viewBadge(o.id === "all" ? "all" : o.id).replace(
                              "ALL",
                              "A",
                            )}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[12.5px] font-medium leading-tight">
                              {o.title}
                            </span>
                            {o.hint && (
                              <span
                                className={clsx(
                                  "block truncate text-[10px] leading-tight",
                                  selected ? "text-white/55" : "text-zinc-400",
                                )}
                              >
                                {o.hint}
                              </span>
                            )}
                          </span>
                          {typeof o.count === "number" && (
                            <span
                              className={clsx(
                                "rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
                                selected
                                  ? "bg-white/15 text-white"
                                  : "bg-zinc-100 text-zinc-600",
                              )}
                            >
                              {o.count}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
        </header>

        <div
          className="widget-no-drag min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3"
          data-no-drag
        >
          {loading && (
            <div className="px-2 py-8 text-center text-[13px] text-zinc-500">
              Loading…
            </div>
          )}
          {!loading && !err && voice && !showingAsk && (
            <div className="rounded-2xl bg-zinc-950 px-3.5 py-3 text-[13px] leading-relaxed text-white">
              {voice}
            </div>
          )}
          {askHint && (
            <div className="rounded-xl bg-amber-50 px-3 py-2 text-[11px] text-amber-800 ring-1 ring-amber-100">
              {askHint}
            </div>
          )}
          {showingAsk && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2 px-0.5">
                <p className="text-[11px] text-zinc-500">
                  Mic answers play aloud; transcript lives here so loops stay
                  clear.
                </p>
                {askThread.length > 0 && (
                  <button
                    type="button"
                    className="shrink-0 rounded-lg bg-zinc-100 px-2 py-1 text-[11px] font-medium text-zinc-600"
                    onClick={() => setAskThread([])}
                  >
                    Clear
                  </button>
                )}
              </div>
              {askThread.length === 0 ? (
                <div className="rounded-2xl bg-white px-4 py-8 text-center text-[13px] text-zinc-500 ring-1 ring-black/5">
                  Ask anything about your day, loops, or memory. Press and hold{" "}
                  <span className="font-medium text-zinc-700">Mic</span>, speak,
                  then release — you&apos;ll hear the reply.
                </div>
              ) : (
                askThread.map((t) => (
                  <div
                    key={t.id}
                    className={clsx(
                      "rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed ring-1",
                      t.role === "user"
                        ? "bg-zinc-100 text-zinc-700 ring-black/5"
                        : "bg-white text-zinc-800 ring-black/5",
                    )}
                  >
                    <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                      {t.role === "user" ? "You" : "Agent"}
                    </div>
                    {t.text}
                  </div>
                ))
              )}
            </div>
          )}
          {err && (
            <div className="rounded-2xl bg-red-50 px-3 py-3 text-[12px] text-red-700 ring-1 ring-red-100">
              Core offline — reopen the Desktop app.
              <div className="mt-1 opacity-80">{err}</div>
            </div>
          )}
          {axTrusted === false && captureMethod === "ax" && !err && (
            <div className="rounded-2xl bg-amber-50 px-3 py-3 text-[12px] text-amber-950 ring-1 ring-amber-100">
              <div className="font-medium">Grant Accessibility</div>
              <div className="mt-1 text-[11px] leading-relaxed text-amber-900/80">
                macOS capture reads on-screen text via Accessibility (no
                screenshots). Enable Second Brain in System Settings → Privacy
                &amp; Security → Accessibility, then reopen the app.
              </div>
              <button
                type="button"
                className="mt-2 rounded-xl bg-amber-900 px-3 py-1.5 text-[11px] font-medium text-white"
                onClick={() => {
                  void tauriInvoke("prompt_accessibility");
                  void tauriInvoke("open_accessibility_settings");
                }}
              >
                Open Accessibility settings
              </button>
            </div>
          )}
          {!loading && !err && showingOpenEmpty && (
            <div className="rounded-2xl bg-white px-4 py-6 text-center text-[13px] text-zinc-500 ring-1 ring-black/5">
              <div className="font-medium text-zinc-700">No open loops yet</div>
              <div className="mt-1 text-[11px] text-zinc-400">
                Connect accounts (browser login), then sync. First sync looks
                back 1 week and skips spam/promos.
              </div>
              <div className="mt-4 flex flex-col gap-2">
                <button
                  type="button"
                  disabled={busy !== null}
                  className="rounded-xl bg-zinc-900 px-3 py-2 text-[12px] font-medium text-white disabled:opacity-50"
                  onClick={() => void runConnectGoogle()}
                >
                  {busy === "google"
                    ? "Waiting for Google…"
                    : googleOk
                      ? "Reconnect Gmail / Calendar"
                      : "Connect Gmail / Calendar"}
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  className="rounded-xl bg-white px-3 py-2 text-[12px] font-medium text-zinc-800 ring-1 ring-black/10 disabled:opacity-50"
                  onClick={() => void runConnectGithub()}
                >
                  {busy === "github"
                    ? "Waiting for GitHub…"
                    : githubOk
                      ? "Reconnect GitHub"
                      : "Connect GitHub"}
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  className="rounded-xl bg-indigo-600 px-3 py-2 text-[12px] font-medium text-white disabled:opacity-50"
                  onClick={() => void runSync()}
                >
                  {busy === "sync" ? "Syncing…" : "Sync now"}
                </button>
              </div>
            </div>
          )}
          {connectMsg && (
            <div className="rounded-xl bg-emerald-50 px-3 py-2 text-[11px] leading-relaxed text-emerald-900 ring-1 ring-emerald-100">
              {connectMsg}
            </div>
          )}
          {!loading &&
            !err &&
            !showingResolved &&
            !showingImprove &&
            !showingAsk &&
            !showingOpenEmpty &&
            filtered.length === 0 && (
              <div className="rounded-2xl bg-white px-4 py-8 text-center text-[13px] text-zinc-500 ring-1 ring-black/5">
                {filter === "today"
                  ? "No actionable items for today yet."
                  : "No loops match this filter."}
              </div>
            )}
          {!loading && !err && showingResolved && filtered.length === 0 && (
            <div className="rounded-2xl bg-white px-4 py-10 text-center text-[13px] text-zinc-500 ring-1 ring-black/5">
              No resolved loops yet.
              <div className="mt-1 text-[11px] text-zinc-400">
                Done and Dismiss land here.
              </div>
            </div>
          )}

          {showingImprove &&
            insights.map((ins) => (
              <article
                key={ins.id}
                className="rounded-2xl bg-white px-3.5 py-3 shadow-sm ring-1 ring-violet-200/60"
              >
                <div className="text-[10px] font-semibold tracking-wide text-violet-600">
                  {insightKindLabel(ins.kind)}
                </div>
                <h3 className="mt-1 text-[14px] font-semibold leading-snug text-zinc-900">
                  {ins.title}
                </h3>
                <p className="mt-1 text-[12px] leading-relaxed text-zinc-600">
                  {ins.kind === "action" && ins.nextStep
                    ? ins.body.split("\n\nNext:")[0] ?? ins.body
                    : ins.body}
                </p>
                {ins.kind === "action" && ins.nextStep && (
                  <p className="mt-2 rounded-lg bg-violet-50 px-2.5 py-1.5 text-[12px] text-violet-950">
                    <span className="font-semibold">Next: </span>
                    {ins.nextStep}
                    {ins.effortMin ? (
                      <span className="ml-1 text-violet-600">
                        · ~{ins.effortMin}m
                      </span>
                    ) : null}
                  </p>
                )}
                {ins.kind === "action" && (ins.sources ?? []).length > 0 && (
                  <ul className="mt-1.5 space-y-1">
                    {ins.sources!.slice(0, 3).map((s, i) => (
                      <li key={`${s.server}-${s.tool}-${i}`}>
                        {s.url && isHttpsUrl(s.url) ? (
                          <button
                            type="button"
                            className="text-[11px] text-violet-700 underline-offset-2 hover:underline"
                            onClick={() => void openExternal(s.url!)}
                          >
                            {s.server}/{s.tool}: {s.ref}
                          </button>
                        ) : (
                          <span className="text-[11px] text-zinc-500">
                            {s.server}/{s.tool}: {s.ref}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {(ins.suggestions ?? []).length > 0 && (
                  <ul className="mt-2 space-y-1.5">
                    {ins.suggestions!.map((s) => (
                      <li key={s.url}>
                        <button
                          type="button"
                          className="w-full rounded-lg bg-violet-50 px-2.5 py-1.5 text-left text-[12px] text-violet-900"
                          onClick={() => void openExternal(s.url)}
                        >
                          <span className="font-medium">
                            {s.kind === "video" ? "Watch" : "Read"}
                          </span>
                          {": "}
                          {s.title}
                          {suggestionHost(s.url) ? (
                            <span className="mt-0.5 block text-[10px] text-violet-500">
                              {suggestionHost(s.url)}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {ins.kind === "learn" && (
                    <button
                      type="button"
                      className="rounded-lg bg-violet-600 px-2.5 py-1 text-[11px] font-medium text-white"
                      disabled={busy === `track:${ins.id}` || trackingLearn.some((l) =>
                        learnTopicLabel(l.title).toLowerCase() === (ins.topic ?? "").toLowerCase(),
                      )}
                      onClick={() => void trackTopic({ insightId: ins.id })}
                    >
                      {trackingLearn.some((l) =>
                        learnTopicLabel(l.title).toLowerCase() === (ins.topic ?? "").toLowerCase(),
                      )
                        ? "Tracking"
                        : "Track this"}
                    </button>
                  )}
                  {ins.kind === "action" && (
                    <button
                      type="button"
                      className="rounded-lg bg-violet-600 px-2.5 py-1 text-[11px] font-medium text-white"
                      disabled={busy === `add-loop:${ins.id}`}
                      onClick={() => {
                        setBusy(`add-loop:${ins.id}`);
                        void api
                          .createLoop({
                            title: ins.title,
                            description: [
                              ins.nextStep ? `Next: ${ins.nextStep}` : null,
                              ins.body,
                            ]
                              .filter(Boolean)
                              .join("\n\n"),
                            kind: "unfinished",
                            tags: ["advisor"],
                            category: "other",
                          })
                          .then(() => api.dismissInsight(ins.id))
                          .then(() => load())
                          .catch((e) => setConnectMsg(String(e)))
                          .finally(() => setBusy(null));
                      }}
                    >
                      {busy === `add-loop:${ins.id}` ? "Adding…" : "Add as loop"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="rounded-lg bg-zinc-100 px-2.5 py-1 text-[11px] font-medium text-zinc-700"
                    disabled={busy === ins.id}
                    onClick={() => {
                      setBusy(ins.id);
                      void api
                        .dismissInsight(ins.id)
                        .then(() => load())
                        .finally(() => setBusy(null));
                    }}
                  >
                    Dismiss
                  </button>
                </div>
              </article>
            ))}

          {showingImprove && trackingLearn.length > 0 && (
            <div className="rounded-2xl bg-white px-3.5 py-3 ring-1 ring-black/5">
              <div className="text-[10px] font-semibold tracking-wide text-zinc-500">
                Tracking
              </div>
              <ul className="mt-1.5 space-y-2">
                {trackingLearn.map((l) => (
                  <li
                    key={l.id}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="min-w-0 truncate text-[12px] text-zinc-700">
                      {learnTopicLabel(l.title)}
                    </span>
                    <span className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        className="rounded-lg bg-zinc-900 px-2 py-1 text-[11px] font-medium text-white"
                        disabled={busy === `done:${l.id}`}
                        onClick={() => {
                          setBusy(`done:${l.id}`);
                          void act(l.id, "closed").finally(() => setBusy(null));
                        }}
                      >
                        Done
                      </button>
                      <button
                        type="button"
                        className="rounded-lg bg-zinc-100 px-2 py-1 text-[11px] font-medium text-zinc-700"
                        disabled={busy === `untrack:${l.id}`}
                        title="Stop tracking this topic"
                        onClick={() => {
                          setBusy(`untrack:${l.id}`);
                          void markNotTracking(l.id).finally(() =>
                            setBusy(null),
                          );
                        }}
                      >
                        Untrack
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {showingImprove && (
            <form
              className="rounded-2xl bg-white px-3.5 py-3 ring-1 ring-black/5"
              onSubmit={(e) => {
                e.preventDefault();
                const topic = learnWant.trim();
                if (!topic) return;
                void trackTopic({ topic });
              }}
            >
              <label className="text-[10px] font-semibold tracking-wide text-zinc-500">
                I want to learn
              </label>
              <div className="mt-1.5 flex gap-1.5">
                <input
                  data-no-drag
                  className="min-w-0 flex-1 rounded-lg bg-zinc-50 px-2.5 py-1.5 text-[12px] text-zinc-900 outline-none ring-1 ring-black/5"
                  placeholder="graph engineering"
                  value={learnWant}
                  onChange={(e) => setLearnWant(e.target.value)}
                />
                <button
                  type="submit"
                  className="rounded-lg bg-violet-600 px-2.5 py-1.5 text-[11px] font-medium text-white"
                  disabled={busy === "track-custom" || !learnWant.trim()}
                >
                  Track
                </button>
              </div>
            </form>
          )}

          {showingImprove && !loading && (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                className="rounded-2xl bg-violet-600 px-4 py-3 text-center text-[12px] font-medium text-white"
                disabled={busy === "advisor" || busy === "insights"}
                onClick={async () => {
                  setBusy("advisor");
                  setConnectMsg(null);
                  try {
                    const r = await api.runAdvisor();
                    setConnectMsg(
                      r.cards.length
                        ? `Advisor: ${r.cards.length} action card${r.cards.length === 1 ? "" : "s"} (${r.mcpTools} MCP tools).`
                        : r.errors[0] ??
                            "Advisor ran — no new action cards this time.",
                    );
                    await load();
                  } catch (e) {
                    setConnectMsg(String(e));
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === "advisor" ? "Advising…" : "Get advice"}
              </button>
              {insights.length > 0 && (
                <button
                  type="button"
                  className="rounded-2xl bg-white px-4 py-3 text-center text-[12px] font-medium text-violet-700 ring-1 ring-violet-200/60"
                  disabled={busy === "insights" || busy === "advisor"}
                  onClick={async () => {
                    setBusy("insights");
                    try {
                      await api.generateInsights();
                      await load();
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {busy === "insights" ? "Refreshing…" : "Refresh insights"}
                </button>
              )}
            </div>
          )}

          {showingImprove && !loading && insights.length === 0 && (
            <div className="rounded-2xl bg-white px-4 py-8 text-center text-[13px] text-zinc-500 ring-1 ring-black/5">
              No action cards yet. Use Get advice to pull next steps from open
              loops, recent activity, and any MCP servers you connected in
              Settings.
            </div>
          )}

          {!showingImprove &&
            !showingAsk &&
            filtered.map((loop) => {
            const src = sourceMeta(loop);
            const resolved = showingResolved;
            return (
              <article
                key={loop.id}
                className={clsx(
                  "rounded-2xl bg-white px-3.5 py-3 shadow-sm ring-1 ring-black/[0.04]",
                  resolved && "opacity-90",
                )}
              >
                <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                  <span
                    className={clsx(
                      "flex h-5 w-5 items-center justify-center rounded-md text-[9px] font-bold",
                      src.color,
                    )}
                  >
                    {src.badge}
                  </span>
                  <span className="truncate font-medium text-zinc-600">
                    {src.label}
                  </span>
                  <span className="text-zinc-300">·</span>
                  <span
                    className={clsx(
                      "rounded-md px-1.5 py-0.5 text-[10px] font-semibold",
                      resolved
                        ? "bg-zinc-100 text-zinc-500"
                        : categoryChip(loop.category).className,
                    )}
                  >
                    {resolved
                      ? loop.status === "dismissed"
                        ? "Dismissed"
                        : "Done"
                      : categoryChip(loop.category).label}
                  </span>
                  {(loop.tags ?? [])
                    .map(extraTagLabel)
                    .filter((t): t is string => Boolean(t))
                    .filter(
                      (t) =>
                        t.toLowerCase() !==
                        categoryChip(loop.category).label.toLowerCase(),
                    )
                    .slice(0, 2)
                    .map((t) => (
                      <span
                        key={t}
                        className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600"
                      >
                        {t}
                      </span>
                    ))}
                  <span className="ml-auto shrink-0">
                    {relativeTime(loop.closedAt ?? loop.detectedAt)}
                  </span>
                </div>
                <h3 className="mt-1.5 text-[14px] font-semibold leading-snug tracking-tight text-zinc-900">
                  {loop.title}
                </h3>
                {(() => {
                  const who = displayWho(loop.who);
                  const due = formatDue(loop.dueAt);
                  if (!who && !due) return null;
                  return (
                    <p className="mt-1 text-[12px] leading-relaxed text-zinc-500">
                      {who ?? ""}
                      {who && due ? " · " : ""}
                      {due ? (
                        <span
                          className={
                            due.overdue
                              ? "font-medium text-rose-600"
                              : undefined
                          }
                        >
                          {due.label}
                        </span>
                      ) : null}
                    </p>
                  );
                })()}
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {loop.sourceUrl && (
                    <button
                      type="button"
                      className="rounded-lg bg-indigo-600 px-2.5 py-1 text-[11px] font-medium text-white"
                      onClick={() => void openExternal(loop.sourceUrl!)}
                    >
                      {loop.sourceLabel ?? "Open source"}
                    </button>
                  )}
                  {resolved ? (
                    <button
                      type="button"
                      className="rounded-lg bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-white"
                      onClick={() => void act(loop.id, "open")}
                    >
                      Reopen
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="rounded-lg bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-white"
                        onClick={() => void act(loop.id, "closed")}
                      >
                        Done
                      </button>
                      <button
                        type="button"
                        className="rounded-lg bg-zinc-100 px-2.5 py-1 text-[11px] font-medium text-zinc-700"
                        onClick={() => void act(loop.id, "snoozed")}
                      >
                        Snooze
                      </button>
                      <button
                        type="button"
                        className="rounded-lg bg-zinc-100 px-2.5 py-1 text-[11px] font-medium text-zinc-700"
                        onClick={() => void act(loop.id, "dismissed")}
                      >
                        Dismiss
                      </button>
                      <button
                        type="button"
                        className="rounded-lg px-2.5 py-1 text-[11px] font-medium text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
                        title="Never show similar noise / promo again"
                        onClick={() => void markSpam(loop.id)}
                      >
                        Spam
                      </button>
                      <button
                        type="button"
                        className="rounded-lg px-2.5 py-1 text-[11px] font-medium text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
                        title="Stop tracking this topic, person, or symbol"
                        onClick={() => void markNotTracking(loop.id)}
                      >
                        Not tracking
                      </button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>

        <footer
          className="widget-no-drag shrink-0 border-t border-black/[0.04] bg-white/90 px-3 py-2"
          data-no-drag
        >
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => void submitAsk(e)}
          >
            <button
              type="button"
              className={clsx(
                "relative shrink-0 touch-none select-none rounded-xl px-2.5 py-2 text-[12px] font-medium disabled:opacity-50",
                recording
                  ? "bg-rose-600 text-white"
                  : voiceReady
                    ? "bg-violet-100 text-violet-800 hover:bg-violet-200"
                    : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200",
              )}
              title={
                recording
                  ? "Release to send"
                  : voiceReady
                    ? "Press and hold to talk"
                    : "Add Cartesia API key in Settings → Voice"
              }
              disabled={askBusy && !recording}
              onPointerDown={onMicPointerDown}
              onPointerUp={onMicPointerUp}
              onPointerCancel={onMicPointerUp}
              onContextMenu={(e) => e.preventDefault()}
            >
              {recording ? "Listening" : "Mic"}
              {recording && (
                <span
                  className="absolute bottom-0.5 left-1.5 right-1.5 h-0.5 overflow-hidden rounded-full bg-white/30"
                  aria-hidden
                >
                  <span
                    className="block h-full bg-white transition-[width] duration-75"
                    style={{
                      width: `${Math.max(8, Math.round(micLevel * 100))}%`,
                    }}
                  />
                </span>
              )}
            </button>
            <input
              className="min-w-0 flex-1 rounded-xl border-0 bg-zinc-100 px-3 py-2 text-[12px] text-zinc-900 outline-none placeholder:text-zinc-400"
              placeholder={
                recording
                  ? "Listening… release Mic to send"
                  : "Ask your agent…"
              }
              value={askQ}
              onChange={(e) => setAskQ(e.target.value)}
              disabled={askBusy || recording}
            />
            <button
              type="submit"
              className="rounded-xl bg-zinc-950 px-3 py-2 text-[12px] font-medium text-white disabled:opacity-50"
              disabled={askBusy || recording}
            >
              {askBusy ? "…" : "Ask"}
            </button>
          </form>
        </footer>
      </div>
    </div>
  );
}
