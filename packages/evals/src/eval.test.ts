import { describe, expect, it } from "vitest";
import { evaluateFixtures, loadFixtures } from "./run-eval.js";

describe("loop detector eval harness", () => {
  it("loads fixtures and achieves F1 >= 0.45", async () => {
    const fixtures = await loadFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(40);
    const report = evaluateFixtures(fixtures);
    expect(report.overall.f1).toBeGreaterThanOrEqual(0.45);
  });
});
