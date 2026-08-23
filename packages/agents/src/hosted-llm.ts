/**
 * Optional OpenAI-compatible chat endpoint for Ask (OpenAI, Groq, OpenRouter, …).
 * Key stays in the encrypted secret store; loops/extraction stay on local Ollama.
 */
import { getDb, getSecret, setSecret, settings } from "@second-brain/core";
import { eq } from "drizzle-orm";

export const HOSTED_LLM_SECRET_KEY = "hosted_llm_key";
const SETTINGS_KEY = "ask.hosted";

export type HostedLlmSettings = {
  url: string;
  model: string;
  useForAsk: boolean;
};

export type HostedLlmStatus = HostedLlmSettings & {
  configured: boolean;
  /** True when env vars are set (overrides Settings URL/model). */
  fromEnv: boolean;
};

function readStored(): HostedLlmSettings {
  const db = getDb();
  const row = db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).get();
  if (!row) return { url: "", model: "gpt-4o-mini", useForAsk: false };
  try {
    const v = JSON.parse(row.valueJson) as Partial<HostedLlmSettings>;
    return {
      url: String(v.url ?? "").replace(/\/$/, ""),
      model: String(v.model ?? "gpt-4o-mini").trim() || "gpt-4o-mini",
      useForAsk: v.useForAsk === true,
    };
  } catch {
    return { url: "", model: "gpt-4o-mini", useForAsk: false };
  }
}

export function hostedLlmStatus(): HostedLlmStatus {
  const stored = readStored();
  const envUrl = (process.env.BRAIN_HOSTED_LLM_URL ?? "").replace(/\/$/, "");
  const envKey = process.env.BRAIN_HOSTED_LLM_KEY?.trim() ?? "";
  const envModel = process.env.BRAIN_HOSTED_LLM_MODEL?.trim() ?? "";
  const envAsk = process.env.BRAIN_ASK_USE_HOSTED === "1";
  const url = envUrl || stored.url;
  const model = envModel || stored.model;
  const key = envKey || getSecret(HOSTED_LLM_SECRET_KEY)?.trim() || "";
  return {
    url,
    model,
    useForAsk: envAsk || stored.useForAsk,
    configured: Boolean(url && key),
    fromEnv: Boolean(envUrl && envKey),
  };
}

export function saveHostedLlm(input: {
  url?: string;
  model?: string;
  apiKey?: string;
  useForAsk?: boolean;
}): HostedLlmStatus {
  const prev = readStored();
  const next: HostedLlmSettings = {
    url: (input.url ?? prev.url).trim().replace(/\/$/, ""),
    model: (input.model ?? prev.model).trim() || "gpt-4o-mini",
    useForAsk: input.useForAsk ?? prev.useForAsk,
  };
  if (input.apiKey?.trim()) {
    setSecret(HOSTED_LLM_SECRET_KEY, input.apiKey.trim());
  }
  const db = getDb();
  const json = JSON.stringify(next);
  const existing = db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).get();
  const now = new Date().toISOString();
  if (existing) {
    db.update(settings)
      .set({ valueJson: json, updatedAt: now })
      .where(eq(settings.key, SETTINGS_KEY))
      .run();
  } else {
    db.insert(settings).values({ key: SETTINGS_KEY, valueJson: json, updatedAt: now }).run();
  }
  return hostedLlmStatus();
}

export function resolveHostedLlm(): {
  url: string;
  key: string;
  model: string;
} | null {
  const st = hostedLlmStatus();
  const key =
    process.env.BRAIN_HOSTED_LLM_KEY?.trim() ||
    getSecret(HOSTED_LLM_SECRET_KEY)?.trim() ||
    "";
  if (!st.url || !key) return null;
  return { url: st.url, key, model: st.model };
}
