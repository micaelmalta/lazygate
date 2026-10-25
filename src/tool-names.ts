// src/tool-names.ts
// Optional server__tool namespacing to avoid collisions across activated servers.

import type { ServerConfig } from "./router.js";

/** Separator between server name and upstream tool name when namespacing is on. */
export const TOOL_NS_SEP = "__";

/** Per-server flag wins over the gateway/stdio default (default off). */
export function isToolsNamespaced(
  cfg: ServerConfig | undefined,
  globalDefault = false
): boolean {
  if (cfg?.namespaceTools === true) return true;
  if (cfg?.namespaceTools === false) return false;
  return globalDefault;
}

export function exposedToolName(server: string, tool: string, namespaced: boolean): string {
  return namespaced ? `${server}${TOOL_NS_SEP}${tool}` : tool;
}

/** Strip `server__` prefix when present; otherwise return the name unchanged. */
export function bareToolName(server: string, exposed: string): string {
  const prefix = `${server}${TOOL_NS_SEP}`;
  return exposed.startsWith(prefix) ? exposed.slice(prefix.length) : exposed;
}

/** Parse `server__tool` into parts. Returns undefined when the separator is missing. */
export function parseNamespacedTool(name: string): { server: string; tool: string } | undefined {
  const i = name.indexOf(TOOL_NS_SEP);
  if (i <= 0 || i + TOOL_NS_SEP.length >= name.length) return undefined;
  return { server: name.slice(0, i), tool: name.slice(i + TOOL_NS_SEP.length) };
}
