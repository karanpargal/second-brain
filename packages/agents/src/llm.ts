import {
  config,
  getDb,
  usageEvents,
  newId,
  log,
} from "@second-brain/core";
import { enqueueLlm } from "./loop-budget.js";
import { resolveHostedLlm } from "./hosted-llm.js";

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

export type LlmFormat = Record<string, unknown> | "json";

/**
 * Map role names to Ollama model tags.
 * Both roles default to the same resident model to avoid VRAM thrash.
 */
function resolveModel(role: LlmRole | "haiku" | "sonnet" | "opus" | string): string {
  if (role === "haiku" || role === "fast") return config.ollama.models.fast;
  if (role === "sonnet" || role === "opus" || role === "smart") {
    return config.ollama.models.smart;
  }
  return role;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Visible reply only — never surface gpt-oss chain-of-thought. */
function extractAssistantText(message?: {
  content?: string;
  thinking?: string;
}): string {
  const content = (message?.content ?? "").trim();
  if (content && content !== "(empty response)") return content;
  return "";
}

function wantsThinkOff(model: string): boolean {
  return /gpt-oss/i.test(model);
}

let cachedTags: { at: number; names: Set<string> } | null = null;

async function ollamaModelTags(baseUrl: string): Promise<Set<string>> {
  const now = Date.now();
  if (cachedTags && now - cachedTags.at < 60_000) return cachedTags.names;
  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return cachedTags?.names ?? new Set();
    const data = (await res.json()) as {
      models?: Array<{ name?: string }>;
    };
    const names = new Set(
      (data.models ?? [])
        .map((m) => m.name ?? "")
        .filter(Boolean)
        .flatMap((n) => {
          // "gpt-oss:20b" and also bare "gpt-oss"
          const base = n.split(":")[0];
          return base && base !== n ? [n, base] : [n];
        }),
    );
    cachedTags = { at: now, names };
    return names;
  } catch {
    return cachedTags?.names ?? new Set();
  }
}

async function pickAvailableModel(
  preferred: string,
  baseUrl: string,
): Promise<string> {
  const tags = await ollamaModelTags(baseUrl);
  if (tags.size === 0) return preferred;
  if (tags.has(preferred) || tags.has(preferred.split(":")[0])) {
    return preferred;
  }
  const fallback = config.ollama.models.fallback;
  if (fallback && (tags.has(fallback) || tags.has(fallback.split(":")[0]))) {
    log.warn("Preferred Ollama model missing — using fallback", {
      preferred,
      fallback,
    });
    return fallback;
  }
  return preferred;
}

/**
 * Call local Ollama chat. Serialised via enqueueLlm when purpose is a loop stage.
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
  /** Try the configured cloud model first (Ask). Loops stay local. */
  preferHosted?: boolean;
  /** Override temperature (default 0.3; use 0 for extraction/judging). */
  temperature?: number;
  /** Ollama structured output: "json" or a JSON Schema object. */
  format?: LlmFormat;
  /** Abort after this many ms (default config.ollama.timeoutMs). */
  timeoutMs?: number;
  /** Retry count on transient failure (default 2). */
  retries?: number;
}): Promise<LlmCallResult> {
  const isLoop =
    opts.purpose === "structure_loops" ||
    opts.purpose === "loop_extract" ||
    opts.purpose === "loop_repair" ||
    opts.purpose === "loop_dedupe" ||
    opts.purpose === "loop_resolve" ||
    opts.purpose === "loop_review" ||
    opts.purpose === "polish_chat";

  const exec = () => runLlmInner(opts);
  return isLoop ? enqueueLlm(exec) : exec();
}

async function runLlmInner(opts: {
  prompt: string;
  model?: LlmRole | "haiku" | "sonnet" | "opus" | string;
  system?: string;
  purpose?: string;
  skipHosted?: boolean;
  preferHosted?: boolean;
  temperature?: number;
  format?: LlmFormat;
  timeoutMs?: number;
  retries?: number;
}): Promise<LlmCallResult> {
  const preferred = resolveModel(opts.model ?? "fast");
  const baseUrl = config.ollama.baseUrl.replace(/\/$/, "");
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? config.ollama.timeoutMs ?? 180_000;
  const temperature = opts.temperature ?? 0.3;

  if (opts.preferHosted && !opts.skipHosted) {
    const hostedFirst = await tryHostedLlm(opts);
    if (hostedFirst) return hostedFirst;
  }

  try {
    const healthy = await ollamaHealthy(baseUrl);
    if (!healthy) {
      if (!opts.skipHosted) {
        const hosted = await tryHostedLlm(opts);
        if (hosted) return hosted;
      }
      log.warn("Ollama unreachable — using offline stub", { baseUrl });
      return offlineStub(opts.prompt, preferred);
    }

    const model = await pickAvailableModel(preferred, baseUrl);
    let lastErr: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const body: Record<string, unknown> = {
          model,
          stream: false,
          keep_alive: config.ollama.keepAlive,
          options: {
            temperature,
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
        };
        if (opts.format) body.format = opts.format;
        if (wantsThinkOff(model)) body.think = false;

        const res = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!res.ok) {
          const errBody = await res.text();
          throw new Error(`Ollama ${res.status}: ${errBody.slice(0, 500)}`);
        }

        const data = (await res.json()) as {
          message?: { content?: string; thinking?: string };
          model?: string;
          prompt_eval_count?: number;
          eval_count?: number;
          error?: string;
        };

        if (data.error) {
          throw new Error(data.error);
        }

        const text = extractAssistantText(data.message) || "(empty response)";
        const usedModel = data.model ?? model;
        trackUsage(
          usedModel,
          data.prompt_eval_count ?? 0,
          data.eval_count ?? 0,
          opts.purpose,
        );
        log.info("Ollama ok", {
          model: usedModel,
          purpose: opts.purpose,
          promptTokens: data.prompt_eval_count,
          completionTokens: data.eval_count,
          attempt,
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
        lastErr = e;
        if (attempt < retries) {
          const backoff = 500 * 2 ** attempt;
          log.warn("Ollama attempt failed — retrying", {
            attempt,
            backoff,
            err: String(e),
          });
          await sleep(backoff);
        }
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  } catch (e) {
    if (!opts.skipHosted) {
      const hosted = await tryHostedLlm(opts);
      if (hosted) return hosted;
    }
    log.error("Ollama failed — offline stub", { err: String(e) });
    return offlineStub(
      opts.prompt,
      preferred,
      e instanceof Error ? e.message : String(e),
    );
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
  temperature?: number;
}): Promise<LlmCallResult | null> {
  const creds = resolveHostedLlm();
  if (!creds) return null;
  const model = creds.model || "gpt-4o-mini";
  try {
    const res = await fetch(`${creds.url}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${creds.key}`,
      },
      body: JSON.stringify({
        model,
        temperature: opts.temperature ?? 0.3,
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

export type LlmChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_name?: string;
};

export type LlmToolDef = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type LlmToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type LlmChatResult = LlmCallResult & {
  toolCalls: LlmToolCall[];
  messages: LlmChatMessage[];
};

/**
 * Multi-turn Ollama chat with optional tools. Returns assistant text and any
 * tool_calls so the caller can run a tool loop. Does not mutate runLlm.
 */
export async function runLlmChat(opts: {
  messages: LlmChatMessage[];
  tools?: LlmToolDef[];
  model?: LlmRole | "haiku" | "sonnet" | "opus" | string;
  purpose?: string;
  skipHosted?: boolean;
  temperature?: number;
  format?: LlmFormat;
  timeoutMs?: number;
  retries?: number;
}): Promise<LlmChatResult> {
  const preferred = resolveModel(opts.model ?? "smart");
  const baseUrl = config.ollama.baseUrl.replace(/\/$/, "");
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? config.ollama.timeoutMs ?? 180_000;
  const temperature = opts.temperature ?? 0.2;

  const asChat = (r: LlmCallResult, toolCalls: LlmToolCall[] = []): LlmChatResult => ({
    ...r,
    toolCalls,
    messages: opts.messages,
  });

  const exec = async (): Promise<LlmChatResult> => {
    try {
      const healthy = await ollamaHealthy(baseUrl);
      if (!healthy) {
        log.warn("Ollama unreachable for chat — stub", { baseUrl });
        return asChat(offlineStub(opts.messages.at(-1)?.content ?? "", preferred));
      }

      const model = await pickAvailableModel(preferred, baseUrl);
      let lastErr: unknown;

      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const body: Record<string, unknown> = {
            model,
            stream: false,
            keep_alive: config.ollama.keepAlive,
            options: {
              temperature,
              num_predict: config.ollama.maxTokens,
            },
            messages: opts.messages.map((m) => {
              const out: Record<string, unknown> = {
                role: m.role,
                content: m.content,
              };
              if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
              if (m.tool_name) out.name = m.tool_name;
              return out;
            }),
          };
          if (opts.tools?.length) body.tools = opts.tools;
          if (opts.format) body.format = opts.format;
          if (wantsThinkOff(model)) body.think = false;

          const res = await fetch(`${baseUrl}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!res.ok) {
            const errBody = await res.text();
            throw new Error(`Ollama ${res.status}: ${errBody.slice(0, 500)}`);
          }

          const data = (await res.json()) as {
            message?: {
              content?: string;
              thinking?: string;
              tool_calls?: Array<{
                id?: string;
                type?: string;
                function?: { name?: string; arguments?: unknown };
              }>;
            };
            model?: string;
            prompt_eval_count?: number;
            eval_count?: number;
            error?: string;
          };
          if (data.error) throw new Error(data.error);

          const text = extractAssistantText(data.message);
          const toolCalls: LlmToolCall[] = (data.message?.tool_calls ?? []).map(
            (tc, i) => ({
              id: tc.id ?? `call_${i}`,
              type: "function",
              function: {
                name: tc.function?.name ?? "",
                arguments:
                  typeof tc.function?.arguments === "string"
                    ? tc.function.arguments
                    : JSON.stringify(tc.function?.arguments ?? {}),
              },
            }),
          );
          const usedModel = data.model ?? model;
          trackUsage(
            usedModel,
            data.prompt_eval_count ?? 0,
            data.eval_count ?? 0,
            opts.purpose,
          );
          log.info("Ollama chat ok", {
            model: usedModel,
            purpose: opts.purpose,
            toolCalls: toolCalls.length,
            attempt,
          });
          return asChat(
            {
              text: text || (toolCalls.length ? "" : "(empty response)"),
              model: usedModel,
              provider: "ollama",
              usage: {
                promptTokens: data.prompt_eval_count,
                completionTokens: data.eval_count,
              },
            },
            toolCalls,
          );
        } catch (e) {
          lastErr = e;
          if (attempt < retries) {
            await sleep(500 * 2 ** attempt);
          }
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    } catch (e) {
      log.error("Ollama chat failed — stub", { err: String(e) });
      return asChat(
        offlineStub(
          opts.messages.at(-1)?.content ?? "",
          preferred,
          e instanceof Error ? e.message : String(e),
        ),
      );
    }
  };

  const serialize =
    opts.purpose === "advisor" || opts.purpose?.startsWith("mcp_");
  return serialize ? enqueueLlm(exec) : exec();
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
  const loopKinds = new Set([
    "structure_loops",
    "loop_extract",
    "loop_repair",
    "loop_dedupe",
    "loop_resolve",
    "loop_review",
  ]);
  db.insert(usageEvents)
    .values({
      id: newId(),
      kind:
        purpose && loopKinds.has(purpose) ? "loop-structure" : "ollama",
      model,
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      metaJson: purpose ? JSON.stringify({ purpose }) : "{}",
    })
    .run();
}

function offlineStub(
  prompt: string,
  model: string,
  cause?: string,
): LlmCallResult {
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
  if (
    prompt.includes("MORNING_BRIEF") ||
    prompt.includes("WEEKLY_REVIEW") ||
    prompt.includes("DIGEST")
  ) {
    return {
      text: "*(LLM offline)* Review open loops and timeline in the dashboard. Start Ollama for AI digests.",
      model: `stub-${model}`,
      provider: "stub",
    };
  }
  if (
    prompt.includes("CLASSIFY_CHAT_OCR") ||
    prompt.includes("POLISH_CHAT_OCR") ||
    prompt.includes("LOOP_EXTRACT") ||
    prompt.includes("LOOP_REPAIR") ||
    prompt.includes("LOOP_DEDUPE") ||
    prompt.includes("LOOP_RESOLVE") ||
    prompt.includes("LOOP_REVIEW")
  ) {
    return {
      text: JSON.stringify({
        loops: [],
        keep: false,
        same_task: false,
        resolved: false,
        verdict: "still_relevant",
      }),
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
    text: cause
      ? `Ollama error: ${cause.slice(0, 240)}`
      : "Ollama not available. Ensure `ollama serve` is running and models are pulled.",
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
