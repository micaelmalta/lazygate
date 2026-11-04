// Reproducible end-to-end benchmark suite: `lazygate benchmark --suite`.
//
// Five workload types × strategies × catalog sizes (20 / 100 / 250 / 500 tools), driven by a
// scripted "oracle agent" against real MCP traffic (a stdio fixture server through the real broker
// and process manager). It needs no model and no network, so every token and turn count is exactly
// reproducible; only latency varies between runs.
//
//   workloads   single_lookup · dependent_chain · parallel_calls · large_json · html_docs
//   strategies  direct (every schema in context) · direct_capped (same, client truncates tool
//               output) · call_tool · call_tool_opt · run_chain · pinned (a few tools exposed in
//               tools/list, the rest through the meta-tools)
//   lookups     how a lazygate agent learns the call shape: cold (discover_tools, then
//               describe_tool) · merged (discover_tools with inline signatures, then call) ·
//               known (it already knows the server and signatures)
//
// What it measures: the tokens that enter the model's context (schemas, tool calls, results), the
// number of model turns, wall-clock time of the tool traffic (median, spread), and whether the
// answer is still correct. On top of those it models (clearly labeled, never measured): prompt
// caching (effective input tokens), model time per turn (modeled ms and a turn-time sweep) and the
// extra turns a wrong discovery result costs. What it does not measure: model behaviour. The oracle
// agent always writes a correct call or script; `benchmark --tasks` covers real model behaviour
// (needs `claude`).
//
// Extras in the same report: discovery quality on a tuned and a held-out labeled set (Recall@k,
// wrong-tool rate, latency) and optimizer latency on large payloads.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { cpus, platform, arch } from "os";
import {
  EXPECTED,
  REGIONS,
} from "../fixtures/suite-data.mjs";
import { TOOLS as SUITE_TOOLS } from "../fixtures/suite-tools.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_ROOT = resolve(here, "..");
const REPO_ROOT = resolve(SCRIPTS_ROOT, "..");
const SERVER_PATH = join(SCRIPTS_ROOT, "fixtures", "suite-server.mjs");

export const SCHEMA_VERSION = 2;
export const DEFAULT_SIZES = [20, 100, 250, 500];
export const QUICK_SIZES = [20, 100];
export const DEFAULT_ROUNDS = 15;
export const QUICK_ROUNDS = 3;
export const STRATEGIES = ["direct", "direct_capped", "call_tool", "call_tool_opt", "run_chain", "pinned"];
export const WORKLOAD_IDS = ["single_lookup", "dependent_chain", "parallel_calls", "large_json", "html_docs"];
export const LOOKUPS = ["cold", "merged", "known"];
/** Tools the `pinned` strategy lists in tools/list (the "hot" ones); the rest go through the meta-tools. */
export const PINNED_TOOLS = ["get_order_status", "list_tickets", "get_ticket", "get_region_metric"];
/** Strategies that go through the lazygate broker (and so pay lookup turns unless the tool is pinned). */
const LAZYGATE_STRATEGIES = ["call_tool", "call_tool_opt", "run_chain", "pinned"];
/** Strategies compared across lookup modes in the "cold start" section. */
const LOOKUP_COMPARE_STRATEGIES = ["call_tool", "call_tool_opt", "run_chain"];
/** Smallest sample count for which a 95th percentile is reported; below it the maximum is shown. */
export const MIN_P95_SAMPLES = 20;

const SUITE_SERVER = "suite";
const TASK_PROMPT_TOKEN_ESTIMATE = 60;
const OPT_CONFIG = { responseOptimization: { enabled: true, defaultMode: "adaptive" } };

// ─── small helpers ───────────────────────────────────────────────────────────

const round = (value, digits = 1) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
}

/**
 * Summary of latency samples: median and spread (min, max, MAD = median absolute deviation). The
 * 95th percentile is only reported from MIN_P95_SAMPLES samples on (`null` below it): a p95 over a
 * handful of rounds is just the maximum.
 */
export function distribution(samples) {
  const mean = samples.reduce((a, b) => a + b, 0) / (samples.length || 1);
  const median = percentile(samples, 0.5);
  return {
    samples: samples.length,
    min: round(Math.min(...samples)),
    p50: round(median),
    mad: round(percentile(samples.map((v) => Math.abs(v - median)), 0.5)),
    p95: samples.length >= MIN_P95_SAMPLES ? round(percentile(samples, 0.95)) : null,
    max: round(Math.max(...samples)),
    mean: round(mean),
  };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The protocol payload a client puts in the model's context for one tool result. */
function resultPayload(result) {
  const payload = { content: result?.content ?? [] };
  if (result?.structuredContent !== undefined) payload.structuredContent = result.structuredContent;
  if (result?._meta !== undefined) payload._meta = result._meta;
  if (result?.isError) payload.isError = true;
  return JSON.stringify(payload);
}

function resultText(result) {
  return (result?.content ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function firstText(result) {
  const block = (result?.content ?? []).find((b) => b?.type === "text" && typeof b.text === "string");
  return block ? block.text : "";
}

/** Value after "Return value:" in a run_chain response. */
function chainValue(result) {
  const text = resultText(result);
  const marker = "Return value: ";
  const at = text.lastIndexOf(marker);
  if (at === -1) return undefined;
  return parseJson(text.slice(at + marker.length).trim());
}

// ─── runtime (lazy dist imports) ─────────────────────────────────────────────

async function loadRuntime(tokenizerName) {
  const dist = (file) => pathToFileURL(join(REPO_ROOT, "dist", file)).href;
  if (!existsSync(join(REPO_ROOT, "dist", "broker.js"))) {
    throw new Error("dist/ not found. Run `npm run build` first.");
  }
  const [broker, router, toolIndex, processManager, metaTools, optimizer, tokenizers, discoveryEval] = await Promise.all([
    import(dist("broker.js")),
    import(dist("router.js")),
    import(dist("tool-index.js")),
    import(dist("process-manager.js")),
    import(dist("meta-tools.js")),
    import(dist("response-optimizer.js")),
    import(dist("tokenizers.js")),
    import(dist("discovery-eval.js")),
  ]);
  const tokenizer = await tokenizers.loadTokenizer(tokenizerName);
  return {
    createBroker: broker.createBroker,
    ToolRouter: router.ToolRouter,
    ToolIndex: toolIndex.ToolIndex,
    ProcessManager: processManager.ProcessManager,
    META_TOOL_NAMES: metaTools.META_TOOL_NAMES,
    optimizer,
    discoveryEval,
    tokenizerName: tokenizer ? tokenizer.name : "chars_per_4",
    count: (text) => (tokenizer ? tokenizer.countTokens(text) : Math.ceil(text.length / 4)),
    tokenizer,
  };
}

// ─── catalogs ────────────────────────────────────────────────────────────────

const FILLER_DESCRIPTION_SUFFIX = ". Returns the matching records as JSON; use the filters to narrow the result.";

function baseFillerTool(serverName, [name, description]) {
  return {
    name: `${serverName.split("-")[0]}_${name}`,
    description: `${description}${FILLER_DESCRIPTION_SUFFIX}`,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Identifier of the record to operate on" },
        query: { type: "string", description: "Free-text filter applied before the operation" },
        limit: { type: "integer", description: "Maximum number of records to return", default: 25 },
      },
      required: [],
    },
  };
}

const PADDING_SENTENCES = [
  "Results are paginated; pass the cursor from a previous response to continue.",
  "Requires the caller to hold read access to the record, otherwise a permission error is returned.",
  "Timestamps are ISO 8601 in UTC; dates without a time zone are interpreted as UTC.",
  "Unknown filter names are rejected rather than ignored.",
];

/**
 * Deterministically grow or shrink a filler tool toward `target` tokens of serialized schema:
 * pad the description and add optional filter properties, or strip property descriptions and
 * optional properties. Stops as soon as the target is reached (or nothing is left to change).
 */
function sizeTool(rt, tool, target) {
  const tokens = (t) => rt.count(JSON.stringify(t));
  const out = JSON.parse(JSON.stringify(tool));
  if (tokens(out) < target) {
    for (let i = 0; i < 80 && tokens(out) < target; i++) {
      if (i < PADDING_SENTENCES.length) out.description += ` ${PADDING_SENTENCES[i]}`;
      else {
        out.inputSchema.properties[`filter_${i}`] = {
          type: "string",
          description: `Optional filter number ${i} applied to the records before the operation`,
        };
      }
    }
  } else if (tokens(out) > target) {
    const props = out.inputSchema.properties;
    for (const key of ["id", "query", "limit"]) {
      if (tokens(out) <= target) break;
      delete props[key].description;
    }
    for (const key of ["limit", "query"]) {
      if (tokens(out) <= target) break;
      delete props[key];
    }
  }
  return out;
}

/** Catalog of `toolCount` tools: the suite server's six plus generated filler servers. */
function buildCatalog(rt, toolCount, seed, schemaTokensPerTool) {
  const fillerServers = Math.max(0, Math.ceil((toolCount - SUITE_TOOLS.length) / 5));
  const generated = rt.discoveryEval.generateDistractorServers(fillerServers, 5, seed);
  const allTools = [...SUITE_TOOLS];
  const fillerConfigs = {};
  const index = new rt.ToolIndex();
  for (const [name, server] of Object.entries(generated)) {
    const config = { description: server.description, keywords: server.keywords, command: "node", autoActivate: false };
    fillerConfigs[name] = config;
    const fillerTools = server.tools.map((tool) => {
      const base = baseFillerTool(name, tool);
      return schemaTokensPerTool ? sizeTool(rt, base, schemaTokensPerTool) : base;
    });
    index.record(name, config, server.tools.map(([toolName, description], i) => ({
      name: toolName,
      description,
      inputSchema: fillerTools[i].inputSchema,
    })));
    for (const tool of fillerTools) {
      if (allTools.length < toolCount) allTools.push(tool);
    }
  }
  const suiteConfig = {
    description: "Orders, support tickets, regional metrics, service events and documentation pages",
    keywords: ["orders", "tickets", "metrics", "events", "docs", "documentation"],
    command: process.execPath,
    args: [SERVER_PATH],
    inheritEnv: false,
    autoActivate: false,
    toolChain: true,
  };
  index.record(
    SUITE_SERVER,
    suiteConfig,
    SUITE_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
  );
  return { allTools, suiteConfig, fillerConfigs, index };
}

/**
 * Average serialized tokens per tool of a real catalog, used to size the filler tools.
 * Accepts an MCP `tools/list` dump (`{ tools: [...] }` or an array; measured as given), a
 * `tool-index.json` (names and descriptions are measured, the input schema is assumed to be the
 * default filler's) or a `servers.json` (reads the `tool-index.json` next to it).
 */
export function catalogProfile(rt, file) {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`--catalog-from: file not found: ${path}`);
  let data = parseJson(readFileSync(path, "utf8"));
  let source = path;
  if (data && typeof data === "object" && !Array.isArray(data) && data.servers && typeof data.servers === "object") {
    const sibling = join(dirname(path), "tool-index.json");
    if (!existsSync(sibling)) {
      throw new Error(`--catalog-from: ${path} lists servers but no tools; put a tool-index.json next to it or pass a tools/list dump`);
    }
    data = parseJson(readFileSync(sibling, "utf8"));
    source = sibling;
  }
  const defaultSchema = baseFillerTool("x", ["x", "x"]).inputSchema;
  const measured = [];
  const take = (tool, withSchema) => {
    if (!tool || typeof tool.name !== "string") return;
    measured.push(
      rt.count(
        JSON.stringify(withSchema ? tool : { name: tool.name, description: tool.description ?? "", inputSchema: defaultSchema })
      )
    );
  };
  if (Array.isArray(data) || (data && Array.isArray(data.tools))) {
    for (const tool of Array.isArray(data) ? data : data.tools) take(tool, Boolean(tool?.inputSchema));
  } else if (data && typeof data === "object") {
    for (const entry of Object.values(data)) for (const tool of entry?.tools ?? []) take(tool, false);
  }
  if (!measured.length) throw new Error(`--catalog-from: no tools found in ${source}`);
  const average = measured.reduce((a, b) => a + b, 0) / measured.length;
  return { source, tools: measured.length, averageSchemaTokens: Math.round(average) };
}

// ─── session: one scripted agent run ─────────────────────────────────────────

const isDirect = (strategy) => strategy === "direct" || strategy === "direct_capped";

class Session {
  constructor(rt, { strategy, catalog, lookup, cache, directOutputCap }) {
    this.rt = rt;
    this.lookup = lookup;
    this.strategy = strategy;
    this.catalog = catalog;
    this.cache = cache;
    this.directOutputCap = directOutputCap;
    this.manager = new rt.ProcessManager({ reservedToolNames: rt.META_TOOL_NAMES });
    this.turns = 0;
    this.modelCalls = 0;
    this.requestTokens = 0;
    this.responseTokens = 0;
    this.cumulativeInput = 0;
    this.effectiveInput = 0;
    this.discoveryTurns = 0;
    this.truncatedResults = 0;
    this.discoveryRank = null;
    this.broker = null;
    this.schemaTokens = 0;
    this.lastDiscovery = "";
  }

  /** Builds the broker / counts the schemas the model carries; must finish before the workload runs. */
  async init() {
    const { rt, strategy, catalog } = this;
    if (isDirect(strategy)) {
      // Classic MCP: every tool schema of the whole catalog sits in context on every turn.
      this.schemaTokens = rt.count(JSON.stringify(catalog.allTools));
      return;
    }
    const pinned = strategy === "pinned";
    const suiteConfig = pinned ? { ...catalog.suiteConfig, expose: PINNED_TOOLS } : catalog.suiteConfig;
    const router = new rt.ToolRouter(
      { [SUITE_SERVER]: suiteConfig, ...catalog.fillerConfigs },
      undefined,
      catalog.index
    );
    const optimization = strategy === "call_tool_opt"
      ? rt.optimizer.parseResponseOptimizationConfig(OPT_CONFIG).config
      : undefined;
    this.broker = rt.createBroker({
      router,
      manager: this.manager,
      skillRouter: null,
      responseOptimization: optimization,
      tokenizer: rt.tokenizer,
    });
    // A pinned server is listed in tools/list, so it has to be running before the client lists tools.
    if (pinned) await this.manager.activate(SUITE_SERVER, suiteConfig);
    this.schemaTokens = rt.count(JSON.stringify(this.broker.listTools().tools));
  }

  get contextTokens() {
    return this.requestTokens + this.responseTokens;
  }

  /**
   * What the model reads at the start of a turn. Raw: the whole conversation, no caching. Effective
   * (a model, not a measurement): the static prefix (prompt + tool schemas) is written to the cache
   * on the first turn (write premium) and read at a discount afterwards; everything the
   * conversation added since is billed at full price.
   */
  readConversation() {
    const prefix = TASK_PROMPT_TOKEN_ESTIMATE + this.schemaTokens;
    this.cumulativeInput += prefix + this.contextTokens;
    this.effectiveInput +=
      prefix * (this.turns === 0 ? this.cache.writePremium : this.cache.readDiscount) + this.contextTokens;
  }

  /** One model turn: the model emits `calls`, the client runs them concurrently, results come back. */
  async turn(calls) {
    this.readConversation();
    this.turns += 1;
    for (const call of calls) {
      this.modelCalls += 1;
      this.requestTokens += this.rt.count(JSON.stringify({ name: call.name, arguments: call.args }));
    }
    const results = await Promise.all(calls.map((call) => call.run()));
    for (const result of results) this.responseTokens += this.rt.count(resultPayload(result));
    return results;
  }

  /** The closing turn where the model writes its answer. */
  finish() {
    this.readConversation();
    this.turns += 1;
  }

  broker_(name, args) {
    return { name, args, run: () => this.broker.callTool(name, args) };
  }

  /** What a client with an output cap does to an oversized result: cut it and say so. */
  cap(result) {
    const cap = this.directOutputCap;
    if (!cap) return result;
    const total = this.rt.count(resultPayload(result));
    if (total <= cap) return result;
    this.truncatedResults += 1;
    const notice = `\n[output truncated by the client at ${cap} tokens]`;
    const original = firstText(result);
    let chars = Math.floor(original.length * (cap / total) * 0.98);
    let capped = { content: [{ type: "text", text: original.slice(0, chars) + notice }] };
    for (let i = 0; i < 8 && this.rt.count(resultPayload(capped)) > cap; i++) {
      chars = Math.floor(chars * 0.95);
      capped = { content: [{ type: "text", text: original.slice(0, chars) + notice }] };
    }
    return capped;
  }

  /** Discovery turn (lazygate strategies): the model asks which server fits, and finds `suite`. */
  async discover(query) {
    const [result] = await this.turn([this.broker_("discover_tools", { query })]);
    this.discoveryTurns += 1;
    const text = resultText(result);
    this.lastDiscovery = text;
    const lines = text.split("\n").filter((line) => /^(✓|○|⚠)/.test(line));
    const at = lines.findIndex((line) => line.includes(`| ${SUITE_SERVER} `));
    this.discoveryRank = at === -1 ? null : at + 1;
    if (at === -1) throw new Error("discover_tools did not surface the target server");
  }

  /** describe_tool for the argument shape (call_tool strategies) or for run_chain stubs. */
  async describe(tools) {
    const calls = tools === null
      ? [this.broker_("describe_tool", { server: SUITE_SERVER })]
      : tools.map((tool) => this.broker_("describe_tool", { server: SUITE_SERVER, tool }));
    await this.turn(calls);
  }

  /** Whether the last discover_tools answer already carried this tool's call signature. */
  hasInlineSignature(tool) {
    return this.lastDiscovery.split("\n").some((line) => line.trim().startsWith(`${tool}(args:`));
  }

  /** Discovery + schema lookup before the first real call; nothing to do for direct MCP. */
  async prepare({ query, tools }) {
    if (isDirect(this.strategy)) {
      await this.manager.activate(SUITE_SERVER, this.catalog.suiteConfig);
      return;
    }
    // Pinned tools are already in tools/list: only the others need a lookup.
    const needed = this.strategy === "pinned" ? tools.filter((tool) => !PINNED_TOOLS.includes(tool)) : tools;
    if (needed.length === 0) return;
    // A known-tools agent already knows the server and the signatures (a skill or AGENTS.md told
    // it), so it skips both lookup turns; the server still activates lazily on the first call.
    if (this.lookup === "known") return;
    await this.discover(query);
    if (this.lookup === "merged") {
      // discover_tools carries the signatures when the match is clear; only what it left out costs a turn.
      const missing = needed.filter((tool) => !this.hasInlineSignature(tool));
      if (missing.length === 0) return;
      await this.describe(this.strategy === "run_chain" ? null : missing);
      return;
    }
    await this.describe(this.strategy === "run_chain" ? null : needed);
  }

  /** One turn of upstream tool calls: parallel `call_tool`s (or direct MCP calls). */
  async calls(specs) {
    const results = await this.turn(
      specs.map((spec) => {
        if (isDirect(this.strategy)) {
          return {
            name: spec.tool,
            args: spec.args ?? {},
            run: async () => {
              const raw = await this.manager.callTool(SUITE_SERVER, spec.tool, spec.args ?? {});
              return this.strategy === "direct_capped" ? this.cap(raw) : raw;
            },
          };
        }
        // A pinned tool is an ordinary tool in tools/list: the model calls it by name.
        if (this.strategy === "pinned" && PINNED_TOOLS.includes(spec.tool)) {
          return this.broker_(spec.tool, spec.args ?? {});
        }
        return this.broker_("call_tool", {
          server: SUITE_SERVER,
          tool: spec.tool,
          args: spec.args ?? {},
          ...(this.strategy === "call_tool_opt" && spec.fields ? { fields: spec.fields } : {}),
        });
      })
    );
    // The payload is the first text block; optimized results may append a second block with a get_result note.
    return results.map((result) => {
      const text = firstText(result);
      return { result, text, json: parseJson(text) };
    });
  }

  /** One run_chain turn. */
  async chain(code) {
    const [result] = await this.turn([this.broker_("run_chain", { code })]);
    return { result, value: chainValue(result) };
  }

  close() {
    this.manager.dispose();
  }
}

// ─── workloads ───────────────────────────────────────────────────────────────

const stripTags = (html) =>
  html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<[^>]+>/g, " ");

export const WORKLOADS = {
  single_lookup: {
    title: "Single known tool",
    tests: "Proxy overhead on a one-call task",
    query: "check the status of an order",
    check: (answer) => answer?.status === EXPECTED.single_lookup.status,
    async run(session) {
      await session.prepare({ query: this.query, tools: ["get_order_status"] });
      if (session.strategy === "run_chain") {
        const { value } = await session.chain(
          `const order = await servers.suite.get_order_status({ id: "${EXPECTED.single_lookup.orderId}" }); return order.status;`
        );
        return { status: value };
      }
      const [r] = await session.calls([
        { tool: "get_order_status", args: { id: EXPECTED.single_lookup.orderId }, fields: ["status"] },
      ]);
      return { status: r.json?.status };
    },
  },

  dependent_chain: {
    title: "Multi-step dependent chain",
    tests: "LLM turns and intermediate results",
    query: "list support tickets and fetch ticket details",
    check: (answer) => answer?.count === EXPECTED.dependent_chain.count && answer?.points === EXPECTED.dependent_chain.points,
    async run(session) {
      await session.prepare({ query: this.query, tools: ["list_tickets", "get_ticket"] });
      if (session.strategy === "run_chain") {
        const { value } = await session.chain(
          'const rows = await servers.suite.list_tickets({ status: "open" });' +
            'const mine = rows.filter((r) => r.assignee === "ana");' +
            "const full = await Promise.all(mine.map((r) => servers.suite.get_ticket({ id: r.id })));" +
            "return { count: full.length, points: full.reduce((sum, t) => sum + t.points, 0) };"
        );
        return value;
      }
      const [list] = await session.calls([{ tool: "list_tickets", args: { status: "open" } }]);
      const mine = (list.json ?? []).filter((row) => row.assignee === "ana");
      const details = await session.calls(
        mine.map((row) => ({ tool: "get_ticket", args: { id: row.id }, fields: ["id", "points"] }))
      );
      return { count: details.length, points: details.reduce((sum, d) => sum + (d.json?.points ?? NaN), 0) };
    },
  },

  parallel_calls: {
    title: "Parallel independent calls",
    tests: "Execution concurrency",
    query: "get request metrics for each region",
    check: (answer) => answer?.requests === EXPECTED.parallel_calls.requests,
    async run(session) {
      await session.prepare({ query: this.query, tools: ["get_region_metric"] });
      if (session.strategy === "run_chain") {
        const { value } = await session.chain(
          `const regions = ${JSON.stringify(REGIONS)};` +
            "const all = await Promise.all(regions.map((region) => servers.suite.get_region_metric({ region })));" +
            "return { requests: all.reduce((sum, m) => sum + m.requests, 0) };"
        );
        return value;
      }
      const results = await session.calls(
        REGIONS.map((region) => ({ tool: "get_region_metric", args: { region }, fields: ["requests"] }))
      );
      return { requests: results.reduce((sum, r) => sum + (r.json?.requests ?? NaN), 0) };
    },
  },

  large_json: {
    title: "Large JSON aggregation",
    tests: "Response compression",
    query: "query recent service events",
    check: (answer) =>
      answer?.errors === EXPECTED.large_json.errors && answer?.maxErrorLatency === EXPECTED.large_json.maxErrorLatency,
    async run(session) {
      await session.prepare({ query: this.query, tools: ["query_events"] });
      if (session.strategy === "run_chain") {
        const { value } = await session.chain(
          "const events = await servers.suite.query_events({});" +
            'const errors = events.filter((e) => e.level === "error");' +
            "return { errors: errors.length, maxErrorLatency: Math.max(...errors.map((e) => e.latency_ms)) };"
        );
        return value;
      }
      const [r] = await session.calls([{ tool: "query_events", args: {}, fields: ["level", "latency_ms"] }]);
      const events = Array.isArray(r.json) ? r.json : [];
      const errors = events.filter((e) => e.level === "error");
      return { errors: errors.length, maxErrorLatency: errors.reduce((max, e) => Math.max(max, e.latency_ms), 0) };
    },
  },

  html_docs: {
    title: "HTML documentation retrieval",
    tests: "HTML → Markdown quality",
    query: "fetch documentation page",
    check: (answer) => answer?.value === EXPECTED.html_docs.value,
    async run(session) {
      await session.prepare({ query: this.query, tools: ["fetch_doc"] });
      if (session.strategy === "run_chain") {
        const { value } = await session.chain(
          'const html = await servers.suite.fetch_doc({ page: "client-config" });' +
            'const text = html.replace(/<style[\\s\\S]*?<\\/style>|<script[\\s\\S]*?<\\/script>|<[^>]+>/g, " ");' +
            "const m = text.match(/request_timeout\\W+(\\d+s)/);" +
            "return { value: m ? m[1] : null };"
        );
        return value;
      }
      const [r] = await session.calls([{ tool: "fetch_doc", args: { page: "client-config" } }]);
      const match = stripTags(r.text).match(/request_timeout\W+(\d+s)/);
      return { value: match ? match[1] : null };
    },
  },
};

// ─── runner ──────────────────────────────────────────────────────────────────

async function runCell(rt, workload, strategy, size, catalog, ctx) {
  const { rounds, warmup, turnMs, prefillMsPer1k, lookup, cache, directOutputCap, turnMsSweep } = ctx;
  const latencies = [];
  const observations = [];
  let correctRounds = 0;
  let error = null;
  for (let round_ = 0; round_ < rounds + warmup; round_++) {
    const session = new Session(rt, { strategy, catalog, lookup, cache, directOutputCap });
    const started = performance.now();
    let answer;
    let failure = null;
    try {
      await session.init();
      answer = await workload.run(session);
      session.finish();
    } catch (err) {
      failure = err.message;
    }
    const elapsed = performance.now() - started;
    session.close();
    if (round_ < warmup) continue;
    latencies.push(elapsed);
    if (!failure && Boolean(workload.check(answer))) correctRounds += 1;
    if (failure) error = failure;
    observations.push({
      turns: session.turns,
      modelCalls: session.modelCalls,
      discoveryTurns: session.discoveryTurns,
      truncatedResults: session.truncatedResults,
      schemaTokens: session.schemaTokens,
      requestTokens: session.requestTokens,
      responseTokens: session.responseTokens,
      inputTokens: session.cumulativeInput,
      effectiveInput: session.effectiveInput,
      discoveryRank: session.discoveryRank,
    });
  }
  // Counts are deterministic except where a result handle's random id lands in the text (a few
  // tokens), so report the median and the spread rather than the first round.
  const median = (field) => percentile(observations.map((o) => o[field]), 0.5);
  const inputs = observations.map((o) => o.inputTokens);
  const dist = distribution(latencies);
  const turns = median("turns");
  const schema = median("schemaTokens");
  const requests = median("requestTokens");
  const responses = median("responseTokens");
  const input = median("inputTokens");
  const prefillMs = (input / 1000) * prefillMsPer1k;
  const modeledAt = (perTurn) => round(dist.p50 + turns * perTurn + prefillMs, 0);
  return {
    workload: workload.id,
    strategy,
    lookup: isDirect(strategy) ? null : lookup,
    catalogTools: size,
    correct: correctRounds === rounds,
    correctRounds,
    rounds,
    ...(error ? { error } : {}),
    turns,
    modelCalls: median("modelCalls"),
    discoveryTurns: median("discoveryTurns"),
    truncatedResults: median("truncatedResults"),
    discoveryRank: observations[0].discoveryRank,
    tokens: {
      schema,
      requests,
      responses,
      context: schema + requests + responses,
      input,
      // Prompt-caching model: static prefix cached after the first turn, conversation not (see Session.readConversation).
      effectiveInput: Math.round(median("effectiveInput")),
    },
    tokenSpread: Math.max(...inputs) - Math.min(...inputs),
    // Wall-clock of all tool traffic in the run (broker meta-tools and upstream calls, fresh server
    // process each round). No model involved.
    latencyMs: dist,
    // Assumed model time (turns × turnMs + input tokens read × prefill rate), added to the measured tool time.
    modelMs: round(turns * turnMs + prefillMs, 0),
    modeledMs: modeledAt(turnMs),
    modeledMsSweep: Object.fromEntries(turnMsSweep.map((ms) => [ms, modeledAt(ms)])),
  };
}

/** Run a labeled set through the ranker at several catalog sizes. */
function discoverySetRows(rt, setName, file, sizes, seed, rounds) {
  const set = rt.discoveryEval.loadDiscoveryEvalSet(join(SCRIPTS_ROOT, "fixtures", file));
  const toolCount = Object.values(set.servers).reduce((n, s) => n + s.tools.length, 0);
  const out = [];
  for (const size of sizes) {
    const distractors = Math.max(0, Math.ceil((size - 6) / 5));
    const router = rt.discoveryEval.buildEvalRouter(set, rt.discoveryEval.generateDistractorServers(distractors, 5, seed));
    for (const strategy of ["lexical", "bm25"]) {
      const m = rt.discoveryEval.evaluateDiscovery(set, strategy, { router, repeat: Math.max(2, rounds) });
      out.push({
        set: setName,
        catalogSize: size,
        catalogTools: size + toolCount,
        servers: Object.keys(set.servers).length + distractors,
        strategy,
        queries: m.queries,
        recallAt1: m.recallAt1,
        recallAt3: m.recallAt3,
        recallAt5: m.recallAt5,
        mrr: m.mrr,
        wrongTopRate: m.wrongTopRate,
        emptyRate: m.emptyRate,
        latencyUs: m.latencyUs,
        byCategory: m.byCategory,
        misses: m.misses.slice(0, 12),
      });
    }
  }
  return out;
}

function discoverySection(rt, sizes, seed, rounds) {
  return [
    ...discoverySetRows(rt, "tuned", "discovery-eval.json", sizes, seed, rounds),
    ...discoverySetRows(rt, "heldout", "discovery-heldout.json", sizes, seed, rounds),
  ];
}

async function truncationSection(rt, rounds) {
  let encoder = null;
  try {
    const { Tiktoken } = await import("js-tiktoken/lite");
    const ranks = (await import("js-tiktoken/ranks/o200k_base")).default;
    encoder = new Tiktoken(ranks);
  } catch {
    encoder = null;
  }
  // No memo: each sample pays the full tokenization cost, like a first call on a fresh response.
  const tokenizer = encoder
    ? { name: "o200k_base", countTokens: (text) => encoder.encode(text, [], []).length }
    : undefined;
  const text = Array.from({ length: 4000 }, (_, i) => `Line ${i}: the quick brown fox {"id":${i}} jumps over.`).join("\n");
  const items = Array.from({ length: 3000 }, (_, id) => ({ id, title: `Record ${id}`, body: "x y z ".repeat(10) }));
  const cases = [
    { name: "text_230KB", result: { content: [{ type: "text", text }] } },
    { name: "json_array_300KB", result: { content: [], structuredContent: { items } } },
  ];
  const context = { serverName: "suite", toolName: "bench", source: "call_tool" };
  const out = [];
  for (const budget of [500, 2000, 8000]) {
    for (const c of cases) {
      const samples = [];
      let metrics;
      let tokenizerCalls = 0;
      let tokenizedChars = 0;
      const counting = tokenizer
        ? {
            name: tokenizer.name,
            countTokens(value) {
              tokenizerCalls += 1;
              tokenizedChars += value.length;
              return tokenizer.countTokens(value);
            },
          }
        : undefined;
      const n = Math.max(5, rounds * 3);
      for (let i = 0; i < n + 1; i++) {
        tokenizerCalls = 0;
        tokenizedChars = 0;
        const started = performance.now();
        const optimized = await rt.optimizer.optimizeToolResult(c.result, { mode: "off", maxTokens: budget }, context, undefined, counting);
        const elapsed = performance.now() - started;
        metrics = optimized.metrics;
        if (i > 0) samples.push(elapsed);
      }
      out.push({
        case: c.name,
        budgetTokens: budget,
        tokenizer: tokenizer ? "o200k_base" : "chars_per_4",
        withinBudget: metrics.optimizedTokens <= budget,
        optimizedTokens: metrics.optimizedTokens,
        tokenizerCalls,
        tokenizedChars,
        latencyMs: distribution(samples),
      });
    }
  }
  return out;
}

/** The broker logs activation and optimization events to stderr; keep them out of the report run. */
async function withQuietBroker(fn) {
  const original = console.error;
  console.error = (...args) => {
    if (typeof args[0] === "string" && args[0].startsWith("[lazygate]")) return;
    original(...args);
  };
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

export async function runSuite(options = {}) {
  const lookup = options.lookup ?? "cold";
  const directOutputCap = options.directOutputCap ?? 25_000;
  const defaultStrategies = STRATEGIES.filter((s) => s !== "direct_capped" || directOutputCap > 0);
  const opts = {
    sizes: options.sizes ?? DEFAULT_SIZES,
    rounds: options.rounds ?? DEFAULT_ROUNDS,
    warmup: options.warmup ?? 1,
    workloads: options.workloads ?? WORKLOAD_IDS,
    strategies: options.strategies ?? defaultStrategies,
    tokenizer: options.tokenizer ?? "o200k_base",
    turnMs: options.turnMs ?? 1500,
    turnMsSweep: options.turnMsSweep ?? [500, 1500, 3000],
    prefillMsPer1k: options.prefillMsPer1k ?? 20,
    lookup,
    cache: {
      readDiscount: options.cacheReadDiscount ?? 0.1,
      writePremium: options.cacheWritePremium ?? 1.25,
    },
    directOutputCap,
    schemaTokensPerTool: options.schemaTokensPerTool ?? null,
    catalogFrom: options.catalogFrom ?? null,
    retryTurns: options.retryTurns ?? 1,
    lookupRounds: options.lookupRounds ?? Math.min(options.rounds ?? DEFAULT_ROUNDS, 3),
    lookupComparison: options.lookupComparison ?? true,
    seed: options.seed ?? 1,
    log: options.log ?? (() => {}),
  };
  if (!LOOKUPS.includes(opts.lookup)) throw new Error(`unknown lookup mode ${opts.lookup} (${LOOKUPS.join(", ")})`);
  const rt = await loadRuntime(opts.tokenizer);
  return withQuietBroker(() => runSuiteWith(rt, opts));
}

async function runSuiteWith(rt, opts) {
  let profile = null;
  let schemaTokensPerTool = opts.schemaTokensPerTool;
  if (opts.catalogFrom) {
    profile = catalogProfile(rt, opts.catalogFrom);
    schemaTokensPerTool = schemaTokensPerTool ?? profile.averageSchemaTokens;
  }

  opts.log("  discovery evaluation");
  const discovery = discoverySection(rt, opts.sizes, opts.seed, opts.rounds);

  const results = [];
  const catalogs = [];
  const lookupModes = [];
  const cellCtx = (rounds, lookup) => ({
    rounds,
    warmup: opts.warmup,
    turnMs: opts.turnMs,
    turnMsSweep: opts.turnMsSweep,
    prefillMsPer1k: opts.prefillMsPer1k,
    lookup,
    cache: opts.cache,
    directOutputCap: opts.directOutputCap,
  });
  for (const size of opts.sizes) {
    const catalog = buildCatalog(rt, size, opts.seed, schemaTokensPerTool);
    const directSchema = rt.count(JSON.stringify(catalog.allTools));
    catalogs.push({
      tools: size,
      directSchemaTokens: directSchema,
      averageTokensPerTool: round(directSchema / catalog.allTools.length, 1),
    });
    for (const id of opts.workloads) {
      const workload = { id, ...WORKLOADS[id] };
      for (const strategy of opts.strategies) {
        opts.log(`  ${size} tools · ${id} · ${strategy} (${opts.lookup})`);
        results.push(await runCell(rt, workload, strategy, size, catalog, cellCtx(opts.rounds, opts.lookup)));
      }
      if (opts.lookupComparison) {
        for (const strategy of LOOKUP_COMPARE_STRATEGIES.filter((s) => opts.strategies.includes(s))) {
          for (const lookup of LOOKUPS) {
            opts.log(`  ${size} tools · ${id} · ${strategy} · lookup ${lookup}`);
            const cell = await runCell(rt, workload, strategy, size, catalog, cellCtx(opts.lookupRounds, lookup));
            lookupModes.push({ ...cell, lookup });
          }
        }
      }
    }
  }
  attachDiscoveryCost(results, discovery, opts);
  attachDiscoveryCost(lookupModes, discovery, opts);

  opts.log("  truncation latency");
  const truncation = await truncationSection(rt, opts.rounds);

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: `${platform()}-${arch()}`,
      cpus: cpus().length,
    },
    config: {
      catalogSizes: opts.sizes,
      rounds: opts.rounds,
      lookupRounds: opts.lookupRounds,
      warmupRounds: opts.warmup,
      workloads: opts.workloads,
      strategies: opts.strategies,
      lookup: opts.lookup,
      tokenizer: rt.tokenizerName,
      turnMs: opts.turnMs,
      turnMsSweep: opts.turnMsSweep,
      prefillMsPer1k: opts.prefillMsPer1k,
      cacheReadDiscount: opts.cache.readDiscount,
      cacheWritePremium: opts.cache.writePremium,
      directOutputCap: opts.directOutputCap,
      schemaTokensPerTool: schemaTokensPerTool ?? null,
      catalogFrom: profile,
      pinnedTools: PINNED_TOOLS,
      retryTurns: opts.retryTurns,
      seed: opts.seed,
    },
    method: methodNotes(opts),
    catalogs,
    results,
    lookupModes,
    discovery,
    truncation,
  };
}

function methodNotes(opts) {
  return {
    agent: "scripted oracle: always issues a correct call or script; measures cost and information loss, not model behaviour",
    tokens: "input = tokens read by the model across all turns without prompt caching (schemas + prompt + every earlier call and result); context = schemas + calls + results counted once",
    effective: `effective input (a model, not a measurement) = the static prefix (prompt + tool schemas) is written to the cache on the first turn at ${opts.cache.writePremium}× and read at ${opts.cache.readDiscount}× on every later turn, while everything the conversation added since (calls and results) is billed at 1×; conservative because earlier turns are not assumed cached either`,
    turns: "model turns including the closing answer turn; parallel calls in one turn count once",
    latency: "tool ms = wall-clock of all tool traffic per round, median with min–max (fresh server process each round, so cold start is included for every strategy); no model involved. A 95th percentile is only shown from " + MIN_P95_SAMPLES + " samples on, otherwise the maximum",
    modeled: `modeled ms = tool ms (median) + assumed model time: turns × ${opts.turnMs} ms + input tokens ÷ 1000 × ${opts.prefillMsPer1k} ms (raw input); the turn-time sweep repeats it for ${opts.turnMsSweep.join(" / ")} ms per turn. These are assumptions to explore sensitivity, not measurements`,
    lookups: "cold: discover_tools, then describe_tool, then call (2 extra turns; the agent ignores the inline signatures). merged: discover_tools returns the signature of the best-matching tool(s) and the agent calls straight away (1 extra turn; a describe_tool turn is added only when a needed signature is missing). known: the agent already knows the server and the signatures (0 extra turns). The main tables use `" + opts.lookup + "`; the cold-start section compares all three",
    pinned: `pinned: lazygate with expose = [${PINNED_TOOLS.join(", ")}] merged into tools/list (their schemas are in context every turn, no lookup turns); every other tool goes through discover_tools, describe_tool and call_tool`,
    directCap: opts.directOutputCap > 0
      ? `direct_capped: like direct, but a client that truncates MCP output at ${fmt(opts.directOutputCap)} tokens cuts larger tool results (the oracle then works with the truncated text); direct is the uncapped upper bound`
      : "direct_capped is off (--direct-output-cap 0)",
    schemas: opts.schemaTokensPerTool
      ? `filler tool schemas are sized toward ${opts.schemaTokensPerTool} tokens each${opts.catalogFrom ? ` (average of ${opts.catalogFrom})` : ""}; the tables' catalog notes give the measured average`
      : "filler tool schemas use the built-in 3-property template (see the measured tokens per tool next to each catalog); use --schema-tokens-per-tool or --catalog-from to size them from a real catalog",
    discoveryCost: `exp. turns / exp. ms add the held-out wrong-tool rate × ${opts.retryTurns} retry turn(s) for every run that used discover_tools (a modeled penalty: a wrong top result costs the agent another discovery turn); the oracle itself never gets it wrong`,
    catalog: "direct puts every tool schema in context; lazygate strategies list only the meta-tools (pinned adds a few tools) and pay discover_tools / describe_tool turns",
  };
}

/**
 * Fold the discovery wrong-tool rate into an end-to-end estimate: a run that used discover_tools
 * pays `wrongTopRate × retryTurns` extra turns (each costing a turn plus the average input read).
 */
function attachDiscoveryCost(rows, discovery, opts) {
  for (const r of rows) {
    const held = discovery.find((d) => d.set === "heldout" && d.strategy === "bm25" && d.catalogSize === r.catalogTools);
    const rate = held?.wrongTopRate ?? 0;
    const retries = r.discoveryTurns > 0 ? rate * opts.retryTurns : 0;
    r.expected = {
      wrongToolRate: r.discoveryTurns > 0 ? rate : 0,
      turns: round(r.turns + retries, 2),
      modeledMs: round(r.modeledMs + retries * (opts.turnMs + (r.tokens.input / r.turns / 1000) * opts.prefillMsPer1k), 0),
    };
  }
}

// ─── baseline comparison ─────────────────────────────────────────────────────

const key = (r) => `${r.workload}|${r.strategy}|${r.catalogTools}`;
const lookupKey = (r) => `${key(r)}|${r.lookup}`;
const discoveryKey = (d) => `${d.set ?? "tuned"}|${d.servers}|${d.strategy}`;

/** Deterministic subset of a report (no latency, no timestamps): what CI compares. */
export function baselineOf(report) {
  return {
    schemaVersion: report.schemaVersion,
    config: {
      catalogSizes: report.config.catalogSizes,
      tokenizer: report.config.tokenizer,
      seed: report.config.seed,
      lookup: report.config.lookup,
    },
    results: report.results.map((r) => ({
      workload: r.workload,
      strategy: r.strategy,
      catalogTools: r.catalogTools,
      correct: r.correct,
      turns: r.turns,
      tokens: { schema: r.tokens.schema, context: r.tokens.context, input: r.tokens.input, effectiveInput: r.tokens.effectiveInput },
    })),
    lookupModes: (report.lookupModes ?? []).map((r) => ({
      workload: r.workload,
      strategy: r.strategy,
      lookup: r.lookup,
      catalogTools: r.catalogTools,
      correct: r.correct,
      turns: r.turns,
      tokens: { input: r.tokens.input },
    })),
    discovery: report.discovery.map((d) => ({
      set: d.set ?? "tuned",
      servers: d.servers,
      strategy: d.strategy,
      queries: d.queries,
      recallAt1: d.recallAt1,
      recallAt3: d.recallAt3,
      wrongTopRate: d.wrongTopRate,
    })),
    truncation: report.truncation.map((t) => ({
      case: t.case,
      budgetTokens: t.budgetTokens,
      withinBudget: t.withinBudget,
      tokenizerCalls: t.tokenizerCalls,
      tokenizedChars: t.tokenizedChars,
    })),
  };
}

/**
 * Compare a report to a baseline. Returns human-readable regressions: a result that was correct is
 * not, turns went up, input tokens grew past `tolerance`, discovery got worse (tuned and held-out
 * sets), or the optimizer tokenizes noticeably more. Entries missing from the current report are
 * skipped (partial runs). Only deterministic fields are compared (never latency or modeled time).
 */
export function compareToBaseline(report, baseline, { tolerance = 0.05 } = {}) {
  const problems = [];
  const compareRows = (rows, baseRows, keyOf, tag) => {
    const current = new Map((rows ?? []).map((r) => [keyOf(r), r]));
    for (const base of baseRows ?? []) {
      const now = current.get(keyOf(base));
      if (!now) continue;
      const label = `${base.workload}/${base.strategy}${base.lookup ? `[${base.lookup}]` : ""}@${base.catalogTools}${tag}`;
      if (base.correct && !now.correct) problems.push(`${label}: no longer answers correctly`);
      if (now.turns > base.turns) problems.push(`${label}: turns ${base.turns} → ${now.turns}`);
      if (now.tokens.input > base.tokens.input * (1 + tolerance)) {
        problems.push(`${label}: input tokens ${base.tokens.input} → ${now.tokens.input} (+${round(((now.tokens.input / base.tokens.input) - 1) * 100)}%)`);
      }
    }
  };
  compareRows(report.results, baseline.results, key, "");
  compareRows(report.lookupModes, baseline.lookupModes, lookupKey, " (lookup modes)");
  const discovery = new Map(report.discovery.map((d) => [discoveryKey(d), d]));
  for (const base of baseline.discovery ?? []) {
    const now = discovery.get(discoveryKey(base));
    if (!now) continue;
    const label = `discovery/${base.set ?? "tuned"}/${base.strategy}@${base.servers} servers`;
    if (now.recallAt1 < base.recallAt1 - 0.02) problems.push(`${label}: Recall@1 ${base.recallAt1} → ${now.recallAt1}`);
    if (now.recallAt3 < base.recallAt3 - 0.02) problems.push(`${label}: Recall@3 ${base.recallAt3} → ${now.recallAt3}`);
    if (now.wrongTopRate > base.wrongTopRate + 0.02) problems.push(`${label}: wrong-tool rate ${base.wrongTopRate} → ${now.wrongTopRate}`);
  }
  const truncation = new Map(report.truncation.map((t) => [`${t.case}|${t.budgetTokens}`, t]));
  for (const base of baseline.truncation ?? []) {
    const now = truncation.get(`${base.case}|${base.budgetTokens}`);
    if (!now) continue;
    const label = `truncation/${base.case}@${base.budgetTokens}`;
    if (base.withinBudget && !now.withinBudget) problems.push(`${label}: output exceeds the budget`);
    if (now.tokenizedChars > base.tokenizedChars * (1 + tolerance * 2)) {
      problems.push(`${label}: tokenized chars ${base.tokenizedChars} → ${now.tokenizedChars}`);
    }
  }
  return problems;
}

// ─── reporting ───────────────────────────────────────────────────────────────

const fmt = (n) => Number(n).toLocaleString("en-US");
const pct = (now, base) => (base ? `${now <= base ? "" : "+"}${round(((now - base) / base) * 100, 0)}%` : "—");
const titleOf = (id) => WORKLOADS[id]?.title ?? id;

/** `p50 [min–max]`, plus a p95 when there are enough samples to call it one. */
function latencyCell(d) {
  const range = `${d.p50} [${d.min}–${d.max}]`;
  return d.p95 === null || d.p95 === undefined ? range : `${range} · p95 ${d.p95}`;
}

export function toMarkdown(report) {
  const out = [];
  const { config } = report;
  const lazygate = (r) => r.strategy !== "direct" && r.strategy !== "direct_capped";
  out.push("# LazyGate benchmark suite");
  out.push("");
  out.push(
    `Generated ${report.generatedAt} on Node ${report.environment.node} (${report.environment.platform}, ${report.environment.cpus} CPUs). ` +
      `Tokenizer \`${config.tokenizer}\`, ${config.rounds} timed rounds after ${config.warmupRounds} warm-up, seed ${config.seed}; lazygate lookup mode \`${config.lookup}\`.`
  );
  out.push("");
  out.push(
    `Scripted oracle agent against real MCP traffic: it always issues a correct call or script, so these numbers show what each strategy costs and whether the answer survives, not how a model behaves. Turn counts and tokens are reproducible (result-handle ids add a few tokens of jitter); tool latency varies by machine. Everything labeled "modeled", "effective" or "exp." is a model with stated assumptions (see Method), not a measurement.`
  );
  out.push("");

  const bySize = new Map();
  for (const r of report.results) {
    if (!bySize.has(r.catalogTools)) bySize.set(r.catalogTools, []);
    bySize.get(r.catalogTools).push(r);
  }
  for (const [size, rows] of bySize) {
    const info = report.catalogs?.find((c) => c.tools === size);
    out.push(`## Catalog of ${size} tools`);
    out.push("");
    if (info) {
      out.push(`Direct MCP carries ${fmt(info.directSchemaTokens)} schema tokens per turn (${info.averageTokensPerTool} tokens per tool on average).`);
      out.push("");
    }
    out.push("| Workload | Strategy | Correct | Turns | Input tokens | vs direct | Effective input | Context tokens | Tool ms p50 [min–max] | Model ms (assumed) | Modeled ms | Exp. turns† | Exp. ms† |");
    out.push("|---|---|:-:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|");
    for (const r of rows) {
      const direct = rows.find((x) => x.workload === r.workload && x.strategy === "direct");
      const effective = direct && r.strategy !== "direct"
        ? `${fmt(r.tokens.effectiveInput)} (${pct(r.tokens.effectiveInput, direct.tokens.effectiveInput)})`
        : fmt(r.tokens.effectiveInput);
      const expected = lazygate(r) ? `${r.expected.turns} | ${fmt(r.expected.modeledMs)}` : "— | —";
      out.push(
        `| ${titleOf(r.workload)} | ${r.strategy} | ${r.correct ? "yes" : `**no** (${r.correctRounds}/${r.rounds})`} | ${r.turns} | ${fmt(r.tokens.input)} | ${r.strategy === "direct" || !direct ? "—" : pct(r.tokens.input, direct.tokens.input)} | ${effective} | ${fmt(r.tokens.context)} | ${latencyCell(r.latencyMs)} | ${fmt(r.modelMs)} | ${fmt(r.modeledMs)} | ${expected} |`
      );
    }
    out.push("");
    out.push("† lazygate strategies only: adds the held-out wrong-tool rate × retry turns for runs that used `discover_tools` (a modeled penalty).");
    out.push("");
    // Best correct strategy per workload.
    const best = [];
    for (const id of config.workloads) {
      const candidates = rows.filter((r) => r.workload === id && r.correct);
      if (!candidates.length) continue;
      const cheapest = candidates.reduce((a, b) => (b.tokens.effectiveInput < a.tokens.effectiveInput ? b : a));
      const cheapestRaw = candidates.reduce((a, b) => (b.tokens.input < a.tokens.input ? b : a));
      const fastest = candidates.reduce((a, b) => (b.modeledMs < a.modeledMs ? b : a));
      best.push(`${titleOf(id)}: cheapest \`${cheapestRaw.strategy}\` (raw input) / \`${cheapest.strategy}\` (effective, cached prefix), fastest (modeled) \`${fastest.strategy}\``);
    }
    if (best.length) {
      out.push(...best.map((line) => `- ${line}`));
      out.push("");
    }
  }

  if (report.lookupModes?.length) {
    out.push("## Cold start: discover → describe → call vs merged discovery vs known tools");
    out.push("");
    out.push(
      `Same oracle, three ways of learning the call shape (see Method → lookups). Median of ${config.lookupRounds} rounds; turns and tokens are deterministic. "Exp. ms†" folds in the held-out wrong-tool rate.`
    );
    out.push("");
    const sizes = [...new Set(report.lookupModes.map((r) => r.catalogTools))];
    for (const size of sizes) {
      const rows = report.lookupModes.filter((r) => r.catalogTools === size);
      out.push(`### ${size} tools`);
      out.push("");
      out.push("| Workload | Strategy | Cold turns | Merged turns | Known turns | Cold input | Merged input | Known input | Cold modeled ms | Merged modeled ms | Known modeled ms | Merged exp. ms† |");
      out.push("|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|");
      for (const id of config.workloads) {
        for (const strategy of LOOKUP_COMPARE_STRATEGIES) {
          const at = (lookup) => rows.find((r) => r.workload === id && r.strategy === strategy && r.lookup === lookup);
          const [cold, merged, known] = [at("cold"), at("merged"), at("known")];
          if (!cold || !merged || !known) continue;
          out.push(
            `| ${titleOf(id)} | ${strategy} | ${cold.turns} | ${merged.turns} | ${known.turns} | ${fmt(cold.tokens.input)} | ${fmt(merged.tokens.input)} | ${fmt(known.tokens.input)} | ${fmt(cold.modeledMs)} | ${fmt(merged.modeledMs)} | ${fmt(known.modeledMs)} | ${fmt(merged.expected.modeledMs)} |`
          );
        }
      }
      out.push("");
    }
  }

  // Turn-time sensitivity: where the fastest strategy flips.
  if (config.turnMsSweep?.length > 1) {
    out.push("## Turn-time sensitivity (modeled)");
    out.push("");
    out.push(
      `Modeled ms (tool ms + turns × per-turn model time + input ÷ 1000 × ${config.prefillMsPer1k} ms) for the fastest correct strategy per workload at each assumed model time per turn. Where the winner changes between columns the ranking depends on how slow the model is — the sweep is the answer, not any single column.`
    );
    out.push("");
    const sweep = config.turnMsSweep;
    out.push(`| Catalog | Workload | ${sweep.map((ms) => `${fmt(ms)} ms/turn`).join(" | ")} | Flips |`);
    out.push(`|--:|---|${sweep.map(() => "---").join("|")}|:-:|`);
    for (const [size, rows] of bySize) {
      for (const id of config.workloads) {
        const candidates = rows.filter((r) => r.workload === id && r.correct);
        if (!candidates.length) continue;
        const winners = sweep.map((ms) => candidates.reduce((a, b) => (b.modeledMsSweep[ms] < a.modeledMsSweep[ms] ? b : a)));
        const flips = new Set(winners.map((w) => w.strategy)).size > 1;
        out.push(
          `| ${size} | ${titleOf(id)} | ${winners.map((w, i) => `${w.strategy} (${fmt(w.modeledMsSweep[sweep[i]])})`).join(" | ")} | ${flips ? "**yes**" : "no"} |`
        );
      }
    }
    out.push("");
  }

  out.push("## Tool discovery");
  out.push("");
  out.push(
    "What `discover_tools` would show (confident matches, top 5) for a labeled query set; the expected server must be ranked. `wrong-tool` = a different server ranked first. **tuned** is the set the ranker and alias table were developed against; **held-out** was written afterwards, against its own catalog of near-duplicate neighbors (github/gitlab/bitbucket, mysql/postgres/sqlite, s3/gcs/azure-blob, …), and nothing was tuned to it, so it is the number to trust."
  );
  out.push("");
  const tail = report.discovery.every((d) => d.queries >= MIN_P95_SAMPLES) ? "p95" : "max";
  out.push(`| Set | Servers | Ranker | Queries | Recall@1 | Recall@3 | Recall@5 | MRR | Wrong-tool | No result | p50 µs | ${tail} µs |`);
  out.push("|---|--:|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|");
  for (const d of report.discovery) {
    out.push(
      `| ${d.set ?? "tuned"} | ${d.servers} | ${d.strategy} | ${d.queries} | ${d.recallAt1} | ${d.recallAt3} | ${d.recallAt5} | ${d.mrr} | ${d.wrongTopRate} | ${d.emptyRate} | ${d.latencyUs.p50} | ${d.latencyUs.p95} |`
    );
  }
  out.push("");
  const heldMisses = report.discovery.find((d) => d.set === "heldout" && d.strategy === "bm25" && d.misses?.length);
  if (heldMisses) {
    out.push(`Held-out queries whose server was not in the top 3 (bm25, ${heldMisses.servers} servers):`);
    out.push("");
    for (const m of heldMisses.misses) out.push(`- "${m.query}" → expected \`${m.expect}\`, got ${m.got.length ? m.got.map((g) => `\`${g}\``).join(", ") : "nothing"}`);
    out.push("");
  }

  out.push("## Optimizer latency on large responses");
  out.push("");
  out.push("`optimizeToolResult` with an output token budget (uncached tokenizer, so each sample counts from scratch).");
  out.push("");
  const truncTail = report.truncation.every((t) => t.latencyMs.p95 !== null && t.latencyMs.p95 !== undefined) ? "p95" : "max";
  out.push(`| Case | Budget | Output tokens | Within budget | Tokenizer calls | Chars tokenized | p50 ms | ${truncTail} ms | Samples |`);
  out.push("|---|--:|--:|:-:|--:|--:|--:|--:|--:|");
  for (const t of report.truncation) {
    out.push(
      `| ${t.case} | ${fmt(t.budgetTokens)} | ${fmt(t.optimizedTokens)} | ${t.withinBudget ? "yes" : "**no**"} | ${t.tokenizerCalls} | ${fmt(t.tokenizedChars)} | ${t.latencyMs.p50} | ${t.latencyMs.p95 ?? t.latencyMs.max} | ${t.latencyMs.samples} |`
    );
  }
  out.push("");
  out.push("## Method");
  out.push("");
  for (const [name, text] of Object.entries(report.method)) out.push(`- **${name}**: ${text}`);
  out.push("");
  return out.join("\n");
}

export function writeReports(report, outDir) {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, "suite.json");
  const mdPath = join(outDir, "suite.md");
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n");
  writeFileSync(mdPath, toMarkdown(report));
  return { jsonPath, mdPath };
}

/** CLI entry used by benchmark.mjs. `get(flag)` / `has(flag)` read the process arguments. */
export async function suiteMain({ get, has }) {
  const intList = (value) => value.split(",").map((n) => Number.parseInt(n, 10));
  const quick = has("--quick");
  const sizes = get("--catalog-sizes") ? intList(get("--catalog-sizes")) : quick ? QUICK_SIZES : DEFAULT_SIZES;
  const rounds = Number.parseInt(get("--rounds") ?? String(quick ? QUICK_ROUNDS : DEFAULT_ROUNDS), 10);
  const workloads = get("--workloads") ? get("--workloads").split(",") : WORKLOAD_IDS;
  const directOutputCap = Number.parseInt(get("--direct-output-cap") ?? "25000", 10);
  const strategies = get("--strategies")
    ? get("--strategies").split(",")
    : STRATEGIES.filter((s) => s !== "direct_capped" || directOutputCap > 0);
  const turnMsSweep = get("--turn-ms-sweep") ? intList(get("--turn-ms-sweep")) : [500, 1500, 3000];
  const cacheReadDiscount = Number.parseFloat(get("--cache-read-discount") ?? "0.1");
  const cacheWritePremium = Number.parseFloat(get("--cache-write-premium") ?? "1.25");
  const schemaTokensPerTool = get("--schema-tokens-per-tool") ? Number.parseInt(get("--schema-tokens-per-tool"), 10) : null;
  const retryTurns = Number.parseFloat(get("--retry-turns") ?? "1");
  const lookup = has("--known-tools") ? "known" : has("--merged-discovery") ? "merged" : "cold";
  const problems = [];
  if (has("--known-tools") && has("--merged-discovery")) problems.push("--known-tools and --merged-discovery are mutually exclusive");
  if (sizes.some((n) => !Number.isInteger(n) || n < SUITE_TOOLS.length || n > 5000)) problems.push(`--catalog-sizes must be integers from ${SUITE_TOOLS.length} to 5000`);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100) problems.push("--rounds must be an integer from 1 to 100");
  if (!Number.isInteger(directOutputCap) || directOutputCap < 0) problems.push("--direct-output-cap must be a non-negative integer (0 = off)");
  if (turnMsSweep.some((n) => !Number.isInteger(n) || n < 0)) problems.push("--turn-ms-sweep must be a comma-separated list of non-negative integers");
  if (!(cacheReadDiscount >= 0 && cacheReadDiscount <= 1)) problems.push("--cache-read-discount must be between 0 and 1");
  if (!(cacheWritePremium >= 1 && cacheWritePremium <= 5)) problems.push("--cache-write-premium must be between 1 and 5");
  if (schemaTokensPerTool !== null && (!Number.isInteger(schemaTokensPerTool) || schemaTokensPerTool < 20 || schemaTokensPerTool > 5000)) {
    problems.push("--schema-tokens-per-tool must be an integer from 20 to 5000");
  }
  if (!(retryTurns >= 0 && retryTurns <= 10)) problems.push("--retry-turns must be between 0 and 10");
  for (const id of workloads) if (!WORKLOAD_IDS.includes(id)) problems.push(`unknown workload ${id} (${WORKLOAD_IDS.join(", ")})`);
  for (const s of strategies) if (!STRATEGIES.includes(s)) problems.push(`unknown strategy ${s} (${STRATEGIES.join(", ")})`);
  if (strategies.includes("direct_capped") && directOutputCap === 0) problems.push("direct_capped needs --direct-output-cap above 0");
  if (problems.length) {
    for (const p of problems) console.error(`✗ ${p}`);
    return 1;
  }
  const baselinePath = get("--baseline");
  if (baselinePath && !existsSync(baselinePath)) {
    console.error(`✗ baseline file not found: ${baselinePath}`);
    return 1;
  }

  console.error(`lazygate benchmark suite: ${workloads.length} workloads × ${strategies.length} strategies × ${sizes.join("/")} tools, ${rounds} rounds, lookup ${lookup}`);
  let report;
  try {
    report = await runSuite({
      sizes,
      rounds,
      workloads,
      strategies,
      lookup,
      tokenizer: get("--tokenizer") ?? "o200k_base",
      turnMs: Number.parseInt(get("--turn-ms") ?? "1500", 10),
      turnMsSweep,
      prefillMsPer1k: Number.parseFloat(get("--prefill-ms-per-1k") ?? "20"),
      cacheReadDiscount,
      cacheWritePremium,
      directOutputCap,
      schemaTokensPerTool,
      catalogFrom: get("--catalog-from") ?? null,
      retryTurns,
      lookupComparison: !has("--no-lookup-comparison"),
      seed: Number.parseInt(get("--seed") ?? "1", 10),
      log: (line) => console.error(line),
    });
  } catch (err) {
    console.error(`✗ ${err.message}`);
    return 1;
  }

  const outDir = resolve(get("--out-dir") ?? "benchmark-results");
  const { jsonPath, mdPath } = writeReports(report, outDir);
  if (has("--json")) console.log(JSON.stringify(report, null, 2));
  else console.log(toMarkdown(report));
  console.error(`\nWrote ${jsonPath}\n      ${mdPath}`);

  const writeBaseline = get("--write-baseline");
  if (writeBaseline) {
    mkdirSync(dirname(resolve(writeBaseline)), { recursive: true });
    writeFileSync(resolve(writeBaseline), JSON.stringify(baselineOf(report), null, 2) + "\n");
    console.error(`Wrote baseline ${resolve(writeBaseline)}`);
  }

  let exit = 0;
  const wrong = report.results.filter((r) => !r.correct);
  if (wrong.length) {
    console.error(`\n${wrong.length} result(s) did not answer correctly:`);
    for (const r of wrong) console.error(`  ✗ ${r.workload}/${r.strategy}@${r.catalogTools}${r.error ? `: ${r.error}` : ""}`);
    // A strategy that loses information is a finding, not a harness failure; only baseline
    // regressions fail the run.
  }
  if (baselinePath) {
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    const regressions = compareToBaseline(report, baseline, {
      tolerance: Number.parseFloat(get("--tolerance") ?? "0.05"),
    });
    if (regressions.length) {
      console.error(`\n${regressions.length} regression(s) against ${baselinePath}:`);
      for (const line of regressions) console.error(`  ✗ ${line}`);
      exit = 1;
    } else {
      console.error(`\nNo regressions against ${baselinePath}.`);
    }
  }
  return exit;
}
