import { describe, expect, it } from "vitest";
import {
  isSelfName,
  segmentChatCapture,
  selfNamesFromSurface,
} from "@second-brain/core";
import {
  AX_TELEGRAM_FULL,
  AX_TELEGRAM_SIDEBAR_ONLY,
  AX_TELEGRAM_SPARSE,
  AX_TELEGRAM_WINDOW_TITLE,
} from "./fixtures/ax-telegram.js";

const CTX = {
  app: "Google Chrome",
  exe: "com.google.Chrome",
  windowTitle: AX_TELEGRAM_WINDOW_TITLE,
};

describe("segmentChatCapture — macOS Telegram Web", () => {
  it("keeps the open thread and drops the sidebar", () => {
    const seg = segmentChatCapture(AX_TELEGRAM_FULL, CTX);
    expect(seg.view).toBe("thread");
    expect(seg.header).toBe("Mira");

    const thread = seg.thread ?? "";
    expect(thread).toContain("I need to complete Atlas changes by tomorrow");
    expect(thread).toContain("I will update you on our hackathon tomorrow");

    // Fifteen other conversations used to be the only thing we stored.
    for (const other of [
      "Best Deals Daily",
      "Market logs by Sam",
      "Dev HUB > Crewsphere",
      "BasedBot",
      "Protocol India",
    ]) {
      expect(thread).not.toContain(other);
    }
  });

  it("strips the bubble clock stamps that became due dates", () => {
    const thread = segmentChatCapture(AX_TELEGRAM_FULL, CTX).thread ?? "";
    expect(thread).not.toContain("4 September 2026, 21:54:39");
    expect(thread).not.toMatch(/^\d{1,2}:\d{2} [AP]M$/m);
    expect(thread).not.toContain("Today");
  });

  it("strips browser chrome and leaked tab titles", () => {
    const thread = segmentChatCapture(AX_TELEGRAM_FULL, CTX).thread ?? "";
    expect(thread).not.toContain("Memory usage");
    expect(thread).not.toContain("Open Gemini in Chrome");
    expect(thread).not.toContain("Tab search");
    expect(thread).not.toContain(AX_TELEGRAM_WINDOW_TITLE);
  });

  it("collapses the same message repeated across bubbles", () => {
    const thread = segmentChatCapture(AX_TELEGRAM_FULL, CTX).thread ?? "";
    const line = "I will launch second brain tomorrow and then update you on the same";
    expect(AX_TELEGRAM_FULL.split(line).length - 1).toBeGreaterThan(3);
    expect(thread.split(line).length - 1).toBe(1);
  });

  it("drops link-preview blocks that read like commitments", () => {
    const thread = segmentChatCapture(AX_TELEGRAM_FULL, CTX).thread ?? "";
    expect(thread).not.toContain("X (formerly Twitter)");
    expect(thread).not.toContain("Devpost");
    expect(thread).not.toMatch(/^https?:\/\//m);
  });

  it("ties the thread back to its sidebar row", () => {
    const seg = segmentChatCapture(AX_TELEGRAM_FULL, CTX);
    expect(seg.peerRow?.name).toBe("Mira");
    // Telegram omits `You:` on the selected row, so absence proves nothing.
    expect(seg.peerRow?.fromMe).toBe(false);
  });

  it("refuses to produce a thread from a sidebar-only capture", () => {
    const seg = segmentChatCapture(AX_TELEGRAM_SIDEBAR_ONLY, CTX);
    expect(seg.view).toBe("list");
    expect(seg.thread).toBeNull();
    expect(seg.header).toBeNull();
  });

  it("still names the peer on a sparse read with no sidebar", () => {
    const seg = segmentChatCapture(AX_TELEGRAM_SPARSE, CTX);
    expect(seg.view).toBe("thread");
    expect(seg.header).toBe("Mira");
    expect(seg.thread).toContain("I need to complete Atlas changes by tomorrow");
    expect(seg.thread).not.toContain("Open Gemini in Chrome");
  });
});

describe("self names", () => {
  it("reads the Chrome profile name out of the window title", () => {
    const names = selfNamesFromSurface({ windowTitle: AX_TELEGRAM_WINDOW_TITLE });
    expect(names).toContain("dev");
    expect(isSelfName("Dev", names)).toBe(true);
    expect(isSelfName("Mira", names)).toBe(false);
  });

  it("reads native Telegram and WhatsApp title suffixes", () => {
    expect(selfNamesFromSurface({ windowTitle: "Telegram @ Dev" })).toContain("dev");
    expect(selfNamesFromSurface({ windowTitle: "WhatsApp (Dev Rao)" })).toContain(
      "dev",
    );
  });

  it("matches a full name against its tokens", () => {
    const names = selfNamesFromSurface({ selfNames: ["dev.rao"] });
    expect(isSelfName("Dev Rao", names)).toBe(true);
  });
});

describe("segmentChatCapture — other surfaces", () => {
  it("passes Windows HEADER OCR through untouched", () => {
    const seg = segmentChatCapture(
      "HEADER: Farhan\nSend the bill by tomorrow 9:29\nI will send the payment",
      { app: "WhatsApp.Root", exe: "WhatsApp.Root.exe", windowTitle: "WhatsApp" },
    );
    expect(seg.view).toBe("thread");
    expect(seg.header).toBe("Farhan");
    expect(seg.thread).toContain("Send the bill by tomorrow 9:29");
  });

  it("leaves Slack alone rather than calling it a list", () => {
    const seg = segmentChatCapture(
      [
        "Acme",
        "#general",
        "jamie",
        "can you review the deploy doc before Friday",
        "Message #general",
      ].join("\n"),
      { app: "Slack", exe: "com.tinyspeck.slackmacgap", windowTitle: "general (Channel) - Acme - Slack" },
    );
    expect(seg.view).toBe("unknown");
    expect(seg.thread).toContain("can you review the deploy doc before Friday");
  });

  it("returns nothing for empty text", () => {
    expect(segmentChatCapture("", {}).thread).toBeNull();
  });
});
