import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { api, type AskResult } from "../lib/api";
import { MarkdownBrief } from "../components/MarkdownBrief";
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

const SUGGESTIONS = [
  "What did I promise to send by Friday?",
  "What should I focus on right now?",
  "Where did I leave off on my main project?",
  "What open loops am I quietly avoiding?",
];

export function AskPage() {
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [thread, setThread] = useState<AskThreadTurn[]>([]);
  const [sources, setSources] = useState<AskResult["sources"]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [voiceReady, setVoiceReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const voiceSessionRef = useRef<VoiceSession | null>(null);
  const sendingVoiceRef = useRef(false);

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
    setThread((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, role: "user", text: userText },
      { id: `a-${Date.now()}`, role: "assistant", text: assistantText },
    ]);
  };

  const submit = async (question: string) => {
    if (!question.trim()) return;
    setLoading(true);
    setErr(null);
    stopAskAudio();
    try {
      const r = await api.ask(question.trim(), getAskSessionId());
      setAskSessionId(r.sessionId);
      pushTurns(question.trim(), r.answer);
      setSources(r.sources);
      setQ("");
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
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
      setErr("Could not finish the recording — try again.");
      return;
    }
    cleanupMic();

    if (clip.durationMs < MIN_VOICE_MS) {
      setErr("Press and hold Mic while you speak, then release.");
      sendingVoiceRef.current = false;
      return;
    }
    if (clip.peak < MIN_VOICE_PEAK) {
      setErr(
        "No speech in the clip. Hold Mic and watch the bar bounce as you talk.",
      );
      sendingVoiceRef.current = false;
      return;
    }
    setLoading(true);
    setErr(null);
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
      setSources(r.sources);
      if (r.audioBase64) playAskAudioBase64(r.audioBase64, r.audioMime);
    } catch (e) {
      setErr(voiceErrorHint(e));
    } finally {
      setLoading(false);
      sendingVoiceRef.current = false;
    }
  };

  const startRecording = async () => {
    if (loading || recording || sendingVoiceRef.current) return;
    if (!voiceReady) {
      setErr("Add a Cartesia API key in Settings → Voice to talk.");
      return;
    }
    setErr(null);
    stopAskAudio();
    try {
      const session = await startVoiceSession(setMicLevel);
      voiceSessionRef.current = session;
      setRecording(true);
    } catch (e) {
      cleanupMic();
      setErr(e instanceof Error ? e.message : "Microphone unavailable");
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

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-white">Ask</h1>
        <p className="mt-1 text-sm text-ink-400">
          Chat over local memory via Ollama. Voice uses Cartesia for speech
          in/out; answers stay on this PC. Press and hold Mic to talk.
        </p>
      </header>

      <form
        className="card flex flex-col gap-2 p-3 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(q);
        }}
      >
        <button
          type="button"
          className={`btn-ghost relative shrink-0 touch-none select-none ${recording ? "bg-rose-600 text-white" : ""}`}
          disabled={loading && !recording}
          onPointerDown={onMicPointerDown}
          onPointerUp={onMicPointerUp}
          onPointerCancel={onMicPointerUp}
          onContextMenu={(e) => e.preventDefault()}
          title={recording ? "Release to send" : "Press and hold to talk"}
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
          className="input flex-1"
          placeholder={
            recording ? "Listening… release Mic to send" : "What did I promise…?"
          }
          value={q}
          onChange={(e) => setQ(e.target.value)}
          disabled={loading || recording}
        />
        <button
          type="submit"
          className="btn-primary"
          disabled={loading || recording || !q.trim()}
        >
          {loading ? "…" : "Ask"}
        </button>
      </form>

      {err && <div className="text-sm text-bad">{err}</div>}
      {!voiceReady && (
        <p className="text-xs text-ink-500">
          Voice needs a Cartesia key in Settings → Voice.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            className="btn-ghost text-xs"
            disabled={loading || recording}
            onClick={() => void submit(s)}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        {thread.map((t) => (
          <div
            key={t.id}
            className={`card p-3 text-sm ${
              t.role === "user" ? "bg-white/5" : "bg-ink-900/40"
            }`}
          >
            <div className="mb-1 text-[10px] uppercase tracking-wide text-ink-500">
              {t.role === "user" ? "You" : "Agent"}
            </div>
            {t.role === "assistant" ? (
              <MarkdownBrief markdown={t.text} />
            ) : (
              <p className="text-ink-200">{t.text}</p>
            )}
          </div>
        ))}
      </div>

      {sources.length > 0 && (
        <div className="card space-y-2 p-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-ink-500">
            Sources
          </h2>
          <ul className="space-y-1 text-xs text-ink-400">
            {sources.map((s, i) => (
              <li key={`${s.score}-${i}`}>
                <span className="text-ink-500">
                  {(s.score * 100).toFixed(0)}%
                </span>{" "}
                {s.text}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
