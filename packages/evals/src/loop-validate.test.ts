import { describe, expect, it } from "vitest";
import {
  validateExtractedLoop,
  isWeakLoopTitle,
  BANNED_GENERIC_TITLES,
  isSelfGeneratedObservation,
  formatDue,
} from "@second-brain/agents";

describe("loop-validate banned titles", () => {
  for (const bad of BANNED_GENERIC_TITLES.slice(0, 5)) {
    it(`rejects "${bad}"`, () => {
      expect(isWeakLoopTitle(bad)).toBe(true);
      const v = validateExtractedLoop(
        {
          keep: true,
          title: bad.replace(/\b\w/g, (c) => c.toUpperCase()),
          who: "CLANX/Senior AI Engineer - Bengaluru",
          evidenceQuote: "we received your application",
        },
        "Thanks for applying. We received your application to CLANX.",
      );
      expect(v.ok).toBe(false);
    });
  }

  it("accepts a concrete Rivet title", () => {
    const source =
      "Hi Rivet hiring, I'd love to work on the engineering role. Resume attached.";
    const v = validateExtractedLoop(
      {
        keep: true,
        title: "Follow up with Rivet hiring on the engineering role",
        who: "Rivet hiring",
        org: "Rivet",
        evidenceQuote: "I'd love to work on the engineering role",
        due: null,
      },
      source,
    );
    expect(v.ok).toBe(true);
    expect(v.fields.due).toBeNull();
  });

  it("rejects soon as due and clears it", () => {
    const v = validateExtractedLoop(
      {
        keep: true,
        title: "Update billing for Kling AI subscription",
        who: "Kling AI",
        org: "Kling AI",
        dueHint: "soon",
        evidenceQuote: "Update your payment method for Kling AI",
      },
      "Your card failed. Update your payment method for Kling AI.",
    );
    // dueHint "soon" becomes null via normalize; may still error if listed
    expect(v.fields.due).toBeNull();
    expect(v.fields.dueHint).toBeNull();
  });

  it("rejects OCR garbage titles", () => {
    expect(
      isWeakLoopTitle(
        'Send the bi" by tomorrow 9:29 N" v" I will send the payment',
      ),
    ).toBe(true);
  });
});

describe("isSelfGeneratedObservation", () => {
  it("blocks Cursor Agents windows", () => {
    expect(
      isSelfGeneratedObservation({
        app: "Cursor",
        windowTitle: "Cursor Agents",
      }),
    ).toBe(true);
  });

  it("allows WhatsApp", () => {
    expect(
      isSelfGeneratedObservation({
        app: "WhatsApp",
        windowTitle: "Wini - WhatsApp",
      }),
    ).toBe(false);
  });
});

describe("formatDue", () => {
  it("formats overdue ISO dates", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 2);
    yesterday.setHours(12, 0, 0, 0);
    const f = formatDue(yesterday.toISOString());
    expect(f?.overdue).toBe(true);
    expect(f?.label).toMatch(/Overdue by 2 days/);
  });

  it("formats today", () => {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    const f = formatDue(d.toISOString());
    expect(f?.label).toBe("Due today");
    expect(f?.overdue).toBe(false);
  });
});
