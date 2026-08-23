/** Shared helpers for Ask text/voice UI (widget + Ask page). */

export type AskThreadTurn = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

const SESSION_KEY = "sb-ask-session";

/** Minimum hold time before a voice clip is worth sending (ms). */
export const MIN_VOICE_MS = 500;

/** Peak amplitude below this is treated as a silent/wrong-device capture. */
export const MIN_VOICE_PEAK = 0.02;

export function getAskSessionId(): string | undefined {
  try {
    return sessionStorage.getItem(SESSION_KEY) || undefined;
  } catch {
    return undefined;
  }
}

export function setAskSessionId(id: string): void {
  try {
    sessionStorage.setItem(SESSION_KEY, id);
  } catch {
    /* */
  }
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      const i = dataUrl.indexOf(",");
      resolve(i >= 0 ? dataUrl.slice(i + 1) : dataUrl);
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

let currentAudio: HTMLAudioElement | null = null;

export function stopAskAudio(): void {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = "";
    currentAudio = null;
  }
}

export function playAskAudioBase64(audioBase64: string, mimeType: string): void {
  stopAskAudio();
  const bytes = Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: mimeType || "audio/mpeg" });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  currentAudio = audio;
  audio.onended = () => {
    URL.revokeObjectURL(url);
    if (currentAudio === audio) currentAudio = null;
  };
  void audio.play().catch(() => {
    URL.revokeObjectURL(url);
  });
}

export function voiceMicConstraints(): MediaStreamConstraints {
  return {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  };
}

export type VoiceClip = {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  peak: number;
};

export type VoiceSession = {
  stop: () => Promise<VoiceClip>;
};

function writeString(view: DataView, offset: number, s: string) {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

/** 16-bit mono WAV — WebView2 MediaRecorder webm is often silent; PCM is not. */
export function encodeWavMono(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * Capture mic as PCM via AudioContext. Avoids WebView2's broken MediaRecorder
 * (silent webm → Cartesia hears "." / "Thank you").
 */
export async function startVoiceSession(
  onLevel: (level: number) => void,
): Promise<VoiceSession> {
  const stream = await navigator.mediaDevices.getUserMedia(voiceMicConstraints());
  const AC =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AC) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error("AudioContext unavailable");
  }
  const ctx = new AC();
  await ctx.resume();
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  const chunks: Float32Array[] = [];
  let peak = 0;
  const startedAt = Date.now();

  processor.onaudioprocess = (ev) => {
    const input = ev.inputBuffer.getChannelData(0);
    const copy = new Float32Array(input.length);
    copy.set(input);
    chunks.push(copy);
    let local = 0;
    for (let i = 0; i < input.length; i++) {
      const v = Math.abs(input[i] ?? 0);
      if (v > local) local = v;
    }
    if (local > peak) peak = local;
    onLevel(local);
  };

  source.connect(processor);
  processor.connect(mute);
  mute.connect(ctx.destination);

  let stopped = false;
  return {
    stop: async () => {
      if (stopped) {
        return {
          blob: new Blob([], { type: "audio/wav" }),
          mimeType: "audio/wav",
          durationMs: 0,
          peak: 0,
        };
      }
      stopped = true;
      processor.onaudioprocess = null;
      try {
        processor.disconnect();
        source.disconnect();
        mute.disconnect();
      } catch {
        /* */
      }
      stream.getTracks().forEach((t) => t.stop());
      const sampleRate = ctx.sampleRate || 48000;
      await ctx.close().catch(() => undefined);
      onLevel(0);

      let total = 0;
      for (const c of chunks) total += c.length;
      const samples = new Float32Array(total);
      let offset = 0;
      for (const c of chunks) {
        samples.set(c, offset);
        offset += c.length;
      }
      return {
        blob: encodeWavMono(samples, sampleRate),
        mimeType: "audio/wav",
        durationMs: Date.now() - startedAt,
        peak,
      };
    },
  };
}

export function isWeakVoiceTranscript(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[.!?…,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length < 4) return true;
  if (/^[.\-–—_/\\]+$/.test(t)) return true;
  if (
    /^(thanks|thank you|thankyou|thanks a lot|thanks so much|thx|ty|bye|goodbye|good bye|see you|you'?re welcome|ok thanks|okay thanks|mm+|mhm+|hmm+|uh+|um+|ah+|huh)$/i.test(
      t,
    )
  ) {
    return true;
  }
  return false;
}

export function voiceErrorHint(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/503|not configured/i.test(msg)) {
    return "Add a Cartesia API key in Settings → Voice.";
  }
  const jsonMatch = msg.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const body = JSON.parse(jsonMatch[0]) as {
        error?: string;
        transcript?: string;
        hint?: string;
      };
      if (body.error === "weak_transcript") {
        const heard = (body.transcript ?? "").trim();
        if (heard && heard !== ".") {
          return `Heard “${heard.slice(0, 80)}” — that isn’t a question. Press and hold Mic while you speak.`;
        }
        return "Mic clip was silent. Press and hold Mic — watch the bar bounce as you talk.";
      }
    } catch {
      /* fall through */
    }
  }
  if (/weak_transcript/i.test(msg)) {
    return "Mic clip was silent. Press and hold Mic — watch the bar bounce as you talk.";
  }
  return msg;
}
