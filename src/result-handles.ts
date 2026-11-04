import { randomBytes } from "crypto";

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 1024 * 1024;
const UNSAFE_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const MISSING = Symbol("missing result field");

export interface ResultHandleStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  maxEntryBytes?: number;
  now?: () => number;
}

export interface CreatedResultHandle {
  handle: string;
  expiresAt: number;
}

interface StoredResult {
  json: string;
  bytes: number;
  expiresAt: number;
}

/**
 * In-memory, per-broker cache for structured tool results. Handles are random, expire, and are
 * never shared between ResultHandleStore instances. Values are retained as JSON strings so the
 * byte cap tracks the stored representation and callers cannot mutate cached objects by reference.
 */
export class ResultHandleStore {
  private readonly entries = new Map<string, StoredResult>();
  private bytes = 0;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxEntryBytes: number;
  private readonly now: () => number;

  constructor(options: ResultHandleStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.ttlMs) || this.ttlMs <= 0) throw new RangeError("ttlMs must be a positive integer");
    if (!Number.isInteger(this.maxEntries) || this.maxEntries <= 0) throw new RangeError("maxEntries must be a positive integer");
    if (!Number.isInteger(this.maxBytes) || this.maxBytes <= 0) throw new RangeError("maxBytes must be a positive integer");
    if (!Number.isInteger(this.maxEntryBytes) || this.maxEntryBytes <= 0) {
      throw new RangeError("maxEntryBytes must be a positive integer");
    }
  }

  /** Store a JSON-compatible value and return an opaque handle, or null when it is too large. */
  create(value: unknown): CreatedResultHandle | null {
    this.removeExpired();
    let json: string | undefined;
    try {
      json = JSON.stringify(value);
    } catch {
      return null;
    }
    if (json === undefined) return null;
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes > this.maxEntryBytes || bytes > this.maxBytes) return null;

    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) this.removeOldest();
    let handle: string;
    do {
      handle = randomBytes(32).toString("base64url");
    } while (this.entries.has(handle));

    const expiresAt = this.now() + this.ttlMs;
    this.entries.set(handle, { json, bytes, expiresAt });
    this.bytes += bytes;
    return { handle, expiresAt };
  }

  /** Return a fresh copy of a stored value, or undefined for an unknown or expired handle. */
  get(handle: string): unknown | undefined {
    this.removeExpired();
    const entry = this.entries.get(handle);
    if (!entry) return undefined;
    try {
      return JSON.parse(entry.json) as unknown;
    } catch {
      this.remove(handle);
      return undefined;
    }
  }

  /** Delete a handle when its metadata cannot be returned within the configured output budget. */
  delete(handle: string): void {
    this.remove(handle);
  }

  /** Return only the requested field paths from a stored result. */
  select(handle: string, fields: string[]): unknown | undefined {
    const value = this.get(handle);
    if (value === undefined) return undefined;
    return selectResultFields(value, fields);
  }

  private removeExpired(): void {
    const now = this.now();
    for (const [handle, entry] of this.entries) {
      if (entry.expiresAt <= now) this.remove(handle);
    }
  }

  private removeOldest(): void {
    const oldest = this.entries.keys().next();
    if (!oldest.done) this.remove(oldest.value);
  }

  private remove(handle: string): void {
    const entry = this.entries.get(handle);
    if (!entry) return;
    this.bytes -= entry.bytes;
    this.entries.delete(handle);
  }
}

/**
 * Selects dot-separated field paths through objects and arrays. It copies only requested fields,
 * ignores inherited properties, and rejects prototype-related keys before reading any values.
 */
export function selectResultFields(value: unknown, fields: string[]): unknown {
  if (!Array.isArray(fields) || fields.length === 0 || fields.length > 100) {
    throw new Error("fields must contain between 1 and 100 field paths");
  }
  const groups = new Map<string, string[][]>();
  for (const field of fields) {
    if (typeof field !== "string" || field.length === 0 || field.length > 256) {
      throw new Error("invalid field path");
    }
    const parts = field.split(".");
    if (parts.some((part) => part.length === 0)) throw new Error(`invalid field path: ${field}`);
    if (parts.some((part) => UNSAFE_SEGMENTS.has(part))) throw new Error(`unsafe field path: ${field}`);
    const head = parts[0]!;
    const tails = groups.get(head) ?? [];
    tails.push(parts.slice(1));
    groups.set(head, tails);
  }

  const selected = project(value, groups);
  if (selected !== MISSING) return selected;
  return Array.isArray(value) ? [] : {};
}

function project(value: unknown, paths: Map<string, string[][]>): unknown | typeof MISSING {
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const selected = project(item, paths);
      if (selected !== MISSING) out.push(selected);
    }
    return out.length ? out : MISSING;
  }
  if (value === null || typeof value !== "object") return MISSING;

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, tails] of paths) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const valuePaths = tails.filter((tail) => tail.length === 0);
    if (valuePaths.length) {
      define(out, key, source[key]);
      continue;
    }
    const childPaths = new Map<string, string[][]>();
    for (const [head, ...tail] of tails) {
      const group = childPaths.get(head) ?? [];
      group.push(tail);
      childPaths.set(head, group);
    }
    const child = project(source[key], childPaths);
    if (child !== MISSING) define(out, key, child);
  }
  return Object.keys(out).length ? out : MISSING;
}

function define(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}
