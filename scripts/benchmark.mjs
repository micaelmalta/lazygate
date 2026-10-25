#!/usr/bin/env node
// Benchmarks token usage across MCP and skill loading strategies.
//
// Runners:
//   claude  — `claude -p --output-format json` (default)
//   codex   — `codex exec --json` (e.g. --model gpt-6-luna via Bifrost)
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
//   lazygate benchmark --servers fetch-mcp,jira --skills loi,writer
//   lazygate benchmark --mcp-only | --skills-only
//   lazygate benchmark --rounds 3
//   lazygate benchmark --estimate   # local chars÷4 preview, no API

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
  } else if (cfg.url && hasAuthHeader(cfg)) {
    servers[name] = cfg;
  } else if (cfg.url || cfg.type === "http") {
    skippedServers.push(`${name} (needs interactive OAuth)`);
  } else {
    skippedServers.push(`${name} (no command)`);
  }
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
    `model_provider = "bifrost"`,
    `model_reasoning_effort = "medium"`,
    `approval_policy = "never"`,
    "",
    "[model_providers.bifrost]",
    `name = "Bifrost"`,
    `base_url = "https://llm-proxy.justworks.io/v1"`,
    `env_key = "BIFROST_AUTH_TOKEN"`,
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

const fmtNum = (n) => n.toLocaleString();

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
