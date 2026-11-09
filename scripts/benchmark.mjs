#!/usr/bin/env node
// Benchmarks token usage across MCP and skill loading strategies.
//
// Runners:
//   claude  — `claude -p --output-format json` (default)
//   codex   — `codex exec --json` (e.g. --model gpt-6-luna via a custom provider)
//
// MCP strategies:
//   baseline     — no MCP servers (system prompt only)
//   mcp-direct   — all servers loaded upfront
//   lazygate     — meta-tools only (idle)
//   mcp-active   — meta-tools + all servers (worst case)
//
// Skill strategies:
//   skills-full  — every skill's full body in context (pre-lazygate / unsplit)
//   skills-stubs — frontmatter + pointer only (after lazygate split)
//   skills-one   — stubs for all + one full body loaded (typical after load_skill)
//
// Caveats: each run is a single cold-cache turn, so dollar figures overstate
// steady-state savings. Skill strategies model what a client pays when it reads
// SKILL.md into context; they do not invoke load_skill.
//
// Usage:
//   lazygate benchmark
//   lazygate benchmark --runner codex --model gpt-6-luna
//   lazygate benchmark --servers github,jira --skills loi,writer
//   lazygate benchmark --mcp-only | --skills-only
//   lazygate benchmark --rounds 3
//   lazygate benchmark --estimate   # local chars÷4 preview, no API
//   lazygate benchmark --responses  # local JSON/HTML optimizer benchmark, no API
//   lazygate benchmark --responses-live --cases benchmark-cases.json
//   lazygate benchmark --suite [--quick] [--catalog-sizes 20,100,250,500] [--rounds 5]
//                      [--out-dir benchmark-results] [--baseline benchmarks/baseline.json]
//                      [--write-baseline path] [--workloads a,b] [--strategies a,b] [--json]
//                      [--known-tools | --merged-discovery] [--turn-ms 1500] [--prefill-ms-per-1k 20]
//                      [--turn-ms-sweep 500,1500,3000] [--cache-read-discount 0.1] [--cache-write-premium 1.25]
//                      [--direct-output-cap 25000] [--schema-tokens-per-tool N | --catalog-from file]
//                      [--retry-turns 1] [--no-lookup-comparison] [--tokenizer o200k_base]
//   lazygate benchmark --tasks [--cold-discovery] [--rounds 3] [--include-catalog]
//                      live `claude -p` task; --cold-discovery starts lazygate cold (the model is not told
//                      the server or tool names and must use discover_tools); needs a logged-in claude CLI

import { execFile, spawn } from "child_process";
import { createHash } from "crypto";
import { promisify } from "util";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
} from "fs";
import { resolve, dirname, join } from "path";
import { homedir, tmpdir } from "os";
import { fileURLToPath, pathToFileURL } from "url";

const execFileAsync = promisify(execFile);

function runSpawn(command, args, { env, input = null, timeout = 180_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      const err = new Error(`timeout after ${timeout}ms`);
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    }, timeout);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code && code !== 0) {
        const err = new Error(`${command} exited ${code}`);
        err.stdout = stdout;
        err.stderr = stderr;
        err.code = code;
        reject(err);
        return;
      }
      resolvePromise({ stdout, stderr });
    });
    if (input != null) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

// ─── CLI args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
};
const has = (flag) => args.includes(flag);

// Reproducible end-to-end suite (no model, no network): see scripts/lib/suite.mjs.
if (has("--suite")) {
  const { suiteMain } = await import("./lib/suite.mjs");
  const code = await suiteMain({ get, has });
  // A large report on a pipe is written asynchronously: let it drain before exiting.
  await new Promise((done) => process.stdout.write("", done));
  process.exit(code);
}

const configArg = get("--config");
const skillsConfigArg = get("--skills-config");
const serverArg = get("--servers");
const skillArg = get("--skills");
const roundsArg = parseInt(get("--rounds") ?? "1", 10);
const runnerArg = (get("--runner") ?? "claude").toLowerCase();
const modelArg = get("--model");
const mcpOnly = has("--mcp-only");
const skillsOnly = has("--skills-only");
const estimateOnly = has("--estimate");
const tasksOnly = has("--tasks");
const responsesOnly = has("--responses");
const liveResponsesOnly = has("--responses-live");
const responseIterations = Number.parseInt(get("--iterations") ?? "30", 10);
const liveResponseIterations = Number.parseInt(get("--iterations") ?? "5", 10);
const responseCasesArg = get("--cases");
// --tasks runs Claude with permission checks bypassed. By default it only sees the tickets fixture;
// the user's real catalog (and its destructive tools) is loaded only with an explicit flag.
const includeCatalog = has("--include-catalog");
// --cold-discovery: the lazygate strategies start cold. The model is not told which server or tools
// exist, so it has to discover_tools → (describe_tool) → call, like a fresh agent with no skill or
// AGENTS.md hint. Without it the instructions name the server and tools (a "known tools" agent).
const coldDiscovery = has("--cold-discovery");
if (coldDiscovery && !tasksOnly) {
  console.error("--cold-discovery only applies to --tasks.");
  process.exit(1);
}
// --task a,b|all picks which tasks --tasks runs (default: all). --json writes the full results.
const taskArg = get("--task") ?? "all";
const taskFlagGiven = has("--task");
// Cold-path variants for --tasks (they only change how the lazygate strategies start):
//   --preview          fixtures opt in to previewOnDiscover (discover_tools may start the server)
//   --index warm       tool-index.json already holds the fixtures' signatures (they ran once before)
//   --manifest         fixtures list their signatures in the MCP instructions (implies --index warm)
//   --strategies a,b   run only these strategies (direct, call-tool, call-tool-optimized, run-chain)
// Default: a fresh, isolated index and no preview, which is what a first-time user gets.
const previewFlag = has("--preview");
const manifestFlag = has("--manifest");
const indexMode = manifestFlag ? "warm" : (get("--index") ?? "fresh");
const strategiesArg = get("--strategies");
const jsonOut = get("--json");
// --trace-dir DIR keeps each run's raw claude stream (tool arguments, results, usage) as JSONL.
// --seed N fixes the per-task strategy order, so a reproduction runs the same sequence.
const traceDirArg = get("--trace-dir");
const seedArg = Number.parseInt(get("--seed") ?? "3801", 10);
// --experiment FILE runs the declarative variants (A–G) from 1.md instead of the strategy list. Each
// variant sets execution (direct / call_tool / run_chain), the manifest, and its optimization policy.
const experimentArg = get("--experiment");
/** The variant the current run belongs to (null outside --experiment). */
let activeVariant = null;
/** Whether the fixture servers list their signatures in the MCP instructions for this run. */
const variantManifest = () => (activeVariant ? activeVariant.manifest : manifestFlag);
/** Index state for this run: an experiment's index, or the --index flag. A manifest implies a warm index. */
const variantIndex = () => (activeVariant ? (variantManifest() ? "warm" : experiment.index) : indexMode);
/** The parsed experiment (null outside --experiment). Loaded and validated before any run starts. */
let experiment = null;
if (experimentArg) {
  const { parseExperiment } = await import("./lib/tasks.mjs");
  try {
    experiment = parseExperiment(JSON.parse(readFileSync(resolve(experimentArg), "utf8")));
  } catch (err) {
    console.error(`--experiment ${experimentArg}: ${err.message}`);
    process.exit(1);
  }
  // 1.md: reject conflicting legacy flags rather than silently overriding them.
  const conflicts = [
    ["--strategies", strategiesArg],
    ["--manifest", manifestFlag],
    ["--preview", previewFlag],
    ["--cold-discovery", coldDiscovery],
  ].filter(([, on]) => on).map(([flag]) => flag);
  if (conflicts.length) {
    console.error(`--experiment sets execution, manifest and optimization per variant; remove ${conflicts.join(", ")}.`);
    process.exit(1);
  }
  if (!tasksOnly) {
    console.error("--experiment only applies to --tasks.");
    process.exit(1);
  }
}
if (!["fresh", "warm"].includes(indexMode)) {
  console.error('--index must be "fresh" or "warm".');
  process.exit(1);
}
const selectedTasks = taskArg === "all" ? [...TASK_IDS] : taskArg.split(",").map((t) => t.trim()).filter(Boolean);
if (tasksOnly) {
  const unknown = selectedTasks.filter((t) => !TASK_IDS.includes(t));
  if (unknown.length || selectedTasks.length === 0) {
    console.error(`Unknown --task ${unknown.join(", ") || taskArg}. Available: ${TASK_IDS.join(", ")} (or "all").`);
    process.exit(1);
  }
  const badStrategies = (strategiesArg ?? "").split(",").map((x) => x.trim()).filter(Boolean).filter((x) => !STRATEGY_IDS.includes(x));
  if (badStrategies.length) {
    console.error(`Unknown --strategies ${badStrategies.join(", ")}. Available: ${STRATEGY_IDS.join(", ")}.`);
    process.exit(1);
  }
} else if (taskFlagGiven) {
  console.error("--task only applies to --tasks.");
  process.exit(1);
}
if (tasksOnly && (mcpOnly || skillsOnly)) {
  console.error("--tasks cannot be combined with --mcp-only / --skills-only.");
  process.exit(1);
}
if (liveResponsesOnly && (tasksOnly || responsesOnly || mcpOnly || skillsOnly)) {
  console.error("--responses-live cannot be combined with --tasks, --responses, --mcp-only, or --skills-only.");
  process.exit(1);
}
if (mcpOnly && skillsOnly) {
  console.error("Use only one of --mcp-only / --skills-only.");
  process.exit(1);
}
if (!["claude", "codex"].includes(runnerArg)) {
  console.error(`Unknown --runner ${runnerArg}. Use claude or codex.`);
  process.exit(1);
}
const runMcp = !skillsOnly;
const runSkills = !mcpOnly;
const codexModel = modelArg ?? "gpt-6-luna";

/** Rough token estimate used by --estimate (Claude tokenizer ≈ 4 chars/token for English prose). */
const estTokens = (chars) => Math.round(chars / 4);

// ─── Paths ─────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

if (responsesOnly) {
  if (!Number.isInteger(responseIterations) || responseIterations < 1 || responseIterations > 1000) {
    console.error("--iterations must be an integer from 1 to 1000.");
    process.exit(1);
  }
  const optimizerPath = resolve(__dirname, "../dist/response-optimizer.js");
  if (!existsSync(optimizerPath)) {
    console.error("✗ dist/response-optimizer.js not found. Run `npm run build` first.");
    process.exit(1);
  }
  const { estimateTokens, optimizeToolResult } = await import(pathToFileURL(optimizerPath).href);
  const context = { serverName: "benchmark", toolName: "response", source: "call_tool" };
  const jsonResult = {
    content: [],
    structuredContent: {
      issues: Array.from({ length: 500 }, (_, id) => ({
        id,
        title: `Issue ${id}`,
        state: id % 2 ? "open" : "closed",
        body: "A long description that is not needed by this projection. ".repeat(8),
        metadata: { owner: `team-${id % 12}`, labels: [], optional: null },
      })),
    },
  };
  const nav = Array.from({ length: 180 }, (_, id) => `<a href="/section/${id}">Navigation section ${id}</a>`).join(" ");
  const htmlResult = {
    content: [{
      type: "text",
      text: `<html><head><style>${".hidden { display:none }".repeat(80)}</style><script>${"var tracker = 1;".repeat(120)}</script></head><body><nav>${nav}</nav><main><h1>Guide</h1><p>${"Core instructions and reference content. ".repeat(24)}</p><pre><code>Authorization: Bearer KEY</code></pre></main><footer>${"Footer navigation. ".repeat(30)}</footer></body></html>`,
    }],
  };
  const smallJson = { content: [], structuredContent: { id: 17, state: "open", labels: ["bug"] } };
  const cases = [
    { name: "small-json-off", result: smallJson, policy: { mode: "off" } },
    { name: "large-json-project", result: jsonResult, policy: { mode: "project", fields: ["issues.id", "issues.title", "issues.state"] } },
    { name: "html-markdown", result: htmlResult, policy: { mode: "html_markdown" } },
    { name: "html-reader", result: htmlResult, policy: { mode: "html_reader" } },
  ];
  const percentile = (values, p) => values.slice().sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)];
  const measurements = [];
  for (const benchmark of cases) {
    const samples = [];
    let metrics;
    for (let i = 0; i < responseIterations + 3; i++) {
      const start = performance.now();
      const optimized = await optimizeToolResult(benchmark.result, benchmark.policy, context);
      const elapsed = performance.now() - start;
      if (i >= 3) samples.push(elapsed);
      metrics = optimized.metrics;
    }
    measurements.push({
      workload: benchmark.name,
      iterations: responseIterations,
      originalTokens: estimateTokens(benchmark.result),
      optimizedTokens: metrics.optimizedTokens,
      savedTokens: metrics.savedTokens,
      reductionPercent: metrics.reductionPercent,
      medianMs: Number(percentile(samples, 0.5).toFixed(3)),
      p95Ms: Number(percentile(samples, 0.95).toFixed(3)),
      complete: metrics.complete,
    });
  }
  console.log(JSON.stringify({ method: "local deterministic fixtures; token estimates use serialized characters / 4", measurements }, null, 2));
  process.exit(0);
}

function resolveUnderConfig(file, explicit) {
  if (explicit) return resolve(explicit);
  for (const dir of ["lazygate", "context-broker"]) {
    const xdg = resolve(homedir(), ".config", dir, file);
    if (existsSync(xdg)) return xdg;
  }
  return resolve(__dirname, "../config", file);
}

const configPath = resolveUnderConfig("servers.json", configArg);
const skillsConfigPath = resolveUnderConfig("skills.json", skillsConfigArg);

// ─── Servers ───────────────────────────────────────────────────────────────

const expandVars = (v) => v.replace(/\$\{(\w+)\}/g, (_, n) => process.env[n] ?? "");
const hasAuthHeader = (cfg) =>
  Object.keys(cfg.headers ?? {}).some((k) => k.toLowerCase() === "authorization");

const allServers = existsSync(configPath)
  ? (JSON.parse(readFileSync(configPath, "utf-8")).servers ?? {})
  : {};
const serverSubset = serverArg ? new Set(serverArg.split(",").map((s) => s.trim())) : null;

const skippedServers = [];
const servers = {};
for (const [name, cfg] of Object.entries(allServers)) {
  if (serverSubset && !serverSubset.has(name)) continue;
  if (cfg.command) {
    servers[name] = cfg;
  } else if (cfg.url && (hasAuthHeader(cfg) || liveResponsesOnly)) {
    servers[name] = cfg;
  } else if (cfg.url || cfg.type === "http") {
    skippedServers.push(`${name} (needs interactive OAuth)`);
  } else {
    skippedServers.push(`${name} (no command)`);
  }
}

if (liveResponsesOnly) {
  if (!responseCasesArg) {
    console.error("--responses-live requires --cases <json-file>.");
    process.exit(1);
  }
  if (!Number.isInteger(liveResponseIterations) || liveResponseIterations < 1 || liveResponseIterations > 100) {
    console.error("--iterations must be an integer from 1 to 100 for --responses-live.");
    process.exit(1);
  }

  const casesPath = resolve(responseCasesArg);
  if (!existsSync(casesPath)) {
    console.error(`Benchmark cases file not found: ${casesPath}`);
    process.exit(1);
  }

  const casesFile = JSON.parse(readFileSync(casesPath, "utf-8"));
  const benchmarkCases = Array.isArray(casesFile) ? casesFile : casesFile.cases;
  if (!Array.isArray(benchmarkCases) || benchmarkCases.length === 0) {
    console.error("Benchmark cases must be a non-empty JSON array or an object with a non-empty `cases` array.");
    process.exit(1);
  }

  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const optimizerPath = resolve(__dirname, "../dist/response-optimizer.js");
  if (!existsSync(optimizerPath)) {
    console.error("✗ dist/response-optimizer.js not found. Run `npm run build` first.");
    process.exit(1);
  }
  const { estimateTokens, optimizeToolResult } = await import(pathToFileURL(optimizerPath).href);
  const { loadTokenizer, parseTokenizerFlag, isBuiltinTokenizer } = await import(
    pathToFileURL(resolve(__dirname, "../dist/tokenizers.js")).href
  );
  let tokenizerName;
  try {
    tokenizerName = parseTokenizerFlag(get("--tokenizer") ?? undefined);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  if (!tokenizerName && existsSync(configPath)) {
    const configured = JSON.parse(readFileSync(configPath, "utf-8")).responseOptimization?.tokenizer;
    if (isBuiltinTokenizer(configured)) tokenizerName = configured;
  }
  const tokenizer = await loadTokenizer(tokenizerName);
  const tokenizerLabel = tokenizer?.name ?? "chars_per_4";
  const allowedModes = new Set(["off", "prune", "project", "jsonpath", "schema", "html_markdown", "html_reader", "adaptive"]);
  const adaptiveCandidateModes = new Set(["prune", "project", "jsonpath", "schema", "html_markdown", "html_reader"]);
  const minimumRecommendationSamples = 3;
  const maximumOptimizationOverheadPercent = 50;
  const percentile = (values, p) => {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
  };
  const stats = (values) => {
    if (!values.length) return { median: 0, p95: 0, mean: 0, stdDev: 0 };
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
    return {
      median: percentile(values, 0.5),
      p95: percentile(values, 0.95),
      mean: average,
      stdDev: Math.sqrt(variance),
    };
  };
  const round = (value, digits = 3) => Number(value.toFixed(digits));
  const recommendPolicy = (benchmarkCase, policy, label, sampleCount, samples) => {
    const mode = policy.mode ?? "off";
    if (mode === "off") return null;

    const result = {
      case: benchmarkCase.name ?? `${benchmarkCase.server}.${benchmarkCase.tool}`,
      server: benchmarkCase.server,
      tool: benchmarkCase.tool,
      policy: label,
      mode,
      ...(mode === "adaptive"
        ? { candidateModes: Array.isArray(policy.candidates) ? policy.candidates.map((candidate) => candidate.mode) : "automatic" }
        : {}),
      decision: "insufficient_evidence",
      reason: "too_few_samples",
      sampleCount,
      requiredSampleCount: minimumRecommendationSamples,
      maximumOptimizationOverheadPercent,
      optimizationFallbacks: samples.filter((sample) => sample.optimizationFallback).length,
      optimizationFallbackRate: sampleCount
        ? round((samples.filter((sample) => sample.optimizationFallback).length / sampleCount) * 100, 1)
        : 0,
    };
    if (sampleCount < minimumRecommendationSamples) return result;
    if (samples.some((sample) => sample.isError)) {
      result.reason = "upstream_errors";
      return result;
    }
    if (samples.some((sample) => sample.correctness === null)) {
      result.reason = "correctness_not_checked";
      return result;
    }
    if (samples.some((sample) => sample.correctness === false)) {
      result.decision = "keep_off";
      result.reason = "correctness_failed";
      return result;
    }
    const savedTokens = stats(samples.map((sample) => sample.savedTokens)).median;
    const optimizationLatencyMs = stats(samples.map((sample) => sample.transformMs)).median;
    const upstreamLatencyMs = stats(samples.map((sample) => sample.upstreamMs)).median;
    const overheadPercent = upstreamLatencyMs > 0
      ? (optimizationLatencyMs / upstreamLatencyMs) * 100
      : (optimizationLatencyMs === 0 ? 0 : null);
    Object.assign(result, {
      medianSavedTokens: round(savedTokens),
      medianOptimizationLatencyMs: round(optimizationLatencyMs),
      medianUpstreamLatencyMs: round(upstreamLatencyMs),
      optimizationOverheadPercent: overheadPercent === null ? null : round(overheadPercent, 1),
      ...(mode === "adaptive"
        ? { selectedModes: [...new Set(samples.map((sample) => sample.selectedMode).filter(Boolean))] }
        : {}),
    });

    if (result.optimizationFallbacks > 0) {
      result.decision = "keep_off";
      result.reason = "optimization_fallback";
      return result;
    }
    if (savedTokens <= 0) {
      result.decision = "keep_off";
      result.reason = "no_token_savings";
      return result;
    }
    if (overheadPercent === null || overheadPercent > maximumOptimizationOverheadPercent) {
      result.decision = "keep_off";
      result.reason = "optimization_overhead_too_high";
      return result;
    }

    result.decision = "recommend";
    result.reason = "correctness_passed_savings_positive_overhead_within_budget";
    return result;
  };
  const stable = (value) => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  };
  const jsonPathValues = async (path, json) => {
    const { JSONPath } = await import("jsonpath-plus");
    return JSONPath({ path, json, wrap: true });
  };
  const checkPreservation = async (original, optimized, benchmarkCase) => {
    const checks = [];
    for (const path of benchmarkCase.preservePaths ?? []) {
      const [before, after] = await Promise.all([
        jsonPathValues(path, original),
        jsonPathValues(path, optimized),
      ]);
      checks.push(before.length > 0 && stable(before) === stable(after));
    }
    const originalText = JSON.stringify(original);
    const optimizedText = JSON.stringify(optimized);
    for (const text of benchmarkCase.preserveText ?? []) {
      checks.push(typeof text === "string" && text.length > 0 && originalText.includes(text) && optimizedText.includes(text));
    }
    return checks.length ? checks.every(Boolean) : null;
  };
  const connectToServer = async (name, cfg) => {
    let transport;
    if (cfg.command) {
      const env = { ...process.env };
      for (const [key, value] of Object.entries(cfg.env ?? {})) env[key] = expandVars(value);
      transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        env,
        stderr: "inherit",
      });
    } else if (cfg.url && (cfg.type === "http" || hasAuthHeader(cfg))) {
      const headers = {};
      for (const [key, value] of Object.entries(cfg.headers ?? {})) headers[key] = expandVars(value);
      transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
        requestInit: { headers },
      });
    } else {
      throw new Error(`server ${name} is not a runnable stdio or authenticated Streamable HTTP server`);
    }
    const client = new Client({ name: "lazygate-benchmark", version: "1.0.0" });
    await client.connect(transport);
    return client;
  };

  const report = [];
  const recommendations = [];
  let failed = false;
  for (const [caseIndex, benchmarkCase] of benchmarkCases.entries()) {
    const caseName = benchmarkCase?.name ?? `${benchmarkCase?.server ?? "unknown"}.${benchmarkCase?.tool ?? "unknown"}`;
    if (!benchmarkCase || benchmarkCase.readOnly !== true) {
      console.error(`Case ${caseName} must set readOnly: true; live benchmarks only run explicitly read-only cases.`);
      process.exit(1);
    }
    if (typeof benchmarkCase.server !== "string" || typeof benchmarkCase.tool !== "string") {
      console.error(`Case ${caseName} must name a configured server and tool.`);
      process.exit(1);
    }
    if (!Array.isArray(benchmarkCase.preservePaths ?? []) || !Array.isArray(benchmarkCase.preserveText ?? [])) {
      console.error(`Case ${caseName} preservePaths and preserveText must be arrays when provided.`);
      process.exit(1);
    }
    if ((benchmarkCase.preservePaths?.length ?? 0) + (benchmarkCase.preserveText?.length ?? 0) === 0) {
      console.error(`Case ${caseName} must declare preservePaths or preserveText for correctness measurement.`);
      process.exit(1);
    }

    const cfg = servers[benchmarkCase.server];
    if (!cfg) {
      console.error(`Case ${caseName} names server ${benchmarkCase.server}, which is not in the selected runnable server config.`);
      process.exit(1);
    }
    const policies = benchmarkCase.policies;
    if (!Array.isArray(policies) || policies.length === 0) {
      console.error(`Case ${caseName} must provide a non-empty policies array with an off baseline and an optimizer mode.`);
      process.exit(1);
    }
    const labels = new Set();
    const policyLabels = new Map();
    for (const policy of policies) {
      if (!policy || typeof policy !== "object" || Array.isArray(policy) || !allowedModes.has(policy.mode ?? "off")) {
        console.error(`Case ${caseName} contains an invalid optimizer mode.`);
        process.exit(1);
      }
      if (policy.mode === "adaptive") {
        if (
          policy.candidates !== undefined &&
          (!Array.isArray(policy.candidates) || policy.candidates.length < 1 || policy.candidates.length > 4)
        ) {
          console.error(`Case ${caseName} adaptive policy must declare one to four candidates, or omit them for the automatic set.`);
          process.exit(1);
        }
        const invalidCandidate = (policy.candidates ?? []).find((candidate) =>
          !candidate || typeof candidate !== "object" || Array.isArray(candidate) ||
          !adaptiveCandidateModes.has(candidate.mode) ||
          (candidate.mode === "project" && (!Array.isArray(candidate.fields) || candidate.fields.length === 0)) ||
          (candidate.mode === "jsonpath" && (typeof candidate.jsonPath !== "string" || candidate.jsonPath.length === 0))
        );
        if (invalidCandidate) {
          console.error(`Case ${caseName} adaptive policy contains an invalid candidate.`);
          process.exit(1);
        }
        if (policy.minInputTokens !== undefined && (!Number.isInteger(policy.minInputTokens) || policy.minInputTokens < 1 || policy.minInputTokens > 1_000_000)) {
          console.error(`Case ${caseName} adaptive policy minInputTokens must be a positive integer up to 1000000.`);
          process.exit(1);
        }
        if (policy.minSavingsPercent !== undefined && (typeof policy.minSavingsPercent !== "number" || !Number.isFinite(policy.minSavingsPercent) || policy.minSavingsPercent < 0 || policy.minSavingsPercent > 100)) {
          console.error(`Case ${caseName} adaptive policy minSavingsPercent must be between 0 and 100.`);
          process.exit(1);
        }
      }
      const label = policy.name ?? `${policy.mode ?? "off"}-${labels.size + 1}`;
      if (labels.has(label)) {
        console.error(`Case ${caseName} policy names must be unique.`);
        process.exit(1);
      }
      labels.add(label);
      policyLabels.set(label, policy);
    }
    if (!policies.some((policy) => (policy.mode ?? "off") === "off") || !policies.some((policy) => (policy.mode ?? "off") !== "off")) {
      console.error(`Case ${caseName} must compare mode "off" with at least one optimizer mode.`);
      process.exit(1);
    }

    const context = { serverName: benchmarkCase.server, toolName: benchmarkCase.tool, source: "call_tool" };
    const measurements = new Map(policies.map((policy, index) => [policy.name ?? `${policy.mode ?? "off"}-${index + 1}`, []]));
    let client;
    let setupMs = 0;
    try {
      const setupStarted = performance.now();
      client = await connectToServer(benchmarkCase.server, cfg);
      let cursor;
      let exposedTools = [];
      do {
        const page = await client.listTools(cursor ? { cursor } : {});
        exposedTools = exposedTools.concat(page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      setupMs = performance.now() - setupStarted;
      if (!exposedTools.some((tool) => tool.name === benchmarkCase.tool)) {
        throw new Error(`tool ${benchmarkCase.tool} is not exposed by server ${benchmarkCase.server}`);
      }
      for (let iteration = 0; iteration < liveResponseIterations; iteration++) {
        const callStarted = performance.now();
        const original = await client.callTool({
          name: benchmarkCase.tool,
          arguments: benchmarkCase.args ?? {},
        });
        const upstreamMs = performance.now() - callStarted;
        const originalTokens = estimateTokens(original, tokenizer);

        for (let policyIndex = 0; policyIndex < policies.length; policyIndex++) {
          const policySpec = policies[policyIndex];
          const label = policySpec.name ?? `${policySpec.mode ?? "off"}-${policyIndex + 1}`;
          const { name: _label, ...policy } = policySpec;
          const transformStarted = performance.now();
          const optimized = await optimizeToolResult(original, policy, context, undefined, tokenizer);
          const transformMs = performance.now() - transformStarted;
          const correctness = await checkPreservation(original, optimized.result, benchmarkCase);
          if (correctness === false) failed = true;
          const optimizedTokens = estimateTokens(optimized.result, tokenizer);
          measurements.get(label).push({
            originalTokens,
            optimizedTokens,
            savedTokens: Math.max(0, originalTokens - optimizedTokens),
            reductionPercent: originalTokens ? Math.max(0, (originalTokens - optimizedTokens) / originalTokens * 100) : 0,
            upstreamMs,
            transformMs,
            totalMs: upstreamMs + transformMs,
            complete: optimized.metrics.complete,
            selectedMode: optimized.metrics.selectedMode,
            optimizationFallback: Boolean(optimized.metrics.failure),
            correctness,
            isError: Boolean(original.isError),
          });
        }
      }
    } catch (error) {
      failed = true;
      const message = String(error?.message ?? "benchmark error").replace(/https?:\/\/\S+/g, "[URL]");
      console.error(`Case ${caseName} failed: ${message}`);
    } finally {
      await client?.close().catch(() => {});
    }

    if (!measurements.size) continue;
    for (const [policy, samples] of measurements) {
      const policySpec = policyLabels.get(policy);
      const recommendation = recommendPolicy(benchmarkCase, policySpec, policy, samples.length, samples);
      if (recommendation) recommendations.push(recommendation);
      if (samples.length === 0) continue;
      const upstream = stats(samples.map((sample) => sample.upstreamMs));
      const transform = stats(samples.map((sample) => sample.transformMs));
      const total = stats(samples.map((sample) => sample.totalMs));
      const tokensBefore = stats(samples.map((sample) => sample.originalTokens));
      const tokensAfter = stats(samples.map((sample) => sample.optimizedTokens));
      const savings = stats(samples.map((sample) => sample.savedTokens));
      const reductions = stats(samples.map((sample) => sample.reductionPercent));
      const correctnessSamples = samples.filter((sample) => sample.correctness !== null);
      report.push({
        case: caseName,
        server: benchmarkCase.server,
        tool: benchmarkCase.tool,
        setupMs: round(setupMs),
        policy,
        sampleCount: samples.length,
        tokenEstimate: tokenizer ? `${tokenizerLabel} over serialized JSON` : "serialized JSON characters / 4",
        originalTokens: { median: round(tokensBefore.median), p95: round(tokensBefore.p95) },
        optimizedTokens: { median: round(tokensAfter.median), p95: round(tokensAfter.p95) },
        savedTokens: { median: round(savings.median), p95: round(savings.p95) },
        reductionPercent: round(reductions.median, 1),
        upstreamLatencyMs: {
          median: round(upstream.median), p95: round(upstream.p95), stdDev: round(upstream.stdDev),
        },
        optimizationLatencyMs: {
          median: round(transform.median), p95: round(transform.p95), stdDev: round(transform.stdDev),
        },
        endToEndToolLatencyMs: {
          median: round(total.median), p95: round(total.p95), stdDev: round(total.stdDev),
        },
        completeSamples: samples.filter((sample) => sample.complete).length,
        optimizationFallbacks: samples.filter((sample) => sample.optimizationFallback).length,
        optimizationFallbackRate: samples.length
          ? round((samples.filter((sample) => sample.optimizationFallback).length / samples.length) * 100, 1)
          : 0,
        correctness: correctnessSamples.length
          ? { passed: correctnessSamples.filter((sample) => sample.correctness).length, checked: correctnessSamples.length }
          : "not checked",
        upstreamErrors: samples.filter((sample) => sample.isError).length,
      });
    }
    if (caseIndex < benchmarkCases.length - 1) process.stderr.write(`Completed ${caseName}\n`);
  }

  console.log(JSON.stringify({
    method: "live MCP calls; optimizer policies applied to each captured response; no model calls",
    iterations: liveResponseIterations,
    tokenizer: tokenizerLabel,
    limitations: [
      tokenizer
        ? `Token counts use ${tokenizerLabel}, a public encoding that approximates (but is not) a Claude tokenizer.`
        : "Token counts are estimates from serialized JSON characters divided by four (pass --tokenizer o200k_base for a real encoding).",
      "Latency includes the upstream tool call and local response transformation, not model inference or full agent task success.",
      "Each case must be a read-only tool call and provide preservation checks.",
    ],
    measurements: report,
    recommendations,
  }, null, 2));
  if (failed) process.exit(1);
  process.exit(0);
}

// ─── Skills ────────────────────────────────────────────────────────────────

const allSkills = existsSync(skillsConfigPath)
  ? (JSON.parse(readFileSync(skillsConfigPath, "utf-8")).skills ?? {})
  : {};
const skillSubset = skillArg ? new Set(skillArg.split(",").map((s) => s.trim())) : null;

const STUB_MARKER = "<!-- lazygate:";
const LEGACY_STUB = "<!-- context-broker:";

function parseFrontmatter(text) {
  const m = text.match(/^(---\r?\n[\s\S]*?\r?\n---)(\r?\n)?([\s\S]*)$/);
  if (!m) return { frontmatter: "", body: text };
  return { frontmatter: m[1], body: (m[3] ?? "").replace(/^\r?\n/, "") };
}

function loadSkillMaterial(name, cfg) {
  const skillPath = cfg.path;
  if (!skillPath || !existsSync(skillPath)) {
    return {
      name,
      ok: false,
      reason: "missing path",
      description: cfg.description ?? name,
      full: "",
      stub: "",
    };
  }
  const skillMd = readFileSync(skillPath, "utf-8");
  const { frontmatter, body: afterFm } = parseFrontmatter(skillMd);
  const instrPath = skillPath.replace(/SKILL\.md$/, "INSTRUCTIONS.md");
  const hasInstr = instrPath !== skillPath && existsSync(instrPath);
  const instructions = hasInstr ? readFileSync(instrPath, "utf-8") : afterFm;
  const description = cfg.description ?? name;

  const pointer =
    `${STUB_MARKER} full instructions are in INSTRUCTIONS.md next to this file; ` +
    `load them with the lazygate load_skill tool ("${name}") -->\n`;

  // Already split → stub is SKILL.md; otherwise synthesise what migrate would leave.
  const stubAlready =
    afterFm.includes(STUB_MARKER) || afterFm.includes(LEGACY_STUB) || hasInstr;
  const stub = stubAlready
    ? skillMd.trimEnd() + "\n"
    : (frontmatter ? frontmatter + "\n\n" : "") + pointer;

  const full =
    (frontmatter ? frontmatter + "\n\n" : "") +
    instructions.replace(/^\r?\n/, "");

  return { name, ok: true, description, full, stub, charsFull: full.length, charsStub: stub.length };
}

const skippedSkills = [];
const skills = [];
for (const [name, cfg] of Object.entries(allSkills)) {
  if (skillSubset && !skillSubset.has(name)) continue;
  const mat = loadSkillMaterial(name, cfg);
  if (!mat.ok) {
    skippedSkills.push(`${name} (${mat.reason})`);
    continue;
  }
  skills.push(mat);
}

if (runMcp && Object.keys(servers).length === 0 && !runSkills) {
  console.error(
    "No servers to benchmark." +
      (skippedServers.length ? ` Skipped: ${skippedServers.join(", ")}` : "")
  );
  process.exit(1);
}
if (runSkills && skills.length === 0 && !runMcp) {
  console.error(
    "No skills to benchmark." +
      (skippedSkills.length ? ` Skipped: ${skippedSkills.join(", ")}` : "") +
      `\nLooked at: ${skillsConfigPath}`
  );
  process.exit(1);
}
if (runMcp && Object.keys(servers).length === 0) {
  console.warn(
    "⚠  No runnable MCP servers — skipping MCP strategies." +
      (skippedServers.length ? ` Skipped: ${skippedServers.join(", ")}` : "")
  );
}
if (runSkills && skills.length === 0) {
  console.warn(
    "⚠  No skills found — skipping skill strategies." +
      (skippedSkills.length ? ` Skipped: ${skippedSkills.join(", ")}` : "")
  );
}

// ─── Broker meta-tools ─────────────────────────────────────────────────────

const metaToolsPath = resolve(__dirname, "..", "dist", "meta-tools.js");
if (!existsSync(metaToolsPath)) {
  console.error("✗ dist/meta-tools.js not found. Run `npm run build` first.");
  process.exit(1);
}
const BROKER_META_TOOLS = (await import(pathToFileURL(metaToolsPath).href)).META_TOOLS;

function makeFakeMcpScript() {
  return `
const tools = JSON.parse(process.argv[process.argv.length - 1]);
let buf = "";
process.stdin.on("data", c => {
  buf += c;
  const lines = buf.split("\\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      let resp;
      if (msg.method === "initialize") {
        resp = { jsonrpc:"2.0", id:msg.id, result:{ protocolVersion:"2024-11-05", capabilities:{tools:{}}, serverInfo:{name:"fake",version:"1.0"} } };
      } else if (msg.method === "tools/list") {
        resp = { jsonrpc:"2.0", id:msg.id, result:{ tools } };
      } else if (msg.id != null) {
        resp = { jsonrpc:"2.0", id:msg.id, result:{} };
      }
      if (resp) process.stdout.write(JSON.stringify(resp) + "\\n");
    } catch {}
  }
});
`.trim();
}

function buildMcpConfig(serverNames, extras = []) {
  const mcpServers = {};
  for (const name of serverNames) {
    const cfg = servers[name];
    if (!cfg) continue;
    if (cfg.command) {
      const env = {};
      for (const [k, v] of Object.entries(cfg.env ?? {})) env[k] = expandVars(v);
      mcpServers[name] = {
        command: cfg.command,
        args: cfg.args ?? [],
        ...(Object.keys(env).length ? { env } : {}),
      };
    } else {
      const headers = {};
      for (const [k, v] of Object.entries(cfg.headers ?? {})) headers[k] = expandVars(v);
      mcpServers[name] = { type: "http", url: cfg.url, headers };
    }
  }
  for (const { name, tools } of extras) {
    mcpServers[name] = {
      command: "node",
      args: ["-e", makeFakeMcpScript(), "--", JSON.stringify(tools)],
    };
  }
  return { mcpServers };
}

function formatSkillBlock(mat, mode) {
  const body = mode === "full" ? mat.full : mat.stub;
  return `### ${mat.name}\n${mat.description}\n\n${body.trimEnd()}\n`;
}

function buildSkillsPrompt(mode, loadedName = null) {
  const lines = [
    "# Skills available in this session",
    "",
    mode === "full"
      ? "Each skill below includes its full instructions."
      : mode === "one"
        ? "Skill listings are stubs. One skill has been loaded in full."
        : "Skill listings are stubs only. Load a body with load_skill when needed.",
    "",
  ];
  for (const mat of skills) {
    if (mode === "one" && mat.name === loadedName) {
      lines.push(formatSkillBlock(mat, "full"));
    } else {
      lines.push(formatSkillBlock(mat, mode === "full" ? "full" : "stub"));
    }
  }
  return lines.join("\n");
}

// ─── Run one measurement ───────────────────────────────────────────────────

const PROMPT = "Say only: ok";
const workDir = mkdtempSync(join(tmpdir(), "lazygate-bench-"));
const failResult = (error, durationMs = 0) => ({
  ok: false,
  error,
  inputTokens: 0,
  cacheCreate: 0,
  cacheRead: 0,
  totalInput: 0,
  outputTokens: 0,
  durationMs,
  costUSD: 0,
});

function writePromptFile(name, text) {
  const path = join(workDir, name);
  writeFileSync(path, text);
  return path;
}

function tomlString(s) {
  return JSON.stringify(String(s));
}

function writeFakeMcpHelper() {
  const path = join(workDir, "fake-mcp.mjs");
  writeFileSync(
    path,
    `
import { readFileSync } from "fs";
const tools = JSON.parse(readFileSync(process.argv[2], "utf8"));
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  const lines = buf.split("\\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      let resp;
      if (msg.method === "initialize") {
        resp = { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1.0" } } };
      } else if (msg.method === "tools/list") {
        resp = { jsonrpc: "2.0", id: msg.id, result: { tools } };
      } else if (msg.id != null) {
        resp = { jsonrpc: "2.0", id: msg.id, result: {} };
      }
      if (resp) process.stdout.write(JSON.stringify(resp) + "\\n");
    } catch {}
  }
});
`.trim()
  );
  return path;
}

const fakeMcpPath = writeFakeMcpHelper();

function buildCodexHome(mcpConfig) {
  const home = mkdtempSync(join(workDir, "codex-home-"));
  const authSrc = resolve(homedir(), ".codex", "auth.json");
  if (existsSync(authSrc)) symlinkSync(authSrc, join(home, "auth.json"));

  const lines = [
    `model = ${tomlString(codexModel)}`,
    `model_provider = "custom"`,
    `model_reasoning_effort = "medium"`,
    `approval_policy = "never"`,
    "",
    "[model_providers.custom]",
    `name = "Custom"`,
    `base_url = "https://llm-proxy.example.com/v1"`,
    `env_key = "LLM_PROXY_AUTH_TOKEN"`,
    `wire_api = "responses"`,
    `supports_websockets = false`,
    "",
  ];

  for (const [name, cfg] of Object.entries(mcpConfig.mcpServers ?? {})) {
    const key = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    lines.push(`[mcp_servers.${key}]`);
    if (cfg.command) {
      lines.push(`command = ${tomlString(cfg.command)}`);
      if (cfg.args?.length) {
        lines.push(`args = [${cfg.args.map(tomlString).join(", ")}]`);
      }
      if (cfg.env && Object.keys(cfg.env).length) {
        lines.push("[mcp_servers." + key + ".env]");
        for (const [ek, ev] of Object.entries(cfg.env)) {
          lines.push(`${ek} = ${tomlString(ev)}`);
        }
      }
    } else if (cfg.url) {
      lines.push(`url = ${tomlString(cfg.url)}`);
    }
    lines.push("");
  }

  writeFileSync(join(home, "config.toml"), lines.join("\n"));
  return home;
}

/** Rewrite extras that used inline -e scripts into file-based fake MCP for Codex TOML. */
function codexMcpConfig(mcpConfig) {
  const out = { mcpServers: {} };
  for (const [name, cfg] of Object.entries(mcpConfig.mcpServers ?? {})) {
    if (cfg.command === "node" && Array.isArray(cfg.args) && cfg.args[0] === "-e") {
      const toolsJson = cfg.args[cfg.args.length - 1];
      const toolsFile = join(workDir, `tools-${name}.json`);
      writeFileSync(toolsFile, toolsJson);
      out.mcpServers[name] = {
        command: "node",
        args: [fakeMcpPath, toolsFile],
      };
    } else {
      out.mcpServers[name] = cfg;
    }
  }
  return out;
}

async function runClaude(mcpConfig, { appendFile = null } = {}) {
  const hasMcpServers = Object.keys(mcpConfig.mcpServers ?? {}).length > 0;
  const claudeArgs = [
    "-p",
    PROMPT,
    "--output-format",
    "json",
    "--tools",
    "",
    "--no-session-persistence",
    "--bare",
    "--disable-slash-commands",
    ...(hasMcpServers ? ["--mcp-config", JSON.stringify(mcpConfig)] : []),
    ...(appendFile ? ["--append-system-prompt-file", appendFile] : []),
  ];

  const start = Date.now();
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("claude", claudeArgs, {
      timeout: 180_000,
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }));
  } catch (err) {
    stdout = err.stdout?.toString?.() ?? err.stdout ?? "";
    if (!stdout.trim()) {
      const detail = (err.stderr?.toString?.() ?? err.message ?? "").slice(0, 160);
      console.warn(`  ⚠  claude CLI error: ${detail}`);
      return failResult(detail || err.message, Date.now() - start);
    }
  }

  const wallMs = Date.now() - start;
  let data;
  try {
    data = JSON.parse(stdout.trim());
  } catch {
    console.warn(`  ⚠  could not parse claude JSON: ${stdout.trim().slice(0, 120)}`);
    return failResult("invalid JSON from claude", wallMs);
  }

  if (data.is_error || data.api_error_status) {
    const msg =
      data.result ||
      (data.api_error_status ? `API error ${data.api_error_status}` : null) ||
      "claude returned is_error";
    console.warn(`  ⚠  ${String(msg).slice(0, 160)}`);
    return failResult(String(msg), data.duration_ms ?? wallMs);
  }

  const u = data.usage ?? {};
  const totalInput =
    (u.input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0);
  return {
    ok: true,
    inputTokens: u.input_tokens ?? 0,
    cacheCreate: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    totalInput,
    outputTokens: u.output_tokens ?? 0,
    durationMs: data.duration_ms ?? wallMs,
    costUSD: data.total_cost_usd ?? 0,
  };
}

async function runCodex(mcpConfig, { appendFile = null } = {}) {
  const start = Date.now();
  const home = buildCodexHome(codexMcpConfig(mcpConfig));
  const cwd = mkdtempSync(join(workDir, "codex-cwd-"));
  let prompt = PROMPT;
  if (appendFile) {
    const body = readFileSync(appendFile, "utf8");
    prompt = `${body}\n\n---\n${PROMPT}`;
  }
  // Large skill corpora exceed argv limits — feed the prompt on stdin.
  const codexArgs = [
    "exec",
    "-m",
    codexModel,
    "-C",
    cwd,
    "-s",
    "read-only",
    "--skip-git-repo-check",
    "--json",
    "-",
  ];

  let stdout = "";
  try {
    ({ stdout } = await runSpawn("codex", codexArgs, {
      timeout: 180_000,
      env: { ...process.env, CODEX_HOME: home },
      input: prompt,
    }));
  } catch (err) {
    stdout = err.stdout?.toString?.() ?? err.stdout ?? "";
    if (!stdout.trim()) {
      const detail = (err.stderr?.toString?.() ?? err.message ?? "").slice(0, 200);
      console.warn(`  ⚠  codex CLI error: ${detail}`);
      return failResult(detail || err.message, Date.now() - start);
    }
  }

  const wallMs = Date.now() - start;
  const lines = stdout.trim().split("\n").filter(Boolean);
  let usage = null;
  let errMsg = null;
  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === "turn.completed" && ev.usage) usage = ev.usage;
      if (ev.type === "error" || ev.type === "turn.failed") {
        const msg = ev.message || ev.error || JSON.stringify(ev).slice(0, 160);
        // Keep the most specific failure; connection flaps often repeat.
        if (!errMsg || /connection|network|401|403|402|budget/i.test(String(msg))) {
          errMsg = String(msg);
        }
      }
    } catch {
      // ignore non-JSON noise
    }
  }

  if (!usage) {
    const msg = errMsg || "no turn.completed usage in codex output";
    console.warn(`  ⚠  ${msg.slice(0, 160)}`);
    return failResult(msg, wallMs);
  }

  const inputTokens = usage.input_tokens ?? 0;
  const cacheRead = usage.cached_input_tokens ?? 0;
  const cacheCreate = usage.cache_write_input_tokens ?? 0;
  // Codex reports input_tokens as the full input; cached/write are breakdowns.
  const totalInput = inputTokens;
  return {
    ok: true,
    inputTokens: Math.max(0, inputTokens - cacheRead - cacheCreate) || inputTokens,
    cacheCreate,
    cacheRead,
    totalInput,
    outputTokens: usage.output_tokens ?? 0,
    durationMs: wallMs,
    costUSD: 0,
  };
}

async function runTurn(mcpConfig, opts = {}) {
  return runnerArg === "codex" ? runCodex(mcpConfig, opts) : runClaude(mcpConfig, opts);
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

async function measure(label, description, mcpConfig, rounds, opts = {}) {
  process.stdout.write(`  ${label.padEnd(14)} ${description}\n`);
  const results = [];
  for (let i = 0; i < rounds; i++) {
    if (rounds > 1) process.stdout.write(`               round ${i + 1}/${rounds}...\r`);
    results.push(await runTurn(mcpConfig, opts));
  }
  if (rounds > 1) process.stdout.write(" ".repeat(40) + "\r");

  const ok = results.filter((r) => r.ok);
  if (ok.length === 0) {
    return {
      label,
      description,
      ok: false,
      error: results[0]?.error,
      totalInput: 0,
      inputTokens: 0,
      cacheCreate: 0,
      cacheRead: 0,
      outputTokens: 0,
      durationMs: 0,
      costUSD: 0,
    };
  }

  const result = {
    label,
    description,
    ok: true,
    rounds: ok.length,
    totalInput: Math.round(mean(ok.map((r) => r.totalInput))),
    inputTokens: Math.round(mean(ok.map((r) => r.inputTokens))),
    cacheCreate: Math.round(mean(ok.map((r) => r.cacheCreate))),
    cacheRead: Math.round(mean(ok.map((r) => r.cacheRead))),
    outputTokens: Math.round(mean(ok.map((r) => r.outputTokens))),
    durationMs: Math.round(mean(ok.map((r) => r.durationMs))),
    costUSD: mean(ok.map((r) => r.costUSD)),
  };
  process.stdout.write(
    `               ${result.totalInput.toLocaleString()} tokens  ${result.durationMs.toLocaleString()}ms\n`
  );
  return result;
}

// ─── Main ──────────────────────────────────────────────────────────────────

const serverNames = Object.keys(servers);
const nServers = serverNames.length;
const nSkills = skills.length;
const charsFull = skills.reduce((a, s) => a + s.charsFull, 0);
const charsStub = skills.reduce((a, s) => a + s.charsStub, 0);
const largest = [...skills].sort((a, b) => b.charsFull - a.charsFull)[0] ?? null;

console.log(`\nlazygate benchmark`);
console.log(`${"─".repeat(60)}`);
if (tasksOnly) {
  // Task mode runs against the fixture servers; --include-catalog adds the user's catalog too.
  console.log(
    `Mode:    --tasks${coldDiscovery ? " --cold-discovery (lazygate starts cold: the model must discover the server and tools)" : ""} (direct | call_tool | call_tool+opt | run_chain; ${includeCatalog ? "loads your full Lazygate catalog (--include-catalog)" : "fixture servers only (pass --include-catalog for the full catalog)"})`
  );
  console.log(
    `Catalog: ${Object.keys(servers).length} runnable` +
      (Object.keys(servers).length ? ` (${Object.keys(servers).join(", ")})` : "")
  );
  if (skippedServers.length) console.log(`Skipped: ${skippedServers.join(", ")}`);
  console.log(`Runner:  ${runnerArg}`);
  console.log();
} else {
  console.log(`Servers config: ${configPath}`);
  console.log(`Skills config:  ${skillsConfigPath}`);
  if (runMcp) {
    console.log(`Servers: ${nServers}${nServers ? `  (${serverNames.join(", ")})` : ""}`);
    if (skippedServers.length) console.log(`Skipped servers: ${skippedServers.join(", ")}`);
  }
  if (runSkills) {
    console.log(`Skills:  ${nSkills}${nSkills ? `  (~${charsFull.toLocaleString()} chars full → ~${charsStub.toLocaleString()} stub)` : ""}`);
    if (skippedSkills.length) console.log(`Skipped skills: ${skippedSkills.join(", ")}`);
  }
  console.log(`Rounds:  ${roundsArg}`);
  console.log(`Runner:  ${runnerArg}${runnerArg === "codex" ? ` (${codexModel})` : ""}`);
  console.log(`Prompt:  "${PROMPT}"`);
  if (estimateOnly) console.log(`Mode:    --estimate (local chars÷4, no API)`);
  console.log();
}

const fmtNum = (n) => n.toLocaleString();

// ─── Task mode (--tasks) ───────────────────────────────────────────────────
//
// Several multi-step tasks, each run four ways against the same fixture servers:
//   direct              — Claude talks to the fixture MCP servers itself (no lazygate)
//   call-tool           — lazygate; model chains call_tool (one round trip per step)
//   call-tool-optimized — call-tool with response optimization (adaptive default + call_tool fields)
//   run-chain           — lazygate; model writes one run_chain script for the chain
// Every run's catalog holds all fixture servers (tickets, orders, logs), so a task also has to pick
// the right server, and one task needs two. Each strategy is one cold-cache `claude -p` turn;
// answers are checked against the fixture data, so a strategy that returns a wrong number is
// reported as a failure. Tasks, instructions and expected answers live in lib/tasks.mjs.

import {
  TASKS,
  TASK_IDS,
  STRATEGY_IDS,
  STRATEGY_LABELS,
  FIXTURE_SERVERS,
  EVAL_FIXTURE_SERVERS,
  ALL_FIXTURE_SERVERS,
  FIXTURE_DIR,
  buildInstruction,
  taskPrompt,
  strategyResponseOptimization,
  answerMatches,
  answerSummary,
} from "./lib/tasks.mjs";

const fmtNumTask = (n) => n.toLocaleString();

/**
 * Fixture servers a run loads. The original four tasks keep the original three (so their catalog and
 * published results do not change); the refund-evaluation tasks add the refunds and docs servers.
 */
function catalogFor(taskId) {
  const names = Object.keys(FIXTURE_SERVERS);
  const needsEval = TASKS[taskId]?.servers.some((s) => s in EVAL_FIXTURE_SERVERS);
  return needsEval ? Object.keys(ALL_FIXTURE_SERVERS) : names;
}

/** One fixture server as a servers.json entry (tool chain on; opted in to the discover preview). */
function fixtureServerEntry(name, startLog) {
  const fixture = ALL_FIXTURE_SERVERS[name];
  return {
    description: fixture.description,
    keywords: fixture.keywords,
    command: process.execPath,
    args: [resolve(FIXTURE_DIR, fixture.file)],
    env: { FIXTURE_START_LOG: startLog },
    inheritEnv: false,
    toolChain: true,
    // Off by default (a discovery request starts nothing); --preview opts the fixtures in.
    ...(previewFlag ? { previewOnDiscover: true } : {}),
    ...(variantManifest() ? { manifest: true } : {}),
  };
}

/** Strategies this run covers, in the catalog's order. */
const activeStrategies = () => {
  const wanted = strategiesArg ? new Set(strategiesArg.split(",").map((x) => x.trim())) : null;
  return STRATEGY_IDS.filter((id) => !wanted || wanted.has(id));
};

/**
 * The run units for one task. Without --experiment these are the four strategies; with it, one per
 * variant. Each unit is { id, strategy, label, variant }: `strategy` drives execution, `variant` (when set)
 * supplies the manifest and optimization policy for that run.
 */
function runUnits() {
  if (!experiment) {
    return activeStrategies().map((id) => ({ id, strategy: id, label: STRATEGY_LABELS[id], variant: null }));
  }
  return experiment.variants.map((v) => ({ id: v.id, strategy: v.strategy, label: `${v.id} ${v.label}`, variant: v }));
}

/**
 * tool-index.json as it would look after each fixture server ran once: tool names, descriptions
 * and call signatures (built through the real ProcessManager and ToolIndex from dist/).
 */
const warmIndexPromises = new Map();
function warmToolIndexJson(taskId) {
  const names = catalogFor(taskId);
  const key = names.join(",");
  if (!warmIndexPromises.has(key)) warmIndexPromises.set(key, buildWarmToolIndexJson(names));
  return warmIndexPromises.get(key);
}

async function buildWarmToolIndexJson(names) {
  const { ProcessManager } = await import(pathToFileURL(resolve(__dirname, "..", "dist", "process-manager.js")).href);
  const { ToolIndex } = await import(pathToFileURL(resolve(__dirname, "..", "dist", "tool-index.js")).href);
  const dir = mkdtempSync(join(workDir, "warm-index-"));
  const indexPath = join(dir, "tool-index.json");
  const index = new ToolIndex(indexPath);
  const manager = new ProcessManager({ idleTtlMs: 0 });
  try {
    for (const name of names) {
      // Same command/args as the servers.json entry, so the index entry is "fresh" for it.
      const cfg = fixtureServerEntry(name, join(dir, "warm-starts.log"));
      const tools = await manager.activate(name, cfg);
      index.record(name, cfg, tools);
    }
  } finally {
    manager.dispose();
  }
  return readFileSync(indexPath, "utf8");
}

/**
 * Broker config for lazygate task strategies: every fixture server (plus the user's runnable
 * catalog with --include-catalog). Meta-tools stay the only schemas in tools/list (expose
 * defaults to none); the instructions name the servers a task needs, or the model discovers them.
 */
function taskBrokerConfig(strategyDir, strategyId, startLog, taskId) {
  const cfgPath = join(strategyDir, "servers.json");
  // Only the fixtures unless --include-catalog: the real catalog can hold destructive tools and
  // --tasks bypasses permission prompts.
  const merged = { ...(includeCatalog ? servers : {}) };
  for (const name of catalogFor(taskId)) merged[name] = fixtureServerEntry(name, startLog);
  // Expand ${VAR} the same way direct MCP wiring does, so stdio children get real secrets.
  const out = {};
  for (const [name, cfg] of Object.entries(merged)) {
    const copy = { ...cfg };
    if (copy.env) {
      copy.env = Object.fromEntries(Object.entries(copy.env).map(([k, v]) => [k, expandVars(String(v))]));
    }
    if (copy.headers) {
      copy.headers = Object.fromEntries(
        Object.entries(copy.headers).map(([k, v]) => [k, expandVars(String(v))])
      );
    }
    out[name] = copy;
  }
  // An experiment variant supplies its own policy (possibly null = off); otherwise the strategy's default.
  const responseOptimization = activeVariant ? activeVariant.responseOptimization : strategyResponseOptimization(strategyId);
  writeFileSync(cfgPath, JSON.stringify({ ...(responseOptimization ? { responseOptimization } : {}), servers: out }));
  return cfgPath;
}

/**
 * MCP config for a task strategy.
 * - direct: every fixture server (and the user's runnable catalog with --include-catalog), classic MCP
 * - lazygate: one broker process wrapping that same catalog
 */
async function taskMcpConfig(strategyId, strategyDir, startLog, taskId) {
  if (strategyId === "direct") {
    const mcp = includeCatalog ? buildMcpConfig(Object.keys(servers)) : { mcpServers: {} };
    // A fixture wins if the user already has a server with the same name.
    for (const name of catalogFor(taskId)) {
      mcp.mcpServers[name] = {
        command: process.execPath,
        args: [resolve(FIXTURE_DIR, ALL_FIXTURE_SERVERS[name].file)],
        env: { FIXTURE_START_LOG: startLog },
      };
    }
    return mcp;
  }
  const cfgPath = taskBrokerConfig(strategyDir, strategyId, startLog, taskId);
  const brokerEntry = resolve(__dirname, "..", "dist", "index.js");
  // The broker keeps tool-index.json under $HOME/.config/lazygate regardless of --config, so give
  // it a private HOME: a run neither reads signatures a previous run left behind (which would make
  // "cold" warm) nor writes fixture entries into the real index. With --include-catalog the real
  // HOME stays, because the catalog's own servers may depend on it.
  let env;
  if (!includeCatalog) {
    const home = join(strategyDir, "home");
    const configHome = join(home, ".config", "lazygate");
    mkdirSync(configHome, { recursive: true });
    if (variantIndex() === "warm") writeFileSync(join(configHome, "tool-index.json"), await warmToolIndexJson(taskId));
    env = { HOME: home };
  }
  return {
    mcpServers: {
      lazygate: { command: process.execPath, args: [brokerEntry, "--config", cfgPath], ...(env ? { env } : {}) },
    },
  };
}

/** Number of fixture-server processes a run launched (each appends a line to the start log). */
function countServerStarts(startLog) {
  try {
    return readFileSync(startLog, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function runTaskStrategy(taskId, strategyId, { round = 1, traceDir = null } = {}) {
  const dir = mkdtempSync(join(workDir, `task-${taskId}-${strategyId}-`));
  const startLog = join(dir, "starts.log");
  const mcpConfig = await taskMcpConfig(strategyId, dir, startLog, taskId);
  const appendFile = join(dir, "instruction.md");
  writeFileSync(appendFile, buildInstruction(taskId, strategyId, { cold: coldDiscovery }));
  // Persist the raw runner stream per run when asked, so every number in a result can be audited.
  // Keyed by the variant id when there is one: B and C share an execution, and must not share a file.
  const runKey = activeVariant ? activeVariant.id : strategyId;
  const traceFile = traceDir ? join(traceDir, `${taskId}__${runKey}__r${round}.jsonl`) : null;
  const result = await runClaudeTask(mcpConfig, {
    appendFile,
    prompt: taskPrompt(taskId, { cold: coldDiscovery }),
    model: modelArg,
    traceFile,
  });
  return {
    taskId,
    id: runKey,
    label: activeVariant ? `${activeVariant.id} ${activeVariant.label}` : STRATEGY_LABELS[strategyId],
    ...result,
    serversStarted: countServerStarts(startLog),
    // The configuration this run was built with, so a published row says exactly what it measured.
    configHash: taskConfigHash(taskId, strategyId),
    ...(traceFile ? { trace: traceFile } : {}),
  };
}

/** Stable hash of everything that defines a strategy's configuration for one task. */
function taskConfigHash(taskId, strategyId) {
  const payload = JSON.stringify({
    instruction: buildInstruction(taskId, strategyId, { cold: coldDiscovery }),
    prompt: taskPrompt(taskId, { cold: coldDiscovery }),
    catalog: catalogFor(taskId),
    responseOptimization: activeVariant ? activeVariant.responseOptimization : strategyResponseOptimization(strategyId),
    variant: activeVariant?.id ?? null,
    manifest: variantManifest(),
    index: variantIndex(),
    preview: previewFlag,
    model: modelArg ?? null,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/**
 * Like runClaude, but the model must actually call MCP tools.
 * Idle schema runs use `--tools ""` + `--bare` and never invoke tools. Task mode still turns
 * built-ins off, but:
 *   - skips `--bare` so Claude can use a logged-in session (bare only accepts ANTHROPIC_API_KEY)
 *   - allows MCP calls without interactive approval
 *   - ignores the user's real MCP config (`--strict-mcp-config`)
 *   - ignores the user's settings and hooks (`--setting-sources ""`, `disableAllHooks`)
 */
async function runClaudeTask(mcpConfig, { appendFile, prompt, model = null, traceFile = null }) {
  const claudeArgs = [
    "-p",
    prompt,
    // Pin the model when asked (--model); the runner's reported model is recorded below, so a run
    // states which model answered even when no pin was given.
    ...(model ? ["--model", model] : []),
    // stream-json (with --verbose) lets us count API round trips: `num_turns` counts tool calls,
    // so a model that batches eight calls into one response still reports ten turns.
    "--output-format",
    "stream-json",
    "--verbose",
    "--tools",
    "",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--permission-mode",
    "bypassPermissions",
    "--dangerously-skip-permissions",
    // Keep the user's own hooks, memory plugins and settings out of the measurement: they inject
    // tens of thousands of tokens into every turn, which hides the difference between strategies.
    "--setting-sources",
    "",
    "--settings",
    JSON.stringify({ disableAllHooks: true }),
    "--mcp-config",
    JSON.stringify(mcpConfig),
    "--append-system-prompt-file",
    appendFile,
  ];
  const start = Date.now();
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("claude", claudeArgs, {
      // Larger fixture: call_tool may need many sequential get_ticket turns.
      timeout: 600_000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }));
  } catch (err) {
    stdout = err.stdout?.toString?.() ?? err.stdout ?? "";
    if (!stdout.trim()) {
      const detail = (err.stderr?.toString?.() ?? err.message ?? "").slice(0, 160);
      return { ok: false, error: detail || err.message, durationMs: Date.now() - start };
    }
  }
  let data;
  const messageIds = new Set();
  const toolUses = new Map(); // tool_use id → { name, input } (a block can repeat across stream events)
  const modelsSeen = new Set();
  try {
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === "assistant" && event.message?.id) {
        messageIds.add(event.message.id);
        if (event.message.model) modelsSeen.add(String(event.message.model));
        for (const block of event.message.content ?? []) {
          // Keep the arguments too: a trace must show which tool, and with which args, each call used.
          if (block?.type === "tool_use" && block.id) {
            toolUses.set(block.id, { name: String(block.name ?? ""), input: block.input ?? {} });
          }
        }
      } else if (event.type === "result") data = event;
    }
    if (!data) throw new Error("no result event");
  } catch {
    return { ok: false, error: "invalid JSON from claude", durationMs: Date.now() - start };
  }
  if (traceFile) {
    try {
      writeFileSync(traceFile, stdout);
    } catch {
      /* a trace is best effort; never fail the run over it */
    }
  }
  if (data.is_error || data.api_error_status) {
    return { ok: false, error: String(data.result ?? "claude returned is_error").slice(0, 160), durationMs: data.duration_ms ?? 0 };
  }
  const u = data.usage ?? {};
  const totalInput = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const names = [...toolUses.values()].map((t) => t.name);
  return {
    ok: true,
    answer: String(data.result ?? ""),
    turns: data.num_turns ?? 0,
    apiCalls: Math.max(1, messageIds.size),
    // discover_tools / describe_tool / activate_server calls: the turns spent finding the right tool.
    lookups: names.filter((name) => /(discover_tools|describe_tool|activate_server)$/.test(name)).length,
    // The model the runner says answered. With --model it should match the pin; if it does not, the run is
    // not the configuration it claims to be.
    model: [...modelsSeen][0] ?? null,
    modelsSeen: [...modelsSeen],
    toolCalls: [...toolUses.values()].map((t) => ({ name: t.name, input: t.input })),
    totalInput,
    outputTokens: u.output_tokens ?? 0,
    durationMs: data.duration_ms ?? Date.now() - start,
    costUSD: data.total_cost_usd ?? 0,
  };
}


/**
 * Input tokens one bare API call costs in this environment (system prompt, built-in agents,
 * ...), measured once with no MCP servers. Every call pays it, so it dwarfs the schema and
 * result differences between strategies; subtracting it per call exposes them.
 */
let taskBaselinePromise = null;
function measureTaskBaseline() {
  taskBaselinePromise ??= (async () => {
    const dir = mkdtempSync(join(workDir, "task-baseline-"));
    const appendFile = join(dir, "instruction.md");
    writeFileSync(appendFile, "Reply with exactly the word ok.");
    const r = await runClaudeTask({ mcpServers: {} }, { appendFile, prompt: "Reply with the single word ok." });
    return r.ok && r.apiCalls === 1 ? r.totalInput : 0;
  })();
  return taskBaselinePromise;
}

/**
 * Collapse one strategy's rounds into a row. Token, turn and duration figures are means over
 * the correct runs, so a wrong answer never skews the comparison; `ok` is false only when every
 * round errored.
 */
function summarizeTaskRuns(id, label, runs, taskId) {
  const completed = runs.filter((r) => r.ok);
  if (completed.length === 0) {
    return { taskId, id, label, ok: false, error: runs[0]?.error ?? "no runs", runs: runs.length, correctRuns: 0, runDetails: runs.map(runDetail) };
  }
  const correct = completed.filter((r) => r.correct);
  const basis = correct.length ? correct : completed;
  const inputs = basis.map((r) => r.totalInput);
  return {
    taskId,
    id,
    label,
    ok: true,
    runs: runs.length,
    correctRuns: correct.length,
    totalInput: Math.round(mean(inputs)),
    // Net input is computed per run (raw − that run's API calls × the fixed overhead), then averaged.
    netInput: Math.round(mean(basis.map((r) => r.netInput ?? r.totalInput))),
    costUSD: mean(basis.map((r) => r.costUSD ?? 0)),
    minDurationMs: Math.min(...basis.map((r) => r.durationMs)),
    maxDurationMs: Math.max(...basis.map((r) => r.durationMs)),
    minInput: Math.min(...inputs),
    maxInput: Math.max(...inputs),
    turns: mean(basis.map((r) => r.turns)),
    apiCalls: mean(basis.map((r) => r.apiCalls ?? 0)),
    lookups: mean(basis.map((r) => r.lookups ?? 0)),
    serversStarted: mean(basis.map((r) => r.serversStarted ?? 0)),
    durationMs: Math.round(mean(basis.map((r) => r.durationMs))),
    answer: basis[basis.length - 1].answer,
    // Every run, including wrong ones and errors, so a published result can be audited.
    runDetails: runs.map(runDetail),
  };
}

/** The auditable facts of one live run. */
function runDetail(r) {
  return r.ok
    ? {
        correct: Boolean(r.correct),
        answer: String(r.answer).trim().slice(0, 200),
        totalInput: r.totalInput,
        netInput: r.netInput,
        apiCalls: r.apiCalls,
        toolCalls: r.turns,
        lookups: r.lookups ?? 0,
        serversStarted: r.serversStarted ?? 0,
        durationMs: r.durationMs,
        costUSD: r.costUSD ?? 0,
        // Provenance: which model the runner reports, which configuration produced the run, and the raw
        // stream to audit it. Each tool call's name and arguments are kept, not just a count.
        model: r.model ?? null,
        configHash: r.configHash ?? null,
        trace: r.trace ?? null,
        toolCallDetail: (r.toolCalls ?? []).map((t) => ({ name: t.name, input: t.input })),
      }
    : { correct: false, error: String(r.error ?? "unknown").slice(0, 200), durationMs: r.durationMs ?? 0 };
}

/** Mean turns: whole numbers stay whole, otherwise one decimal. */
function fmtTurns(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** Mean of a list, ignoring nothing; 0 for an empty list. */
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** mulberry32: a small seeded PRNG, so a strategy order is reproducible from --seed. */
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash of a string (FNV-1a), to vary the seed per task. */
function hashString(s) {
  let h = 0x811c9dc5;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h;
}

/** Fisher–Yates shuffle with an injected random source; returns a new array. */
function shuffle(items, rng) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** One strategy's row under a task: net/raw input, calls, lookups, servers started, time, verdict. */
function taskRowLine(r, rounds, expectedCount) {
  if (!r.ok) return `${r.label.padEnd(14)} ERROR  ${r.error}`;
  const range = r.correctRuns > 1 ? `  (${fmtNumTask(r.minInput)}–${fmtNumTask(r.maxInput)})` : "";
  const verdict = rounds > 1 ? `correct ${r.correctRuns}/${r.runs}` : r.correctRuns ? "correct" : "WRONG";
  return (
    `${r.label.padEnd(14)} net ${fmtNumTask(r.netInput).padStart(8)}  raw ${fmtNumTask(r.totalInput).padStart(9)}  ` +
    `calls ${fmtTurns(r.apiCalls).padStart(4)}  tool calls ${fmtTurns(r.turns).padStart(4)}  ` +
    `lookups ${fmtTurns(r.lookups).padStart(3)}  servers started ${fmtTurns(r.serversStarted).padStart(3)}  ` +
    `$${r.costUSD.toFixed(4)}  ${(r.durationMs / 1000).toFixed(1).padStart(5)}s  ${verdict}  answer: ${answerSummary(r.answer, expectedCount)}${range}`
  );
}

/** "label: −N net input tokens (−P%); ±K API calls" for two strategies that both answered correctly. */
function taskDeltaLine(label, base, other) {
  const fair = (r) => r?.ok && r.correctRuns > 0;
  if (!fair(base) || !fair(other)) return null;
  const d = other.netInput - base.netInput;
  const pct = base.netInput ? Math.abs((d / base.netInput) * 100).toFixed(1) : "0.0";
  const sign = d > 0 ? "+" : d < 0 ? "−" : "±";
  const rawD = other.totalInput - base.totalInput;
  const callsD = other.apiCalls - base.apiCalls;
  return (
    `${label}: ${sign}${fmtNumTask(Math.abs(d))} net input tokens (${sign}${pct}%); ` +
    `${callsD >= 0 ? "+" : "−"}${fmtTurns(Math.abs(callsD))} API calls; raw ${rawD >= 0 ? "+" : "−"}${fmtNumTask(Math.abs(rawD))} ` +
    `(${rawD >= 0 ? "+" : "−"}${base.totalInput ? Math.abs((rawD / base.totalInput) * 100).toFixed(1) : "0.0"}%); ` +
    `cost ${other.costUSD - base.costUSD >= 0 ? "+" : "−"}$${Math.abs(other.costUSD - base.costUSD).toFixed(4)}`
  );
}

/**
 * Aggregate across tasks. A strategy is compared with `direct` only on tasks where both answered
 * correctly, using summed net input, so one cheap task cannot dominate and a wrong run never counts.
 */
function summarizeAcrossTasks(rowsByTask) {
  const out = [];
  for (const id of activeStrategies()) {
    const rows = Object.values(rowsByTask).map((r) => r.find((x) => x.id === id)).filter(Boolean);
    const okRows = rows.filter((r) => r.ok);
    const paired = Object.values(rowsByTask)
      .map((r) => [r.find((x) => x.id === "direct"), r.find((x) => x.id === id)])
      .filter(([d, o]) => d?.ok && d.correctRuns > 0 && o?.ok && o.correctRuns > 0);
    const sum = (pick) => ({
      base: paired.reduce((a, [d]) => a + pick(d), 0),
      other: paired.reduce((a, [, o]) => a + pick(o), 0),
    });
    const pct = (t) => (id !== "direct" && t.base ? ((t.other - t.base) / t.base) * 100 : null);
    const net = sum((r) => r.netInput);
    const raw = sum((r) => r.totalInput);
    const cost = sum((r) => r.costUSD);
    out.push({
      id,
      label: STRATEGY_LABELS[id],
      tasksCorrect: rows.filter((r) => r.ok && r.correctRuns === r.runs).length,
      tasks: rows.length,
      correctRuns: rows.reduce((a, r) => a + (r.correctRuns ?? 0), 0),
      runs: rows.reduce((a, r) => a + (r.runs ?? 0), 0),
      meanApiCalls: avg(okRows.map((r) => r.apiCalls)),
      meanLookups: avg(okRows.map((r) => r.lookups)),
      meanServersStarted: avg(okRows.map((r) => r.serversStarted)),
      meanNetInput: Math.round(avg(okRows.map((r) => r.netInput))),
      meanRawInput: Math.round(avg(okRows.map((r) => r.totalInput))),
      meanCostUSD: avg(okRows.map((r) => r.costUSD)),
      pairedTasks: paired.length,
      vsDirectPct: pct(net),
      vsDirectRawPct: pct(raw),
      vsDirectCostPct: pct(cost),
    });
  }
  return out;
}

if (tasksOnly) {
  const rounds = Math.max(1, roundsArg || 1);
  console.log(
    `Tasks:   ${selectedTasks.length} (${selectedTasks.join(", ")}); catalog holds ${selectedTasks.some((t) => catalogFor(t).length > Object.keys(FIXTURE_SERVERS).length) ? Object.keys(ALL_FIXTURE_SERVERS).join(", ") : Object.keys(FIXTURE_SERVERS).join(", ")}` +
      (coldDiscovery ? "; cold discovery — extra turns versus a known-tools run are the discover_tools / describe_tool lookups" : "")
  );
  if (coldDiscovery || manifestFlag) {
    console.log(
      `Variant: index ${includeCatalog ? "user's own" : indexMode}${indexMode === "warm" ? " (signatures cached from an earlier run)" : ""}, ` +
        `discover preview ${previewFlag ? "on" : "off"}, manifest ${manifestFlag ? "in the MCP instructions" : "off"}`
    );
  }
  console.log(
    `Runner:  claude (task mode, ${rounds} cold turn${rounds !== 1 ? "s" : ""} per strategy and task; ` +
      `averages use correct runs only)\n`
  );
  if (estimateOnly) {
    console.log(`Mode:    --estimate: skipping live runs (task mode needs claude -p). Instructions the model would get:\n`);
    for (const taskId of selectedTasks) {
      const task = TASKS[taskId];
      console.log(`Task ${taskId} — ${task.title}`);
      console.log(`Prompt: ${taskPrompt(taskId, { cold: coldDiscovery })}`);
      console.log(`Expect: ${task.expected().join(" ")}\n`);
      for (const unit of runUnits()) {
        // An experiment variant's instruction follows its execution mode, so a variant shows what it will get.
        console.log(`[${unit.label ?? STRATEGY_LABELS[unit.id]}]\n${buildInstruction(taskId, unit.strategy, { cold: coldDiscovery })}\n`);
      }
    }
    process.exit(0);
  }
  const baselinePerCall = await measureTaskBaseline();
  console.log(
    baselinePerCall
      ? `Fixed overhead: ${fmtNumTask(baselinePerCall)} input tokens per API call (system prompt of this Claude Code install, no MCP). ` +
          `"net" removes it, so the strategies are compared on what they add.\n`
      : `Could not measure the fixed per-call overhead; "net" equals the raw input.\n`
  );
  const rowsByTask = {};
  const expectedByTask = {};
  if (traceDirArg) mkdirSync(resolve(traceDirArg), { recursive: true });
  for (const taskId of selectedTasks) {
    const expected = TASKS[taskId].expected();
    expectedByTask[taskId] = expected;
    console.log(`── ${taskId}: ${TASKS[taskId].title}`);
    console.log(`   expected answer: ${expected.join(" ")}`);
    const units = runUnits();
    const strategies = units.map((u) => u.id);
    const runsByStrategy = Object.fromEntries(strategies.map((id) => [id, []]));
    // Rounds are the outer loop and the run order is shuffled inside each round, so prompt-cache
    // state and time-of-run do not line up with one strategy. Seeded, so the order is reproducible.
    const rng = seededRandom(seedArg ^ hashString(taskId));
    for (let round = 1; round <= rounds; round++) {
      for (const unit of shuffle(units, rng)) {
        const strategyId = unit.id;
        const label = unit.label ?? STRATEGY_LABELS[strategyId];
        const suffix = rounds > 1 ? ` (round ${round}/${rounds})` : "";
        process.stdout.write(`  ${label.padEnd(14)} running...${suffix}\n`);
        activeVariant = unit.variant;
        const r = await runTaskStrategy(taskId, unit.strategy, {
          round,
          traceDir: traceDirArg ? resolve(traceDirArg) : null,
        });
        activeVariant = null;
        if (r.ok) {
          r.correct = answerMatches(r.answer, expected);
          // Input above the fixed per-call overhead: schemas, instructions, calls and results only.
          r.netInput = Math.max(0, Math.round(r.totalInput - r.apiCalls * baselinePerCall));
          // A pinned run must report the pinned model. If the runner used another model, the run is not
          // the configuration it claims to be, so it is flagged rather than silently counted.
          if (modelArg && r.modelsSeen?.length && !r.modelsSeen.some((m) => m.includes(modelArg))) {
            r.modelMismatch = `pinned ${modelArg}, runner used ${r.modelsSeen.join(", ")}`;
            console.error(`  ! model mismatch on ${taskId}/${strategyId}: ${r.modelMismatch}`);
          }
        }
        runsByStrategy[strategyId].push(r);
      }
    }
    const rows = units.map((unit) =>
      summarizeTaskRuns(unit.id, unit.label ?? STRATEGY_LABELS[unit.id], runsByStrategy[unit.id], taskId)
    );
    rowsByTask[taskId] = rows;
    console.log("");
    for (const r of rows) console.log(taskRowLine(r, rounds, expected.length));
    const by = (id) => rows.find((r) => r.id === id);
    const lines = [
      taskDeltaLine("call_tool vs direct", by("direct"), by("call-tool")),
      taskDeltaLine("call_tool+opt vs direct", by("direct"), by("call-tool-optimized")),
      taskDeltaLine("call_tool+opt vs call_tool", by("call-tool"), by("call-tool-optimized")),
      taskDeltaLine("run_chain vs direct", by("direct"), by("run-chain")),
      taskDeltaLine("run_chain vs call_tool", by("call-tool"), by("run-chain")),
    ].filter(Boolean);
    if (lines.length) {
      console.log("");
      for (const line of lines) console.log(line);
    } else {
      const status = (r) => (!r ? "missing" : !r.ok ? "ERROR" : r.correctRuns ? "correct" : "WRONG");
      console.log(
        `\n(Skipping token deltas — need correct runs to compare; direct=${status(by("direct"))}, ` +
          `call_tool=${status(by("call-tool"))}, call_tool+opt=${status(by("call-tool-optimized"))}, run_chain=${status(by("run-chain"))}.)`
      );
    }
    console.log("");
  }

  const summary = summarizeAcrossTasks(rowsByTask);
  console.log(`${"═".repeat(76)}`);
  console.log(
    `ACROSS ${selectedTasks.length} TASK${selectedTasks.length !== 1 ? "S" : ""}  ` +
      `(${coldDiscovery ? "cold discovery" : "known tools"}, ${rounds} round${rounds !== 1 ? "s" : ""} each)`
  );
  console.log(`${"═".repeat(76)}`);
  console.log(
    `${"strategy".padEnd(14)} ${"correct".padStart(9)} ${"net in".padStart(9)} ${"raw in".padStart(9)} ${"cost".padStart(8)} ${"calls".padStart(6)} ${"lookups".padStart(8)} ${"servers".padStart(8)}  vs direct: net / raw / cost`
  );
  const signed = (v) => (v === null ? "—" : `${v <= 0 ? "−" : "+"}${Math.abs(v).toFixed(1)}%`);
  for (const r of summary) {
    const vs = r.vsDirectPct === null ? "—" : `${signed(r.vsDirectPct)} / ${signed(r.vsDirectRawPct)} / ${signed(r.vsDirectCostPct)} (${r.pairedTasks} paired)`;
    console.log(
      `${r.label.padEnd(14)} ${`${r.correctRuns}/${r.runs}`.padStart(9)} ${fmtNumTask(r.meanNetInput).padStart(9)} ${fmtNumTask(r.meanRawInput).padStart(9)} ` +
        `${`$${r.meanCostUSD.toFixed(4)}`.padStart(8)} ${fmtTurns(Math.round(r.meanApiCalls * 10) / 10).padStart(6)} ${fmtTurns(Math.round(r.meanLookups * 10) / 10).padStart(8)} ` +
        `${fmtTurns(Math.round(r.meanServersStarted * 10) / 10).padStart(8)}  ${vs}`
    );
  }
  console.log(
    `\n"servers" is how many fixture server processes the run launched (direct starts all ${Object.keys(FIXTURE_SERVERS).length} eagerly; ` +
      `lazygate starts only what the task touches). "net in" removes the fixed per-call overhead (a modeled figure); "raw in" and "cost" are what the run reported. All are means over the strategy's tasks; "vs direct" sums each measure over the tasks where both sides were correct.\n`
  );

  if (jsonOut) {
    const doc = {
      generatedAt: new Date().toISOString(),
      mode: coldDiscovery ? "cold" : "known",
      variant: { index: includeCatalog ? "user" : indexMode, preview: previewFlag, manifest: manifestFlag },
      rounds,
      includeCatalog,
      baselineInputPerCall: baselinePerCall,
      tasks: Object.fromEntries(
        selectedTasks.map((id) => [id, { title: TASKS[id].title, expected: expectedByTask[id], rows: rowsByTask[id] }])
      ),
      summary,
    };
    writeFileSync(resolve(jsonOut), JSON.stringify(doc, null, 2) + "\n");
    console.log(`Wrote ${jsonOut}`);
  }
  rmSync(workDir, { recursive: true, force: true });
  process.exit(0);
}

// Local preview: always useful, and the only output for --estimate.
if (runSkills && nSkills > 0) {
  const fullPrompt = buildSkillsPrompt("full");
  const stubPrompt = buildSkillsPrompt("stubs");
  const onePrompt = largest ? buildSkillsPrompt("one", largest.name) : null;
  const metaChars = JSON.stringify(BROKER_META_TOOLS).length;
  console.log(`Local size preview (chars ÷ 4 ≈ tokens):\n`);
  if (runMcp) {
    console.log(
      `  lazygate meta-tools   ${fmtNum(metaChars).padStart(10)} chars  ~${fmtNum(estTokens(metaChars))} tokens  (${BROKER_META_TOOLS.length} tools)`
    );
  }
  console.log(
    `  skills-full           ${fmtNum(fullPrompt.length).padStart(10)} chars  ~${fmtNum(estTokens(fullPrompt.length))} tokens`
  );
  console.log(
    `  skills-stubs          ${fmtNum(stubPrompt.length).padStart(10)} chars  ~${fmtNum(estTokens(stubPrompt.length))} tokens`
  );
  if (onePrompt && largest) {
    const label = `skills-one (+${largest.name})`;
    console.log(
      `  ${label.padEnd(22)} ${fmtNum(onePrompt.length).padStart(10)} chars  ~${fmtNum(estTokens(onePrompt.length))} tokens`
    );
  }
  const saved = fullPrompt.length - stubPrompt.length;
  const pct = fullPrompt.length ? ((saved / fullPrompt.length) * 100).toFixed(1) : "0";
  console.log(
    `\n  Skill idle saving (estimate): −${fmtNum(saved)} chars (~${fmtNum(estTokens(saved))} tokens, ${pct}%)\n`
  );
}

if (estimateOnly) {
  if (runMcp && nServers > 0) {
    console.log(
      `MCP schema sizes need a live \`claude -p\` run (tool inputSchema isn't fully in tool-index.json).`
    );
    console.log(`Drop --estimate when your Claude API budget allows:\n`);
    console.log(`  lazygate benchmark --mcp-only\n`);
  }
  process.exit(0);
}

const rows = [];

try {
  if (runMcp && nServers > 0) {
    console.log(`MCP strategies...\n`);
    const empty = buildMcpConfig([]);
    const direct = buildMcpConfig(serverNames);
    const brokerIdle = buildMcpConfig([], [{ name: "broker", tools: BROKER_META_TOOLS }]);
    const brokerFull = buildMcpConfig(serverNames, [
      { name: "broker", tools: BROKER_META_TOOLS },
    ]);

    rows.push(
      await measure("baseline", "no MCP servers", empty, roundsArg),
      await measure("mcp-direct", `all ${nServers} servers loaded upfront`, direct, roundsArg),
      await measure(
        "lazygate",
        `${BROKER_META_TOOLS.length} meta-tools only (idle)`,
        brokerIdle,
        roundsArg
      ),
      await measure(
        "mcp-active",
        `${BROKER_META_TOOLS.length} meta-tools + all ${nServers} servers`,
        brokerFull,
        roundsArg
      )
    );
    console.log();
  }

  if (runSkills && nSkills > 0) {
    console.log(`Skill strategies...\n`);
    const empty = buildMcpConfig([]);
    const fullFile = writePromptFile("skills-full.md", buildSkillsPrompt("full"));
    const stubFile = writePromptFile("skills-stubs.md", buildSkillsPrompt("stubs"));
    const oneFile = largest
      ? writePromptFile("skills-one.md", buildSkillsPrompt("one", largest.name))
      : null;

    rows.push(
      await measure(
        "skills-full",
        `all ${nSkills} skill bodies in context`,
        empty,
        roundsArg,
        { appendFile: fullFile }
      ),
      await measure(
        "skills-stubs",
        `${nSkills} stubs only (lazygate after split)`,
        empty,
        roundsArg,
        { appendFile: stubFile }
      )
    );
    if (oneFile && largest) {
      rows.push(
        await measure(
          "skills-one",
          `stubs + load_skill("${largest.name}")`,
          empty,
          roundsArg,
          { appendFile: oneFile }
        )
      );
    }
    console.log();
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

// ─── Report ────────────────────────────────────────────────────────────────

const ok = rows.filter((r) => r.ok);
if (ok.length === 0) {
  console.error("All strategies failed.");
  const sample = rows.find((r) => r.error)?.error;
  if (sample) console.error(`Last error: ${sample}`);
  process.exit(1);
}

const W = 76;
const colL = (s, w) => String(s).padEnd(w);
const colR = (s, w) => String(s).padStart(w);
const fmt = (n) => n.toLocaleString();

console.log(`${"═".repeat(W)}`);
console.log(`RESULTS  (${roundsArg} round${roundsArg !== 1 ? "s" : ""} each)`);
console.log(`${"═".repeat(W)}\n`);

const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));

if (byLabel.baseline?.ok && byLabel["mcp-direct"]?.ok && byLabel.lazygate?.ok) {
  const sys = byLabel.baseline.totalInput;
  const directMCP = byLabel["mcp-direct"].totalInput - sys;
  const brokerMCP = byLabel.lazygate.totalInput - sys;
  const saved = byLabel["mcp-direct"].totalInput - byLabel.lazygate.totalInput;
  const pct = ((saved / byLabel["mcp-direct"].totalInput) * 100).toFixed(1);
  const savedCost = byLabel["mcp-direct"].costUSD - byLabel.lazygate.costUSD;
  console.log(`MCP (idle)`);
  console.log(`  Without lazygate  ${fmt(directMCP)} tokens of tool schemas per request`);
  console.log(
    `  With lazygate     ${fmt(brokerMCP)} tokens              (${pct}% less, −${fmt(saved)} tokens/req)`
  );
  console.log(
    `  Cost saving       $${savedCost.toFixed(5)} / request   ≈ $${(savedCost * 1000).toFixed(2)} / 1,000 requests`
  );
  console.log();
}

if (byLabel["skills-full"]?.ok && byLabel["skills-stubs"]?.ok) {
  const saved =
    byLabel["skills-full"].totalInput - byLabel["skills-stubs"].totalInput;
  const pct = ((saved / byLabel["skills-full"].totalInput) * 100).toFixed(1);
  const savedCost =
    byLabel["skills-full"].costUSD - byLabel["skills-stubs"].costUSD;
  console.log(`Skills (idle)`);
  console.log(
    `  Full bodies       ${fmt(byLabel["skills-full"].totalInput)} tokens  (${nSkills} skills, ${fmt(charsFull)} chars)`
  );
  console.log(
    `  Stubs only        ${fmt(byLabel["skills-stubs"].totalInput)} tokens  (${pct}% less, −${fmt(saved)} tokens/req)`
  );
  console.log(
    `  Cost saving       $${savedCost.toFixed(5)} / request   ≈ $${(savedCost * 1000).toFixed(2)} / 1,000 requests`
  );
  if (byLabel["skills-one"]?.ok && largest) {
    console.log(
      `  After load_skill  ${fmt(byLabel["skills-one"].totalInput)} tokens  (loaded largest: ${largest.name})`
    );
  }
  console.log();
}

console.log(
  `${colL("Strategy", 14)} ${colR("Tokens", 10)} ${colR("Token cost", 12)} ${colR("vs peer", 12)} ${colR("Latency", 9)}`
);
console.log(`${"─".repeat(W)}`);

function peerDelta(r) {
  if (r.label === "lazygate" || r.label === "mcp-active") {
    const peer = byLabel["mcp-direct"];
    if (!peer?.ok) return "—";
    const d = peer.totalInput - r.totalInput;
    return d > 0 ? `−${fmt(d)}` : `+${fmt(-d)}`;
  }
  if (r.label === "skills-stubs" || r.label === "skills-one") {
    const peer = byLabel["skills-full"];
    if (!peer?.ok) return "—";
    const d = peer.totalInput - r.totalInput;
    return d > 0 ? `−${fmt(d)}` : `+${fmt(-d)}`;
  }
  return "";
}

for (const r of rows) {
  if (!r.ok) {
    console.log(`${colL(r.label, 14)} ${"ERROR".padStart(10)}`);
    continue;
  }
  console.log(
    `${colL(r.label, 14)} ${colR(fmt(r.totalInput), 10)} ${colR("$" + r.costUSD.toFixed(5), 12)} ${colR(peerDelta(r), 12)} ${colR(fmt(r.durationMs) + "ms", 9)}`
  );
}
console.log(`${"─".repeat(W)}`);

console.log(`\n${"─".repeat(W)}`);
console.log(`CACHE BREAKDOWN\n`);
console.log(
  `${colL("Strategy", 14)} ${colR("uncached", 10)} ${colR("cache write", 13)} ${colR("cache read", 12)} ${colR("total", 8)}`
);
console.log(`${"─".repeat(W)}`);
for (const r of ok) {
  console.log(
    `${colL(r.label, 14)} ${colR(fmt(r.inputTokens), 10)} ${colR(fmt(r.cacheCreate), 13)} ${colR(fmt(r.cacheRead), 12)} ${colR(fmt(r.totalInput), 8)}`
  );
}

console.log(`\n${"─".repeat(W)}`);
console.log(`Notes`);
console.log(`  • Single cold-cache turn. Prompt-cached follow-ups cost less per turn.`);
console.log(`  • skills-* append SKILL.md-shaped text; they model split savings, not discover_skill.`);
console.log(`  • mcp-active ≈ mcp-direct: activating everything closes the idle gap.`);
console.log(`  • Re-run after changing servers.json / skills.json.\n`);
