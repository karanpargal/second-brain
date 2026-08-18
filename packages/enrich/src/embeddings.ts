import {
  config,
  log,
  getDb,
  usageEvents,
  newId,
} from "@second-brain/core";

type Pipeline = (
  texts: string[],
  opts: { pooling: string; normalize: boolean },
) => Promise<{ data: Float32Array | number[] }>;

let pipelinePromise: Promise<Pipeline> | null = null;
let lastModel = "";
let lastDims = 0;

async function getFallbackEmbedder(): Promise<Pipeline> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline } = await import("@xenova/transformers");
      log.info("Loading fallback embedding model", {
        model: config.embed.fallbackModel,
      });
      const pipe = await pipeline(
        "feature-extraction",
        config.embed.fallbackModel,
      );
      return pipe as unknown as Pipeline;
    })();
  }
  return pipelinePromise;
}

async function embedViaOllama(text: string): Promise<number[] | null> {
  const baseUrl = config.ollama.baseUrl.replace(/\/$/, "");
  try {
    const res = await fetch(`${baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.ollama.embedModel,
        prompt: text.slice(0, 8000) || " ",
        keep_alive: config.ollama.keepAlive,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      log.debug("Ollama embeddings HTTP error", { status: res.status });
      return null;
    }
    const data = (await res.json()) as { embedding?: number[] };
    if (!data.embedding?.length) return null;
    lastModel = config.ollama.embedModel;
    lastDims = data.embedding.length;
    return data.embedding;
  } catch (e) {
    log.debug("Ollama embeddings failed", { err: String(e) });
    return null;
  }
}

async function embedViaTransformers(text: string): Promise<number[]> {
  const pipe = await getFallbackEmbedder();
  const input = text.slice(0, 2000) || " ";
  const out = await pipe([input], { pooling: "mean", normalize: true });
  lastModel = config.embed.fallbackModel;
  lastDims = config.embed.fallbackDims;
  return Array.from(out.data);
}

export function lastEmbedMeta(): { model: string; dims: number } {
  return {
    model: lastModel || config.ollama.embedModel,
    dims: lastDims || config.embed.dims,
  };
}

export async function embedText(text: string): Promise<number[]> {
  const ollama = await embedViaOllama(text);
  if (ollama) {
    try {
      const db = getDb();
      db.insert(usageEvents)
        .values({
          id: newId(),
          kind: "embed",
          model: lastModel,
          inputTokens: Math.ceil(text.length / 4),
          outputTokens: 0,
          metaJson: JSON.stringify({ dims: lastDims }),
        })
        .run();
    } catch {
      /* ignore usage tracking failures */
    }
    return ollama;
  }
  return embedViaTransformers(text);
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];
  for (const t of texts) {
    results.push(await embedText(t));
  }
  return results;
}

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
