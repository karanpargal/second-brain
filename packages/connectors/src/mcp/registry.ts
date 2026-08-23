/**
 * MCP server configs live in settings (`mcp.servers`); tokens in encrypted secrets.
 */
import { getDb, settings, log } from "@second-brain/core";
import { eq } from "drizzle-orm";

export type McpServerConfig = {
  id: string;
  label: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  /** Plain env vars (non-secret). */
  env?: Record<string, string>;
  /** Names of env vars whose values are read from getSecret(`mcp.${id}.${name}`). */
  secretKeys?: string[];
  enabled: boolean;
};

const SETTINGS_KEY = "mcp.servers";

function parseServers(raw: unknown): McpServerConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: McpServerConfig[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = String(r.id ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "");
    if (!id) continue;
    const transport = r.transport === "http" ? "http" : "stdio";
    out.push({
      id,
      label: String(r.label ?? id),
      transport,
      command: r.command ? String(r.command) : undefined,
      args: Array.isArray(r.args) ? r.args.map(String) : undefined,
      url: r.url ? String(r.url) : undefined,
      env:
        r.env && typeof r.env === "object" && !Array.isArray(r.env)
          ? Object.fromEntries(
              Object.entries(r.env as Record<string, unknown>).map(([k, v]) => [
                k,
                String(v),
              ]),
            )
          : undefined,
      secretKeys: Array.isArray(r.secretKeys)
        ? r.secretKeys.map(String)
        : undefined,
      enabled: r.enabled !== false,
    });
  }
  return out;
}

export function listMcpServerConfigs(): McpServerConfig[] {
  try {
    const row = getDb()
      .select()
      .from(settings)
      .where(eq(settings.key, SETTINGS_KEY))
      .get();
    if (!row) return [];
    return parseServers(JSON.parse(row.valueJson));
  } catch (e) {
    log.warn("Failed to read mcp.servers", { err: String(e) });
    return [];
  }
}

export function getMcpServerConfig(id: string): McpServerConfig | undefined {
  return listMcpServerConfigs().find((s) => s.id === id);
}

export function saveMcpServerConfigs(servers: McpServerConfig[]): void {
  const db = getDb();
  const valueJson = JSON.stringify(servers);
  const existing = db
    .select()
    .from(settings)
    .where(eq(settings.key, SETTINGS_KEY))
    .get();
  if (existing) {
    db.update(settings)
      .set({ valueJson, updatedAt: new Date().toISOString() })
      .where(eq(settings.key, SETTINGS_KEY))
      .run();
  } else {
    db.insert(settings)
      .values({
        key: SETTINGS_KEY,
        valueJson,
        updatedAt: new Date().toISOString(),
      })
      .run();
  }
}

export function upsertMcpServerConfig(cfg: McpServerConfig): McpServerConfig[] {
  const all = listMcpServerConfigs().filter((s) => s.id !== cfg.id);
  all.push(cfg);
  saveMcpServerConfigs(all);
  return all;
}

export function removeMcpServerConfig(id: string): McpServerConfig[] {
  const all = listMcpServerConfigs().filter((s) => s.id !== id);
  saveMcpServerConfigs(all);
  return all;
}

export function listEnabledMcpServers(): McpServerConfig[] {
  return listMcpServerConfigs().filter((s) => s.enabled);
}
