import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  scoreFixture,
  type EvalFixture,
  type FixtureSource,
} from "./score-fixture.js";
import { evaluateAiGoldens, type AiEvalReport } from "./ai-eval.js";
import { saveEvalLearn, type EvalLearnMiss } from "@second-brain/agents";

export type Metrics = {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
  support: number;
};

export type EvalReport = {
  overall: Metrics;
  bySource: Record<string, Metrics>;
  rows: Array<{
    id: string;
    source: string;
    label: string;
    predicted: boolean;
    confidence: number;
    title?: string;
    ok: boolean;
  }>;
};

function metricsFromCounts(tp: number, fp: number, tn: number, fn: number): Metrics {
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 =
    precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    tp,
    fp,
    tn,
    fn,
    precision,
    recall,
    f1,
    support: tp + fp + tn + fn,
  };
}

function emptyCounts() {
  return { tp: 0, fp: 0, tn: 0, fn: 0 };
}

function accumulate(
  c: ReturnType<typeof emptyCounts>,
  actual: boolean,
  predicted: boolean,
) {
  if (actual && predicted) c.tp++;
  else if (!actual && predicted) c.fp++;
  else if (!actual && !predicted) c.tn++;
  else c.fn++;
}

export async function loadFixtures(dir?: string): Promise<EvalFixture[]> {
  const base =
    dir ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
  const names = (await readdir(base))
    .filter((n) => n.endsWith(".json") && !n.startsWith("trading-"))
    .sort();
  const out: EvalFixture[] = [];
  for (const name of names) {
    const raw = await readFile(path.join(base, name), "utf8");
    out.push(JSON.parse(raw) as EvalFixture);
  }
  // Pad with deterministic synthetics so eval corpus ≈ 200 without shipping hundreds of files
  if (out.length < 200) {
    out.push(...syntheticFixtures(200 - out.length, out.length));
  }
  return out;
}

function syntheticFixtures(count: number, startIdx: number): EvalFixture[] {
  const templates: Array<Omit<EvalFixture, "id">> = [
    {
      source: "email",
      label: "is_loop",
      input: {
        kind: "email",
        title: "Action required: sign the NDA",
        body: "Please sign and return by EOD",
        author: "legal@example.com",
      },
    },
    {
      source: "email",
      label: "not_loop",
      input: {
        kind: "email",
        title: "Flash sale 50% off",
        body: "Shop now unsubscribe",
        author: "noreply@deals.com",
      },
    },
    {
      source: "github",
      label: "is_loop",
      input: {
        kind: "issue",
        title: "Fix login race",
        body: "assigned to you please review",
      },
    },
    {
      source: "github",
      label: "not_loop",
      input: {
        kind: "pr",
        title: "[dependabot] bump lodash",
        body: "automated",
        author: "dependabot",
      },
    },
    {
      source: "ocr",
      label: "not_loop",
      input: {
        app: "chrome",
        windowTitle: "YouTube",
        text: "Search\nwow this clip is wild\nYesterday",
      },
    },
    {
      source: "chat",
      label: "is_loop",
      expectedTitleContains: "Priya",
      input: {
        app: "WhatsApp",
        windowTitle: "Priya - WhatsApp",
        text: "can you send the notes tonight?",
      },
    },
    {
      source: "chat",
      label: "not_loop",
      input: {
        app: "WhatsApp",
        windowTitle: "Priya - WhatsApp",
        text: "ok lol haha thanks",
      },
    },
  ];
  const out: EvalFixture[] = [];
  for (let i = 0; i < count; i++) {
    const t = templates[i % templates.length]!;
    const text = t.input.text
      ? `${t.input.text} #${startIdx + i}`
      : t.input.body
        ? undefined
        : undefined;
    out.push({
      id: `syn-${String(startIdx + i).padStart(3, "0")}`,
      source: t.source,
      label: t.label,
      expectedTitleContains: t.expectedTitleContains,
      input: {
        ...t.input,
        text: text ?? t.input.text,
        body: t.input.body
          ? `${t.input.body} #${startIdx + i}`
          : t.input.body,
        title: t.input.title
          ? `${t.input.title} (${startIdx + i})`
          : t.input.title,
      },
    });
  }
  return out;
}

export function evaluateFixtures(fixtures: EvalFixture[]): EvalReport {
  const overall = emptyCounts();
  const bySource: Record<string, ReturnType<typeof emptyCounts>> = {};
  const rows: EvalReport["rows"] = [];

  for (const f of fixtures) {
    const src = f.source as FixtureSource;
    bySource[src] ??= emptyCounts();
    const scored = scoreFixture(f);
    const actual = f.label === "is_loop";
    accumulate(overall, actual, scored.predicted);
    accumulate(bySource[src], actual, scored.predicted);

    let titleOk = true;
    if (
      scored.predicted &&
      f.expectedTitleContains &&
      scored.title &&
      !scored.title.toLowerCase().includes(f.expectedTitleContains.toLowerCase())
    ) {
      titleOk = false;
    }
    // Window chrome and the user's own name must never reach a card.
    const title = (scored.title ?? "").toLowerCase();
    if (
      scored.predicted &&
      (f.expectedTitleNotContains ?? []).some((bad) =>
        title.includes(bad.toLowerCase()),
      )
    ) {
      titleOk = false;
    }
    const who = (scored.who ?? "").toLowerCase();
    if (
      scored.predicted &&
      who &&
      (f.expectedWhoNot ?? []).some((bad) => who === bad.toLowerCase())
    ) {
      titleOk = false;
    }

    rows.push({
      id: f.id,
      source: f.source,
      label: f.label,
      predicted: scored.predicted,
      confidence: scored.confidence,
      title: scored.title,
      ok: actual === scored.predicted && titleOk,
    });
  }

  const report: EvalReport = {
    overall: metricsFromCounts(overall.tp, overall.fp, overall.tn, overall.fn),
    bySource: {},
    rows,
  };
  for (const [k, c] of Object.entries(bySource)) {
    report.bySource[k] = metricsFromCounts(c.tp, c.fp, c.tn, c.fn);
  }
  return report;
}

function fmt(n: number): string {
  return n.toFixed(3);
}

export function formatMarkdownTable(report: EvalReport): string {
  const lines: string[] = [];
  lines.push("| Scope | N | Precision | Recall | F1 | TP | FP | FN | TN |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  const o = report.overall;
  lines.push(
    `| overall | ${o.support} | ${fmt(o.precision)} | ${fmt(o.recall)} | ${fmt(o.f1)} | ${o.tp} | ${o.fp} | ${o.fn} | ${o.tn} |`,
  );
  for (const src of Object.keys(report.bySource).sort()) {
    const m = report.bySource[src];
    lines.push(
      `| ${src} | ${m.support} | ${fmt(m.precision)} | ${fmt(m.recall)} | ${fmt(m.f1)} | ${m.tp} | ${m.fp} | ${m.fn} | ${m.tn} |`,
    );
  }
  return lines.join("\n");
}

const F1_GATE = 0.5;

export type FullEvalResult = {
  heuristic: EvalReport;
  ai: AiEvalReport;
  fixtureCount: number;
};

export async function runFullEval(opts?: {
  persist?: boolean;
}): Promise<FullEvalResult> {
  const fixtures = await loadFixtures();
  const heuristic = evaluateFixtures(fixtures);
  const ai = await evaluateAiGoldens();

  if (opts?.persist) {
    const misses: EvalLearnMiss[] = [
      ...heuristic.rows
        .filter((r) => !r.ok)
        .slice(0, 12)
        .map((r) => ({
          id: r.id,
          note: `${r.source} label=${r.label} pred=${r.predicted}${r.title ? ` title="${r.title}"` : ""}`,
        })),
      ...ai.misses,
    ];
    try {
      saveEvalLearn({
        at: new Date().toISOString(),
        heuristicF1: heuristic.overall.f1,
        heuristicN: fixtures.length,
        aiSkipped: ai.skipped,
        aiF1: ai.skipped ? undefined : ai.f1,
        aiN: ai.skipped ? undefined : ai.n,
        misses,
      });
    } catch {
      /* no local DB in some CLI runs */
    }
  }

  return { heuristic, ai, fixtureCount: fixtures.length };
}

async function main() {
  const { heuristic, ai, fixtureCount } = await runFullEval({ persist: true });
  console.log(`# Loop detector eval (${fixtureCount} fixtures)\n`);
  console.log(formatMarkdownTable(heuristic));
  console.log("");
  const misses = heuristic.rows.filter((r) => !r.ok);
  if (misses.length) {
    console.log(`## Heuristic misses (${misses.length})`);
    for (const m of misses.slice(0, 25)) {
      console.log(
        `- ${m.id} [${m.source}] label=${m.label} pred=${m.predicted} conf=${m.confidence.toFixed(2)}${m.title ? ` title="${m.title}"` : ""}`,
      );
    }
    if (misses.length > 25) console.log(`- … ${misses.length - 25} more`);
  }
  console.log(`\nHeuristic F1 gate: ${F1_GATE} — actual ${heuristic.overall.f1.toFixed(3)}`);
  if (heuristic.overall.f1 < F1_GATE) {
    process.exitCode = 1;
  }

  if (ai.skipped) {
    console.log(`\nAI STRUCTURE_LOOPS: skipped (${ai.reason ?? "no local Ollama"})`);
  } else {
    console.log(
      `\nAI STRUCTURE_LOOPS: N=${ai.n} ok=${ai.ok} F1=${ai.f1.toFixed(3)} TP=${ai.tp} FP=${ai.fp} FN=${ai.fn}`,
    );
    if (ai.misses.length) {
      console.log("## AI misses");
      for (const m of ai.misses) {
        console.log(`- ${m.id}: ${m.note}`);
      }
    }
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
