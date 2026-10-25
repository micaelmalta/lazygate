// src/router.ts
// Scores and selects relevant servers based on a query

import { readFileSync, statSync } from "fs";
import type { OAuthConfig } from "./oauth.js";
import { parseServersConfig, reportConfigErrors } from "./config.js";
import { scoreEntry } from "./scoring.js";
import { ToolIndex, toolText } from "./tool-index.js";
import { LOG_PREFIX } from "./version.js";

function fileMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export type { OAuthConfig };

/**
 * Where a server's credentials come from (gateway mode; ignored by plain stdio mode unless
 * `${secret:…}` / `${cred:…}` templates are used).
 * - scope "server": one credential for everyone — `${secret:path}` from the gateway's secret store
 *   (default for stdio).
 * - scope "user": each user's own — `${cred:field}` from the `X-Lazygate-Cred-<Server>-<Field>`
 *   request headers, and per-user OAuth tokens (default for HTTP).
 * - fallback "server": when the user sent nothing, `${cred:field}` falls back to the secret
 *   `<server>/<field>`.
 * `env` (stdio) and `headers` (HTTP) are templates applied on top of the server's own.
 */
export interface AuthConfig {
  scope?: "user" | "server";
  fallback?: "server";
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface ServerConfig {
  description: string;
  keywords: string[];
  // stdio transport (default)
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http transport
  type?: "http" | "stdio";
  url?: string;
  headers?: Record<string, string>;
  /**
   * OAuth for HTTP MCP servers.
   * - omit / undefined: start OAuth only if the server answers 401
   * - true: force OAuth (discover clientId + callback port)
   * - false: never attempt OAuth
   * - object: optional overrides (clientId, callbackPort, scopes); missing fields are discovered
   */
  oauth?: boolean | OAuthConfig;
  autoActivate: boolean;
  /**
   * Environment passed to a stdio child.
   * - omit / true: the broker's whole environment (default in stdio mode; gateway defaults omit → false)
   * - false: only a minimal base set (PATH, HOME, locale, temp dirs, proxies, …)
   * - string[]: the base set plus the listed variable names (`PREFIX_*` allowed)
   * The server's own `env` entries are always added on top. `LAZYGATE_*` is always stripped.
   */
  inheritEnv?: boolean | string[];
  /** Credential sources (see AuthConfig). */
  auth?: AuthConfig;
  /** Gateway mode: only users in one of these groups can see or use the server (omit = everyone). */
  groups?: string[];
  /** Per-call timeout for tools/call (default 5 minutes). */
  toolTimeoutMs?: number;
  /** Set by `migrate` so `revert` can find the entries it created. */
  migratedFrom?: string;
  /** Plugin keys that `migrate` disabled for this server (re-enabled by `revert`). */
  disabledPlugins?: string[];
  /** Soft-disable: hidden from non-admins; activate/discover refuse for everyone. */
  disabled?: boolean;
  /**
   * Needs the caller's local machine (filesystem, desktop apps, …). Hidden from the
   * gateway catalog and refused for activate/discover in serve mode — use personal
   * stdio lazygate instead.
   */
  local?: boolean;
  /**
   * Which of this server's tools appear in the broker's tools/list after activate.
   * - omit / `"none"` (default): none — use `describe_tool` / `call_tool` so the list stays stable
   * - `"all"`: merge every tool schema into tools/list (legacy behaviour)
   * - string[]: allowlist of tool names to merge
   */
  expose?: "none" | "all" | string[];
  /**
   * When true, expose and accept tools as `server__tool` so identical upstream names
   * across servers do not collide. Per-server value overrides a gateway-wide default.
   * Default off (omit / false).
   */
  namespaceTools?: boolean;
}

/** Effective credential scope. HTTP servers default to per-user; stdio defaults to shared. */
export function effectiveAuthScope(cfg: ServerConfig): "user" | "server" {
  if (cfg.auth?.scope) return cfg.auth.scope;
  if (cfg.url || cfg.type === "http") return "user";
  return "server";
}

/**
 * True when a shared-scope HTTP server is visible to more than one group (or to everyone).
 * Those callers all act under the same shared credential / OAuth identity.
 */
export function sharedScopeMultiGroup(cfg: ServerConfig): boolean {
  if (effectiveAuthScope(cfg) !== "server") return false;
  if (!cfg.url && cfg.type !== "http") return false;
  return !cfg.groups || cfg.groups.length !== 1;
}

export interface RouterResult {
  name: string;
  score: number;
  /** Keywords that matched. */
  reason: string[];
  /** Description words that matched. */
  descriptionMatches: string[];
  /** Words from the server's (learned) tool names/descriptions that matched. */
  toolMatches: string[];
}

export class ToolRouter {
  private servers: Record<string, ServerConfig>;
  private readonly configPath?: string;
  /** Last successfully applied (or failed-with-keep) mtime; skip re-read when unchanged. */
  private configMtime = -1;

  private readonly toolIndex?: ToolIndex;

  constructor(servers: Record<string, ServerConfig>, configPath?: string, toolIndex?: ToolIndex) {
    this.servers = servers;
    this.configPath = configPath;
    this.toolIndex = toolIndex;
    if (configPath) this.configMtime = fileMtimeMs(configPath);
  }

  /**
   * Re-read server definitions from disk (same path as at startup).
   * Picks up edits to servers.json without restarting the broker process.
   * Skips the read when the file mtime is unchanged.
   * On any read/parse/validation failure the previous definitions are kept.
   * Returns true when the registry was refreshed.
   */
  reloadServersFromDisk(): boolean {
    if (!this.configPath) return false;
    const mtime = fileMtimeMs(this.configPath);
    if (mtime === this.configMtime) return false;
    try {
      const raw = JSON.parse(readFileSync(this.configPath, "utf-8"));
      const { entries, errors } = parseServersConfig(raw, this.configPath);
      reportConfigErrors(errors);
      this.servers = entries;
      this.configMtime = mtime;
      return true;
    } catch (err) {
      // Remember mtime so a persistently broken file isn't re-parsed every call.
      this.configMtime = mtime;
      console.error(
        `${LOG_PREFIX} Could not reload ${this.configPath}: ${(err as Error).message} — keeping previous config`
      );
      return false;
    }
  }

  /**
   * Score all servers against a query.
   * Returns ranked list with scores and match reasons.
   */
  rank(query: string): RouterResult[] {
    const results: RouterResult[] = [];

    for (const [name, config] of Object.entries(this.servers)) {
      const learned = this.toolIndex?.get(name, config) ?? [];
      const s = scoreEntry(query, {
        description: config.description,
        keywords: config.keywords,
        toolText: learned.length ? toolText(learned) : undefined,
      });
      if (s.score > 0) {
        results.push({
          name,
          score: s.score,
          reason: s.keywords,
          descriptionMatches: s.descriptionWords,
          toolMatches: s.toolWords,
        });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Select top-k servers for a query.
   */
  select(query: string, topK = 3): string[] {
    return this.rank(query).slice(0, topK).map((r) => r.name);
  }

  /** Servers whose learned tool index lists this exact tool name (signature-fresh). */
  serversWithTool(toolName: string): string[] {
    return this.toolIndex?.findServersWithTool(toolName, this.servers) ?? [];
  }

  getConfig(name: string): ServerConfig | undefined {
    return this.servers[name];
  }

  listAll(): string[] {
    return Object.keys(this.servers);
  }
}
