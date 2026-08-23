import { describe, expect, it } from "vitest";
import {
  extractSkillHint,
  extractLearningTopic,
  extractSearchQueryFromUrl,
  focusStats,
  isAllowedSuggestionUrl,
  isHttpsUrl,
  isNoiseSurface,
  isSafeInsightText,
  isWorkArtifact,
  parseSuggestions,
  prettyApp,
  rankLearningTopics,
  redactPii,
  sessionizeByApp,
  topicMatches,
} from "@second-brain/agents";

describe("insight quality", () => {
  it("redacts emails from Gmail window titles", () => {
    const raw =
      "Ready to Claim Your One-Time Pack? - you@example.com - Gmail";
    expect(redactPii(raw)).not.toMatch(/@/);
    expect(isSafeInsightText(raw)).toBe(false);
  });

  it("treats search, YouTube, Gmail, and X as noise — Cursor/repos as work", () => {
    expect(
      isNoiseSurface("graph engineering ai - Google Search"),
    ).toBe(true);
    expect(
      isWorkArtifact({
        kind: "url",
        key: "https://www.google.com/search",
        title: "graph engineering ai - Google Search",
      }),
    ).toBe(false);
    expect(
      isWorkArtifact({
        kind: "url",
        key: "https://www.youtube.com/watch",
        title: "The Classic Ones from Season 6 | Friends - YouTube",
      }),
    ).toBe(false);
    expect(
      isWorkArtifact({
        kind: "url",
        key: "https://mail.google.com/mail",
        title: "Claim Your One-Time Pack? - you@example.com - Gmail",
      }),
    ).toBe(false);
    expect(isNoiseSurface("Home / X")).toBe(true);
    expect(
      isWorkArtifact({
        kind: "window",
        key: "cursor:insights.ts",
        title: "insights.ts - second-brain - Cursor",
      }),
    ).toBe(true);
    expect(
      isWorkArtifact({
        kind: "url",
        key: "https://github.com/example/second-brain",
        title: "second-brain pull request",
      }),
    ).toBe(true);
  });

  it("rejects telemetry copy that should never ship", () => {
    expect(
      isSafeInsightText(
        "You switched contexts about 44 times across 549 activity blocks. Top apps: Cursor (5m).",
      ),
    ).toBe(false);
    expect(
      isSafeInsightText(
        "Most-touched: YouTube. Consider pinning or scripting the top one.",
      ),
    ).toBe(false);
    expect(
      isSafeInsightText(
        "Block 90 minutes tomorrow morning with notifications paused.",
      ),
    ).toBe(false);
    expect(isSafeInsightText("Most time in Cursor")).toBe(true);
  });

  it("sessionizes by app so file hops count as one deep-work stretch", () => {
    const sessions = sessionizeByApp([
      { app: "Cursor", startAt: "2026-08-13T09:00:00Z", dwellMs: 10 * 60_000 },
      { app: "Cursor", startAt: "2026-08-13T09:10:00Z", dwellMs: 20 * 60_000 },
      { app: "chrome", startAt: "2026-08-13T09:30:00Z", dwellMs: 0 },
    ]);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.dwellMs).toBe(30 * 60_000);
    const stats = focusStats([
      { app: "Cursor", startAt: "2026-08-13T09:00:00Z", dwellMs: 10 * 60_000 },
      { app: "Cursor", startAt: "2026-08-13T09:10:00Z", dwellMs: 20 * 60_000 },
      { app: "chrome", startAt: "2026-08-13T09:30:00Z", dwellMs: 0 },
    ]);
    expect(stats.deepWorkMs).toBe(30 * 60_000);
    expect(stats.totalMs).toBe(30 * 60_000);
    expect(stats.topApps[0]?.[0]).toBe("cursor");
    expect(prettyApp("chrome")).toBe("Chrome");
  });

  it("extracts a skill from GitHub or a Cursor file, not from browsing", () => {
    expect(
      extractSkillHint({
        artifacts: [
          {
            kind: "url",
            key: "https://www.youtube.com/watch",
            title: "Friends - YouTube",
          },
        ],
        github: [
          {
            title: "fix widget",
            url: "https://github.com/example/second-brain/pull/1",
          },
        ],
      }),
    ).toBe("example/second-brain");
  });

  it("extracts learning topics from search titles, not Friends or Gmail", () => {
    expect(
      extractLearningTopic("graph engineering ai - Google Search"),
    ).toBe("graph engineering");
    expect(
      extractLearningTopic(
        "graph engineering ai - Google Search",
        "https://www.google.com/search",
      ),
    ).toBe("graph engineering");
    expect(
      extractLearningTopic(
        "The Classic Ones from Season 6 | Friends - YouTube",
        "https://www.youtube.com/watch",
      ),
    ).toBeNull();
    expect(
      extractLearningTopic(
        "Ready to Claim Your One-Time Pack? - you@example.com - Gmail",
        "https://mail.google.com/mail",
      ),
    ).toBeNull();
    const ranked = rankLearningTopics([
      {
        title: "graph engineering ai - Google Search",
        key: "https://www.google.com/search",
      },
      {
        title: "graph engineering ai - Google Search",
        key: "https://www.google.com/search",
      },
      {
        title: "graph engineering ai - Google Search",
        key: "https://www.google.com/search",
      },
      {
        title: "graph engineering ai - Google Search",
        key: "https://www.google.com/search",
      },
      {
        title: "The Classic Ones from Season 6 | Friends - YouTube",
        key: "https://www.youtube.com/watch",
      },
    ]);
    expect(ranked).toEqual([{ topic: "graph engineering", count: 4 }]);
    expect(topicMatches("graph engineering", "graph engineering ai")).toBe(
      true,
    );
  });

  it("keeps graph engineering after a later Google search for weather", () => {
    const events = [
      {
        title: "graph engineering ai - Google Search",
        url: "https://www.google.com/search?q=graph+engineering+ai",
      },
      {
        title: "graph engineering ai - Google Search",
        url: "https://www.google.com/search?q=graph+engineering+ai",
      },
      {
        title: "weather - Google Search",
        url: "https://www.google.com/search?q=weather",
      },
    ];
    const ranked = rankLearningTopics(events);
    expect(ranked.map((r) => r.topic).sort()).toEqual(
      ["graph engineering", "weather"].sort(),
    );
    expect(ranked.find((r) => r.topic === "graph engineering")?.count).toBe(2);
    expect(ranked.find((r) => r.topic === "weather")?.count).toBe(1);
    const collapsed = rankLearningTopics([
      {
        title: "weather - Google Search",
        key: "https://www.google.com/search",
        touchCount: 3,
      },
    ]);
    expect(collapsed).toEqual([{ topic: "weather", count: 1 }]);
  });

  it("extracts a topic from the search URL when the title is empty", () => {
    expect(
      extractSearchQueryFromUrl(
        "https://www.google.com/search?q=graph+engineering",
      ),
    ).toBe("graph engineering");
    expect(
      extractLearningTopic("", "https://www.google.com/search?q=graph+engineering"),
    ).toBe("graph engineering");
  });

  it("only allows https public URLs for suggestions", () => {
    expect(isHttpsUrl("https://en.wikipedia.org/wiki/Graph_theory")).toBe(
      true,
    );
    expect(isHttpsUrl("http://example.com/article")).toBe(false);
    expect(isHttpsUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpsUrl("https://user:pass@evil.example/x")).toBe(false);
    expect(isHttpsUrl("https://127.0.0.1/wiki/x")).toBe(false);
    expect(
      isAllowedSuggestionUrl("https://en.wikipedia.org/wiki/Graph_theory"),
    ).toBe(true);
    expect(
      isAllowedSuggestionUrl("https://www.youtube.com/watch?v=abc"),
    ).toBe(true);
    expect(isAllowedSuggestionUrl("https://evil.example/phish")).toBe(false);
    expect(
      isAllowedSuggestionUrl("https://wikipedia.evil.example/wiki/Graph"),
    ).toBe(false);
  });

  it("parseSuggestions drops unknown hosts and non-https URLs", () => {
    const items = parseSuggestions(`{
      "items": [
        {"title": "Graph theory", "url": "https://en.wikipedia.org/wiki/Graph_theory", "kind": "article"},
        {"title": "phish", "url": "https://evil.example/x", "kind": "article"},
        {"title": "insecure", "url": "http://en.wikipedia.org/wiki/Graph_theory", "kind": "article"},
        {"title": "js", "url": "javascript:alert(1)", "kind": "video"}
      ]
    }`);
    expect(items).toEqual([
      {
        title: "Graph theory",
        url: "https://en.wikipedia.org/wiki/Graph_theory",
        kind: "article",
      },
    ]);
    expect(parseSuggestions("not json")).toEqual([]);
  });
});
