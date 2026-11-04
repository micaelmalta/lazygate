// src/router.ts
// Scores and selects relevant servers based on a query

import { readFileSync, statSync } from "fs";
import type { OAuthConfig } from "./oauth.js";
import { parseServersConfig, reportConfigErrors } from "./config.js";
import { scoreEntry } from "./scoring.js";
import { DiscoveryRanker, type DiscoveryEntry } from "./discovery.js";
import { ToolIndex, toolText, type IndexedTool } from "./tool-index.js";
import { LOG_PREFIX } from "./version.js";
import { parseResponseOptimizationConfig, type ResponseOptimizationConfig } from "./response-optimizer.js";

function fileMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export type { OAuthConfig };

const NO_TOOLS: IndexedTool[] = [];

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
  /**
   * Tool chain: which of this server's tools `run_chain` scripts may call.
   * - omit / false (default): no script access; use call_tool
   * - true: every tool on the server
   * - string[]: allowlist of upstream (bare) tool names
   */
  toolChain?: boolean | string[];
  /**
   * Let `discover_tools` start this server (when it is the clearly best, credential-free match) so
   * the reply can carry its call signatures. Default: off, so a discovery request never starts a
   * process; set true for servers that are cheap and safe to start. Once the server has run, its
   * signatures are cached in tool-index.json and discovery shows them without starting anything.
   */
  previewOnDiscover?: boolean;
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
  /**
   * Hybrid relevance (0–1 within one ranking): the order `rank` returns. `score` stays the
   * integer keyword/word count so thresholds and displays keep their meaning.
   */
  relevance: number;
  /** Upstream tool names the query matched, best first (needs a learned tool index). */
  toolNameMatches: string[];
  /** The query contains a whole multi-word upstream tool identifier. */
  exactTool: boolean;
  /** First result of a BM25 / hybrid ranking. */
  best?: boolean;
}

/**
 * How `rank` orders servers.
 * - `lexical`: keyword / description / tool-word counts only (the original scorer)
 * - `bm25`: BM25 over weighted fields plus tool-name matches
 * - `hybrid` (default): both, each normalized to its best hit in the query
 */
export type RankStrategy = "lexical" | "bm25" | "hybrid";

export interface RankOptions {
  strategy?: RankStrategy;
  /** Calls per server (optional tie-break signal). Defaults to the router's usage signal. */
  usage?: Readonly<Record<string, number>>;
}

/** Strategy used when the caller does not pick one. */
export const DEFAULT_RANK_STRATEGY: RankStrategy = "bm25";

/** Servers (best BM25 first) that also get keyword/word-count detail for display and thresholds. */
const BM25_LEXICAL_DETAIL = 10;

/** Require at least one keyword match or two description-word matches (or a tool-name match). */
export const MIN_DISCOVERY_SCORE = 2;

/**
 * True when a ranked server is strong enough to show: enough keyword/word matches, a tool-name
 * hit, or the single best BM25 hit with at least one keyword/word match.
 */
export function isConfidentMatch(
  r: Pick<RouterResult, "score" | "exactTool" | "toolNameMatches"> & { best?: boolean }
): boolean {
  return (
    r.score >= MIN_DISCOVERY_SCORE ||
    r.exactTool ||
    r.toolNameMatches.length > 0 ||
    Boolean(r.best && r.score > 0)
  );
}

/** Weight of the BM25 side in the hybrid order (the remainder goes to the lexical counts). */
const HYBRID_BM25_WEIGHT = 0.5;

export class ToolRouter {
  private servers: Record<string, ServerConfig>;
  private readonly configPath?: string;
  /** Last successfully applied (or failed-with-keep) mtime; skip re-read when unchanged. */
  private configMtime = -1;

  private readonly toolIndex?: ToolIndex;
  private readonly ranker = new DiscoveryRanker();
  private usage?: Readonly<Record<string, number>>;
  private responseOptimization: ResponseOptimizationConfig;

  constructor(
    servers: Record<string, ServerConfig>,
    configPath?: string,
    toolIndex?: ToolIndex,
    responseOptimization?: ResponseOptimizationConfig
  ) {
    this.servers = servers;
    this.configPath = configPath;
    this.toolIndex = toolIndex;
    this.responseOptimization = responseOptimization ?? parseResponseOptimizationConfig({}).config;
    if (configPath) this.configMtime = fileMtimeMs(configPath);
  }

  /** Current response optimization policy, refreshed together with server definitions. */
  getResponseOptimization(): ResponseOptimizationConfig {
    return this.responseOptimization;
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
      const optimization = parseResponseOptimizationConfig(raw, this.configPath);
      reportConfigErrors(errors);
      reportConfigErrors(optimization.errors);
      this.servers = entries;
      if (optimization.errors.length === 0) this.responseOptimization = optimization.config;
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
  rank(query: string, options: RankOptions = {}): RouterResult[] {
    const strategy = options.strategy ?? DEFAULT_RANK_STRATEGY;
    const entries: DiscoveryEntry[] = [];

    const lexicalScore = (name: string, config: ServerConfig, learned: IndexedTool[]): RouterResult | undefined => {
      const s = scoreEntry(query, {
        description: config.description,
        keywords: config.keywords,
        toolText: learned.length ? toolText(learned) : undefined,
      });
      if (s.score <= 0) return undefined;
      return {
        name,
        score: s.score,
        reason: s.keywords,
        descriptionMatches: s.descriptionWords,
        toolMatches: s.toolWords,
        relevance: 0,
        toolNameMatches: [],
        exactTool: false,
      };
    };
    const learnedFor = (name: string, config: ServerConfig): IndexedTool[] => {
      const tools = this.toolIndex?.get(name, config);
      // One shared empty array keeps the ranker's per-server document cache valid.
      return tools && tools.length ? tools : NO_TOOLS;
    };

    if (strategy === "lexical") {
      const out: RouterResult[] = [];
      for (const [name, config] of Object.entries(this.servers)) {
        const r = lexicalScore(name, config, learnedFor(name, config));
        if (r) out.push(r);
      }
      const best = Math.max(1, ...out.map((r) => r.score));
      for (const r of out) r.relevance = r.score / best;
      return out.sort((a, b) => b.score - a.score);
    }

    for (const [name, config] of Object.entries(this.servers)) {
      entries.push({
        name,
        description: config.description,
        keywords: config.keywords,
        tools: learnedFor(name, config),
        sources: [config, learnedFor(name, config)],
      });
    }
    const hits = this.ranker.search(query, entries, { usage: options.usage ?? this.usage });
    const topBm25 = hits[0]?.relevance ?? 0;

    // "bm25" scores keyword/word counts only for the hits it can return (they feed `score`, the
    // thresholds and the "Matched …" lines); "hybrid" scores every server so it can blend the two.
    const lexical = new Map<string, RouterResult>();
    if (strategy === "hybrid") {
      for (const [name, config] of Object.entries(this.servers)) {
        const r = lexicalScore(name, config, learnedFor(name, config));
        if (r) lexical.set(name, r);
      }
    } else {
      for (const hit of hits.slice(0, BM25_LEXICAL_DETAIL)) {
        const config = this.servers[hit.name]!;
        const r = lexicalScore(hit.name, config, learnedFor(hit.name, config));
        if (r) lexical.set(hit.name, r);
      }
    }
    const topLexical = Math.max(1, ...[...lexical.values()].map((r) => r.score));

    const merged = new Map<string, RouterResult>();
    for (const hit of hits) {
      const base = lexical.get(hit.name) ?? {
        name: hit.name,
        score: 0,
        reason: [],
        descriptionMatches: [],
        toolMatches: [],
        relevance: 0,
        toolNameMatches: [],
        exactTool: false,
      };
      base.toolNameMatches = hit.toolMatches;
      base.exactTool = hit.exactTool;
      const bm25 = topBm25 > 0 ? hit.relevance / topBm25 : 0;
      base.relevance =
        strategy === "hybrid"
          ? HYBRID_BM25_WEIGHT * bm25 + (1 - HYBRID_BM25_WEIGHT) * (base.score / topLexical)
          : bm25;
      merged.set(hit.name, base);
    }
    if (strategy === "hybrid") {
      // Lexical-only hits (BM25 found nothing) still count, at the lexical share of the blend.
      for (const [name, r] of lexical) {
        if (merged.has(name)) continue;
        r.relevance = (1 - HYBRID_BM25_WEIGHT) * (r.score / topLexical);
        merged.set(name, r);
      }
    }
    const ordered = [...merged.values()].sort(
      (a, b) => b.relevance - a.relevance || b.score - a.score || a.name.localeCompare(b.name)
    );
    if (ordered[0]) ordered[0].best = true;
    return ordered;
  }

  /** Optional per-server call counts used as a small tie-break (see DiscoveryOptions.usage). */
  setUsageSignal(usage: Readonly<Record<string, number>> | undefined): void {
    this.usage = usage;
  }

  /**
   * Select top-k servers for a query.
   */
  select(query: string, topK = 3): string[] {
    // Auto-activation looks a bare tool name up after the exact tool-index lookup missed; it keeps
    // the keyword/word-count order (ties in configuration order) rather than BM25 field weighting.
    return this.rank(query, { strategy: "lexical" })
      .slice(0, topK)
      .map((r) => r.name);
  }

  /** Tools learned for a server (names, descriptions, compact signatures); [] when unknown or stale. */
  indexedTools(name: string): IndexedTool[] {
    const config = this.servers[name];
    return config ? this.toolIndex?.get(name, config) ?? [] : [];
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
