import { describe, expect, it } from "vitest";
import { evaluateFixtures, loadFixtures } from "./run-eval.js";
import { scoreFixture } from "./score-fixture.js";

describe("loop detector eval harness", () => {
  it("loads fixtures and achieves F1 >= 0.45", async () => {
    const fixtures = await loadFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(40);
    const report = evaluateFixtures(fixtures);
    expect(report.overall.f1).toBeGreaterThanOrEqual(0.45);
  });

  it("treats WhatsApp OCR with a real ask as a follow-up", () => {
    const hit = scoreFixture({
      id: "t",
      source: "chat",
      label: "is_loop",
      expectedTitleContains: "Farhan",
      input: {
        app: "WhatsApp",
        windowTitle: "Farhan - WhatsApp",
        text: "can you send the deck tonight?",
      },
    });
    expect(hit.predicted).toBe(true);
    expect(hit.title?.toLowerCase()).toContain("farhan");
  });

  it("does not treat a named chat title without an ask as a loop", () => {
    expect(
      scoreFixture({
        id: "t",
        source: "chat",
        label: "not_loop",
        input: { app: "WhatsApp", windowTitle: "Farhan - WhatsApp" },
      }).predicted,
    ).toBe(false);
  });

  it("uses HEADER chat name OCR and prefers the clean commitment over garbled text", () => {
    const hit = scoreFixture({
      id: "t",
      source: "chat",
      label: "is_loop",
      expectedTitleContains: "payment",
      input: {
        app: "WhatsApp.Root",
        windowTitle: "WhatsApp",
        text: `HEADER: Yeh bhi kr liya You
Send the bi" by tomorrow 9:29 N" v"
I will send the paymen to you tornorrow`,
      },
    });
    expect(hit.predicted).toBe(true);
    expect(hit.title?.toLowerCase()).toContain("payment");
    expect(hit.title).not.toMatch(/bi["']/);
  });

  it("picks native WhatsApp desktop (OS title WhatsApp) from thread OCR", () => {
    const hit = scoreFixture({
      id: "t",
      source: "chat",
      label: "is_loop",
      expectedTitleContains: "bill",
      input: {
        app: "WhatsApp.Root",
        windowTitle: "WhatsApp",
        text: "start a new chat Yeh bhi kr liya click here You: I will send the bill by tomorrow",
      },
    });
    expect(hit.predicted).toBe(true);
    expect(hit.title?.toLowerCase()).toMatch(/bill/);
  });

  it("does not treat generic chat chrome as a loop", () => {
    expect(
      scoreFixture({
        id: "t",
        source: "chat",
        label: "not_loop",
        input: { app: "WhatsApp", windowTitle: "WhatsApp" },
      }).predicted,
    ).toBe(false);
  });

  it("does not treat trading OCR as a loop", () => {
    expect(
      scoreFixture({
        id: "t",
        source: "ocr",
        label: "not_loop",
        input: {
          app: "Binance",
          windowTitle: "Binance",
          text: "Unrealized PnL TP/SL",
        },
      }).predicted,
    ).toBe(false);
  });
});

