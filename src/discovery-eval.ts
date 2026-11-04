// src/discovery-eval.ts
// Offline evaluation of tool discovery: a labeled catalog + queries → Recall@k, wrong-tool rate
// and latency per ranking strategy. Used by the benchmark suite and the regression test.

import { readFileSync } from "fs";
import { isConfidentMatch, ToolRouter, type RankStrategy, type ServerConfig } from "./router.js";
import { ToolIndex } from "./tool-index.js";

export interface DiscoveryEvalServer {
  description: string;
  keywords: string[];
  tools: Array<[name: string, description: string]>;
}

export interface DiscoveryEvalQuery {
  query: string;
  expect: string;
  category: string;
}

export interface DiscoveryEvalSet {
  servers: Record<string, DiscoveryEvalServer>;
  queries: DiscoveryEvalQuery[];
}

export interface DiscoveryMetrics {
  strategy: RankStrategy;
  queries: number;
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  /** Mean reciprocal rank of the expected server. */
  mrr: number;
  /** Share of queries whose top result is a different server (an answer exists but is wrong). */
  wrongTopRate: number;
  /** Share of queries with no result at all. */
  emptyRate: number;
  /** Per-query ranking time in microseconds. */
  latencyUs: { p50: number; p95: number };
  byCategory: Record<string, { queries: number; recallAt1: number; recallAt3: number }>;
  /** Queries whose expected server was not in the top 3. */
  misses: Array<{ query: string; expect: string; got: string[] }>;
}

export function loadDiscoveryEvalSet(path: string): DiscoveryEvalSet {
  return JSON.parse(readFileSync(path, "utf8")) as DiscoveryEvalSet;
}

/** Build the router the way the broker sees it: configs plus a learned tool index. */
export function buildEvalRouter(set: DiscoveryEvalSet, extraServers: Record<string, DiscoveryEvalServer> = {}): ToolRouter {
  const configs: Record<string, ServerConfig> = {};
  const index = new ToolIndex();
  for (const [name, server] of Object.entries({ ...set.servers, ...extraServers })) {
    const config: ServerConfig = {
      description: server.description,
      keywords: server.keywords,
      command: "node",
      autoActivate: false,
    };
    configs[name] = config;
    index.record(name, config, server.tools.map(([toolName, description]) => ({ name: toolName, description })));
  }
  return new ToolRouter(configs, undefined, index);
}

function percentile(values: number[], p: number): number {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))] ?? 0;
}

export function evaluateDiscovery(
  set: DiscoveryEvalSet,
  strategy: RankStrategy,
  options: { router?: ToolRouter; repeat?: number; distractors?: number } = {}
): DiscoveryMetrics {
  const router =
    options.router ?? buildEvalRouter(set, options.distractors ? generateDistractorServers(options.distractors) : {});
  const repeat = Math.max(1, options.repeat ?? 1);
  let hits1 = 0;
  let hits3 = 0;
  let hits5 = 0;
  let reciprocal = 0;
  let wrong = 0;
  let empty = 0;
  const times: number[] = [];
  const categories: DiscoveryMetrics["byCategory"] = {};
  const misses: DiscoveryMetrics["misses"] = [];

  for (const q of set.queries) {
    let ranked: string[] = [];
    for (let i = 0; i < repeat; i++) {
      const start = performance.now();
      // What discover_tools would show: confident matches only, best first, at most five.
      ranked = router
        .rank(q.query, { strategy })
        .filter(isConfidentMatch)
        .slice(0, 5)
        .map((r) => r.name);
      times.push((performance.now() - start) * 1000);
    }
    const position = ranked.indexOf(q.expect);
    if (position === 0) hits1++;
    if (position !== -1 && position < 3) hits3++;
    if (position !== -1 && position < 5) hits5++;
    if (position !== -1) reciprocal += 1 / (position + 1);
    if (ranked.length === 0) empty++;
    else if (position !== 0) wrong++;
    if (position === -1 || position >= 3) misses.push({ query: q.query, expect: q.expect, got: ranked.slice(0, 3) });
    const cat = (categories[q.category] ??= { queries: 0, recallAt1: 0, recallAt3: 0 });
    cat.queries++;
    if (position === 0) cat.recallAt1++;
    if (position !== -1 && position < 3) cat.recallAt3++;
  }
  const n = set.queries.length || 1;
  for (const cat of Object.values(categories)) {
    cat.recallAt1 = round(cat.recallAt1 / cat.queries);
    cat.recallAt3 = round(cat.recallAt3 / cat.queries);
  }
  return {
    strategy,
    queries: set.queries.length,
    recallAt1: round(hits1 / n),
    recallAt3: round(hits3 / n),
    recallAt5: round(hits5 / n),
    mrr: round(reciprocal / n),
    wrongTopRate: round(wrong / n),
    emptyRate: round(empty / n),
    latencyUs: { p50: Math.round(percentile(times, 0.5)), p95: Math.round(percentile(times, 0.95)) },
    byCategory: categories,
    misses,
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Small deterministic PRNG so distractor catalogs are identical on every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOUNS = [
  "ticket", "issue", "message", "page", "file", "task", "report", "event", "user", "order", "metric",
  "alert", "log", "invoice", "customer", "document", "project", "release", "build", "deployment",
  "contact", "campaign", "channel", "comment", "article", "asset", "device", "shipment", "survey",
  "booking", "license", "policy", "backup", "secret", "token", "queue", "job", "workflow", "form", "note",
];
const VERBS = ["list", "get", "create", "update", "delete", "search", "export", "archive", "assign", "sync"];
const BRANDS = [
  "Acme", "Borealis", "Cobalt", "Delta", "Ember", "Fjord", "Granite", "Harbor", "Indigo", "Juniper", "Krypton",
  "Lumen", "Meridian", "Nimbus", "Orchid", "Pioneer", "Quartz", "Radian", "Summit", "Tundra", "Umbra",
  "Vertex", "Willow", "Xenon", "Yonder", "Zephyr",
];

/**
 * Deterministic filler servers that share generic vocabulary (create, list, ticket, report, …) with
 * the labeled catalog, so ranking is tested against realistic noise rather than an empty field.
 * Each has `toolsPerServer` tools; none is the expected answer to any labeled query.
 */
export function generateDistractorServers(
  count: number,
  toolsPerServer = 5,
  seed = 1
): Record<string, DiscoveryEvalServer> {
  const random = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const servers: Record<string, DiscoveryEvalServer> = {};
  for (let i = 0; i < count; i++) {
    const brand = `${pick(BRANDS)}${pick(BRANDS)}`.toLowerCase() + `-${i}`;
    const nouns = Array.from(new Set(Array.from({ length: 3 }, () => pick(NOUNS))));
    const tools: Array<[string, string]> = [];
    for (let t = 0; t < toolsPerServer; t++) {
      const noun = nouns[t % nouns.length]!;
      const verb = VERBS[(i + t) % VERBS.length]!;
      tools.push([`${verb}_${noun}`, `${verb[0]!.toUpperCase()}${verb.slice(1)} ${noun} records in ${brand.split("-")[0]}`]);
    }
    servers[brand] = {
      description: `${brand.split("-")[0]} service for ${nouns.join(", ")} and related records`,
      keywords: [brand.split("-")[0]!, nouns[0]!],
      tools,
    };
  }
  return servers;
}
