import { describe, expect, it } from "vitest";
import {
  parseChatPeer,
  detectChatApp,
  chatFollowUpTitle,
  scoreChatAction,
} from "@second-brain/agents";

describe("chat window titles", () => {
  it("parses WhatsApp desktop peer titles", () => {
    const hit = parseChatPeer("Farhan - WhatsApp", "WhatsApp");
    expect(hit?.peer).toBe("Farhan");
    expect(hit?.app).toBe("WhatsApp");
    expect(chatFollowUpTitle(hit!.peer, hit!.app)).toBe(
      "Follow up with Farhan on WhatsApp",
    );
  });

  it("parses Telegram Desktop and unread badges", () => {
    const hit = parseChatPeer("(2) Raj — Telegram Desktop", "Telegram");
    expect(hit?.peer).toBe("Raj");
    expect(hit?.app).toBe("Telegram");
  });

  it("parses WhatsApp Web from URL + peer title", () => {
    const hit = parseChatPeer(
      "Priya",
      "Google Chrome",
      "chrome.exe",
      "https://web.whatsapp.com/",
    );
    expect(hit?.peer).toBe("Priya");
    expect(hit?.app).toBe("WhatsApp");
  });

  it("drops generic chrome titles without OCR", () => {
    expect(parseChatPeer("WhatsApp", "WhatsApp")).toBeNull();
    expect(parseChatPeer("Telegram Desktop", "Telegram")).toBeNull();
    expect(parseChatPeer("Chats", "WhatsApp")).toBeNull();
  });

  it("parses native WhatsApp.Root from OCR when the OS title is just WhatsApp", () => {
    const hit = parseChatPeer(
      "WhatsApp",
      "WhatsApp.Root",
      "WhatsApp.Root.exe",
      null,
      "Chats Search start a new chat Yeh bhi kr liya click here for contact info You: I will send the bill by tomorrow",
    );
    expect(hit?.peer.toLowerCase()).toContain("yeh bhi");
    expect(hit?.app).toBe("WhatsApp");
    const scored = scoreChatAction({
      app: "WhatsApp.Root",
      exe: "WhatsApp.Root.exe",
      windowTitle: "WhatsApp",
      text: "Chats Search start a new chat Yeh bhi kr liya click here for contact info You: I will send the bill by tomorrow Type a message",
    });
    expect(scored?.actionTitle.toLowerCase()).toMatch(/bill/);
  });

  it("detects Telegram web URLs", () => {
    expect(
      detectChatApp("chrome", null, "Saved Messages", "https://web.telegram.org/k/"),
    ).toBe("Telegram");
  });

  it("scores native WhatsApp thread OCR without a contact in the window title", () => {
    const scored = scoreChatAction({
      app: "WhatsApp.Root",
      exe: "WhatsApp.Root.exe",
      windowTitle: "WhatsApp",
      text: "eAadhaar_1784103079.pdf 1:41 I will send the paymen to you tornorrow",
    });
    expect(scored).not.toBeNull();
    expect(scored!.actionTitle.toLowerCase()).toMatch(/payment|bill|send/);
    expect(scored!.actionTitle.toLowerCase()).toContain("tomorrow");
  });

  it("reads the chat name from HEADER and skips garbled OCR as the title", () => {
    const scored = scoreChatAction({
      app: "WhatsApp.Root",
      exe: "WhatsApp.Root.exe",
      windowTitle: "WhatsApp",
      text: `HEADER: Yeh bhi kr liya You
Send the bi" by tomorrow 9:29 N" v"
I will send the paymen to you tornorrow`,
    });
    expect(scored).not.toBeNull();
    expect(scored!.peer?.toLowerCase()).toContain("yeh bhi");
    expect(scored!.actionTitle.toLowerCase()).toContain("payment");
    expect(scored!.actionTitle).not.toMatch(/bi["']/);
    expect(scored!.actionTitle.toLowerCase()).not.toContain("9:29");
  });

  it("drops idle threads even with a named peer", () => {
    expect(
      scoreChatAction({
        app: "WhatsApp",
        windowTitle: "Farhan - WhatsApp",
        text: "ok lol thanks",
      }),
    ).toBeNull();
  });

  it("drops market / trading tape in a chat window", () => {
    expect(
      scoreChatAction({
        app: "Slack",
        windowTitle: "jamie (DM) - Acme - Slack",
        text: "Opened LONG xyz:GOLD Market $99.81 notional PnL -0.15 cross margin TP/SL",
      }),
    ).toBeNull();
  });
});
