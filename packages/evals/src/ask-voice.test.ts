import { describe, expect, it, vi } from "vitest";
import { buildAskContext } from "@second-brain/agents";
import {
  cartesiaSpeak,
  cartesiaTranscribe,
  isWeakVoiceTranscript,
  CARTESIA_STT_MODEL,
  CARTESIA_TTS_MODEL,
  CARTESIA_VERSION,
} from "@second-brain/agents";

describe("isWeakVoiceTranscript", () => {
  it("rejects courtesy STT hallucinations", () => {
    expect(isWeakVoiceTranscript("Thank you.")).toBe(true);
    expect(isWeakVoiceTranscript("thanks")).toBe(true);
    expect(isWeakVoiceTranscript("  THX  ")).toBe(true);
    expect(isWeakVoiceTranscript("hmm")).toBe(true);
  });

  it("keeps real questions", () => {
    expect(isWeakVoiceTranscript("What should I focus on today?")).toBe(false);
    expect(isWeakVoiceTranscript("Summarize my open loops")).toBe(false);
    expect(isWeakVoiceTranscript("Plan")).toBe(false);
  });
});

describe("buildAskContext", () => {
  it("includes timeline, profile, resume, and prior turns", () => {
    const ctx = buildAskContext({
      question: "What was I doing?",
      memory: [
        { score: 0.9, kind: "observation", text: "Cursor — ask.ts", ts: "2026-08-20T08:00:00Z" },
      ],
      openLoops: [{ title: "Ship voice", kind: "manual", who: null, due: "today" }],
      recentArtifacts: [
        { title: "second-brain", kind: "project", lastTouchedAt: "2026-08-20T09:00:00Z" },
      ],
      todayTimeline: [
        {
          app: "Cursor",
          title: "ask.ts",
          startAt: "2026-08-20T08:00:00Z",
          endAt: "2026-08-20T09:00:00Z",
        },
      ],
      whereLeftOff: [
        {
          title: "second-brain",
          kind: "project",
          lastTouchedAt: "2026-08-20T09:00:00Z",
          openLoopTitles: ["Ship voice"],
        },
      ],
      profile: { role: "founder", goals: ["Ship desktop agent"] },
      recentTurns: [
        { role: "user", text: "hi" },
        { role: "assistant", text: "hello" },
      ],
    });

    expect(ctx.todayTimeline).toEqual([
      {
        app: "Cursor",
        title: "ask.ts",
        startAt: "2026-08-20T08:00:00Z",
        endAt: "2026-08-20T09:00:00Z",
      },
    ]);
    expect(ctx.profile).toEqual({
      role: "founder",
      goals: ["Ship desktop agent"],
    });
    expect(ctx.whereLeftOff).toHaveLength(1);
    expect(ctx.recentTurns).toHaveLength(2);
    expect((ctx.openLoops as Array<{ title: string }>)[0]).toMatchObject({
      title: "Ship voice",
    });
    expect((ctx.memory as Array<{ kind: string }>)[0]).toMatchObject({
      kind: "observation",
    });
  });
});

describe("cartesia client (mocked fetch)", () => {
  it("transcribes via Ink STT multipart", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-key");
      expect(headers["Cartesia-Version"]).toBe(CARTESIA_VERSION);
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init!.body as FormData;
      expect(form.get("model")).toBe(CARTESIA_STT_MODEL);
      return new Response(JSON.stringify({ text: "what did I work on" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const r = await cartesiaTranscribe(Buffer.from("fake-audio"), "audio/webm", {
      fetchImpl,
      apiKey: "test-key",
    });
    expect(r.text).toBe("what did I work on");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("speaks via Sonic TTS bytes", async () => {
    const pcm = Buffer.from([1, 2, 3, 4]);
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body)) as {
        model_id: string;
        transcript: string;
      };
      expect(body.model_id).toBe(CARTESIA_TTS_MODEL);
      expect(body.transcript).toBe("Ship the widget");
      return new Response(pcm, {
        status: 200,
        headers: { "Content-Type": "audio/mpeg" },
      });
    }) as unknown as typeof fetch;

    const r = await cartesiaSpeak("Ship the widget", {
      fetchImpl,
      apiKey: "test-key",
    });
    expect(r.mimeType).toBe("audio/mpeg");
    expect(Buffer.compare(r.audio, pcm)).toBe(0);
  });

  it("rejects empty STT transcript", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ text: "  " }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    await expect(
      cartesiaTranscribe(Buffer.from("x"), "audio/webm", {
        fetchImpl,
        apiKey: "k",
      }),
    ).rejects.toThrow(/empty transcript/i);
  });
});
