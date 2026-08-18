import { describe, expect, it } from "vitest";
import {
  loopsAreDuplicate,
  sourceThreadKey,
  senderKey,
  titleSim,
} from "@second-brain/agents";

describe("loop dedupe", () => {
  it("treats Gmail messages in the same thread as one task", () => {
    const thread =
      "https://mail.google.com/mail/u/0/#inbox/18abc123def45678";
    expect(sourceThreadKey(thread)).toBe("gmail:18abc123def45678");
    expect(
      loopsAreDuplicate(
        {
          title: "Answer the two questions about services and offerings for a premium KOSH card.",
          who: "Karan",
          sourceUrl: thread,
        },
        {
          title: "Follow up: A question about the KOSH premium card",
          who: "Karan",
          sourceUrl: thread,
        },
      ),
    ).toBe(true);
  });

  it("merges LLM-rewritten titles from the same Stripe billing sender", () => {
    const who =
      "Kling AI <failed-payments+acct_1TE4m49FGqv0wmIF@stripe.com>";
    expect(senderKey(who)).toBe("failed-payments@stripe.com");
    expect(
      loopsAreDuplicate(
        {
          title: "Update billing information for Kling AI subscription",
          who,
          sourceUrl:
            "https://mail.google.com/mail/u/0/#inbox/thread-aaa11111",
        },
        {
          title: "update billing info",
          who,
          sourceUrl:
            "https://mail.google.com/mail/u/0/#inbox/thread-bbb22222",
        },
      ),
    ).toBe(true);
  });

  it("does not merge different topics from the same person", () => {
    expect(
      loopsAreDuplicate(
        {
          title: "Reply to Priya about the invoice",
          who: "Priya <priya@example.com>",
        },
        {
          title: "Reply to Priya about the NDA",
          who: "Priya <priya@example.com>",
        },
      ),
    ).toBe(false);
    expect(titleSim("Reply to Priya about the invoice", "Reply to Priya about the NDA")).toBeLessThan(0.5);
  });

  it("keys GitHub issues by repo + number, not comment fragment", () => {
    expect(
      sourceThreadKey("https://github.com/acme/app/issues/12#issuecomment-9"),
    ).toBe("gh:acme/app/issues/12");
    expect(
      loopsAreDuplicate(
        {
          title: "Fix login race",
          sourceUrl: "https://github.com/acme/app/issues/12",
        },
        {
          title: "Work on issue: login race",
          sourceUrl: "https://github.com/acme/app/issues/12#issuecomment-9",
        },
      ),
    ).toBe(true);
  });
});
