/**
 * Thin Cartesia STT/TTS client. Key stays in core secrets; never sent to the webview.
 * Speech audio is proxied in-memory only — not written to disk.
 */
import { getSecret, setSecret } from "@second-brain/core";

export const CARTESIA_SECRET_KEY = "cartesia_api_key";
export const CARTESIA_VERSION = "2026-03-01";
export const CARTESIA_STT_MODEL = "ink-whisper";
export const CARTESIA_TTS_MODEL = "sonic-3.5";
/** Default Cartesia voice (docs default). */
export const CARTESIA_DEFAULT_VOICE_ID =
  "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4";

const API_BASE = "https://api.cartesia.ai";

export function isCartesiaConfigured(): boolean {
  return Boolean(getSecret(CARTESIA_SECRET_KEY)?.trim());
}

export function saveCartesiaApiKey(apiKey: string): void {
  const key = apiKey.trim();
  if (!key) throw new Error("apiKey required");
  setSecret(CARTESIA_SECRET_KEY, key);
}

function requireApiKey(): string {
  const key = getSecret(CARTESIA_SECRET_KEY)?.trim();
  if (!key) {
    throw new Error(
      "Cartesia is not configured. Add your API key in Settings → Voice.",
    );
  }
  return key;
}

function authHeaders(apiKey: string, contentType?: string): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Cartesia-Version": CARTESIA_VERSION,
  };
  if (contentType) h["Content-Type"] = contentType;
  return h;
}

export type CartesiaSttResult = { text: string };

export type CartesiaTtsResult = {
  audio: Buffer;
  mimeType: string;
};

/** Injectable fetch for tests. */
export type CartesiaFetch = typeof fetch;

export async function cartesiaTranscribe(
  audio: Buffer,
  mimeType: string,
  opts?: { fetchImpl?: CartesiaFetch; apiKey?: string },
): Promise<CartesiaSttResult> {
  const apiKey = opts?.apiKey ?? requireApiKey();
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const ext = mimeType.includes("wav")
    ? "wav"
    : mimeType.includes("mp4") || mimeType.includes("m4a")
      ? "m4a"
      : mimeType.includes("ogg")
        ? "ogg"
        : "webm";
  const blob = new Blob([new Uint8Array(audio)], {
    type: mimeType || `audio/${ext}`,
  });
  const form = new FormData();
  form.append("file", blob, `ask.${ext}`);
  form.append("model", CARTESIA_STT_MODEL);
  form.append("language", "en");

  const res = await fetchImpl(`${API_BASE}/stt`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: form,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Cartesia STT ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = (await res.json()) as { text?: string };
  const text = (data.text ?? "").trim();
  if (!text) throw new Error("Cartesia STT returned empty transcript");
  return { text };
}

/**
 * Cartesia Whisper often invents courtesy fillers for silence, mic taps,
 * or speaker bleed ("Thank you."). Those are not real Ask questions.
 */
export function isWeakVoiceTranscript(text: string): boolean {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[.!?…,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t || t.length < 4) return true;
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

export async function cartesiaSpeak(
  transcript: string,
  opts?: {
    fetchImpl?: CartesiaFetch;
    apiKey?: string;
    voiceId?: string;
  },
): Promise<CartesiaTtsResult> {
  const apiKey = opts?.apiKey ?? requireApiKey();
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const voiceId = opts?.voiceId ?? CARTESIA_DEFAULT_VOICE_ID;
  const body = {
    model_id: CARTESIA_TTS_MODEL,
    transcript: transcript.slice(0, 4000),
    voice: { mode: "id", id: voiceId },
    language: "en",
    output_format: {
      container: "mp3",
      sample_rate: 44100,
      bit_rate: 128000,
    },
  };

  const res = await fetchImpl(`${API_BASE}/tts/bytes`, {
    method: "POST",
    headers: authHeaders(apiKey, "application/json"),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Cartesia TTS ${res.status}: ${errText.slice(0, 200)}`);
  }
  const ab = await res.arrayBuffer();
  return {
    audio: Buffer.from(ab),
    mimeType: res.headers.get("content-type") || "audio/mpeg",
  };
}
