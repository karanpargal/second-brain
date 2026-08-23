/**
 * MCP-powered advisor: bounded tool-calling loop → actionable recommendation cards.
 */
import {
  getDb,
  observations,
  activityBlocks,
  briefs,
  insights,
  newId,
  log,
  looksLikeMarket,
} from "@second-brain/core";
import { eq } from "drizzle-orm";
import {
  runLlmChat,
  parseJsonFromText,
  type LlmChatMessage,
} from "./llm.js";
import {
  buildMcpCatalog,
  executeNamespacedTool,
  type McpCatalog,
} from "./mcp-tools.js";
import { getUserProfile } from "./feedback.js";
import { listOpenLoops } from "./tools.js";

const MAX_TURNS = 4;
const MAX_TOOL_CALLS = 8;
const MAX_TOOL_RESULT = 8_000;

export type AdviceSource = {
  server: string;
  tool: string;
  ref: string;
  url?: string;
};

export type AdviceCard = {
  title: string;
  why: string;
  nextStep: string;
  effortMin: number;
  sources: AdviceSource[];
  confidence: number;
};

const ADVICE_SCHEMA = {
  type: "object",
  properties: {
    recommendations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          why: { type: "string" },
          nextStep: { type: "string" },
          effortMin: { type: "number" },
          sources: {
            type: "array",
            items: {
              type: "object",
              properties: {
                server: { type: "string" },
                tool: { type: "string" },
                ref: { type: "string" },
                url: { type: "string" },
              },
              required: ["server", "tool", "ref"],
            },
          },
          confidence: { type: "number" },
        },
        required: [
          "title",
          "why",
          "nextStep",
          "effortMin",
          "sources",
          "confidence",
        ],
      },
    },
  },
  required: ["recommendations"],
};

function localContextBlob(): string {
  const loops = listOpenLoops("open")
    .slice(0, 20)
    .map((l) => ({
      title: l.title,
      who: l.who,
      dueAt: l.dueAt,
      category: l.category,
      priority: l.priority,
    }));

  const db = getDb();
  const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
  const recentObs = db
    .select()
    .from(observations)
    .all()
    .filter((o) => o.ts >= dayAgo)
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 30)
    .map((o) => ({
      ts: o.ts,
      app: o.app,
      title: o.windowTitle,
      url: o.url,
    }));

  const blocks = db
    .select()
    .from(activityBlocks)
    .all()
    .sort((a, b) => (b.startAt ?? "").localeCompare(a.startAt ?? ""))
    .slice(0, 12)
    .map((b) => ({
      app: b.app,
      title: b.title,
      start: b.startAt,
      dwellMs: b.dwellMs,
    }));

  let profile: unknown = null;
  try {
    profile = getUserProfile();
  } catch {
    profile = null;
  }

  return JSON.stringify(
    {
      openLoops: loops,
      recentActivity: recentObs,
      activityBlocks: blocks,
      profile,
    },
    null,
    2,
  ).slice(0, 14_000);
}

function evidenceKeys(
  results: Array<{ serverId?: string; toolName?: string }>,
): Set<string> {
  const keys = new Set<string>();
  for (const r of results) {
    if (r.serverId && r.toolName) keys.add(`${r.serverId}::${r.toolName}`);
  }
  return keys;
}

function normalizeCards(
  raw: AdviceCard[],
  toolEvidence: Set<string>,
  allowLocalOnly: boolean,
): AdviceCard[] {
  const out: AdviceCard[] = [];
  for (const c of raw) {
    if (!c?.title || !c.nextStep || !c.why) continue;
    if (looksLikeMarket(`${c.title} ${c.why} ${c.nextStep}`)) continue;
    let sources = Array.isArray(c.sources) ? [...c.sources] : [];
    if (sources.length === 0) {
      if (!allowLocalOnly) continue;
      sources = [
        {
          server: "local",
          tool: "memory",
          ref: "open_loops_and_activity",
        },
      ];
    } else if (!allowLocalOnly) {
      const ok = sources.some(
        (s) =>
          s.server === "local" ||
          toolEvidence.has(`${s.server}::${s.tool}`),
      );
      if (!ok) continue;
    }
    out.push({
      title: String(c.title).slice(0, 120),
      why: String(c.why).slice(0, 400),
      nextStep: String(c.nextStep).slice(0, 240),
      effortMin: Math.max(5, Math.min(120, Number(c.effortMin) || 30)),
      sources: sources.slice(0, 4).map((s) => ({
        server: String(s.server),
        tool: String(s.tool),
        ref: String(s.ref).slice(0, 200),
        url: s.url ? String(s.url).slice(0, 500) : undefined,
      })),
      confidence: Math.max(0, Math.min(1, Number(c.confidence) || 0.5)),
    });
    if (out.length >= 6) break;
  }
  return out;
}

/** Persist advice cards as insights kind=action. */
export function persistAdviceCards(cards: AdviceCard[]): string[] {
  const db = getDb();
  for (const row of db.select().from(insights).all()) {
    if (row.kind === "action") {
      db.delete(insights).where(eq(insights.id, row.id)).run();
    }
  }
  const ids: string[] = [];
  const weekKey = new Date().toISOString().slice(0, 10);
  for (const c of cards) {
    const id = newId();
    db.insert(insights)
      .values({
        id,
        kind: "action",
        title: c.title,
        body: `${c.why}\n\nNext: ${c.nextStep}`,
        score: c.confidence,
        metaJson: JSON.stringify({
          nextStep: c.nextStep,
          effortMin: c.effortMin,
          sources: c.sources,
          confidence: c.confidence,
        }),
        weekKey,
      })
      .run();
    ids.push(id);
  }
  return ids;
}

/** Pull ## Suggestions from today's morning brief into action cards. */
export function harvestBriefSuggestions(): AdviceCard[] {
  const day = new Date().toISOString().slice(0, 10);
  const brief = getDb()
    .select()
    .from(briefs)
    .all()
    .filter((b) => b.date === day && b.kind === "morning")
    .at(-1);
  if (!brief?.markdown) return [];
  const md = brief.markdown;
  const idx = md.search(/^##\s+Suggestions\b/im);
  if (idx < 0) return [];
  const section = md.slice(idx);
  const nextH2 = section.slice(1).search(/\n##\s+/);
  const body = nextH2 >= 0 ? section.slice(0, nextH2 + 1) : section;

  const cards: AdviceCard[] = [];
  const blocks = body.split(/\n###\s+/).slice(1);
  for (const block of blocks) {
    const lines = block.split(/\n/).map((l) => l.trim());
    const title = lines[0]?.replace(/^\d+\.\s*/, "").trim();
    if (!title) continue;
    let why = "";
    let nextStep = "";
    let type = "";
    for (const line of lines) {
      const whyM = line.match(/^\*?\*?Why you:\*?\*?\s*(.+)$/i);
      const nextM = line.match(/^\*?\*?Next step:\*?\*?\s*(.+)$/i);
      const typeM = line.match(/^\*?\*?Type:\*?\*?\s*(.+)$/i);
      if (whyM) why = whyM[1];
      if (nextM) nextStep = nextM[1];
      if (typeM) type = typeM[1];
    }
    if (!nextStep) continue;
    cards.push({
      title: title.slice(0, 120),
      why: (why || type || "From your morning brief").slice(0, 400),
      nextStep: nextStep.slice(0, 240),
      effortMin: 30,
      sources: [
        { server: "local", tool: "morning_brief", ref: "suggestions" },
      ],
      confidence: 0.55,
    });
  }
  return cards.slice(0, 5);
}

export async function runAdvisor(opts?: {
  persist?: boolean;
  includeBrief?: boolean;
}): Promise<{
  cards: AdviceCard[];
  toolCalls: number;
  mcpServers: number;
  mcpTools: number;
  errors: string[];
}> {
  const catalog: McpCatalog = await buildMcpCatalog();
  const errors = catalog.errors.map((e) => `${e.serverId}: ${e.error}`);
  const context = localContextBlob();
  const toolEvidenceResults: Array<{
    serverId?: string;
    toolName?: string;
  }> = [];

  const system = `You are a personal advisor for Second Brain. You turn real signals into concrete next steps.
Rules:
- Prefer evidence from tool results when tools are available.
- Every recommendation needs a clear nextStep doable in ≤60 minutes.
- Never invent private URLs or credentials.
- Skip market/trading chatter.
- Return ONLY JSON matching the schema when finished.`;

  const messages: Array<
    LlmChatMessage & { tool_calls?: unknown }
  > = [
    { role: "system", content: system },
    {
      role: "user",
      content: `Advise me. Local context (JSON):
${context}

${
  catalog.ollamaTools.length
    ? `You have ${catalog.ollamaTools.length} read-only MCP tools. Call tools if they help, then finish with recommendations JSON.`
    : `No MCP tools are configured. Recommend from local context only.`
}

When finished, reply with JSON:
{"recommendations":[{"title":"...","why":"...","nextStep":"...","effortMin":25,"sources":[{"server":"...","tool":"...","ref":"..."}],"confidence":0.7}]}`,
    },
  ];

  let toolCalls = 0;
  let finalText = "";

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const forceFinal =
      toolCalls >= MAX_TOOL_CALLS ||
      turn === MAX_TURNS - 1 ||
      catalog.ollamaTools.length === 0;

    const res = await runLlmChat({
      messages,
      tools: forceFinal ? undefined : catalog.ollamaTools,
      model: "smart",
      purpose: "advisor",
      temperature: 0.2,
      format:
        forceFinal || catalog.ollamaTools.length === 0
          ? ADVICE_SCHEMA
          : undefined,
      timeoutMs: 180_000,
    });

    if (res.toolCalls.length && !forceFinal) {
      messages.push({
        role: "assistant",
        content: res.text || "",
        tool_calls: res.toolCalls,
      });

      for (const tc of res.toolCalls) {
        if (toolCalls >= MAX_TOOL_CALLS) break;
        toolCalls++;
        const exec = await executeNamespacedTool(
          catalog,
          tc.function.name,
          tc.function.arguments,
        );
        toolEvidenceResults.push({
          serverId: exec.serverId,
          toolName: exec.toolName,
        });
        messages.push({
          role: "tool",
          content: exec.text.slice(0, MAX_TOOL_RESULT),
          tool_call_id: tc.id,
          tool_name: tc.function.name,
        });
      }
      continue;
    }

    finalText = res.text;
    break;
  }

  const parsed = parseJsonFromText<{ recommendations?: AdviceCard[] }>(
    finalText,
  );
  const allowLocal = catalog.ollamaTools.length === 0 || toolCalls === 0;
  let cards = normalizeCards(
    parsed?.recommendations ?? [],
    evidenceKeys(toolEvidenceResults),
    allowLocal,
  );

  if (opts?.includeBrief !== false) {
    const fromBrief = harvestBriefSuggestions();
    const seen = new Set(cards.map((c) => c.title.toLowerCase()));
    for (const b of fromBrief) {
      if (seen.has(b.title.toLowerCase())) continue;
      cards.push(b);
      seen.add(b.title.toLowerCase());
    }
  }

  cards = cards.slice(0, 8);
  if (opts?.persist !== false) {
    persistAdviceCards(cards);
  }

  log.info("Advisor finished", {
    cards: cards.length,
    toolCalls,
    mcpTools: catalog.tools.length,
    mcpServers: catalog.servers.length,
  });

  return {
    cards,
    toolCalls,
    mcpServers: catalog.servers.length,
    mcpTools: catalog.tools.length,
    errors,
  };
}
