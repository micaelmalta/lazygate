// src/manifest.ts
// A compact tool manifest for the MCP `instructions` field.
//
// A cold agent pays an extra model call to find a tool (discover_tools), and that call re-reads the
// whole prompt. For the few servers most sessions need, listing their call signatures up front costs
// a few hundred tokens once per prompt instead, and removes that call. Servers opt in with
// `manifest` in servers.json; signatures come from the learned tool index, so only servers that
// have been activated before are listed. Nothing is started to build it.

import type { ServerConfig } from "./router.js";
import type { ToolIndex, IndexedTool } from "./tool-index.js";

/** Whole-manifest budget in characters (about 400 tokens). Servers that do not fit are left out. */
export const MANIFEST_MAX_CHARS = 1_600;
/** Tools listed per server. */
export const MANIFEST_MAX_TOOLS_PER_SERVER = 12;

export interface ManifestOptions {
  maxChars?: number;
  maxToolsPerServer?: number;
}

function selectTools(cfg: ServerConfig, tools: IndexedTool[], limit: number): IndexedTool[] {
  const allow = Array.isArray(cfg.manifest) ? new Set(cfg.manifest) : null;
  return tools.filter((t) => !allow || allow.has(t.name)).slice(0, limit);
}

/**
 * The manifest text, or undefined when no opted-in server has indexed tools. Deterministic
 * (servers in registry order), so the instructions do not change between sessions and the prompt
 * cache stays valid.
 */
export function buildManifest(
  servers: Record<string, ServerConfig>,
  index: ToolIndex,
  options: ManifestOptions = {}
): string | undefined {
  const maxChars = options.maxChars ?? MANIFEST_MAX_CHARS;
  const limit = options.maxToolsPerServer ?? MANIFEST_MAX_TOOLS_PER_SERVER;
  const head =
    "Call these tools directly with call_tool(server, tool, args); no discover_tools or describe_tool turn is needed. " +
    "A server marked (run_chain) can also be scripted as servers.<server>.<tool>(args) inside run_chain.";
  const tail = "Anything else: discover_tools.";

  const lines: string[] = [];
  let used = head.length + tail.length + 2;
  let omitted = 0;
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg.manifest) continue;
    const tools = selectTools(cfg, index.get(name, cfg), limit);
    if (tools.length === 0) continue;
    const marker = cfg.toolChain ? " (run_chain)" : "";
    const line = `- ${name}${marker}: ${tools.map((t) => t.signature ?? `${t.name}(args)`).join("; ")}`;
    if (used + line.length + 1 > maxChars) {
      omitted += 1;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }

  const assemble = (): string => {
    const more = omitted ? `\n(${omitted} more server${omitted === 1 ? "" : "s"} omitted to keep this short.)` : "";
    return `${head}\n${lines.join("\n")}${more}\n${tail}`;
  };
  // The omission note counts against the cap too: drop whole servers until the text fits.
  while (lines.length > 0 && assemble().length > maxChars) {
    lines.pop();
    omitted += 1;
  }
  return lines.length === 0 ? undefined : assemble();
}
