import {
  config,
  getDb,
  usageEvents,
  newId,
  log,
} from "@second-brain/core";

export type LlmRole = "fast" | "smart";

export type LlmCallResult = {
  text: string;
  model: string;
  provider: "ollama" | "hosted" | "stub";
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
};

/** @deprecated prefer LlmCallResult — kept for callers */
export type ClaudeCallResult = LlmCallResult & { apiKeySource?: string };

/**
 * Map role names to Ollama model tags.
 * Both roles default to the same resident 14B to avoid VRAM thrash.
 */
function resolveModel(role: LlmRole | "haiku" | "sonnet" | "opus" | string): string {
  if (role === "haiku" || role === "fast") return config.ollama.models.fast;
  if (role === "sonnet" || role === "opus" || role === "smart") {
    return config.ollama.models.smart;
  }
  return role;
}

/**
 * Call local Ollama chat (OpenAI-compatible /api/chat under the hood via /api/chat).
 */
export async function runLlm(opts: {
  prompt: string;
  /** tier: fast | smart, or a full Ollama model tag */
  model?: LlmRole | "haiku" | "sonnet" | "opus" | string;
  system?: string;
  /** Tagged on usage_events.metaJson for budgets (e.g. structure_loops) */
  purpose?: string;
  /** Never send this prompt to a hosted LLM (search history, Improve suggestions). */
  skipHosted?: boolean;
}): Promise<LlmCallResult> {
  const model = resolveModel(opts.model ?? "fast");
  const baseUrl = config.ollama.baseUrl.replace(/\/$/, "");

  try {
    const healthy = await ollamaHealthy(baseUrl);
    if (!healthy) {
      if (!opts.skipHosted) {
        const hosted = await tryHostedLlm(opts);
        if (hosted) return hosted;
      }
      log.warn("Ollama unreachable — using offline stub", { baseUrl });
      return offlineStub(opts.prompt, model);
    }

    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        keep_alive: config.ollama.keepAlive,
        options: {
          temperature: 0.3,
          num_predict: config.ollama.maxTokens,
        },
        messages: [
          {
            role: "system",
            content:
              opts.system ??
              "You are a precise personal second-brain assistant. Follow format instructions exactly. When asked for JSON, reply with ONLY a single JSON object — no markdown fences, no preamble, no trailing commentary.",
          },
          { role: "user", content: opts.prompt },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama ${res.status}: ${body.slice(0, 500)}`);
    }

    const data = (await res.json()) as {
      message?: { content?: string };
      model?: string;
      prompt_eval_count?: number;
      eval_count?: number;
      error?: string;
    };

    if (data.error) {
      throw new Error(data.error);
    }

    const text = data.message?.content?.trim() || "(empty response)";
    const usedModel = data.model ?? model;
    trackUsage(
      usedModel,
      data.prompt_eval_count ?? 0,
      data.eval_count ?? 0,
      opts.purpose,
    );
    log.info("Ollama ok", {
      model: usedModel,
      promptTokens: data.prompt_eval_count,
      completionTokens: data.eval_count,
    });
    return {
      text,
      model: usedModel,
      provider: "ollama",
      usage: {
        promptTokens: data.prompt_eval_count,
        completionTokens: data.eval_count,
      },
    };
  } catch (e) {
    if (!opts.skipHosted) {
      const hosted = await tryHostedLlm(opts);
      if (hosted) return hosted;
    }
    log.error("Ollama failed — offline stub", { err: String(e) });
    return offlineStub(opts.prompt, model);
  }
}

/**
 * Optional OpenAI-compatible hosted fallback when local Ollama is down.
 * Set BRAIN_HOSTED_LLM_URL + BRAIN_HOSTED_LLM_KEY (+ optional BRAIN_HOSTED_LLM_MODEL).
 */
async function tryHostedLlm(opts: {
  prompt: string;
  system?: string;
  purpose?: string;
  model?: string;
}): Promise<LlmCallResult | null> {
  const url = process.env.BRAIN_HOSTED_LLM_URL?.replace(/\/$/, "");
  const key = process.env.BRAIN_HOSTED_LLM_KEY;
  if (!url || !key) return null;
  const model =
    process.env.BRAIN_HOSTED_LLM_MODEL ||
    (typeof opts.model === "string" ? opts.model : "gpt-4o-mini");
  try {
    const res = await fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content:
              opts.system ??
              "You are a precise personal second-brain assistant. Follow format instructions exactly. When asked for JSON, reply with ONLY a single JSON object — no markdown fences, no preamble, no trailing commentary.",
          },
          { role: "user", content: opts.prompt },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      log.warn("Hosted LLM failed", { status: res.status });
      return null;
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };
    const text = data.choices?.[0]?.message?.content?.trim() || "(empty)";
    trackUsage(
      data.model ?? model,
      data.usage?.prompt_tokens ?? 0,
      data.usage?.completion_tokens ?? 0,
      opts.purpose,
    );
    return {
      text,
      model: data.model ?? model,
      provider: "hosted",
      usage: {
        promptTokens: data.usage?.prompt_tokens,
        completionTokens: data.usage?.completion_tokens,
      },
    };
  } catch (e) {
    log.warn("Hosted LLM error", { err: String(e) });
    return null;
  }
}

/** Back-compat wrapper used by tagger / planner / etc. */
export async function runClaude(opts: {
  prompt: string;
  model?: "haiku" | "sonnet" | "opus" | string;
  maxTurns?: number;
}): Promise<ClaudeCallResult> {
  const r = await runLlm({
    prompt: opts.prompt,
    model: opts.model ?? "haiku",
  });
  return { ...r, apiKeySource: r.provider };
}

async function ollamaHealthy(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function trackUsage(
  model: string,
  promptTokens: number,
  completionTokens: number,
  purpose?: string,
): void {
  const db = getDb();
  db.insert(usageEvents)
    .values({
      id: newId(),
      kind: purpose === "structure_loops" ? "loop-structure" : "ollama",
      model,
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      metaJson: purpose ? JSON.stringify({ purpose }) : "{}",
    })
    .run();
}

function offlineStub(prompt: string, model: string): LlmCallResult {
  if (prompt.includes("TAG_ITEMS_JSON")) {
    return {
      text: JSON.stringify({
        annotations: [],
        note: "offline stub — start Ollama and pull a chat model",
      }),
      model: `stub-${model}`,
      provider: "stub",
    };
  }
  if (prompt.includes("DAILY_PLAN") || prompt.includes("OPEN_LOOPS")) {
    return {
      text: JSON.stringify({
        rationale:
          "Offline plan: work high-priority open loops. Start Ollama for richer rationale.",
        reorderHints: [],
        loops: [],
      }),
      model: `stub-${model}`,
      provider: "stub",
    };
  }
  if (prompt.includes("MORNING_BRIEF") || prompt.includes("WEEKLY_REVIEW") || prompt.includes("DIGEST")) {
    return {
      text: "*(LLM offline)* Review open loops and timeline in the dashboard. Start Ollama for AI digests.",
      model: `stub-${model}`,
      provider: "stub",
    };
  }
  if (prompt.includes("EXTRACT_TASKS") || prompt.includes("STRUCTURE_LOOPS")) {
    return {
      text: JSON.stringify({ tasks: [], loops: [] }),
      model: `stub-${model}`,
      provider: "stub",
    };
  }
  return {
    text: "Ollama not available. Ensure `ollama serve` is running and models are pulled.",
    model: `stub-${model}`,
    provider: "stub",
  };
}

export function parseJsonFromText<T>(text: string): T | null {
  const cleaned = text.trim();
  const attempts: string[] = [cleaned];
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) attempts.push(fenced[1].trim());
  const start = cleaned.indexOf("{");
  if (start >= 0) {
    const end = cleaned.lastIndexOf("}");
    if (end > start) attempts.push(cleaned.slice(start, end + 1));
    attempts.push(cleaned.slice(start));
  }

  for (const raw of attempts) {
    try {
      return JSON.parse(raw) as T;
    } catch {
      /* try repair */
    }
    const repaired = repairTruncatedJson(raw);
    if (repaired) {
      try {
        return JSON.parse(repaired) as T;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

/** Best-effort close of truncated JSON objects/arrays. */
function repairTruncatedJson(text: string): string | null {
  let s = text.trim();
  if (!s.startsWith("{") && !s.startsWith("[")) return null;

  s = s.replace(/,\s*"[^"]*$/s, "");
  s = s.replace(/,\s*$/, "");

  const quoteCount = (s.match(/(?<!\\)"/g) ?? []).length;
  if (quoteCount % 2 === 1) s += '"';

  s = s.replace(/:\s*$/, ": null");
  s = s.replace(/,\s*$/, "");

  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  while (stack.length) {
    const open = stack.pop();
    s += open === "{" ? "}" : "]";
  }
  return s;
}
