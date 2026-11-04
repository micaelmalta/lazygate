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
  /** Optimization policy mode, absent when the call was not measured by the optimizer. */
  optimizationMode?: string;
  /** Candidate selected by adaptive optimization; "off" means no candidate qualified. */
  optimizationSelectedMode?: string;
  /** Token counter label used by the optimizer for its estimates and budgets. */
  optimizationTokenizer?: string;
  /** Time spent transforming or enforcing an output budget, separate from total call time. */
  optimizationDurationMs?: number;
  /** True when a configured transformation failed and the original response was retained. */
  optimizationFallback?: boolean;
  /** Whether the optimized response retained all source information. */
  optimizationComplete?: boolean;
  /** "fields" when the agent asked call_tool for specific fields (field names are not logged). */
  optimizationIntent?: string;
  /** True when the response carried a get_result handle for the omitted data. */
  resultHandleOffered?: boolean;
  /** On get_result rows: the `server.tool` whose response the handle held. */
  resultHandleSource?: string;
}

/** A suggested `responseOptimization.tools` change derived from recent audit rows. */
export interface PolicyRecommendation {
  /** Policy key in servers.json (`server.tool`). */
  tool: string;
  action: "enable_adaptive" | "pin_mode" | "add_projection" | "review_policy" | "disable";
  reason:
    | "large_unoptimized_responses"
    | "stable_adaptive_selection"
    | "agents_request_fields"
    | "frequent_fallbacks"
    | "frequent_result_reads"
    | "overhead_high"
    | "adaptive_never_selected"
    | "no_savings";
  detail: string;
  calls: number;
  suggestedPolicy?: Record<string, unknown>;
}

/** Fewer calls than this per tool are not enough evidence for a recommendation. */
export const RECOMMENDATION_MIN_CALLS = 5;
const LARGE_RESPONSE_TOKENS = 2000;
const FALLBACK_RATE_LIMIT = 20;
const OVERHEAD_SHARE_LIMIT = 0.5;
const STABLE_SELECTION_SHARE = 0.8;
const MIN_USEFUL_REDUCTION_PERCENT = 5;
/**
 * Share of handle-bearing responses followed by get_result above which the reduction costs more
 * than it saves. Counts tool calls: the gateway cannot see whether a read shared a model turn.
 */
const RESULT_READ_RATE_LIMIT = 30;

const AUTOMATIC_PRUNE = { mode: "prune", removeNulls: true, removeEmptyObjects: true, removeEmptyArrays: true, removeEmptyStrings: true };

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function mostCommon(counts: Map<string, number>): [string, number] | undefined {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
}

/**
 * Turn proxied-call audit rows into at most one policy suggestion per upstream tool. Problems with
 * an existing policy (fallbacks, overhead, no savings) outrank tuning (pinning, projection), which
 * outranks enabling optimization for large unoptimized responses.
 */
export function recommendOptimizationPolicies(events: AuditedEvent[], limit = 20): PolicyRecommendation[] {
  interface ToolStats {
    calls: number;
    originalTokens: number[];
    msTotal: number;
    policyCalls: number;
    policyOriginal: number;
    policySaved: number;
    policyDurationMs: number;
    policyMs: number;
    fallbacks: number;
    modes: Map<string, number>;
    selected: Map<string, number>;
    intentCalls: number;
    handleOffers: number;
    handleReads: number;
  }
  const byTool = new Map<string, ToolStats>();
  const stats = (key: string): ToolStats => {
    let s = byTool.get(key);
    if (!s) {
      s = {
        calls: 0, originalTokens: [], msTotal: 0, policyCalls: 0, policyOriginal: 0, policySaved: 0,
        policyDurationMs: 0, policyMs: 0, fallbacks: 0, modes: new Map(), selected: new Map(), intentCalls: 0,
        handleOffers: 0, handleReads: 0,
      };
      byTool.set(key, s);
    }
    return s;
  };
  for (const e of events) {
    if (!isUsageEvent(e) || e.ok === false) continue;
    if (e.tool === "get_result") {
      if (e.resultHandleSource) stats(e.resultHandleSource).handleReads += 1;
      continue;
    }
    if (!e.server || !e.target) continue;
    const s = stats(`${e.server}.${e.target}`);
    s.calls += 1;
    s.originalTokens.push(e.originalTokens ?? 0);
    s.msTotal += e.ms ?? 0;
    if (e.resultHandleOffered) s.handleOffers += 1;
    if (e.optimizationIntent) {
      s.intentCalls += 1;
      continue;
    }
    if (!e.optimizationMode || e.optimizationMode === "off") continue;
    s.policyCalls += 1;
    s.policyOriginal += e.originalTokens ?? 0;
    s.policySaved += e.savedTokens ?? 0;
    s.policyDurationMs += e.optimizationDurationMs ?? 0;
    s.policyMs += e.ms ?? 0;
    if (e.optimizationFallback) s.fallbacks += 1;
    s.modes.set(e.optimizationMode, (s.modes.get(e.optimizationMode) ?? 0) + 1);
    if (e.optimizationSelectedMode) s.selected.set(e.optimizationSelectedMode, (s.selected.get(e.optimizationSelectedMode) ?? 0) + 1);
  }

  const out: PolicyRecommendation[] = [];
  for (const [tool, s] of byTool) {
    if (s.calls < RECOMMENDATION_MIN_CALLS) continue;
    const base = { tool, calls: s.calls };
    const topSelectedOverall = mostCommon(s.selected);
    if (s.handleOffers >= RECOMMENDATION_MIN_CALLS) {
      const readRate = Math.round((Math.min(s.handleReads, s.handleOffers) / s.handleOffers) * 100);
      if (readRate >= RESULT_READ_RATE_LIMIT) {
        const summarized = topSelectedOverall?.[0] === "schema";
        out.push({
          ...base, action: "review_policy", reason: "frequent_result_reads",
          ...(summarized ? { suggestedPolicy: { mode: "adaptive", allowSummary: false } } : {}),
          detail:
            `Agents called get_result after ${readRate}% of ${s.handleOffers} reduced responses, so the reduction costs extra tool calls (and often model turns). ` +
            (summarized
              ? "Adaptive mostly picked the schema summary; turn allowSummary off."
              : "Raise maxTokens or project the fields agents read back."),
        });
        continue;
      }
    }
    if (s.policyCalls >= RECOMMENDATION_MIN_CALLS) {
      const fallbackRate = Math.round((s.fallbacks / s.policyCalls) * 100);
      const avgOptimizationMs = s.policyDurationMs / s.policyCalls;
      const avgCallMs = s.policyMs / s.policyCalls;
      const mode = mostCommon(s.modes)![0];
      const reduction = s.policyOriginal ? (s.policySaved / s.policyOriginal) * 100 : 0;
      const topSelected = mostCommon(s.selected);
      if (fallbackRate >= FALLBACK_RATE_LIMIT) {
        out.push({
          ...base, action: "review_policy", reason: "frequent_fallbacks",
          detail: `${fallbackRate}% of ${s.policyCalls} optimized calls fell back to the original response (input limits or transform errors).`,
        });
        continue;
      }
      if (avgOptimizationMs >= 5 && avgOptimizationMs > avgCallMs * OVERHEAD_SHARE_LIMIT) {
        out.push({
          ...base, action: "review_policy", reason: "overhead_high",
          detail: `Optimization averages ${Math.round(avgOptimizationMs)} ms against ${Math.round(avgCallMs)} ms per call.`,
        });
        continue;
      }
      if (mode === "adaptive" && topSelected?.[0] === "off" && topSelected[1] / s.policyCalls >= 0.9) {
        out.push({
          ...base, action: "disable", reason: "adaptive_never_selected", suggestedPolicy: { mode: "off" },
          detail: `Adaptive optimization kept the original response on ${topSelected[1]} of ${s.policyCalls} calls.`,
        });
        continue;
      }
      if (mode !== "adaptive" && reduction < MIN_USEFUL_REDUCTION_PERCENT) {
        out.push({
          ...base, action: "disable", reason: "no_savings", suggestedPolicy: { mode: "off" },
          detail: `The ${mode} policy saved ${reduction.toFixed(1)}% of tokens over ${s.policyCalls} calls.`,
        });
        continue;
      }
      if (
        mode === "adaptive" && topSelected && topSelected[0] !== "off" &&
        topSelected[1] / s.policyCalls >= STABLE_SELECTION_SHARE
      ) {
        const pinned = topSelected[0];
        out.push({
          ...base, action: "pin_mode", reason: "stable_adaptive_selection",
          suggestedPolicy: pinned === "prune" ? AUTOMATIC_PRUNE : { mode: pinned },
          detail:
            `Adaptive selected ${pinned} on ${topSelected[1]} of ${s.policyCalls} calls; pinning it skips candidate evaluation` +
            (pinned === "project" || pinned === "jsonpath" ? " (copy that candidate's options)." : "."),
        });
        continue;
      }
    }
    if (s.intentCalls >= RECOMMENDATION_MIN_CALLS && s.intentCalls * 2 >= s.calls) {
      out.push({
        ...base, action: "add_projection", reason: "agents_request_fields",
        suggestedPolicy: { mode: "project", fields: ["<fields agents request>"] },
        detail: `Agents passed call_tool fields on ${s.intentCalls} of ${s.calls} calls; a project policy applies the same projection to every call.`,
      });
      continue;
    }
    const medianTokens = median(s.originalTokens);
    if (s.policyCalls === 0 && medianTokens >= LARGE_RESPONSE_TOKENS) {
      out.push({
        ...base, action: "enable_adaptive", reason: "large_unoptimized_responses", suggestedPolicy: { mode: "adaptive" },
        detail: `Median response is ~${Math.round(medianTokens).toLocaleString("en-US")} tokens and no optimization policy applied.`,
      });
    }
  }
  return out.sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool)).slice(0, limit);
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
  optimizationCalls: number;
  optimizationFallbacks: number;
  optimizationFallbackRate: number;
  optimizationIncompleteCalls: number;
  optimizationIncompleteRate: number;
  optimizationDurationMs: number;
  averageOptimizationDurationMs: number;
  optimizationSelectedModes: Record<string, number>;
}

export interface ChainUsage {
  runChainCalls: number;
  callToolCalls: number;
  /** run_chain share of run_chain + call_tool, in percent (0 when neither was used). */
  adoptionRate: number;
  /** Successful run_chain calls, in percent of run_chain calls. */
  successRate: number;
  /** Upstream tool calls made by scripts, per run_chain call. */
  nestedCallsPerChain: number;
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
  optimizationCalls: number;
  optimizationFallbacks: number;
  optimizationFallbackRate: number;
  optimizationIncompleteCalls: number;
  optimizationIncompleteRate: number;
  optimizationDurationMs: number;
  averageOptimizationDurationMs: number;
  optimizationSelectedModes: Record<string, number>;
  /** Responses that carried a get_result handle, and get_result reads of those handles. */
  resultHandleOffers: number;
  resultHandleReads: number;
  /** Reads as a percentage of offers: how often a reduction cost the agent another tool call. */
  resultHandleReadRate: number;
  /**
   * run_chain adoption: scripts run versus direct call_tool calls (calls a script makes itself are
   * excluded from both), how often scripts succeed, and how many upstream calls each one makes.
   */
  chain: ChainUsage;
  from: string | null;
  to: string | null;
  byServer: UsageBucket[];
  byTool: UsageBucket[];
  byUser: UsageBucket[];
  /** Policy suggestions from the same audit window (see recommendOptimizationPolicies). */
  recommendations: PolicyRecommendation[];
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
    b = {
      key,
      calls: 0,
      ok: 0,
      error: 0,
      originalTokens: 0,
      optimizedTokens: 0,
      savedTokens: 0,
      optimizationCalls: 0,
      optimizationFallbacks: 0,
      optimizationFallbackRate: 0,
      optimizationIncompleteCalls: 0,
      optimizationIncompleteRate: 0,
      optimizationDurationMs: 0,
      averageOptimizationDurationMs: 0,
      optimizationSelectedModes: {},
    };
    map.set(key, b);
  }
  b.calls += 1;
  if (e.ok === false) b.error += 1;
  else b.ok += 1;
  b.originalTokens += e.originalTokens ?? 0;
  b.optimizedTokens += e.optimizedTokens ?? 0;
  b.savedTokens += e.savedTokens ?? 0;
  if (e.optimizationMode) {
    b.optimizationCalls += 1;
    if (e.optimizationFallback) b.optimizationFallbacks += 1;
    if (e.optimizationComplete === false) b.optimizationIncompleteCalls += 1;
    b.optimizationDurationMs += e.optimizationDurationMs ?? 0;
    b.optimizationFallbackRate = Math.round((b.optimizationFallbacks / b.optimizationCalls) * 100);
    b.optimizationIncompleteRate = Math.round((b.optimizationIncompleteCalls / b.optimizationCalls) * 100);
    b.averageOptimizationDurationMs = b.optimizationDurationMs / b.optimizationCalls;
    if (e.optimizationMode === "adaptive" && e.optimizationSelectedMode) {
      b.optimizationSelectedModes[e.optimizationSelectedMode] = (b.optimizationSelectedModes[e.optimizationSelectedMode] ?? 0) + 1;
    }
  }
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
  let optimizationCalls = 0;
  let optimizationFallbacks = 0;
  let optimizationIncompleteCalls = 0;
  let optimizationDurationMs = 0;
  let resultHandleOffers = 0;
  let resultHandleReads = 0;
  const selectedModes = new Map<string, number>();
  const byServer = new Map<string, UsageBucket>();
  const byTool = new Map<string, UsageBucket>();
  const byUser = new Map<string, UsageBucket>();
  let runChainCalls = 0;
  let runChainOk = 0;
  let callToolCalls = 0;
  let nestedCalls = 0;
  let from: string | null = null;
  let to: string | null = null;

  for (const e of usage) {
    if (e.ok === false) error += 1;
    else ok += 1;
    originalTokens += e.originalTokens ?? 0;
    optimizedTokens += e.optimizedTokens ?? 0;
    savedTokens += e.savedTokens ?? 0;
    if (e.via === "run_chain") nestedCalls += 1;
    else if (e.tool === "run_chain") {
      runChainCalls += 1;
      if (e.ok !== false) runChainOk += 1;
    } else if (e.tool === "call_tool") callToolCalls += 1;
    if (e.resultHandleOffered) resultHandleOffers += 1;
    if (e.tool === "get_result" && e.resultHandleSource && e.ok !== false) resultHandleReads += 1;
    if (e.optimizationMode) {
      optimizationCalls += 1;
      if (e.optimizationFallback) optimizationFallbacks += 1;
      if (e.optimizationComplete === false) optimizationIncompleteCalls += 1;
      optimizationDurationMs += e.optimizationDurationMs ?? 0;
      if (e.optimizationMode === "adaptive" && e.optimizationSelectedMode) {
        selectedModes.set(e.optimizationSelectedMode, (selectedModes.get(e.optimizationSelectedMode) ?? 0) + 1);
      }
    }
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
    optimizationCalls,
    optimizationFallbacks,
    optimizationFallbackRate: optimizationCalls ? Math.round((optimizationFallbacks / optimizationCalls) * 100) : 0,
    optimizationIncompleteCalls,
    optimizationIncompleteRate: optimizationCalls ? Math.round((optimizationIncompleteCalls / optimizationCalls) * 100) : 0,
    optimizationDurationMs,
    averageOptimizationDurationMs: optimizationCalls ? optimizationDurationMs / optimizationCalls : 0,
    optimizationSelectedModes: Object.fromEntries(selectedModes),
    resultHandleOffers,
    resultHandleReads,
    resultHandleReadRate: resultHandleOffers
      ? Math.round((Math.min(resultHandleReads, resultHandleOffers) / resultHandleOffers) * 100)
      : 0,
    chain: {
      runChainCalls,
      callToolCalls,
      adoptionRate:
        runChainCalls + callToolCalls ? Math.round((runChainCalls / (runChainCalls + callToolCalls)) * 100) : 0,
      successRate: runChainCalls ? Math.round((runChainOk / runChainCalls) * 100) : 0,
      nestedCallsPerChain: runChainCalls ? Math.round((nestedCalls / runChainCalls) * 10) / 10 : 0,
    },
    from,
    to,
    byServer: ranked(byServer, top),
    byTool: ranked(byTool, top),
    byUser: ranked(byUser, top),
    recommendations: recommendOptimizationPolicies(usage),
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
