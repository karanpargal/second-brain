/**
 * Aggregate read-only tools from enabled MCP servers into an Ollama tool catalog.
 */
import {
  listEnabledMcpServers,
  listMcpTools,
  callMcpTool,
  type McpServerConfig,
  type McpToolInfo,
} from "@second-brain/connectors";
import { log } from "@second-brain/core";
import type { LlmToolDef } from "./llm.js";

const READ_RE =
  /\b(get|list|search|find|read|fetch|query|lookup|describe|show|view|inspect|status|count|summar)\w*/i;
const WRITE_RE =
  /\b(delete|remove|archive|send|create|update|write|post|put|patch|merge|close|cancel|invite|move|rename|trash|destroy|insert|upsert|edit|set_|add_|drop)\w*/i;

const MAX_ARG_CHARS = 4_000;
const MAX_RESULT_CHARS = 12_000;

export type NamespacedTool = {
  /** e.g. notion__search */
  name: string;
  serverId: string;
  serverLabel: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpCatalog = {
  tools: NamespacedTool[];
  ollamaTools: LlmToolDef[];
  servers: McpServerConfig[];
  skipped: Array<{ serverId: string; tool: string; reason: string }>;
  errors: Array<{ serverId: string; error: string }>;
};

export function isReadOnlyTool(t: McpToolInfo): boolean {
  if (t.readOnlyHint === true) return true;
  if (t.destructiveHint === true) return false;
  if (t.readOnlyHint === false) return false;
  const blob = `${t.name} ${t.description ?? ""}`;
  if (WRITE_RE.test(blob)) return false;
  if (READ_RE.test(blob)) return true;
  // Unknown + no annotations → exclude (fail closed)
  return false;
}

export function namespaceTool(serverId: string, toolName: string): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${safe(serverId)}__${safe(toolName)}`;
}

export function parseNamespacedTool(
  name: string,
): { serverId: string; toolName: string } | null {
  const i = name.indexOf("__");
  if (i <= 0) return null;
  return { serverId: name.slice(0, i), toolName: name.slice(i + 2) };
}

function toOllamaTool(t: NamespacedTool): LlmToolDef {
  return {
    type: "function",
    function: {
      name: t.name,
      description: `[${t.serverLabel}] ${t.description}`.slice(0, 500),
      parameters: t.inputSchema?.type
        ? t.inputSchema
        : { type: "object", properties: {}, additionalProperties: true },
    },
  };
}

/** Discover tools across enabled MCP servers; keep only read-only. */
export async function buildMcpCatalog(): Promise<McpCatalog> {
  const servers = listEnabledMcpServers();
  const tools: NamespacedTool[] = [];
  const skipped: McpCatalog["skipped"] = [];
  const errors: McpCatalog["errors"] = [];

  for (const server of servers) {
    try {
      const listed = await listMcpTools(server);
      for (const t of listed) {
        if (!isReadOnlyTool(t)) {
          skipped.push({
            serverId: server.id,
            tool: t.name,
            reason: "not_read_only",
          });
          continue;
        }
        tools.push({
          name: namespaceTool(server.id, t.name),
          serverId: server.id,
          serverLabel: server.label,
          toolName: t.name,
          description: t.description ?? t.name,
          inputSchema: t.inputSchema ?? { type: "object", properties: {} },
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn("MCP listTools failed", { server: server.id, err: msg });
      errors.push({ serverId: server.id, error: msg });
    }
  }

  return {
    tools,
    ollamaTools: tools.map(toOllamaTool),
    servers,
    skipped,
    errors,
  };
}

export async function executeNamespacedTool(
  catalog: McpCatalog,
  namespacedName: string,
  rawArgs: unknown,
): Promise<{ ok: boolean; text: string; serverId?: string; toolName?: string }> {
  const parsed = parseNamespacedTool(namespacedName);
  if (!parsed) {
    return { ok: false, text: `Unknown tool name: ${namespacedName}` };
  }
  const meta = catalog.tools.find((t) => t.name === namespacedName);
  if (!meta) {
    return {
      ok: false,
      text: `Tool ${namespacedName} is not in the read-only catalog`,
    };
  }
  const server = catalog.servers.find((s) => s.id === parsed.serverId);
  if (!server) {
    return { ok: false, text: `Server ${parsed.serverId} not configured` };
  }

  let args: Record<string, unknown> = {};
  try {
    if (typeof rawArgs === "string") {
      args = rawArgs.trim() ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
    } else if (rawArgs && typeof rawArgs === "object") {
      args = rawArgs as Record<string, unknown>;
    }
  } catch {
    return { ok: false, text: "Invalid tool arguments JSON" };
  }

  const argJson = JSON.stringify(args);
  if (argJson.length > MAX_ARG_CHARS) {
    return { ok: false, text: "Tool arguments too large" };
  }

  try {
    const res = await callMcpTool(server, meta.toolName, args);
    let text = res.text;
    if (text.length > MAX_RESULT_CHARS) {
      text = text.slice(0, MAX_RESULT_CHARS) + "\n…[truncated]";
    }
    return {
      ok: !res.isError,
      text,
      serverId: server.id,
      toolName: meta.toolName,
    };
  } catch (e) {
    return {
      ok: false,
      text: e instanceof Error ? e.message : String(e),
      serverId: server.id,
      toolName: meta.toolName,
    };
  }
}
