import { describe, expect, it } from "vitest";
import {
  classifyMailLoop,
  isGenericTitle,
  isSentCloseOut,
  polishLoopTitle,
} from "@second-brain/agents";

describe("mail categories", () => {
  it("turns a sent job application into a follow-up, never reply", () => {
    const r = classifyMailLoop({
      subject: "Interested in engineering at Rivet",
      body: "Hi, I'm Karan — I'd love to work on Rust and actors at Rivet. Resume attached.",
      from: "Karan Pargal <karanpargal007@gmail.com>",
      to: "hiring@rivet.dev",
      labels: ["SENT"],
      userEmail: "karanpargal007@gmail.com",
      kind: "email",
    });
    expect(r.keep).toBe(true);
    expect(r.fromMe).toBe(true);
    expect(r.category).toBe("follow_up");
    expect(r.tags).toContain("career");
    expect(r.kind).toBe("awaiting_reply");
    expect(r.title.toLowerCase()).toMatch(/follow up/);
    expect(r.title.toLowerCase()).not.toBe("reply");
    expect(r.who?.toLowerCase()).toMatch(/rivet/);
  });

  it("drops a sent close-out even when the quoted thread is about hiring", () => {
    const body = `Thanks, Parth!

I really appreciate you taking the time to look through my background. I'd be happy to reconnect if something comes up that could be a good fit.

Wishing you and the team all the best!

Best,
Karan

On Mon, Aug 10, 2026 at 11:56 PM Y Combinator <notifications@ycombinator.com> wrote:
-- Reply above this line --
Parth Badhwar from Locke sent you the following message:
Hi Karan, Thanks for reaching out. Companies hiring on Work at a Startup...`;
    expect(isSentCloseOut(body)).toBe(true);
    const r = classifyMailLoop({
      subject: "Parth from Locke sent you a message",
      body,
      from: "Karan Pargal <you@example.com>",
      to: "bf-j-10059294@inbound.nnd.yccombinator.com",
      labels: ["SENT"],
      userEmail: "you@example.com",
      kind: "email",
    });
    expect(r.fromMe).toBe(true);
    expect(r.keep).toBe(false);
    expect(r.title.toLowerCase()).not.toMatch(/follow up/);
  });

  it("drops sent mail that is not outreach or an ask", () => {
    const r = classifyMailLoop({
      subject: "Thanks for today",
      body: "Great catching up. See you next week.",
      from: "me@example.com",
      to: "friend@example.com",
      labels: ["SENT"],
      userEmail: "me@example.com",
      kind: "email",
    });
    expect(r.keep).toBe(false);
  });

  it("tags Stripe dunning as billing", () => {
    const r = classifyMailLoop({
      subject: "Your Kling AI payment failed",
      body: "Please update your billing information for the subscription.",
      from: "Kling AI <failed-payments@stripe.com>",
      labels: ["INBOX"],
      userEmail: "me@example.com",
      kind: "notification",
    });
    expect(r.keep).toBe(true);
    expect(r.category).toBe("billing");
    expect(r.title.toLowerCase()).toMatch(/billing/);
  });

  it("does not treat an IPO allotment regret as billing", () => {
    const r = classifyMailLoop({
      subject: "DHOOT TRANSMISSION LIMITED-IPO",
      body: `Dear Investor, Greetings!!
This is with reference to the application made by you in the public issue of DHOOT TRANSMISSION LIMITED-IPO.
Shares Allotted: 0
Status: Regret - Un-successful allotment due to over-subscription
Amount Unblocked: 14807.00
Date of Unblock: 14/08/2026`,
      from: "KFIN TECHNOLOGIES LIMITED <dhoot.ipo@kfintech.com>",
      labels: ["INBOX"],
      userEmail: "you@example.com",
      kind: "email",
    });
    expect(r.keep).toBe(false);
    expect(r.category).not.toBe("billing");
    expect(r.title.toLowerCase()).not.toMatch(/update billing/);
  });

  it("drops marketing Action Required / promote-your mail", () => {
    const r = classifyMailLoop({
      subject: "Action Required: Promote Your ENS Domain to v2",
      body: "Promote your ENS domain to v2. Claim your domain now.",
      from: "ENS <noreply@ens.domains>",
      labels: ["INBOX"],
      userEmail: "me@example.com",
      kind: "email",
    });
    expect(r.keep).toBe(false);
  });

  it("keeps a real human review ask even if the subject says Action required", () => {
    const r = classifyMailLoop({
      subject: "Action required: please review the contract",
      body: "Please review the attached MSA and confirm by Friday.",
      from: "Legal <legal@partner.co>",
      labels: ["INBOX"],
      userEmail: "me@example.com",
      kind: "email",
    });
    expect(r.keep).toBe(true);
    expect(r.category).toBe("review");
  });

  it("drops generic inbound mail with no personal ask", () => {
    const r = classifyMailLoop({
      subject: "Your weekly product update",
      body: "Here is what shipped this week.",
      from: "Product <hello@acme.com>",
      kind: "email",
    });
    expect(r.keep).toBe(false);
  });

  it("rejects one-word LLM titles", () => {
    expect(isGenericTitle("reply")).toBe(true);
    expect(isGenericTitle("update")).toBe(true);
    expect(
      polishLoopTitle(
        "reply",
        "Follow up with Rivet hiring on the engineering role",
      ),
    ).toMatch(/Rivet/);
  });
});
