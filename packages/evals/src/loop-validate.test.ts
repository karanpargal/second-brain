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

describe("loop-validate direction and identity", () => {
  const source =
    "HEADER: Wini\nI will update you on our hackathon tomorrow\nSecond brain tujhe chahiye lagta hai";

  it("rejects a chase for something the user themselves promised", () => {
    const v = validateExtractedLoop(
      {
        keep: true,
        direction: "from_me",
        title: "Follow up with Wini on the hackathon update",
        who: "Wini",
        evidenceQuote: "I will update you on our hackathon tomorrow",
      },
      source,
    );
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/imperative/i);
  });

  it("accepts the imperative form of the same promise", () => {
    const v = validateExtractedLoop(
      {
        keep: true,
        direction: "from_me",
        title: "Update Wini on the hackathon",
        who: "Wini",
        evidenceQuote: "I will update you on our hackathon tomorrow",
      },
      source,
    );
    expect(v.ok).toBe(true);
  });

  it("rejects a browser or tab name as the person", () => {
    const v = validateExtractedLoop(
      {
        keep: true,
        title: "Follow up with Telegram Web - Google Chrome about Trench changes",
        who: "Telegram Web",
        evidenceQuote: "I need to complete Trench changes by tomorrow",
      },
      "I need to complete Trench changes by tomorrow",
    );
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/browser, app or tab/i);
    expect(v.fields.who).toBeNull();
  });

  it("rejects the user's own name as the counterparty", () => {
    const v = validateExtractedLoop(
      {
        keep: true,
        selfNames: ["karan"],
        title: "Follow up with Karan about Trench changes",
        who: "Karan",
        evidenceQuote: "I need to complete Trench changes by tomorrow",
      },
      "I need to complete Trench changes by tomorrow",
    );
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/is the user/i);
    expect(v.fields.who).toBeNull();
  });
});

describe("loop-validate due dates", () => {
  it("drops a due copied from the message's own send time", () => {
    const v = validateExtractedLoop(
      {
        keep: true,
        title: "Complete the Trench changes for Wini",
        who: "Wini",
        due: "2026-09-04T21:54:39",
        evidenceQuote: "I need to complete Trench changes by tomorrow",
      },
      "I need to complete Trench changes by tomorrow\n4 September 2026, 21:54:39\n09:54 PM",
    );
    expect(v.fields.due).toBeNull();
  });

  it("rescues a day-first date the model read month-first", () => {
    // "tomorrow is 5/9/2026" answered as 2026-05-09 rendered "Overdue by 118 days".
    const now = new Date();
    now.setHours(12, 0, 0, 0);
    const v = validateExtractedLoop(
      {
        keep: true,
        title: "Update Wini on the hackathon",
        who: "Wini",
        due: "2026-05-09",
        evidenceQuote: "I will update you on our hackathon tomorrow",
      },
      "I will update you on our hackathon tomorrow",
    );
    const due = v.fields.due ? new Date(Date.parse(v.fields.due)) : null;
    expect(due).not.toBeNull();
    expect(due!.getTime()).toBeGreaterThan(now.getTime());
    expect(formatDue(v.fields.due!)?.label).toBe("Due tomorrow");
  });

  it("reads a bare ISO date as local noon, not UTC midnight", () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const iso = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
    const v = validateExtractedLoop(
      {
        keep: true,
        title: "Send Wini the revenue deck",
        who: "Wini",
        due: iso,
        evidenceQuote: "send the revenue deck",
      },
      "please send the revenue deck",
    );
    expect(formatDue(v.fields.due!)?.label).toBe("Due tomorrow");
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
