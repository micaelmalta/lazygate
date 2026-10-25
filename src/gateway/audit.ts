// src/gateway/audit.ts
// Append-only JSON-lines audit log. Records who called what — never arguments, results, or secret values.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
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

export class AuditLog {
  constructor(private readonly path: string | null) {
    if (path) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }

  /** Most recent events first; optionally only one user's. Reads the whole file — fine for a POC. */
  tail(limit: number, user?: string): Array<AuditEvent & { ts: string }> {
    if (!this.path || !existsSync(this.path)) return [];
    const out: Array<AuditEvent & { ts: string }> = [];
    const lines = readFileSync(this.path, "utf-8").split("\n");
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
