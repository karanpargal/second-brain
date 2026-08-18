#!/usr/bin/env node
/**
 * stdio MCP server — local memory tools for Cursor / Claude Desktop.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  ensureDataDir,
  migrate,
  seed,
} from "@second-brain/core";
import {
  searchMemory,
  timeline,
  listOpenLoops,
  whatDidIDo,
  whereDidILeaveOff,
  findArtifact,
} from "@second-brain/agents";

ensureDataDir();
migrate();
seed();

const server = new Server(
  { name: "second-brain", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search_memory",
      description:
        "Semantic search over local PC memory (observations, gmail, github, activity).",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" },
        },
        required: ["query"],
      },
    },
    {
      name: "timeline",
      description: "Activity blocks for a calendar day (YYYY-MM-DD).",
      inputSchema: {
        type: "object",
        properties: { date: { type: "string" } },
        required: ["date"],
      },
    },
    {
      name: "open_loops",
      description: "List open loops (unfinished work / promises / waiting).",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description: "open | closed | all (default open)",
          },
        },
      },
    },
    {
      name: "what_did_i_do",
      description: "What the user did recently or on a date.",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string" },
          hours: { type: "number" },
        },
      },
    },
    {
      name: "where_did_i_leave_off",
      description: "Recent artifacts (files, URLs, windows) last touched.",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number" } },
      },
    },
    {
      name: "find_artifact",
      description: "Find work artifacts by title or key substring.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;

  let result: unknown;
  switch (name) {
    case "search_memory":
      result = await searchMemory(
        String(args.query ?? ""),
        Number(args.limit ?? 15),
      );
      break;
    case "timeline":
      result = timeline(String(args.date ?? new Date().toISOString().slice(0, 10)));
      break;
    case "open_loops":
      result = listOpenLoops(String(args.status ?? "open"));
      break;
    case "what_did_i_do":
      result = whatDidIDo({
        date: args.date ? String(args.date) : undefined,
        hours: args.hours ? Number(args.hours) : undefined,
      });
      break;
    case "where_did_i_leave_off":
      result = whereDidILeaveOff(Number(args.limit ?? 8));
      break;
    case "find_artifact":
      result = findArtifact(String(args.query ?? ""));
      break;
    default:
      throw new Error(`Unknown tool: ${name}`);
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
