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
import { promisify } from "util";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdtempSync,
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
  // Task mode still uses the tickets fixture for the workload; direct wires the user's catalog too.
  console.log(
    `Mode:    --tasks${coldDiscovery ? " --cold-discovery (lazygate starts cold: the model must discover the server and tools)" : ""} (direct | call_tool | call_tool+opt | run_chain; ${includeCatalog ? "loads your full Lazygate catalog (--include-catalog)" : "fixture server only (pass --include-catalog for the full catalog)"})`
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
// One multi-step task four ways against the same fixture server:
//   direct              — Claude talks to the tickets MCP server itself (no lazygate)
//   call-tool           — lazygate; model chains call_tool (one round trip per step)
//   call-tool-optimized — call-tool with response optimization (adaptive default + call_tool fields)
//   run-chain           — lazygate; model writes one run_chain script for the chain
// Each strategy is one cold-cache `claude -p` turn. Results are checked against the fixture's
// known answer, so a strategy that returns a wrong number is reported as a failure.

const TASK_PROMPT =
  "Using the tickets server, count the open tickets assigned to ana and sum each ticket's " +
  "bodyLength field (from get_ticket). Answer with exactly two numbers: the count, then the sum.";

const fmtNumTask = (n) => n.toLocaleString();

/** Same task, but nothing names the server: the model has to find it (--cold-discovery). */
const COLD_TASK_PROMPT =
  "Count the open support tickets assigned to ana and sum each ticket's bodyLength field " +
  "(the per-ticket record has it). Answer with exactly two numbers: the count, then the sum.";
const COLD_ANSWER_RULE = "Your entire final message must be exactly: <count> <sum> — two integers, one space, nothing else.";

/** Expected answer, derived from the same deterministic data as the fixture server. */
function taskExpectedAnswer() {
  const fixturePath = resolve(__dirname, "..", "src", "__tests__", "fixtures", "tickets-server.mjs");
  const src = readFileSync(fixturePath, "utf8");
  // Include TICKET_COUNT / BODY_REPEATS so the TICKETS initializer can eval offline.
  const start = src.indexOf("const TICKET_COUNT");
  const dataset = src.slice(start === -1 ? src.indexOf("const TICKETS") : start, src.indexOf("const tools"));
  const TICKETS = new Function(`${dataset}; return TICKETS;`)();
  const hits = TICKETS.filter((t) => t.status === "open" && t.assignee === "ana");
  const total = hits.reduce((sum, t) => sum + t.body.length, 0);
  return { count: hits.length, total };
}

const TASK_STRATEGIES = {
  direct: {
    label: "direct",
    // Claude gets every runnable server from ~/.config/lazygate/servers.json plus the tickets fixture.
    mcp: "direct",
    instruction:
      "You have many MCP servers loaded directly (no lazygate), including \"tickets\".\n" +
      "IGNORE every server except tickets. Tools on tickets: list_tickets, get_ticket.\n" +
      "There are several matching tickets; get_ticket bodies are large — still fetch each one.\n" +
      "Required sequence:\n" +
      "1) list_tickets with status \"open\" — the list includes assignee.\n" +
      "2) For each open ticket whose assignee is \"ana\", call get_ticket once.\n" +
      "3) Add the numeric bodyLength fields from those results (do NOT count characters in body).\n" +
      "Your entire final message must be exactly: <count> <sum> — two integers, one space, nothing else.",
    coldInstruction:
      "You have many MCP servers loaded directly (no lazygate). Pick the one that serves support tickets and use its tools.\n" +
      "Ticket bodies are large — still fetch each ticket you need, and add the numeric bodyLength fields (do NOT count characters in body).\n" +
      COLD_ANSWER_RULE,
  },
  "call-tool": {
    label: "call_tool",
    mcp: "lazygate",
    instruction:
      "You have the lazygate MCP server. Upstream server: \"tickets\". Tools: list_tickets, get_ticket.\n" +
      "There are several matching tickets; get_ticket bodies are large — still fetch each one.\n" +
      "Required sequence (use call_tool only; never run_chain):\n" +
      "1) call_tool(server=\"tickets\", tool=\"list_tickets\", args={status:\"open\"}) — list includes assignee.\n" +
      "2) For each open ticket whose assignee is \"ana\", call_tool get_ticket once.\n" +
      "3) Add the numeric bodyLength fields from those results (do NOT count characters in body).\n" +
      "Your entire final message must be exactly: <count> <sum> — two integers, one space, nothing else.",
    coldInstruction:
      "You have the lazygate MCP server and do not know which upstream servers or tools exist.\n" +
      "Start with discover_tools to find the right server, learn the tool names and argument shapes from its answer (use describe_tool only if you need more), then use call_tool only (never run_chain).\n" +
      "Ticket bodies are large — still fetch each ticket you need, and add the numeric bodyLength fields (do NOT count characters in body).\n" +
      COLD_ANSWER_RULE,
  },
  "call-tool-optimized": {
    label: "call_tool+opt",
    mcp: "lazygate",
    // Response optimization on, with no per-tool policy: adaptive defaults plus agent-requested fields.
    responseOptimization: { enabled: true, defaultMode: "adaptive", maxOutputTokens: 4000 },
    instruction:
      "You have the lazygate MCP server. Upstream server: \"tickets\". Tools: list_tickets, get_ticket.\n" +
      "There are several matching tickets; get_ticket bodies are large, so ask call_tool for only the fields you need.\n" +
      "Required sequence (use call_tool only; never run_chain):\n" +
      "1) call_tool(server=\"tickets\", tool=\"list_tickets\", args={status:\"open\"}) — list includes assignee.\n" +
      "2) For each open ticket whose assignee is \"ana\", call_tool(server=\"tickets\", tool=\"get_ticket\", " +
      "args={id}, fields=[\"id\",\"bodyLength\"]) once.\n" +
      "3) Add the numeric bodyLength fields from those results (do NOT count characters in body).\n" +
      "Your entire final message must be exactly: <count> <sum> — two integers, one space, nothing else.",
    coldInstruction:
      "You have the lazygate MCP server and do not know which upstream servers or tools exist.\n" +
      "Start with discover_tools to find the right server, learn the tool names and argument shapes from its answer (use describe_tool only if you need more), then use call_tool only (never run_chain).\n" +
      "Ticket bodies are large, so ask call_tool for only the fields you need: pass fields=[...] (for example [\"id\",\"bodyLength\"]).\n" +
      COLD_ANSWER_RULE,
  },
  "run-chain": {
    label: "run_chain",
    mcp: "lazygate",
    instruction:
      "You have the lazygate MCP server. Upstream server: \"tickets\" (toolChain on).\n" +
      "There are several matching tickets with large bodies; keep all of that inside the script.\n" +
      "Do exactly this, then stop (no retries unless a tool returns an error):\n" +
      "1) describe_tool with server=\"tickets\" and NO tool argument (stubs).\n" +
      "2) ONE run_chain call. Inside the script: await servers.tickets.list_tickets({status:\"open\"}), " +
      "filter assignee===\"ana\", await servers.tickets.get_ticket({id}) for each (use Promise.all if you want), " +
      "sum bodyLength (or body.length), return {count, total}. Do not use call_tool.\n" +
      "Your entire final message must be exactly: <count> <sum> — two integers, one space, nothing else.",
    coldInstruction:
      "You have the lazygate MCP server and do not know which upstream servers or tools exist.\n" +
      "Start with discover_tools to find the right server; a clear match lists call signatures, and inside run_chain you call servers.<server>.<tool>(args). Use describe_tool with that server and NO tool argument only if you need the tool-chain stubs.\n" +
      "Then write ONE run_chain script that fetches, filters and totals; ticket bodies are large, so keep them inside the script (never use call_tool).\n" +
      COLD_ANSWER_RULE,
  },
};

/** Tickets fixture entry for a temp servers.json (tool chain on for run_chain). */
function ticketsServerEntry() {
  const ticketsServer = resolve(__dirname, "..", "src", "__tests__", "fixtures", "tickets-server.mjs");
  return {
    description: "Support tickets: list and fetch",
    keywords: ["tickets", "support", "ticket", "open"],
    command: process.execPath,
    args: [ticketsServer],
    inheritEnv: false,
    toolChain: true,
    // The fixture is safe to start, so cold discovery can show its signatures in one turn.
    previewOnDiscover: true,
  };
}

/**
 * Broker config for lazygate task strategies: the user's runnable catalog plus the tickets
 * fixture. Meta-tools stay the only schemas in tools/list (expose defaults to none); other
 * servers are available if discovered but the task instructions say to use tickets only.
 */
function taskBrokerConfig(strategyDir, strategy) {
  const cfgPath = join(strategyDir, "servers.json");
  // Only the fixture unless --include-catalog: the real catalog can hold destructive tools and
  // --tasks bypasses permission prompts.
  const merged = { ...(includeCatalog ? servers : {}), tickets: ticketsServerEntry() };
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
  writeFileSync(
    cfgPath,
    JSON.stringify({
      ...(strategy.responseOptimization ? { responseOptimization: strategy.responseOptimization } : {}),
      servers: out,
    })
  );
  return cfgPath;
}

/**
 * MCP config for a task strategy.
 * - direct: every runnable server from the user's Lazygate catalog + tickets fixture (classic MCP)
 * - lazygate: one broker process wrapping that same catalog
 */
function taskMcpConfig(strategy, strategyDir) {
  const ticketsServer = resolve(__dirname, "..", "src", "__tests__", "fixtures", "tickets-server.mjs");
  if (strategy.mcp === "direct") {
    const mcp = includeCatalog
      ? buildMcpConfig(Object.keys(servers))
      : { mcpServers: {} };
    // Fixture wins if the user already has a server named "tickets".
    mcp.mcpServers.tickets = { command: process.execPath, args: [ticketsServer] };
    return mcp;
  }
  const cfgPath = taskBrokerConfig(strategyDir, strategy);
  const brokerEntry = resolve(__dirname, "..", "dist", "index.js");
  return {
    mcpServers: {
      lazygate: { command: process.execPath, args: [brokerEntry, "--config", cfgPath] },
    },
  };
}

async function runTaskStrategy(id) {
  const strategy = TASK_STRATEGIES[id];
  const dir = mkdtempSync(join(workDir, `task-${id}-`));
  const mcpConfig = taskMcpConfig(strategy, dir);
  const appendFile = join(dir, "instruction.md");
  writeFileSync(appendFile, coldDiscovery ? strategy.coldInstruction : strategy.instruction);
  const result = await runClaudeTask(mcpConfig, { appendFile, prompt: coldDiscovery ? COLD_TASK_PROMPT : TASK_PROMPT });
  return { id, label: strategy.label, ...result };
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
async function runClaudeTask(mcpConfig, { appendFile, prompt }) {
  const claudeArgs = [
    "-p",
    prompt,
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
  try {
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === "assistant" && event.message?.id) messageIds.add(event.message.id);
      else if (event.type === "result") data = event;
    }
    if (!data) throw new Error("no result event");
  } catch {
    return { ok: false, error: "invalid JSON from claude", durationMs: Date.now() - start };
  }
  if (data.is_error || data.api_error_status) {
    return { ok: false, error: String(data.result ?? "claude returned is_error").slice(0, 160), durationMs: data.duration_ms ?? 0 };
  }
  const u = data.usage ?? {};
  const totalInput = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  return {
    ok: true,
    answer: String(data.result ?? ""),
    turns: data.num_turns ?? 0,
    apiCalls: Math.max(1, messageIds.size),
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
 * True when the answer reports the expected pair.
 * Prefer a final line that is exactly two integers (what we asked for); fall back to
 * finding both numbers anywhere so minor formatting still counts as correct.
 */
/** The "count total" line the model was asked for, or the start of its first line when it gave prose. */
function answerSummary(answer) {
  const lines = String(answer).trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const numeric = lines.findLast((l) => /^(\d+)\s+(\d+)$/.test(l));
  return numeric ?? (lines[0] ?? "").slice(0, 60);
}

function answerMatches(answer, expected) {
  const lines = String(answer)
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^(\d+)\s+(\d+)$/.exec(lines[i]);
    if (m) return Number(m[1]) === expected.count && Number(m[2]) === expected.total;
  }
  const nums = (answer.match(/\d+/g) ?? []).map(Number);
  return nums.includes(expected.count) && nums.includes(expected.total);
}

/**
 * Collapse one strategy's rounds into a row. Token, turn and duration figures are means over
 * the correct runs, so a wrong answer never skews the comparison; `ok` is false only when every
 * round errored.
 */
function summarizeTaskRuns(id, label, runs) {
  const completed = runs.filter((r) => r.ok);
  if (completed.length === 0) {
    return { id, label, ok: false, error: runs[0]?.error ?? "no runs", runs: runs.length, correctRuns: 0 };
  }
  const correct = completed.filter((r) => r.correct);
  const basis = correct.length ? correct : completed;
  const inputs = basis.map((r) => r.totalInput);
  return {
    id,
    label,
    ok: true,
    runs: runs.length,
    correctRuns: correct.length,
    totalInput: Math.round(mean(inputs)),
    minInput: Math.min(...inputs),
    maxInput: Math.max(...inputs),
    turns: mean(basis.map((r) => r.turns)),
    apiCalls: mean(basis.map((r) => r.apiCalls ?? 0)),
    durationMs: Math.round(mean(basis.map((r) => r.durationMs))),
    answer: basis[basis.length - 1].answer,
  };
}

/** Mean turns: whole numbers stay whole, otherwise one decimal. */
function fmtTurns(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

if (tasksOnly) {
  const expected = taskExpectedAnswer();
  console.log(`Task:    ${coldDiscovery ? COLD_TASK_PROMPT : TASK_PROMPT}`);
  if (coldDiscovery) {
    console.log(`Lookup:  cold discovery — the extra turns versus a known-tools run (omit --cold-discovery) are the discover_tools / describe_tool lookups`);
  }
  console.log(
    `Expect:  ${expected.count} tickets, total bodyLength ${fmtNumTask(expected.total)} ` +
      `(~${Math.round(expected.total / 1024)} KiB of bodies if every get_ticket returns through the model)`
  );
  const rounds = Math.max(1, roundsArg || 1);
  console.log(
    `Runner:  claude (task mode, ${rounds} cold turn${rounds !== 1 ? "s" : ""} per strategy; ` +
      `averages use correct runs only)\n`
  );
  if (estimateOnly) {
    console.log(`Mode:    --estimate: skipping live runs (task mode needs claude -p). Instructions the model would get:\n`);
    for (const strategy of Object.values(TASK_STRATEGIES)) {
      console.log(`[${strategy.label}]\n${coldDiscovery ? strategy.coldInstruction : strategy.instruction}\n`);
    }
    process.exit(0);
  }
  const baselinePerCall = await measureTaskBaseline();
  const taskRows = [];
  for (const id of Object.keys(TASK_STRATEGIES)) {
    const label = TASK_STRATEGIES[id].label;
    const runs = [];
    for (let i = 0; i < rounds; i++) {
      const suffix = rounds > 1 ? ` (round ${i + 1}/${rounds})` : "";
      process.stdout.write(`  ${label.padEnd(14)} running...${suffix}\n`);
      const r = await runTaskStrategy(id);
      if (r.ok) r.correct = answerMatches(r.answer, expected);
      runs.push(r);
    }
    const row = summarizeTaskRuns(id, label, runs);
    // Input above the fixed per-call overhead: schemas, instructions, calls and results only.
    if (row.ok) row.netInput = Math.max(0, Math.round(row.totalInput - row.apiCalls * baselinePerCall));
    taskRows.push(row);
  }
  console.log(
    baselinePerCall
      ? `\nFixed overhead: ${fmtNumTask(baselinePerCall)} input tokens per API call (system prompt of this Claude Code install, no MCP). ` +
          `"net" removes it, so the strategies are compared on what they add.\n`
      : `\nCould not measure the fixed per-call overhead; "net" equals the raw input.\n`
  );
  for (const r of taskRows) {
    if (!r.ok) {
      console.log(`${r.label.padEnd(14)} ERROR  ${r.error}`);
      continue;
    }
    const range =
      r.correctRuns > 1 ? `  (${fmtNumTask(r.minInput)}–${fmtNumTask(r.maxInput)})` : "";
    const verdict =
      rounds > 1 ? `correct ${r.correctRuns}/${r.runs}` : r.correctRuns ? "correct" : "WRONG";
    console.log(
      `${r.label.padEnd(14)} net ${fmtNumTask(r.netInput).padStart(8)}  raw ${fmtNumTask(r.totalInput).padStart(9)}  ` +
        `calls ${fmtTurns(r.apiCalls).padStart(4)}  tool calls ${fmtTurns(r.turns).padStart(4)}  ` +
        `${(r.durationMs / 1000).toFixed(1).padStart(5)}s  ${verdict}  answer: ${answerSummary(r.answer)}${range}`
    );
  }
  const direct = taskRows.find((r) => r.id === "direct");
  const callTool = taskRows.find((r) => r.id === "call-tool");
  const callToolOptimized = taskRows.find((r) => r.id === "call-tool-optimized");
  const execCode = taskRows.find((r) => r.id === "run-chain");
  const fair = (r) => r?.ok && r.correctRuns > 0;

  const deltaLine = (label, base, other) => {
    if (!fair(base) || !fair(other)) return null;
    const d = other.netInput - base.netInput;
    const pct = base.netInput ? Math.abs((d / base.netInput) * 100).toFixed(1) : "0.0";
    const sign = d > 0 ? "+" : d < 0 ? "−" : "±";
    const rawD = other.totalInput - base.totalInput;
    return `${label}: ${sign}${fmtNumTask(Math.abs(d))} net input tokens (${sign}${pct}%); ${other.apiCalls - base.apiCalls >= 0 ? "+" : "−"}${fmtTurns(Math.abs(other.apiCalls - base.apiCalls))} API calls; raw ${rawD >= 0 ? "+" : "−"}${fmtNumTask(Math.abs(rawD))}`;
  };

  const lines = [
    deltaLine("call_tool vs direct", direct, callTool),
    deltaLine("call_tool+opt vs direct", direct, callToolOptimized),
    deltaLine("call_tool+opt vs call_tool", callTool, callToolOptimized),
    deltaLine("run_chain vs direct", direct, execCode),
    deltaLine("run_chain vs call_tool", callTool, execCode),
  ].filter(Boolean);

  if (lines.length) {
    console.log("");
    for (const line of lines) console.log(line);
  } else {
    const status = (r) => (!r ? "missing" : !r.ok ? "ERROR" : r.correctRuns ? "correct" : "WRONG");
    console.log(
      `\n(Skipping token deltas — need correct runs to compare; ` +
        `direct=${status(direct)}, call_tool=${status(callTool)}, call_tool+opt=${status(callToolOptimized)}, ` +
        `run_chain=${status(execCode)}.)`
    );
  }
  console.log(
    rounds > 1
      ? `\nMean of correct runs over ${rounds} cold-cache rounds per strategy.\n`
      : `\nSingle cold-cache turn per strategy; one sample is noisy. Use --rounds 3 before drawing conclusions.\n`
  );
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
