// src/gateway/audit.ts
// Append-only JSON-lines audit log. Records who called what — never arguments, results, or secret values.

import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from "fs";
import { createHash } from "crypto";
import { dirname } from "path";

export interface AuditEvent {
  user: string;
  session?: string;
  /** Tool name as called by the client (meta-tool or proxied tool). */
  tool?: string;
  server?: string;
  ok?: boolean;
  ms?: number;
  /** Short reason for failures (never contains credential values). */
  error?: string;
  /** How the call was reached: "run_chain" for tool calls made from a tool-chain script. */
  via?: string;
  /** Peer address for security events (auth failures, denials). */
  ip?: string;
  /** Admin UI/API mutation (e.g. token.create, secret.set, server.patch). */
  action?: string;
  /** Resource id (token id, secret path, server/skill name). */
  target?: string;
  /** SHA-256 prefix of a sanitized before snapshot (no secret values). */
  beforeHash?: string;
  /** SHA-256 prefix of a sanitized after snapshot (no secret values). */
  afterHash?: string;
  /** Estimated tokens before response optimization (approx; never secret values). */
  originalTokens?: number;
  /** Estimated tokens delivered to the client after optimization. */
  optimizedTokens?: number;
  /** originalTokens − optimizedTokens (0 when optimization did not shrink the payload). */
  savedTokens?: number;
}

export type AuditedEvent = AuditEvent & { ts: string };

export interface UsageBucket {
  key: string;
  calls: number;
  ok: number;
  error: number;
  originalTokens: number;
  optimizedTokens: number;
  savedTokens: number;
}

export interface UsageSummary {
  /** Events included in the summary (MCP tool traffic only). */
  calls: number;
  ok: number;
  error: number;
  originalTokens: number;
  optimizedTokens: number;
  savedTokens: number;
  reductionPercent: number;
  from: string | null;
  to: string | null;
  byServer: UsageBucket[];
  byTool: UsageBucket[];
  byUser: UsageBucket[];
}

/** True for MCP session tool traffic (excludes UI admin mutations and auth noise). */
export function isUsageEvent(e: AuditEvent): boolean {
  if (!e.tool || !e.session) return false;
  if (e.session === "ui" || e.session === "mcp") return false;
  return true;
}

function bump(
  map: Map<string, UsageBucket>,
  key: string,
  e: AuditEvent
): void {
  let b = map.get(key);
  if (!b) {
    b = { key, calls: 0, ok: 0, error: 0, originalTokens: 0, optimizedTokens: 0, savedTokens: 0 };
    map.set(key, b);
  }
  b.calls += 1;
  if (e.ok === false) b.error += 1;
  else b.ok += 1;
  b.originalTokens += e.originalTokens ?? 0;
  b.optimizedTokens += e.optimizedTokens ?? 0;
  b.savedTokens += e.savedTokens ?? 0;
}

function ranked(map: Map<string, UsageBucket>, limit: number): UsageBucket[] {
  return [...map.values()]
    .sort((a, b) => b.calls - a.calls || b.savedTokens - a.savedTokens || a.key.localeCompare(b.key))
    .slice(0, limit);
}

/** Aggregate MCP tool-call audit rows into dashboard totals. */
export function summarizeUsage(events: AuditedEvent[], top = 10): UsageSummary {
  const usage = events.filter(isUsageEvent);
  let ok = 0;
  let error = 0;
  let originalTokens = 0;
  let optimizedTokens = 0;
  let savedTokens = 0;
  const byServer = new Map<string, UsageBucket>();
  const byTool = new Map<string, UsageBucket>();
  const byUser = new Map<string, UsageBucket>();
  let from: string | null = null;
  let to: string | null = null;

  for (const e of usage) {
    if (e.ok === false) error += 1;
    else ok += 1;
    originalTokens += e.originalTokens ?? 0;
    optimizedTokens += e.optimizedTokens ?? 0;
    savedTokens += e.savedTokens ?? 0;
    if (e.server) bump(byServer, e.server, e);
    const toolKey = e.server && e.target ? `${e.server}/${e.target}` : e.tool || "(unknown)";
    bump(byTool, toolKey, e);
    bump(byUser, e.user, e);
    // events are newest-first from tail()
    if (!to) to = e.ts;
    from = e.ts;
  }

  return {
    calls: usage.length,
    ok,
    error,
    originalTokens,
    optimizedTokens,
    savedTokens,
    reductionPercent: originalTokens ? Math.round((savedTokens / originalTokens) * 100) : 0,
    from,
    to,
    byServer: ranked(byServer, top),
    byTool: ranked(byTool, top),
    byUser: ranked(byUser, top),
  };
}

/** Short content hash for before/after snapshots — never pass raw secrets into this. */
export function auditHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex").slice(0, 16);
}

/** `tail` never reads more than this many bytes from the end of the log. */
export const TAIL_BYTES = 1024 * 1024;

export class AuditLog {
  constructor(private readonly path: string | null) {
    if (path) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }

  /** Most recent events first; optionally only one user's. Reads at most the last TAIL_BYTES of the file. */
  tail(limit: number, user?: string): Array<AuditEvent & { ts: string }> {
    if (!this.path || !existsSync(this.path)) return [];
    const out: Array<AuditEvent & { ts: string }> = [];
    let text: string;
    let truncated = false;
    const fd = openSync(this.path, "r");
    try {
      const size = fstatSync(fd).size;
      const len = Math.min(size, TAIL_BYTES);
      const buf = Buffer.alloc(len);
      let read = 0;
      while (read < len) {
        const n = readSync(fd, buf, read, len - read, size - len + read);
        if (n <= 0) break;
        read += n;
      }
      truncated = size > len;
      text = buf.subarray(0, read).toString("utf-8");
    } finally {
      closeSync(fd);
    }
    const lines = text.split("\n");
    // When we started mid-file the first line is probably partial.
    if (truncated) lines.shift();
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      if (!lines[i]) continue;
      try {
        const e = JSON.parse(lines[i]) as AuditEvent & { ts: string };
        if (!user || e.user === user) out.push(e);
      } catch {
        /* skip a torn line */
      }
    }
    return out;
  }

  record(e: AuditEvent): void {
    if (!this.path) return;
    try {
      appendFileSync(this.path, JSON.stringify({ ts: new Date().toISOString(), ...e }) + "\n", { mode: 0o600 });
    } catch (err) {
      console.error(`[lazygate] audit write failed: ${(err as Error).message}`);
    }
  }

  /**
   * Record a security-relevant event (failed auth, denial, session mismatch, session start).
   * `ip` is the peer address; never pass token values.
   */
  recordSecurity(opts: {
    user?: string;
    action: string;
    surface: "mcp" | "ui";
    ip?: string;
    ok: boolean;
    session?: string;
    target?: string;
    error?: string;
  }): void {
    this.record({
      user: opts.user ?? "-",
      session: opts.session ?? opts.surface,
      tool: opts.action,
      action: opts.action,
      target: opts.target,
      ip: opts.ip,
      ok: opts.ok,
      ms: 0,
      error: opts.error,
    });
  }

  /**
   * Record a successful admin mutation from the web UI/API.
   * Pass sanitized snapshots only (names, flags, templates) — never secret or token values.
   */
  recordAdmin(opts: {
    user: string;
    action: string;
    target?: string;
    before?: unknown;
    after?: unknown;
  }): void {
    this.record({
      user: opts.user,
      session: "ui",
      tool: opts.action,
      action: opts.action,
      target: opts.target,
      beforeHash: opts.before !== undefined ? auditHash(opts.before) : undefined,
      afterHash: opts.after !== undefined ? auditHash(opts.after) : undefined,
      ok: true,
      ms: 0,
    });
  }
}
