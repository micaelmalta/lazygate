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
