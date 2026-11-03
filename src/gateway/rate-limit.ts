// src/gateway/rate-limit.ts
// Tiny in-memory per-key failed-authentication limiter (sliding window). Keyed by client IP.

export class AuthFailureLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly maxFailures = 20,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now
  ) {}

  private prune(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    // Bound memory: drop everything if an attacker sprays many addresses.
    if (this.hits.size > 10_000) this.hits.clear();
    return list;
  }

  /** Seconds the caller must wait, or 0 when allowed. */
  retryAfterSec(key: string): number {
    const list = this.prune(key);
    if (list.length < this.maxFailures) return 0;
    return Math.max(1, Math.ceil((list[0] + this.windowMs - this.now()) / 1000));
  }

  fail(key: string): void {
    const list = this.prune(key);
    list.push(this.now());
    this.hits.set(key, list);
  }
}

export function clientKey(req: { socket?: { remoteAddress?: string } }): string {
  return req.socket?.remoteAddress ?? "unknown";
}
