/**
 * OCR classification graph (state → action → reward) for future RL.
 * Local only. No training loop yet — we store trajectories and few-shot misses.
 */
import { eq } from "drizzle-orm";
import { getDb } from "./db/client.js";
import { learnEdges, learnNodes, openLoops } from "./db/schema.js";
import { newId } from "./jobs.js";
import { log } from "./log.js";

export type ChatAudience = "me" | "other" | "neither";
export type ChatTopic = "actionable" | "idle" | "market";

export type LearnClassifyInput = {
  ocr: string;
  audience: ChatAudience;
  topic: ChatTopic;
  keep: boolean;
  title?: string;
  who?: string;
  observationId?: string;
  loopId?: string;
};

const MARKET_RE =
  /\b(unrealized pn|opened (long|short)|cross margin|tp\/sl|take profit|stop loss|liquidation|oracle price|notional|isolated margin|limit order at|fill(s)?\b.{0,12}(long|short)|xyz:(gold|spcx|btc|unitree)|bull run|bear run)\b/i;

export function looksLikeMarket(text: string): boolean {
  const t = text.replace(/\s+/g, " ");
  if (MARKET_RE.test(t)) return true;
  const hits = [
    /\bpnl\b/i,
    /\bleverage\b/i,
    /\bnotional\b/i,
    /\b(long|short)\b/i,
    /\bmargin\b/i,
  ].filter((re) => re.test(t)).length;
  return hits >= 3;
}

function snippet(ocr: string): string {
  return ocr.replace(/\s+/g, " ").trim().slice(0, 220);
}

function insertNode(row: {
  kind: string;
  label: string;
  payload: unknown;
  reward?: number | null;
}): string | null {
  try {
    const id = newId();
    getDb()
      .insert(learnNodes)
      .values({
        id,
        kind: row.kind,
        label: row.label.slice(0, 120),
        payloadJson: JSON.stringify(row.payload ?? {}),
        reward: row.reward ?? null,
      })
      .run();
    return id;
  } catch (e) {
    log.debug("learn node skip", { err: String(e) });
    return null;
  }
}

function insertEdge(fromId: string, toId: string, rel: string, weight = 1): void {
  try {
    getDb()
      .insert(learnEdges)
      .values({
        id: newId(),
        fromId,
        toId,
        rel,
        weight,
      })
      .run();
  } catch (e) {
    log.debug("learn edge skip", { err: String(e) });
  }
}

/** Record one classify step. Returns episode class-node id. */
export function recordLearnClassify(input: LearnClassifyInput): string | null {
  const ocrId = insertNode({
    kind: "ocr",
    label: snippet(input.ocr).slice(0, 80) || "ocr",
    payload: {
      ocr: snippet(input.ocr),
      observationId: input.observationId ?? null,
    },
  });
  const classId = insertNode({
    kind: input.topic === "market" ? "market" : "class",
    label: `${input.audience}:${input.topic}`,
    payload: {
      audience: input.audience,
      topic: input.topic,
      keep: input.keep,
      title: input.title ?? null,
      who: input.who ?? null,
      loopId: input.loopId ?? null,
    },
  });
  if (ocrId && classId) insertEdge(ocrId, classId, "classified");
  if (input.topic === "market" && classId) {
    const m = insertNode({
      kind: "market",
      label: "market_drop",
      payload: { ocr: snippet(input.ocr) },
    });
    if (m && classId) insertEdge(classId, m, "corrected");
  }
  return classId;
}

export function linkLearnCard(classNodeId: string, loopId: string, title: string): void {
  const cardId = insertNode({
    kind: "card",
    label: title.slice(0, 80),
    payload: { loopId, title },
  });
  if (cardId) insertEdge(classNodeId, cardId, "carded");
  try {
    const row = getDb()
      .select()
      .from(learnNodes)
      .where(eq(learnNodes.id, classNodeId))
      .get();
    if (!row) return;
    const payload = JSON.parse(row.payloadJson || "{}") as Record<string, unknown>;
    payload.loopId = loopId;
    getDb()
      .update(learnNodes)
      .set({ payloadJson: JSON.stringify(payload) })
      .where(eq(learnNodes.id, classNodeId))
      .run();
  } catch {
    /* */
  }
}

function rewardForSignal(signal: string): number {
  if (signal === "positive" || signal === "closed" || signal === "done") return 1;
  if (signal === "spam" || signal === "dismiss" || signal === "not_tracking") {
    return -1;
  }
  if (signal === "negative") return -0.5;
  return 0;
}

/** User outcome on a card — the RL reward for the classify action. */
export function recordLearnReward(loopId: string, signal: string): void {
  try {
    const db = getDb();
    const loop = db.select().from(openLoops).where(eq(openLoops.id, loopId)).get();
    const blob = `${loop?.title ?? ""} ${loop?.description ?? ""}`;
    const market = looksLikeMarket(blob);
    const reward = rewardForSignal(signal);
    const outcomeId = insertNode({
      kind: "outcome",
      label: market && reward < 0 ? "market_miss" : signal,
      payload: {
        loopId,
        signal,
        title: loop?.title ?? null,
        market,
      },
      reward,
    });
    if (!outcomeId) return;

    const nodes = db.select().from(learnNodes).all();
    const classNode = [...nodes]
      .reverse()
      .find((n) => {
        if (n.kind !== "class" && n.kind !== "market") return false;
        try {
          const p = JSON.parse(n.payloadJson || "{}") as { loopId?: string };
          return p.loopId === loopId;
        } catch {
          return false;
        }
      });
    const cardNode = [...nodes]
      .reverse()
      .find((n) => {
        if (n.kind !== "card") return false;
        try {
          const p = JSON.parse(n.payloadJson || "{}") as { loopId?: string };
          return p.loopId === loopId;
        } catch {
          return false;
        }
      });
    if (cardNode) insertEdge(cardNode.id, outcomeId, "rewarded", reward);
    else if (classNode) insertEdge(classNode.id, outcomeId, "rewarded", reward);

    if (market && reward < 0) {
      const m = insertNode({
        kind: "market",
        label: "incorrect_market_card",
        payload: { title: loop?.title ?? blob.slice(0, 180), loopId },
      });
      if (m && (cardNode || classNode)) {
        insertEdge((cardNode ?? classNode)!.id, m, "corrected", -1);
      }
    }
  } catch (e) {
    log.debug("learn reward skip", { err: String(e) });
  }
}

/** Few-shot for the classify prompt — especially market misses. */
export function learnGraphFewShot(limit = 8): string {
  try {
    const nodes = getDb()
      .select()
      .from(learnNodes)
      .all()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const lines: string[] = [];
    for (const n of nodes) {
      if (lines.length >= limit) break;
      if (n.kind === "market" || n.label === "market_miss" || n.label === "incorrect_market_card") {
        let ocr = "";
        try {
          const p = JSON.parse(n.payloadJson || "{}") as {
            ocr?: string;
            title?: string;
          };
          ocr = (p.ocr || p.title || "").slice(0, 140);
        } catch {
          /* */
        }
        if (ocr.length < 8) continue;
        lines.push(`- MARKET / not for me (no card): ${ocr}`);
        continue;
      }
      if (n.kind === "outcome" && (n.reward ?? 0) < 0) {
        let title = n.label;
        try {
          const p = JSON.parse(n.payloadJson || "{}") as { title?: string };
          title = p.title || title;
        } catch {
          /* */
        }
        lines.push(`- User rejected card: ${String(title).slice(0, 120)}`);
      }
    }
    if (lines.length === 0) return "(none)";
    return lines.join("\n").slice(0, 1400);
  } catch {
    return "(none)";
  }
}
