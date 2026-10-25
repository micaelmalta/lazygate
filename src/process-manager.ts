// src/process-manager.ts
// Manages lifecycle of child MCP server processes (stdio) and HTTP MCP servers

import { createHash } from "crypto";
import { spawn, ChildProcess } from "child_process";
import { ServerConfig, OAuthConfig, effectiveAuthScope } from "./router.js";
import { getAccessToken } from "./oauth.js";
import { VERSION, LOG_PREFIX } from "./version.js";
import { buildChildEnv, resolveInheritEnv } from "./child-env.js";
import { assertStdioCommandAllowed } from "./stdio-policy.js";
import { assertSafeUrl, safeFetch } from "./ssrf.js";
import {
  bareToolName,
  exposedToolName,
  isToolsNamespaced,
  parseNamespacedTool,
} from "./tool-names.js";

/** Streamable HTTP MCP clients must advertise both JSON and SSE. */
const MCP_HTTP_ACCEPT = "application/json, text/event-stream";
/** Protocol revision we offer; servers answer with the revision they support. */
const PROTOCOL_VERSION = "2025-06-18";

/** Default per-call timeout for tools/call (override with `toolTimeoutMs`). */
export const DEFAULT_TOOL_TIMEOUT_MS = 5 * 60 * 1000;
/** Deactivate a server after this long without a tool call (0 disables). */
export const DEFAULT_IDLE_TTL_MS = 20 * 60 * 1000;
/** Soft cap on concurrently active servers; LRU-evict when exceeded (0 = unlimited). */
export const DEFAULT_MAX_ACTIVE_SERVERS = 8;
/** Soft cap on total tools across active servers; LRU-evict when exceeded (0 = unlimited). */
export const DEFAULT_MAX_ACTIVE_TOOLS = 64;
/** Sandbox wrappers may `docker build` on first launch before speaking MCP. */
const STDIO_HANDSHAKE_TIMEOUT_MS = 600_000;
const HTTP_HANDSHAKE_TIMEOUT_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class HttpStatusError extends Error {
  constructor(
    public readonly status: number,
    public readonly serverName: string,
    body: string
  ) {
    super(`HTTP ${status} from ${serverName}: ${body}`);
    this.name = "HttpStatusError";
  }
}

/** JSON-RPC error returned by a server; keeps `code` and `data`. */
export class McpRpcError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly data?: unknown
  ) {
    super(message);
    this.name = "McpRpcError";
  }
}

function toRpcError(e: { message?: string; code?: number; data?: unknown } | undefined): McpRpcError {
  return new McpRpcError(e?.message ?? "Unknown JSON-RPC error", e?.code, e?.data);
}

type JsonObject = Record<string, unknown>;

function parseSseBlock(block: string): unknown | undefined {
  const dataLines = block
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, ""));
  if (dataLines.length === 0) return undefined;
  const payload = dataLines.join("\n").trim();
  if (!payload || payload === "[DONE]") return undefined;
  try {
    return JSON.parse(payload);
  } catch {
    return undefined; // ignore non-JSON data
  }
}

function isResponseFor(msg: unknown, id: number | string | undefined): boolean {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as JsonObject;
  return !("method" in m) && id !== undefined && m.id === id;
}

async function readSseStream(res: Response, expectedId: number | string): Promise<unknown> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fallback: unknown;

  const consider = (block: string): unknown | undefined => {
    const msg = parseSseBlock(block);
    if (msg === undefined) return undefined;
    if (isResponseFor(msg, expectedId)) return msg;
    if (!(msg as JsonObject).method) fallback = msg;
    return undefined;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const hit = consider(block);
      if (hit !== undefined) {
        await reader.cancel().catch(() => undefined);
        return hit;
      }
    }
    if (done) break;
  }
  if (buffer.trim()) {
    const hit = consider(buffer);
    if (hit !== undefined) return hit;
  }
  return fallback ?? {};
}

/**
 * Parse application/json or text/event-stream MCP responses into a JSON-RPC object.
 * For SSE, the message whose `id` equals `expectedId` wins (streams are read
 * incrementally and closed as soon as it arrives); otherwise the last
 * non-request message is used.
 */
export async function readMcpHttpResponse(
  res: Response,
  expectedId?: number | string
): Promise<unknown> {
  const ct = res.headers.get("content-type") ?? "";

  if (
    ct.includes("text/event-stream") &&
    expectedId !== undefined &&
    res.body &&
    typeof res.body.getReader === "function"
  ) {
    return readSseStream(res, expectedId);
  }

  const text = await res.text();
  if (!text) return {};

  if (ct.includes("text/event-stream") || text.startsWith("event:") || text.includes("\ndata:")) {
    let fallback: unknown;
    for (const block of text.split(/\r?\n\r?\n/)) {
      const msg = parseSseBlock(block);
      if (msg === undefined) continue;
      if (isResponseFor(msg, expectedId)) return msg;
      if (!(msg as JsonObject).method) fallback = msg;
    }
    if (fallback !== undefined) return fallback;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON MCP HTTP response (${ct || "unknown content-type"})`);
  }
}

export interface ActiveServer {
  name: string;
  process: ChildProcess;
  /** Upstream (bare) tool names — use getAllActiveTools() for exposed names. */
  tools: MCPTool[];
  activatedAt: Date;
  /** Last activate or tools/call; used for idle TTL and LRU eviction. */
  lastUsedAt: number;
  /** Stable hash of stdio spawn inputs; if config changes, ProcessManager respawns. */
  spawnSig: string;
  toolTimeoutMs: number;
  /** When true, exposed names are `server__tool` (collision check uses those). */
  namespaced: boolean;
}

export interface ActiveHttpServer {
  name: string;
  url: string;
  headers: Record<string, string>;
  /** Upstream (bare) tool names — use getAllActiveTools() for exposed names. */
  tools: MCPTool[];
  activatedAt: Date;
  /** Last activate or tools/call; used for idle TTL and LRU eviction. */
  lastUsedAt: number;
  nextId: number;
  config: ServerConfig; // kept for token refresh on 401
  /** Resolved OAuth overrides (may be empty when fully auto-discovered). */
  oauth?: OAuthConfig;
  /** True when the user supplied an Authorization header; we never replace it. */
  staticAuth: boolean;
  /** Hash of the URL/headers/credentials this session was opened with. */
  sig: string;
  toolTimeoutMs: number;
  /** When true, exposed names are `server__tool` (collision check uses those). */
  namespaced: boolean;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverName: string; // track which server owns this tool
}

export interface ProcessManagerOptions {
  /** Called whenever the set of exposed tools changes (activate, deactivate, exit, refresh). */
  onToolsChanged?: () => void;
  /** Tool names that servers may not expose (e.g. the broker's own meta-tools). */
  reservedToolNames?: Iterable<string>;
  /** Called with a server's full tool list after activation and after every refresh. */
  onServerTools?: (serverName: string, tools: MCPTool[]) => void;
  /**
   * Gateway mode: the user this manager serves. OAuth tokens of servers with
   * `auth.scope: "user"` are stored per owner instead of per server.
   */
  owner?: string;
  /**
   * When false, OAuth never opens a browser (gateway: users connect via the UI /
   * connect_server). Default true so local stdio mode is unchanged.
   */
  oauthInteractive?: boolean;
  /**
   * Used when a server omits `inheritEnv`. Gateway mode passes `false` so children
   * do not see the gateway process environment by default. Stdio mode leaves this
   * unset (full inherit, with `LAZYGATE_*` still stripped).
   */
  defaultInheritEnv?: boolean | string[];
  /**
   * When non-empty, stdio `command` must be an exact match (see
   * `LAZYGATE_STDIO_ALLOWLIST` / GatewayOptions.stdioCommandAllowlist).
   */
  stdioCommandAllowlist?: readonly string[];
  /**
   * Deactivate a server after this many ms without a tool call.
   * Default {@link DEFAULT_IDLE_TTL_MS}; `0` disables the idle sweep.
   */
  idleTtlMs?: number;
  /**
   * Max concurrently active servers. Default {@link DEFAULT_MAX_ACTIVE_SERVERS};
   * `0` means unlimited. Excess servers are LRU-evicted after activate.
   */
  maxActiveServers?: number;
  /**
   * Max total tools across active servers. Default {@link DEFAULT_MAX_ACTIVE_TOOLS};
   * `0` means unlimited. Excess servers are LRU-evicted after activate.
   */
  maxActiveTools?: number;
  /**
   * Gateway: receive secret values (runtime credentials, resolved env/headers) so a
   * session redactor can scrub them from tool results and logs.
   */
  onSecrets?: (values: Iterable<string | undefined>) => void;
  /** Gateway: scrub a stderr / log line before writing it. */
  redactLog?: (line: string) => string;
  /**
   * Default for `namespaceTools` when a server omits the flag.
   * Per-server `namespaceTools: true|false` always wins. Default false.
   */
  namespaceTools?: boolean;
}

/**
 * Credentials resolved at runtime by the gateway (never read from servers.json).
 * Merged after `${VAR}` expansion and never re-expanded, so a credential value that happens
 * to contain `${…}` cannot pull in the gateway's own environment.
 */
export interface RuntimeCredentials {
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

function hashOf(values: Record<string, string>): string {
  const sorted = Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower && headers[k]);
}

export class ProcessManager {
  private active = new Map<string, ActiveServer>();
  private activeHttp = new Map<string, ActiveHttpServer>();
  /**
   * In-flight activations keyed by `name\0sig` so concurrent callers with the same
   * spawn/HTTP signature share one flow, while a credential change does not.
   */
  private activating = new Map<string, Promise<MCPTool[]>>();
  /** In-flight HTTP session re-inits (one per server name). */
  private httpReinit = new Map<string, Promise<void>>();
  /** Stdio children spawned but not yet in `active` (handshake still in flight). */
  private pendingStdio = new Map<string, ChildProcess>();
  // Keyed by child process so IDs are scoped per-child and never collide
  private pendingRequests = new Map<ChildProcess, Map<number, {
    resolve: (val: unknown) => void;
    reject: (err: Error) => void;
  }>>();
  // Per-child stdout buffers — avoids a new listener per sendRequest call
  private stdoutBuffers = new Map<ChildProcess, string>();
  // Per-child monotonic request counter
  private requestIds = new Map<ChildProcess, number>();
  /** Set by `dispose()`; in-flight activations must not call `active.set` afterwards. */
  private disposed = false;
  /** Periodic idle-TTL sweep; cleared by `dispose()`. */
  private idleTimer: ReturnType<typeof setInterval> | undefined;

  private readonly onToolsChanged?: () => void;
  private readonly onServerTools?: (serverName: string, tools: MCPTool[]) => void;
  private readonly onSecrets?: (values: Iterable<string | undefined>) => void;
  private readonly redactLog?: (line: string) => string;
  private readonly reserved: Set<string>;
  private readonly owner?: string;
  private readonly oauthInteractive: boolean;
  private readonly defaultInheritEnv?: boolean | string[];
  private readonly stdioCommandAllowlist?: readonly string[];
  private readonly idleTtlMs: number;
  private readonly maxActiveServers: number;
  private readonly maxActiveTools: number;
  private readonly namespaceToolsDefault: boolean;

  constructor(opts: ProcessManagerOptions = {}) {
    this.owner = opts.owner;
    this.oauthInteractive = opts.oauthInteractive !== false;
    this.onToolsChanged = opts.onToolsChanged;
    this.onServerTools = opts.onServerTools;
    this.onSecrets = opts.onSecrets;
    this.redactLog = opts.redactLog;
    this.reserved = new Set(opts.reservedToolNames ?? []);
    this.defaultInheritEnv = opts.defaultInheritEnv;
    this.stdioCommandAllowlist = opts.stdioCommandAllowlist;
    this.idleTtlMs = opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.maxActiveServers = opts.maxActiveServers ?? DEFAULT_MAX_ACTIVE_SERVERS;
    this.maxActiveTools = opts.maxActiveTools ?? DEFAULT_MAX_ACTIVE_TOOLS;
    this.namespaceToolsDefault = opts.namespaceTools === true;
    if (this.idleTtlMs > 0) {
      const every = Math.min(60_000, Math.max(1_000, this.idleTtlMs / 2));
      this.idleTimer = setInterval(() => this.sweepIdle(), every);
      this.idleTimer.unref?.();
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error("ProcessManager disposed");
  }

  private touch(name: string): void {
    const s = this.active.get(name) ?? this.activeHttp.get(name);
    if (s) s.lastUsedAt = Date.now();
  }

  private lastUsedAt(name: string): number {
    return this.active.get(name)?.lastUsedAt ?? this.activeHttp.get(name)?.lastUsedAt ?? 0;
  }

  /** Deactivate servers idle longer than `idleTtlMs`. */
  sweepIdle(): string[] {
    if (this.disposed || this.idleTtlMs <= 0) return [];
    const cutoff = Date.now() - this.idleTtlMs;
    const dropped: string[] = [];
    for (const name of this.listActive()) {
      if (this.lastUsedAt(name) < cutoff) {
        console.error(`${LOG_PREFIX} idle TTL: deactivating "${name}"`);
        this.deactivate(name);
        dropped.push(name);
      }
    }
    return dropped;
  }

  /**
   * Evict LRU servers until under `maxActiveServers` / `maxActiveTools`.
   * Never evicts `protect` (typically the server just activated).
   */
  private enforceBudgets(protect?: string): void {
    if (this.disposed) return;
    this.sweepIdle();

    const overBudget = (): boolean => {
      const n = this.listActive().length;
      const tools = this.getAllActiveTools().length;
      return (
        (this.maxActiveServers > 0 && n > this.maxActiveServers) ||
        (this.maxActiveTools > 0 && tools > this.maxActiveTools)
      );
    };

    while (overBudget()) {
      const victims = this.listActive()
        .filter((n) => n !== protect)
        .sort((a, b) => this.lastUsedAt(a) - this.lastUsedAt(b));
      if (victims.length === 0) break;
      const victim = victims[0]!;
      console.error(`${LOG_PREFIX} budget: evicting "${victim}" (LRU)`);
      this.deactivate(victim);
    }
  }

  private emitChanged(): void {
    try {
      this.onToolsChanged?.();
    } catch {
      /* listeners must never break lifecycle handling */
    }
  }

  private reportTools(name: string, tools: MCPTool[]): void {
    try {
      this.onServerTools?.(name, tools);
    } catch {
      /* indexing must never break lifecycle handling */
    }
  }

  private reportSecrets(...maps: Array<Record<string, string> | undefined>): void {
    if (!this.onSecrets) return;
    const values: string[] = [];
    for (const m of maps) {
      if (!m) continue;
      for (const v of Object.values(m)) if (v) values.push(v);
    }
    if (values.length === 0) return;
    try {
      this.onSecrets(values);
    } catch {
      /* redactor must never break lifecycle handling */
    }
  }

  private logLine(line: string): void {
    const text = this.redactLog ? this.redactLog(line) : line;
    console.error(text);
  }

  private effectiveInheritEnv(config: ServerConfig): boolean | string[] | undefined {
    return resolveInheritEnv(config.inheritEnv, this.defaultInheritEnv);
  }

  /** Inputs that determine the stdio child process; any change requires a new spawn. */
  private stdioSpawnSignature(config: ServerConfig, runtime?: RuntimeCredentials): string {
    return JSON.stringify({
      command: config.command ?? null,
      args: config.args ?? [],
      env: config.env ?? {},
      inheritEnv: this.effectiveInheritEnv(config) ?? null,
      // A changed credential means a fresh process (hashed so secrets never sit in a map key).
      runtimeEnv: runtime?.env ? hashOf(runtime.env) : null,
    });
  }

  /** Same for HTTP servers: a changed URL, header or credential means a fresh session. */
  private httpSignature(config: ServerConfig, runtime?: RuntimeCredentials): string {
    return JSON.stringify({
      url: config.url ?? null,
      headers: config.headers ?? {},
      runtimeHeaders: runtime?.headers ? hashOf(runtime.headers) : null,
    });
  }

  private activationKey(name: string, config: ServerConfig, runtime?: RuntimeCredentials): string {
    const sig =
      config.type === "http" || config.url
        ? this.httpSignature(config, runtime)
        : this.stdioSpawnSignature(config, runtime);
    return `${name}\0${sig}`;
  }

  activate(name: string, config: ServerConfig, runtime?: RuntimeCredentials): Promise<MCPTool[]> {
    if (this.disposed) {
      return Promise.reject(new Error("ProcessManager disposed"));
    }
    const key = this.activationKey(name, config, runtime);
    const inFlight = this.activating.get(key);
    if (inFlight) return inFlight;

    const p = this.doActivate(name, config, runtime).finally(() => {
      this.activating.delete(key);
    });
    this.activating.set(key, p);
    return p;
  }

  /**
   * Tear down every active server and abort in-flight activations.
   * After this, `activate` rejects and late handshake completions must not
   * register orphaned children (gateway session close / process shutdown).
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.activating.clear();
    this.httpReinit.clear();
    for (const name of this.listActive()) this.deactivate(name);
    const reason = new Error("ProcessManager disposed");
    for (const [, child] of this.pendingStdio) {
      this.disposeChild(child, reason);
    }
    this.pendingStdio.clear();
  }

  private async doActivate(
    name: string,
    config: ServerConfig,
    runtime?: RuntimeCredentials
  ): Promise<MCPTool[]> {
    this.assertNotDisposed();
    if (config.type === "http" || config.url) {
      const existing = this.activeHttp.get(name);
      const httpSig = this.httpSignature(config, runtime);
      if (existing) {
        if (existing.sig === httpSig) {
          this.touch(name);
          return this.exposeTools(name, existing.tools, existing.namespaced);
        }
        this.deactivate(name);
      }
      return this.activateHttp(name, config, runtime, httpSig);
    }

    const sig = this.stdioSpawnSignature(config, runtime);
    const existingStdio = this.active.get(name);
    if (existingStdio) {
      if (existingStdio.spawnSig === sig) {
        this.touch(name);
        return this.exposeTools(name, existingStdio.tools, existingStdio.namespaced);
      }
      this.deactivate(name);
    }
    if (this.activeHttp.has(name)) {
      const http = this.activeHttp.get(name)!;
      this.touch(name);
      return this.exposeTools(name, http.tools, http.namespaced);
    }

    if (!config.command) {
      throw new Error(`Server "${name}" has no command or url configured`);
    }
    assertStdioCommandAllowed(config.command, this.stdioCommandAllowlist);

    this.assertNotDisposed();
    this.logLine(`${LOG_PREFIX} Activating server: ${name}`);

    const env = { ...this.resolveEnv(config.env ?? {}, name), ...(runtime?.env ?? {}) };
    this.reportSecrets(config.env, env, runtime?.env);
    const child = spawn(config.command, config.args ?? [], {
      env: buildChildEnv(process.env, this.effectiveInheritEnv(config), env),
    }) as ChildProcess;

    this.stdoutBuffers.set(child, "");
    this.pendingRequests.set(child, new Map());
    this.requestIds.set(child, 1);
    this.pendingStdio.set(name, child);

    // Without these listeners a bad command (ENOENT) or a dead pipe (EPIPE)
    // would be an unhandled 'error' event and take down the whole broker.
    child.on("error", (err) => {
      this.rejectPending(child, new Error(`[${name}] failed to run "${config.command}": ${err.message}`));
    });
    child.stdin?.on("error", (err) => {
      this.rejectPending(child, new Error(`[${name}] stdin error: ${err.message}`));
    });

    child.stderr?.on("data", (data) => {
      this.logLine(`[${name}] ${data.toString().trim()}`);
    });

    child.stdout?.on("data", (chunk) => {
      const buf = (this.stdoutBuffers.get(child) ?? "") + chunk.toString();
      const lines = buf.split("\n");
      this.stdoutBuffers.set(child, lines.pop() ?? "");

      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: JsonObject;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // non-JSON line
        }
        this.handleChildMessage(name, child, msg);
      }
    });

    // Reject all pending requests if the child exits unexpectedly
    child.on("exit", (code) => {
      this.rejectPending(child, new Error(`[${name}] process exited with code ${code}`));
      // Remove from active map if it died on its own
      if (this.active.get(name)?.process === child) {
        this.active.delete(name);
        this.forgetChild(child);
        console.error(`${LOG_PREFIX} ${name} exited (code ${code})`);
        this.emitChanged();
      }
    });

    const namespaced = this.namespacedFor(config);
    let tools: MCPTool[];
    try {
      await this.handshake(child, { timeoutMs: STDIO_HANDSHAKE_TIMEOUT_MS });
      this.assertNotDisposed();
      tools = await this.listToolsStdio(child, name, STDIO_HANDSHAKE_TIMEOUT_MS);
      this.assertNotDisposed();
      this.assertNoToolCollisions(name, tools, namespaced);
    } catch (err) {
      // Never leak a half-initialised child.
      this.disposeChild(child, err as Error);
      throw err;
    } finally {
      this.pendingStdio.delete(name);
    }

    this.assertNotDisposed();
    // Another activation of this name may have finished while we were handshaking.
    const raced = this.active.get(name);
    if (raced) {
      if (raced.spawnSig === sig) {
        this.disposeChild(child, new Error(`Server "${name}" already active`));
        this.touch(name);
        return this.exposeTools(name, raced.tools, raced.namespaced);
      }
      this.deactivate(name);
    }
    if (this.activeHttp.has(name)) this.deactivate(name);

    this.active.set(name, {
      name,
      process: child,
      tools,
      activatedAt: new Date(),
      lastUsedAt: Date.now(),
      spawnSig: sig,
      toolTimeoutMs: config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
      namespaced,
    });
    this.enforceBudgets(name);

    console.error(`${LOG_PREFIX} ${name} activated with ${tools.length} tools`);
    this.reportTools(name, tools);
    this.emitChanged();
    return this.exposeTools(name, tools, namespaced);
  }

  // ── stdio message handling ───────────────────────────────────────────────

  private handleChildMessage(name: string, child: ChildProcess, msg: JsonObject): void {
    // Anything with a `method` is server → client traffic, never a response —
    // even if its id happens to collide with one of our pending request ids.
    if (typeof msg.method === "string") {
      const hasId = msg.id !== undefined && msg.id !== null;
      if (hasId) {
        const reply = msg.method === "ping"
          ? { jsonrpc: "2.0", id: msg.id, result: {} }
          : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
        this.writeLine(child, reply);
      } else if (msg.method === "notifications/tools/list_changed") {
        void this.refreshStdioTools(name, child);
      }
      return;
    }

    const id = msg.id as number;
    const pending = this.pendingRequests.get(child)?.get(id);
    if (!pending) return;
    this.pendingRequests.get(child)!.delete(id);
    if (msg.error) {
      pending.reject(toRpcError(msg.error as { message?: string; code?: number; data?: unknown }));
    } else {
      pending.resolve(msg.result);
    }
  }

  private async refreshStdioTools(name: string, child: ChildProcess): Promise<void> {
    if (this.active.get(name)?.process !== child) return;
    try {
      const tools = await this.listToolsStdio(child, name, DEFAULT_REQUEST_TIMEOUT_MS * 3);
      const current = this.active.get(name);
      if (current && current.process === child) {
        current.tools = tools;
        this.reportTools(name, tools);
        this.emitChanged();
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} ${name}: tools/list refresh failed: ${(err as Error).message}`);
    }
  }

  private writeLine(child: ChildProcess, payload: unknown): void {
    try {
      child.stdin?.write(JSON.stringify(payload) + "\n");
    } catch {
      /* the 'error' listener on stdin handles dead pipes */
    }
  }

  private rejectPending(child: ChildProcess, err: Error): void {
    const pending = this.pendingRequests.get(child);
    if (!pending || pending.size === 0) return;
    for (const { reject } of Array.from(pending.values())) reject(err);
    pending.clear();
  }

  private forgetChild(child: ChildProcess): void {
    this.stdoutBuffers.delete(child);
    this.pendingRequests.delete(child);
    this.requestIds.delete(child);
  }

  /** Reject outstanding requests, drop bookkeeping, and kill the process. */
  private disposeChild(child: ChildProcess, reason: Error): void {
    this.rejectPending(child, reason);
    this.forgetChild(child);
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }

  private namespacedFor(config: ServerConfig): boolean {
    return isToolsNamespaced(config, this.namespaceToolsDefault);
  }

  /** Map upstream (bare) tools to the names clients see. */
  private exposeTools(serverName: string, tools: MCPTool[], namespaced: boolean): MCPTool[] {
    if (!namespaced) return tools.map((t) => ({ ...t, serverName }));
    return tools.map((t) => ({
      ...t,
      serverName,
      name: exposedToolName(serverName, t.name, true),
    }));
  }

  /**
   * Collision check uses exposed names (`server__tool` when namespaced).
   * Namespaced servers therefore coexist with identical upstream tool names
   * (and with reserved meta-tool bare names).
   */
  private assertNoToolCollisions(name: string, tools: MCPTool[], namespaced: boolean): void {
    const owners = new Map<string, string>();
    for (const [other, s] of this.active) {
      if (other === name) continue;
      for (const t of s.tools) owners.set(exposedToolName(other, t.name, s.namespaced), other);
    }
    for (const [other, s] of this.activeHttp) {
      if (other === name) continue;
      for (const t of s.tools) owners.set(exposedToolName(other, t.name, s.namespaced), other);
    }

    const clashes: string[] = [];
    for (const t of tools) {
      const exposed = exposedToolName(name, t.name, namespaced);
      if (this.reserved.has(exposed)) clashes.push(`${exposed} (reserved broker tool)`);
      else if (owners.has(exposed)) {
        clashes.push(`${exposed} (provided by "${owners.get(exposed)}")`);
      }
    }
    if (clashes.length > 0) {
      throw new Error(
        `Cannot activate "${name}": tool name collision — ${clashes.join(", ")}. ` +
          `Deactivate the other server first` +
          (namespaced ? "." : `, or set namespaceTools: true.`)
      );
    }
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────

  private normalizeOAuthConfig(oauth: ServerConfig["oauth"]): OAuthConfig | undefined {
    if (oauth === undefined || oauth === false) return undefined;
    if (oauth === true) return {};
    return oauth;
  }

  private noteSecrets(...values: Array<string | undefined>): void {
    if (!this.onSecrets) return;
    this.onSecrets(values);
  }

  private async attachOAuth(
    name: string,
    url: string,
    headers: Record<string, string>,
    oauth: OAuthConfig | undefined,
    force: boolean,
    config: ServerConfig
  ): Promise<OAuthConfig> {
    const resolved = oauth ?? {};
    const owner = effectiveAuthScope(config) === "user" ? this.owner : undefined;
    // Gateway sessions have an owner: never open a browser on the gateway host — the user
    // connects through the UI / connect_server instead.
    const token = await getAccessToken(name, url, resolved, {
      force,
      owner,
      interactive: this.oauthInteractive,
    });
    this.noteSecrets(token);
    headers["Authorization"] = `Bearer ${token}`;
    return resolved;
  }

  private async activateHttp(
    name: string,
    config: ServerConfig,
    runtime: RuntimeCredentials | undefined,
    sig: string
  ): Promise<MCPTool[]> {
    const url = config.url!;
    const resolvedEnv = this.resolveEnv(config.env ?? {}, name);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: MCP_HTTP_ACCEPT,
    };

    // Resolve ${VAR} in explicit headers
    for (const [k, v] of Object.entries(config.headers ?? {})) {
      headers[k] = this.expandVars(v, name, resolvedEnv);
    }
    // Gateway credentials go in last and are never re-expanded.
    Object.assign(headers, runtime?.headers ?? {});
    this.reportSecrets(config.headers, headers, runtime?.headers, resolvedEnv);

    const staticAuth = hasHeader(headers, "authorization");
    const oauthAllowed = config.oauth !== false && !staticAuth;
    let oauth = this.normalizeOAuthConfig(config.oauth);

    // Explicit `oauth` config → authenticate up front. Otherwise only on a 401.
    if (oauthAllowed && oauth !== undefined) {
      oauth = await this.attachOAuth(name, url, headers, oauth, false, config);
      this.assertNotDisposed();
    }

    let tools: MCPTool[];
    try {
      tools = await this.fetchToolsHttp(url, headers, name);
      this.assertNotDisposed();
    } catch (err) {
      if (err instanceof HttpStatusError && err.status === 401 && oauthAllowed) {
        console.error(`${LOG_PREFIX} ${name} returned 401 on activate — starting OAuth`);
        oauth = await this.attachOAuth(name, url, headers, oauth, true, config);
        this.assertNotDisposed();
        tools = await this.fetchToolsHttp(url, headers, name);
        this.assertNotDisposed();
      } else {
        throw err;
      }
    }

    const namespaced = this.namespacedFor(config);
    this.assertNoToolCollisions(name, tools, namespaced);
    this.assertNotDisposed();

    const raced = this.activeHttp.get(name);
    if (raced) {
      if (raced.sig === sig) {
        this.touch(name);
        return this.exposeTools(name, raced.tools, raced.namespaced);
      }
      this.deactivate(name);
    }
    if (this.active.has(name)) this.deactivate(name);

    this.activeHttp.set(name, {
      name,
      url,
      headers,
      tools,
      config,
      oauth,
      staticAuth,
      sig,
      activatedAt: new Date(),
      lastUsedAt: Date.now(),
      nextId: 1,
      toolTimeoutMs: config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
      namespaced,
    });
    this.enforceBudgets(name);

    console.error(`${LOG_PREFIX} ${name} (http) activated with ${tools.length} tools`);
    this.reportTools(name, tools);
    this.emitChanged();
    return this.exposeTools(name, tools, namespaced);
  }

  /**
   * Re-handshake an HTTP session after a 404 (expired session id).
   * Dedupes concurrent callers, uses a fresh headers object so in-flight requests
   * keep their snapshot, then runs the same collision / notify steps as activate.
   */
  private reinitHttpSession(server: ActiveHttpServer): Promise<void> {
    const existing = this.httpReinit.get(server.name);
    if (existing) return existing;

    const p = (async () => {
      this.assertNotDisposed();
      // Copy headers without the stale session — do not mutate the shared object
      // while other calls may still be using it.
      const headers: Record<string, string> = { ...server.headers };
      delete headers["mcp-session-id"];
      delete headers["MCP-Protocol-Version"];

      const tools = await this.fetchToolsHttp(server.url, headers, server.name);
      this.assertNotDisposed();

      const current = this.activeHttp.get(server.name);
      if (!current || current !== server) return; // deactivated or replaced

      this.assertNoToolCollisions(server.name, tools, current.namespaced);
      current.headers = headers;
      current.tools = tools;
      current.lastUsedAt = Date.now();
      this.reportTools(server.name, tools);
      this.emitChanged();
    })().finally(() => {
      this.httpReinit.delete(server.name);
    });

    this.httpReinit.set(server.name, p);
    return p;
  }

  private async httpFetch(
    serverName: string,
    url: string,
    init: RequestInit,
    timeoutMs: number
  ): Promise<Response> {
    try {
      // Prefer https for non-loopback; never auto-follow redirects (SSRF via Location).
      const target = new URL(url);
      if (target.protocol === "http:" && !["localhost", "127.0.0.1", "::1"].includes(target.hostname)) {
        console.error(`${LOG_PREFIX} warning: ${serverName} uses non-HTTPS URL ${target.origin}`);
      }
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        await assertSafeUrl(url);
        return await safeFetch(url, { ...init, signal });
      } catch (err) {
        // Admin-configured MCP hosts may be on a private network — allow the configured URL only.
        // Redirects are never followed (redirect: "manual"), so Location cannot pivot to metadata IPs.
        if ((err as Error).name === "UnsafeUrlError" && /private\/link-local/i.test((err as Error).message)) {
          return fetch(url, { ...init, redirect: "manual", signal });
        }
        throw err;
      }
    } catch (err) {
      const e = err as Error;
      if (e?.name === "TimeoutError" || e?.name === "AbortError") {
        throw new Error(`HTTP request to ${serverName} timed out after ${timeoutMs}ms`);
      }
      throw err;
    }
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ content: unknown[] }> {
    // Clients may pass the exposed `server__tool` name; upstream always wants the bare name.
    const upstream = bareToolName(serverName, toolName);

    const httpServer = this.activeHttp.get(serverName);
    if (httpServer) {
      this.touch(serverName);
      return this.callToolHttp(httpServer, upstream, args);
    }

    const server = this.active.get(serverName);
    if (!server) throw new Error(`Server ${serverName} is not active`);

    this.touch(serverName);
    const child = server.process;
    const id = this.nextId(child);
    return this.sendRequest(
      child,
      {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: upstream, arguments: args },
      },
      server.toolTimeoutMs
    ) as Promise<{ content: unknown[] }>;
  }

  private async callToolHttp(
    server: ActiveHttpServer,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ content: unknown[] }> {
    const id = server.nextId++;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    });
    const send = () =>
      this.httpFetch(
        server.name,
        server.url,
        { method: "POST", headers: server.headers, body },
        server.toolTimeoutMs
      );

    let res = await send();

    // 401: force a fresh token (never replay the rejected one), retry once.
    // A user-supplied static Authorization header is never replaced.
    if (res.status === 401 && server.config.oauth !== false && !server.staticAuth) {
      console.error(`${LOG_PREFIX} ${server.name} returned 401 — refreshing OAuth token`);
      server.oauth = await this.attachOAuth(
        server.name,
        server.url,
        server.headers,
        server.oauth ?? this.normalizeOAuthConfig(server.config.oauth),
        true,
        server.config
      );
      res = await send();
    }

    // 404 with a session id means the session expired: re-initialize, retry once.
    if (res.status === 404 && server.headers["mcp-session-id"]) {
      console.error(`${LOG_PREFIX} ${server.name} session expired — re-initializing`);
      await this.reinitHttpSession(server);
      // Session object may have been replaced; use the live entry for the retry.
      const live = this.activeHttp.get(server.name) ?? server;
      res = await this.httpFetch(
        live.name,
        live.url,
        {
          method: "POST",
          headers: live.headers,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name: toolName, arguments: args },
          }),
        },
        live.toolTimeoutMs
      );
    }

    if (!res.ok) {
      throw new HttpStatusError(res.status, server.name, await res.text());
    }

    const data = (await readMcpHttpResponse(res, id)) as {
      result?: { content: unknown[] };
      error?: { message: string; code?: number; data?: unknown };
    };
    if (data.error) throw toRpcError(data.error);
    return data.result ?? { content: [] };
  }

  deactivate(name: string): boolean {
    const http = this.activeHttp.get(name);
    if (http) {
      this.activeHttp.delete(name);
      const sessionId = http.headers["mcp-session-id"];
      if (sessionId) {
        // Best-effort session termination (spec: DELETE with the session id).
        void Promise.resolve()
          .then(() => fetch(http.url, { method: "DELETE", headers: { ...http.headers }, signal: AbortSignal.timeout(5000) }))
          .catch(() => undefined);
      }
      console.error(`${LOG_PREFIX} Deactivated server: ${name}`);
      this.emitChanged();
      return true;
    }

    const server = this.active.get(name);
    if (!server) return false;

    // Remove first so the child's 'exit' handler doesn't treat this as a crash.
    this.active.delete(name);
    this.disposeChild(server.process, new Error(`Server "${name}" was deactivated`));
    console.error(`${LOG_PREFIX} Deactivated server: ${name}`);
    this.emitChanged();
    return true;
  }

  listActive(): string[] {
    return [
      ...Array.from(this.active.keys()),
      ...Array.from(this.activeHttp.keys()),
    ];
  }

  getAllActiveTools(): MCPTool[] {
    return [
      ...Array.from(this.active.entries()).flatMap(([name, s]) =>
        this.exposeTools(name, s.tools, s.namespaced)
      ),
      ...Array.from(this.activeHttp.entries()).flatMap(([name, s]) =>
        this.exposeTools(name, s.tools, s.namespaced)
      ),
    ];
  }

  findServerForTool(toolName: string): string | undefined {
    const parsed = parseNamespacedTool(toolName);
    if (parsed) {
      const s = this.active.get(parsed.server) ?? this.activeHttp.get(parsed.server);
      if (s?.tools.some((t) => t.name === parsed.tool)) return parsed.server;
    }
    const match = (name: string, server: { tools: MCPTool[]; namespaced: boolean }): boolean => {
      if (server.namespaced) {
        // Only the exposed `server__tool` form — bare names are ambiguous across servers.
        return server.tools.some((t) => exposedToolName(name, t.name, true) === toolName);
      }
      return server.tools.some((t) => t.name === toolName);
    };
    for (const [name, server] of this.active.entries()) {
      if (match(name, server)) return name;
    }
    for (const [name, server] of this.activeHttp.entries()) {
      if (match(name, server)) return name;
    }
    return undefined;
  }

  private nextId(child: ChildProcess): number {
    const id = this.requestIds.get(child) ?? 1;
    this.requestIds.set(child, id + 1);
    return id;
  }

  /** Replace ${VAR} from the process env (or the server's own env), warning on gaps. */
  private expandVars(
    value: string,
    serverName: string,
    fallback: Record<string, string> = {}
  ): string {
    return value.replace(/\$\{(\w+)\}/g, (_, varName: string) => {
      const v = process.env[varName] ?? fallback[varName];
      if (v === undefined) {
        console.error(
          `${LOG_PREFIX} warning: ${serverName} references \${${varName}} but it is not set in the environment`
        );
        return "";
      }
      this.noteSecrets(v);
      return v;
    });
  }

  private resolveEnv(env: Record<string, string>, serverName: string): Record<string, string> {
    const resolved: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      resolved[k] = this.expandVars(v, serverName);
    }
    return resolved;
  }

  private async fetchToolsHttp(
    url: string,
    headers: Record<string, string>,
    serverName: string
  ): Promise<MCPTool[]> {
    // Fresh handshake → drop any previous session / negotiated version.
    delete headers["mcp-session-id"];
    delete headers["MCP-Protocol-Version"];

    const initBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "lazygate", version: VERSION },
      },
    });

    const post = (body: string) =>
      this.httpFetch(serverName, url, { method: "POST", headers, body }, HTTP_HANDSHAKE_TIMEOUT_MS);

    const initRes = await post(initBody);
    if (!initRes.ok) {
      throw new HttpStatusError(initRes.status, serverName, await initRes.text());
    }

    // Persist session ID for all subsequent requests (required by some servers e.g. Datadog)
    const sessionId = initRes.headers?.get("mcp-session-id");
    if (sessionId) headers["mcp-session-id"] = sessionId;

    const initMsg = (await readMcpHttpResponse(initRes, 1).catch(() => undefined)) as
      | { result?: { protocolVersion?: string }; error?: { message: string; code?: number; data?: unknown } }
      | undefined;
    if (initMsg?.error) throw toRpcError(initMsg.error);

    // Required on every request after initialize (spec 2025-06-18+).
    headers["MCP-Protocol-Version"] = initMsg?.result?.protocolVersion ?? PROTOCOL_VERSION;

    // Send initialized notification (some servers won't respond to tools/list without it)
    const notifBody = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    try {
      const notifRes = await post(notifBody);
      await notifRes?.body?.cancel?.().catch?.(() => undefined);
    } catch {
      /* best-effort */
    }

    type ToolsListResult = {
      tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
      nextCursor?: string;
    };

    const allTools: ToolsListResult["tools"] = [];
    let cursor: string | undefined;
    let reqId = 2;

    do {
      const id = reqId++;
      const listRes = await post(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/list",
          params: cursor ? { cursor } : {},
        })
      );
      if (!listRes.ok) {
        throw new HttpStatusError(listRes.status, serverName, await listRes.text());
      }

      const data = (await readMcpHttpResponse(listRes, id)) as {
        result?: ToolsListResult;
        error?: { message: string; code?: number; data?: unknown };
      };
      if (data.error) throw toRpcError(data.error);

      allTools.push(...(data.result?.tools ?? []));
      cursor = data.result?.nextCursor;
    } while (cursor);

    return allTools.map((t) => ({ ...t, serverName }));
  }

  private async handshake(child: ChildProcess, opts: { timeoutMs: number }): Promise<void> {
    await this.sendRequest(
      child,
      {
        jsonrpc: "2.0",
        id: this.nextId(child),
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "lazygate", version: VERSION },
        },
      },
      opts.timeoutMs
    );

    // Required notification — some servers won't respond to tools/list without it
    this.writeLine(child, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
  }

  /** tools/list, following nextCursor for paginated servers. */
  private async listToolsStdio(
    child: ChildProcess,
    serverName: string,
    timeoutMs: number
  ): Promise<MCPTool[]> {
    type ToolsListResult = {
      tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
      nextCursor?: string;
    };

    const allTools: ToolsListResult["tools"] = [];
    let cursor: string | undefined;

    do {
      const result = (await this.sendRequest(
        child,
        {
          jsonrpc: "2.0",
          id: this.nextId(child),
          method: "tools/list",
          params: cursor ? { cursor } : {},
        },
        timeoutMs
      )) as ToolsListResult;

      allTools.push(...(result.tools ?? []));
      cursor = result.nextCursor;
    } while (cursor);

    return allTools.map((t) => ({ ...t, serverName }));
  }

  private sendRequest(
    child: ChildProcess,
    request: Record<string, unknown>,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = request.id as number;
      const childPending = this.pendingRequests.get(child);
      if (!childPending) {
        reject(new Error(`No pending map for child process (already deactivated?)`));
        return;
      }

      const timer = setTimeout(() => {
        if (childPending.delete(id)) {
          const reason = `Request timed out after ${timeoutMs}ms`;
          this.writeLine(child, {
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: id, reason },
          });
          reject(new Error(`Request ${id} (${String(request.method)}) timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      timer.unref();

      childPending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });

      this.writeLine(child, request);
    });
  }
}
