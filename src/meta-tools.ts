// src/meta-tools.ts
// Meta-tool definitions the broker advertises (11 total), plus their argument schemas.
// Stdio lists 9; gateway-only connect/disconnect are filtered when access.connect is absent.
// Prefer describe_tool / call_tool when the client ignores notifications/tools/list_changed.

import { z } from "zod";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const META_TOOLS: Tool[] = [
  {
    name: "discover_tools",
    description:
      "Find which tool servers are available and relevant for a task. " +
      "Call this first when you need a capability you don't have yet.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Describe what you want to do" },
      },
      required: ["query"],
    },
  },
  {
    name: "activate_server",
    description:
      "Load and connect a tool server. Its tools stay off tools/list by default — " +
      "use describe_tool for a schema and call_tool to invoke (or set expose in servers.json).",
    inputSchema: {
      type: "object",
      properties: {
        server_name: { type: "string", description: "Name of the server to activate" },
      },
      required: ["server_name"],
    },
  },
  {
    name: "deactivate_server",
    description: "Shut down a tool server to free resources.",
    inputSchema: {
      type: "object",
      properties: {
        server_name: { type: "string", description: "Name of the server to deactivate" },
      },
      required: ["server_name"],
    },
  },
  {
    name: "list_active_servers",
    description: "Show which servers are currently active and their tools.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "describe_tool",
    description:
      "Return one tool's full schema (name, description, inputSchema) from an active server. " +
      "Activates the server if needed. Prefer this over dumping every schema into tools/list.",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string", description: "Server name (from discover_tools / activate_server)" },
        tool: { type: "string", description: "Tool name on that server" },
      },
      required: ["server", "tool"],
    },
  },
  {
    name: "call_tool",
    description:
      "Call a tool on a server without adding its schema to tools/list. " +
      "Activates the server if needed. Use describe_tool first when you need the argument shape.",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string", description: "Server name" },
        tool: { type: "string", description: "Tool name on that server" },
        args: {
          type: "object",
          description: "Arguments for the tool (object; default {})",
        },
      },
      required: ["server", "tool"],
    },
  },
  {
    name: "discover_skill",
    description:
      "Find the right skill for a task before executing it. " +
      "Call this at the start of any task that produces a file or " +
      "requires specialist knowledge.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you are trying to do" },
      },
      required: ["query"],
    },
  },
  {
    name: "load_skill",
    description:
      "Load a skill's full instructions into context. " +
      "Also lists bundled files (scripts, templates, references) as skill:// URIs — " +
      "use read_skill_file or resources/read to fetch them.",
    inputSchema: {
      type: "object",
      properties: {
        skill_name: { type: "string", description: "Name returned by discover_skill" },
      },
      required: ["skill_name"],
    },
  },
  {
    name: "read_skill_file",
    description:
      "Read a file bundled with a skill (script, template, reference). " +
      "Paths are relative to the skill directory; prefer URIs from load_skill " +
      "(skill://<name>/<path>). Fallback when the client has no MCP resources support.",
    inputSchema: {
      type: "object",
      properties: {
        skill_name: { type: "string", description: "Skill name" },
        path: {
          type: "string",
          description: "Relative path within the skill (e.g. scripts/helper.py), or a skill:// URI",
        },
      },
      required: ["skill_name", "path"],
    },
  },
  {
    name: "connect_server",
    description:
      "Get a link to connect your account to a server that needs OAuth or an API key " +
      "(gateway mode). Open the link, finish authorizing, then call activate_server.",
    inputSchema: {
      type: "object",
      properties: {
        server_name: { type: "string", description: "Name of the server to connect" },
      },
      required: ["server_name"],
    },
  },
  {
    name: "disconnect_server",
    description:
      "Remove your stored credentials (API key and/or OAuth token) for a server (gateway mode).",
    inputSchema: {
      type: "object",
      properties: {
        server_name: { type: "string", description: "Name of the server to disconnect" },
      },
      required: ["server_name"],
    },
  },
];

/** Meta-tools only useful when BrokerAccess.connect is present (HTTP gateway). */
export const GATEWAY_ONLY_META_TOOL_NAMES = new Set(["connect_server", "disconnect_server"]);

/** Meta-tools advertised in tools/list for this session. */
export function listedMetaTools(includeGateway: boolean): Tool[] {
  if (includeGateway) return META_TOOLS;
  return META_TOOLS.filter((t) => !GATEWAY_ONLY_META_TOOL_NAMES.has(t.name));
}

export const META_TOOL_NAMES = META_TOOLS.map((t) => t.name);

export const QuerySchema = z.object({ query: z.string().min(1, "`query` must be a non-empty string") });
export const ServerNameSchema = z.object({
  server_name: z.string().min(1, "`server_name` must be a non-empty string"),
});
export const SkillNameSchema = z.object({
  skill_name: z.string().min(1, "`skill_name` must be a non-empty string"),
});
export const ReadSkillFileSchema = z.object({
  skill_name: z.string().min(1, "`skill_name` must be a non-empty string"),
  path: z.string().min(1, "`path` must be a non-empty string"),
});
export const DescribeToolSchema = z.object({
  server: z.string().min(1, "`server` must be a non-empty string"),
  tool: z.string().min(1, "`tool` must be a non-empty string"),
});
export const CallToolSchema = z.object({
  server: z.string().min(1, "`server` must be a non-empty string"),
  tool: z.string().min(1, "`tool` must be a non-empty string"),
  args: z.record(z.string(), z.unknown()).optional().default({}),
});
