export { syncGmail } from "./gmail.js";
export { syncGcal, freeBlocksForDate } from "./gcal.js";
export { syncGithub } from "./github.js";
export {
  runGoogleAuthFlow,
  googleStatus,
  getAuthedClient,
  getStoredTokens,
} from "./google-auth.js";
export {
  githubStatus,
  runGithubGhAuthLogin,
  tryLoadGhCliToken,
  resolveGithubToken,
  installGithubCli,
} from "./github-auth.js";
export type { ConnectorResult, NormalizedItem } from "./base.js";
export {
  withMcpClient,
  listMcpTools,
  callMcpTool,
  type McpToolInfo,
} from "./mcp/client.js";
export {
  listMcpServerConfigs,
  listEnabledMcpServers,
  getMcpServerConfig,
  saveMcpServerConfigs,
  upsertMcpServerConfig,
  removeMcpServerConfig,
  type McpServerConfig,
} from "./mcp/registry.js";

import { syncGmail } from "./gmail.js";
import { syncGcal } from "./gcal.js";
import { syncGithub } from "./github.js";
import type { ConnectorResult } from "./base.js";
import { getDb, sources } from "@second-brain/core";
import { eq } from "drizzle-orm";

export const connectors: Record<
  string,
  () => Promise<ConnectorResult>
> = {
  gmail: syncGmail,
  gcal: syncGcal,
  github: syncGithub,
};

const SOURCE_IDS: Record<string, string> = {
  gmail: "src-gmail",
  gcal: "src-gcal",
  github: "src-github",
};

function isEnabled(name: string): boolean {
  const id = SOURCE_IDS[name];
  if (!id) return true;
  const row = getDb().select().from(sources).where(eq(sources.id, id)).get();
  return row?.enabled !== false;
}

export async function ingestAll(): Promise<Record<string, ConnectorResult>> {
  const out: Record<string, ConnectorResult> = {};
  for (const [name, fn] of Object.entries(connectors)) {
    if (!isEnabled(name)) {
      out[name] = { fetched: 0, upserted: 0, cursor: { skipped: "disabled" } };
      continue;
    }
    try {
      out[name] = await fn();
    } catch (e) {
      out[name] = {
        fetched: 0,
        upserted: 0,
        cursor: { error: e instanceof Error ? e.message : String(e) },
      };
    }
  }
  return out;
}
