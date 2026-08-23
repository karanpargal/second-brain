/**
 * Thin MCP client: spawn/connect per call, always close.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getSecret, log } from "@second-brain/core";
import type { McpServerConfig } from "./registry.js";

const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_RESULT_CHARS = 24_000;

export type McpToolInfo = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
};

function buildEnv(cfg: McpServerConfig): Record<string, string> {
  const env: Record<string, string> = {};
  // Inherit a minimal safe env so Windows PATH works for npx/node
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "USERPROFILE", "HOME", "TMP", "TEMP", "APPDATA", "LOCALAPPDATA"]) {
    const v = process.env[key];
    if (v) env[key] = v;
  }
  for (const [k, v] of Object.entries(cfg.env ?? {})) {
    env[k] = v;
  }
  for (const secretKey of cfg.secretKeys ?? []) {
    const val = getSecret(`mcp.${cfg.id}.${secretKey}`) ?? getSecret(secretKey);
    if (val) env[secretKey] = val;
  }
  return env;
}

export async function withMcpClient<T>(
  cfg: McpServerConfig,
  fn: (client: Client) => Promise<T>,
  opts?: { timeoutMs?: number },
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const client = new Client(
    { name: "second-brain", version: "0.2.0" },
    { capabilities: {} },
  );

  let transport: StdioClientTransport | StreamableHTTPClientTransport;

  if (cfg.transport === "http") {
    if (!cfg.url) throw new Error(`MCP server ${cfg.id}: url required for http`);
    transport = new StreamableHTTPClientTransport(new URL(cfg.url));
  } else {
    if (!cfg.command) {
      throw new Error(`MCP server ${cfg.id}: command required for stdio`);
    }
    transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: buildEnv(cfg),
      stderr: "pipe",
    });
  }

  const timer = setTimeout(() => {
    void client.close().catch(() => undefined);
  }, timeoutMs);

  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    clearTimeout(timer);
    try {
      await client.close();
    } catch (e) {
      log.warn("MCP client close failed", { id: cfg.id, err: String(e) });
    }
  }
}

export async function listMcpTools(cfg: McpServerConfig): Promise<McpToolInfo[]> {
  return withMcpClient(cfg, async (client) => {
    const res = await client.listTools();
    return (res.tools ?? []).map((t) => {
      const ann = (t as { annotations?: Record<string, unknown> }).annotations ?? {};
      return {
        name: t.name,
        description: t.description,
        inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as Record<
          string,
          unknown
        >,
        readOnlyHint:
          typeof ann.readOnlyHint === "boolean" ? ann.readOnlyHint : undefined,
        destructiveHint:
          typeof ann.destructiveHint === "boolean"
            ? ann.destructiveHint
            : undefined,
      };
    });
  });
}

export async function callMcpTool(
  cfg: McpServerConfig,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> {
  return withMcpClient(cfg, async (client) => {
    const res = await client.callTool({ name, arguments: args });
    const isError = Boolean((res as { isError?: boolean }).isError);
    const content = (res as { content?: Array<{ type?: string; text?: string }> })
      .content;
    let text = "";
    if (Array.isArray(content)) {
      text = content
        .map((c) => (c.type === "text" ? (c.text ?? "") : JSON.stringify(c)))
        .join("\n");
    } else {
      text = JSON.stringify(res);
    }
    if (text.length > MAX_RESULT_CHARS) {
      text = text.slice(0, MAX_RESULT_CHARS) + "\n…[truncated]";
    }
    return { text, isError };
  });
}
