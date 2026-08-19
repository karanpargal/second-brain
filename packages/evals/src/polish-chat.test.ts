import { describe, expect, it } from "vitest";
import {
  applyChatPolish,
  parseChatPolishResponse,
  buildChatPolishPrompt,
  chatDateContext,
  scoreChatAction,
  parseDueHint,
} from "@second-brain/agents";
import type { LoopCandidate } from "@second-brain/agents";

function baseCand(over: Partial<LoopCandidate> = {}): LoopCandidate {
  return {
    title: "Share the revenue details to you by tonwrrow",
    snippet:
      "HEADER: Wini You\nI will share the revenue details to you by tonwrrow 11:58am",
    ocrText:
      "HEADER: Wini You\nI will share the revenue details to you by tonwrrow 11:58am",
    kind: "promise",
    recallScore: 0.78,
    confidence: 0.78,
    source: "chat",
    fromMe: true,
    tags: ["chat", "whatsapp"],
    ...over,
  };
}

describe("chat OCR LLM polish", () => {
  it("parses POLISH_CHAT_OCR JSON", () => {
    const loops = parseChatPolishResponse(
      `{"loops":[{"i":0,"keep":true,"title":"Share the revenue details to Wini by 20/8/2026","who":"Wini","dueHint":"20/8/2026"}]}`,
    );
    expect(loops[0]?.who).toBe("Wini");
    expect(loops[0]?.title).toMatch(/20\/8\/2026/);
  });

  it("rewrites a garbled self-commitment with contact + DMY date", () => {
    const now = new Date("2026-08-19T06:30:00.000Z");
    const out = applyChatPolish(
      baseCand(),
      {
        i: 0,
        keep: true,
        title: "Share the revenue details to Wini by 20/8/2026",
        who: "Wini",
        dueHint: "20/8/2026",
      },
      now,
    );
    expect(out.title).toBe("Share the revenue details to Wini by 20/8/2026");
    expect(out.who).toBe("Wini");
    expect(out.dueHint).toBe("20/8/2026");
    const due = parseDueHint("20/8/2026", now);
    expect(due).toBeTruthy();
    expect(new Date(due!).getDate()).toBe(20);
    expect(new Date(due!).getMonth()).toBe(7);
  });

  it("keeps heuristic title if polish JSON is junk", () => {
    const c = baseCand();
    const out = applyChatPolish(c, undefined);
    expect(out.title).toBe(c.title);
  });

  it("prompt includes today/tomorrow and HEADER", () => {
    const now = new Date(2026, 7, 19, 12, 0, 0);
    const { tomorrowDmy } = chatDateContext(now);
    const prompt = buildChatPolishPrompt(
      [
        {
          i: 0,
          fromMe: true,
          who: null,
          ocr: "HEADER: Wini You\nI will share the revenue details to you by tonwrrow 11:58am",
        },
      ],
      now,
    );
    expect(prompt).toContain("POLISH_CHAT_OCR");
    expect(prompt).toContain(tomorrowDmy);
    expect(prompt).toContain("Wini");
    expect(prompt).toContain("tonwrrow");
  });

  it("softens tonwrrow in heuristic scoring", () => {
    const scored = scoreChatAction({
      app: "WhatsApp.Root",
      exe: "WhatsApp.Root.exe",
      windowTitle: "WhatsApp",
      text: `HEADER: Wini You
I will share the revenue details to you by tonwrrow 11:58am`,
    });
    expect(scored).not.toBeNull();
    expect(scored!.peer?.toLowerCase()).toContain("wini");
    expect(scored!.actionTitle.toLowerCase()).toContain("tomorrow");
    expect(scored!.actionTitle.toLowerCase()).not.toContain("tonwrrow");
  });
});
