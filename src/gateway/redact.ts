// src/gateway/redact.ts
// Keeps credential values out of tool results, errors and logs.

const MIN_SECRET_LENGTH = 6; // shorter values would shred ordinary text
/** Cap registered secrets so long-lived sessions cannot grow without bound. */
export const MAX_REDACT_SECRETS = 1000;

export class Redactor {
  /** Insertion-ordered map used as an LRU (delete + set = touch). */
  private values = new Map<string, true>();

  add(values: Iterable<string | undefined>): void {
    for (const v of values) {
      if (!v || v.length < MIN_SECRET_LENGTH) continue;
      if (this.values.has(v)) this.values.delete(v);
      this.values.set(v, true);
      while (this.values.size > MAX_REDACT_SECRETS) {
        const oldest = this.values.keys().next().value;
        if (oldest === undefined) break;
        this.values.delete(oldest);
      }
    }
  }

  /** Number of registered secret values (for tests). */
  get size(): number {
    return this.values.size;
  }

  text(input: string): string {
    let out = input;
    // Longest first so a secret that contains another is replaced whole.
    for (const v of [...this.values.keys()].sort((a, b) => b.length - a.length)) {
      if (out.includes(v)) out = out.split(v).join("[redacted]");
    }
    return out;
  }

  /** Deep-redact strings in an MCP tool result (content, structuredContent, _meta, resources). */
  result<T>(result: T): T {
    if (this.values.size === 0) return result;
    return this.walk(result) as T;
  }

  private walk(value: unknown): unknown {
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value)) return value.map((v) => this.walk(v));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.walk(v);
      }
      return out;
    }
    return value;
  }
}
