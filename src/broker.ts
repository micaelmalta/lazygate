// src/broker.ts
// Request handling for the broker, independent of the stdio transport so it can be tested.

import type { z } from "zod";
import type { ToolRouter, ServerConfig } from "./router.js";
import type { SkillRouter } from "./skill-router.js";
import type { ProcessManager, RuntimeCredentials, MCPTool } from "./process-manager.js";
import {
  listedMetaTools,
  QuerySchema,
  ServerNameSchema,
  SkillNameSchema,
  LoadSkillSchema,
  ReadSkillFileSchema,
  DescribeToolSchema,
  CallToolSchema,
  RunChainSchema,
} from "./meta-tools.js";
import { formatSkillUri, parseSkillUri } from "./skill-router.js";
import { composePrompt, type SecretLookup } from "./prompt-compose.js";
import { bareToolName, parseNamespacedTool } from "./tool-names.js";
import { LOG_PREFIX } from "./version.js";
import { runCode, serverStubs, toScriptResult, type CodeBinding } from "./tool-chain/index.js";

export interface ToolResult {
  content: unknown[];
  isError?: boolean;
  [key: string]: unknown;
}

/** Per-caller access rules (gateway mode). Without it every configured server is usable. */
export interface BrokerAccess {
  /** Whether this caller may see and use the server. */
  canUse(name: string, cfg: ServerConfig): boolean;
  /**
   * Whether this caller may discover/load the skill (gateway: group ACL + install list).
   * Absent = all configured skills.
   */
  canUseSkill?(name: string): boolean;
  /**
   * Resolve the caller's credentials for the server. Throws an Error with a user-facing message
   * (e.g. which header to send) when something required is missing.
   */
  prepare(name: string, cfg: ServerConfig): RuntimeCredentials | undefined;
  /** What the caller still has to provide before the server can be activated (shown by discover_tools). */
  missing?(name: string, cfg: ServerConfig): string[];
  /**
   * Start connecting the caller's account (gateway). Returns a message that may include an
   * authorization URL. Absent outside gateway mode.
   */
  connect?(name: string, cfg: ServerConfig): Promise<string>;
  /** Drop the caller's stored credentials for the server (gateway). */
  disconnect?(name: string, cfg: ServerConfig): Promise<string>;
  /** Called once per tool call a script makes through run_chain (gateway audit). */
  onNestedCall?(e: { server: string; tool: string; ok: boolean; ms: number; error?: string }): void;
}

export interface BrokerDeps {
  router: ToolRouter;
  manager: ProcessManager;
  skillRouter: SkillRouter | null; // null only in unit tests / stdio without a skills path
  access?: BrokerAccess;
  /** Gateway secret store for skill prompt context `${secret:…}` expansion. */
  secrets?: SecretLookup;
  /** Allow private/link-local URLs in skill prompt.context (gateway admin-configured). */
  allowPrivatePromptUrls?: boolean;
}

/** Reject if the promise does not settle within `ms` (nested calls in scripts use the run budget). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

function fail(t: string): ToolResult {
  return { content: [{ type: "text", text: t }], isError: true };
}

function matchedLine(keywords: string[], descriptionWords: string[], toolWords: string[] = []): string {
  const parts: string[] = [];
  if (keywords.length) parts.push(`keywords: ${keywords.join(", ")}`);
  if (descriptionWords.length) parts.push(`description: ${descriptionWords.join(", ")}`);
  if (toolWords.length) parts.push(`tools: ${toolWords.join(", ")}`);
  return parts.join(" | ") || "—";
}

const SUMMARY_MAX = 160;
/** Above this many tools, activation lists names only (the schemas carry the details). */
const DETAILED_LIST_MAX_TOOLS = 12;
/** Cap discovery results so a large catalog cannot flood the context window. */
export const DISCOVER_TOP_K = 5;
/** Require at least one keyword match or two description-word matches. */
export const DISCOVER_MIN_SCORE = 2;

/** Whether any of this server's tools are merged into tools/list. */
export function exposesInList(cfg: ServerConfig | undefined): boolean {
  const expose = cfg?.expose ?? "none";
  if (expose === "none") return false;
  if (expose === "all") return true;
  return Array.isArray(expose) && expose.length > 0;
}

/** Filter active tools according to the server's `expose` setting (default `"none"`). */
export function filterExposedTools(
  tools: MCPTool[],
  getConfig: (serverName: string) => ServerConfig | undefined
): MCPTool[] {
  return tools.filter((t) => {
    const expose = getConfig(t.serverName)?.expose ?? "none";
    if (expose === "none") return false;
    if (expose === "all") return true;
    // Allowlists use upstream (bare) names even when tools are exposed as server__tool.
    const bare = bareToolName(t.serverName, t.name);
    return Array.isArray(expose) && (expose.includes(bare) || expose.includes(t.name));
  });
}

/** Match a describe/call tool arg against an exposed or bare tool name. */
function toolNameMatches(server: string, exposedName: string, requested: string): boolean {
  if (exposedName === requested) return true;
  return bareToolName(server, exposedName) === requested;
}

export function formatActivation(
  serverName: string,
  tools: Array<{ name: string; description?: string }>,
  opts: { exposed: boolean } = { exposed: false }
): string {
  const schemaHint = opts.exposed
    ? "full descriptions are in the tool schemas"
    : "use describe_tool for schemas and call_tool to invoke";
  if (tools.length > DETAILED_LIST_MAX_TOOLS) {
    return (
      `✓ Activated "${serverName}" with ${tools.length} tools (names only; ${schemaHint}):\n` +
      tools.map((t) => t.name).join(", ")
    );
  }
  return (
    `✓ Activated "${serverName}" with ${tools.length} tools (first sentence of each; ${schemaHint}):\n` +
    tools.map((t) => `  • ${t.name}: ${summarizeDescription(t.description)}`).join("\n")
  );
}

// Activation output uses the first sentence of each tool description so a server with dozens of
// tools doesn't dump its full documentation into the context window (see tool-chain/stubs.ts).
import { summarizeDescription } from "./tool-chain/stubs.js";
export { summarizeDescription };

export function createBroker({
  router,
  manager,
  skillRouter,
  access,
  secrets,
  allowPrivatePromptUrls,
}: BrokerDeps) {
  /** Servers this caller may see. Hidden servers behave exactly like unknown ones. */
  const visible = (name: string): boolean => {
    const cfg = router.getConfig(name);
    if (!cfg || cfg.disabled) return false;
    return !access || access.canUse(name, cfg);
  };
  const visibleNames = (): string[] => router.listAll().filter(visible);
  const skillVisible = (name: string): boolean => {
    const cfg = skillRouter?.getConfig(name);
    if (!cfg || cfg.disabled) return false;
    return !access?.canUseSkill || access.canUseSkill(name);
  };
  const visibleSkillNames = (): string[] => (skillRouter ? skillRouter.listAll().filter(skillVisible) : []);

  /** Upstream tool names this server allows in tool chain (empty when toolChain is off). */
  const toolChainAllows = (cfg: ServerConfig): ((tool: string) => boolean) | null => {
    const mode = cfg.toolChain;
    if (mode === true) return () => true;
    if (Array.isArray(mode) && mode.length > 0) {
      const allowed = new Set(mode);
      return (tool) => allowed.has(tool);
    }
    return null;
  };

  /** Servers this caller may script right now (visible + toolChain set). */
  const toolChainServers = (): string[] =>
    router.listAll().filter((n) => visible(n) && toolChainAllows(router.getConfig(n)!) !== null);

  /**
   * Bindings for one script: every visible tool-chain server. The names come from the toolChain
   * config (an allowlist, or "*" for toolChain: true), not from what is active, so a server that
   * is not activated yet is still callable and activates on its first call (see nestedCall).
   */
  const toolChainBindings = (): CodeBinding[] =>
    toolChainServers().map((server) => {
      const mode = router.getConfig(server)!.toolChain;
      return { server, tools: mode === true ? "*" : [...new Set(mode as string[])] };
    });

  /**
   * The single policy chokepoint for every script-initiated tool call: visibility, toolChain
   * allowlist, lazy activation, then the upstream call. A refused call becomes an error value.
   */
  async function nestedCall(
    server: string,
    tool: string,
    args: unknown,
    timeoutMs: number
  ): Promise<{ value: unknown; failed: boolean }> {
    const started = Date.now();
    const report = (ok: boolean, error?: string) =>
      access?.onNestedCall?.({ server, tool, ok, ms: Date.now() - started, error });
    const refuse = (message: string) => {
      report(false, message);
      return { value: { error: message }, failed: true };
    };

    if (!visible(server)) return refuse(`Unknown server: "${server}"`);
    const cfg = router.getConfig(server)!;
    const allows = toolChainAllows(cfg);
    if (!allows) return refuse(`Server "${server}" is not enabled for tool chain`);
    if (!allows(tool)) return refuse(`Tool "${tool}" on "${server}" is not enabled for tool chain`);

    const actErr = await ensureActive(server, cfg);
    if (actErr) {
      const msg = actErr.content.map((c) => (c as { text?: string }).text ?? "").join("");
      return refuse(msg || `Failed to activate "${server}"`);
    }
    const known = manager
      .getAllActiveTools()
      .some((t) => t.serverName === server && toolNameMatches(server, t.name, tool));
    if (!known) return refuse(`Tool "${tool}" not found on server "${server}"`);

    let raw: unknown;
    try {
      raw = await withTimeout(manager.callTool(server, tool, (args ?? {}) as Record<string, unknown>), timeoutMs);
    } catch (err) {
      const msg = `Error calling ${tool}: ${(err as Error).message}`;
      report(false, msg);
      return { value: { error: msg }, failed: true };
    }
    const converted = toScriptResult(raw as { content?: unknown[]; isError?: boolean });
    report(!("failed" in converted));
    return { value: converted.value, failed: "failed" in converted };
  }

  function listTools() {
    // Gateway-only connect/disconnect stay off the list in stdio (no access.connect).
    const meta = listedMetaTools(Boolean(access?.connect));
    // Default expose is "none": tools/list stays stable; use describe_tool / call_tool.
    const activeTools = filterExposedTools(manager.getAllActiveTools(), (n) => router.getConfig(n)).map((t) => ({
      name: t.name,
      description: `[${t.serverName}] ${t.description}`,
      inputSchema: t.inputSchema,
    }));
    return { tools: [...meta, ...activeTools] };
  }

  function parseArgs<S extends z.ZodTypeAny>(schema: S, args: unknown): z.infer<S> | ToolResult {
    const parsed = schema.safeParse(args ?? {});
    if (parsed.success) return parsed.data;
    return fail(`Invalid arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }

  const isResult = (v: unknown): v is ToolResult =>
    typeof v === "object" && v !== null && "content" in v && Array.isArray((v as ToolResult).content);

  async function ensureActive(serverName: string, cfg: ServerConfig): Promise<ToolResult | null> {
    if (manager.listActive().includes(serverName)) return null;
    try {
      await manager.activate(serverName, cfg, access?.prepare(serverName, cfg));
      return null;
    } catch (err) {
      return fail(`Failed to activate "${serverName}": ${(err as Error).message}`);
    }
  }

  async function callTool(name: string, rawArgs: Record<string, unknown> | undefined): Promise<ToolResult> {
    switch (name) {
      case "discover_tools": {
        const a = parseArgs(QuerySchema, rawArgs);
        if (isResult(a)) return a;
        router.reloadServersFromDisk();
        const ranked = router
          .rank(a.query)
          .filter((r) => visible(r.name) && r.score >= DISCOVER_MIN_SCORE)
          .slice(0, DISCOVER_TOP_K);

        if (ranked.length === 0) {
          const all = visibleNames();
          return text(
            `No matching servers found for: "${a.query}"\n\nAvailable servers:\n` +
              (all.length
                ? all.map((n) => `• ${n}`).join("\n")
                : "(none configured — add entries to ~/.config/lazygate/servers.json)")
          );
        }

        const active = manager.listActive();
        const lines = ranked.map((r) => {
          const cfg = router.getConfig(r.name)!;
          const missing = active.includes(r.name) ? [] : access?.missing?.(r.name, cfg) ?? [];
          const status = active.includes(r.name) ? "✓ active" : missing.length ? "⚠ needs credentials" : "○ inactive";
          const needs = missing.length ? `\n  Needs: ${missing.join(", ")}` : "";
          return `${status} | ${r.name} (score: ${r.score})\n  ${cfg.description}\n  Matched ${matchedLine(r.reason, r.descriptionMatches, r.toolMatches)}${needs}`;
        });
        return text(
          `Servers relevant to "${a.query}":\n\n${lines.join("\n\n")}\n\n` +
            `Use activate_server to load an inactive server.`
        );
      }

      case "activate_server": {
        const a = parseArgs(ServerNameSchema, rawArgs);
        if (isResult(a)) return a;
        router.reloadServersFromDisk();
        const cfg = router.getConfig(a.server_name);
        if (!cfg || !visible(a.server_name)) {
          return fail(
            `Unknown server: "${a.server_name}". Available: ${visibleNames().join(", ") || "(none)"}`
          );
        }
        try {
          const tools = await manager.activate(a.server_name, cfg, access?.prepare(a.server_name, cfg));
          return text(formatActivation(a.server_name, tools, { exposed: exposesInList(cfg) }));
        } catch (err) {
          return fail(`Failed to activate "${a.server_name}": ${(err as Error).message}`);
        }
      }

      case "deactivate_server": {
        const a = parseArgs(ServerNameSchema, rawArgs);
        if (isResult(a)) return a;
        if (!manager.deactivate(a.server_name)) {
          const active = manager.listActive();
          return fail(
            `Server "${a.server_name}" is not active. Active: ${active.join(", ") || "(none)"}`
          );
        }
        return text(`Deactivated "${a.server_name}"`);
      }

      case "list_active_servers": {
        const active = manager.listActive();
        if (active.length === 0) return text("No servers currently active.");
        const allTools = manager.getAllActiveTools();
        return text(
          active
            .map((n) => {
              const tools = allTools
                .filter((t) => t.serverName === n)
                .map((t) => `    • ${t.name}`)
                .join("\n");
              return `${n}:\n${tools}`;
            })
            .join("\n\n")
        );
      }

      case "describe_tool": {
        const a = parseArgs(DescribeToolSchema, rawArgs);
        if (isResult(a)) return a;
        router.reloadServersFromDisk();
        const cfg = router.getConfig(a.server);
        if (!cfg || !visible(a.server)) {
          return fail(`Unknown server: "${a.server}". Available: ${visibleNames().join(", ") || "(none)"}`);
        }
        const actErr = await ensureActive(a.server, cfg);
        if (actErr) return actErr;
        if (a.tool === undefined) {
          // No tool named: return TypeScript stubs for the server's tool-chain tools.
          const allows = toolChainAllows(cfg);
          if (!allows) {
            return fail(`Server "${a.server}" is not enabled for tool chain. Name a tool to describe it.`);
          }
          // Stubs cover the allowlisted tools that exist upstream (the active tool list).
          const scoped = manager
            .getAllActiveTools()
            .filter((t) => t.serverName === a.server && allows(bareToolName(a.server, t.name)));
          const stubs = serverStubs(a.server, scoped);
          if (!stubs) return text(`No tool-chain tools on "${a.server}" (toolChain allowlist matches none).`);
          return text(stubs);
        }
        const toolName = a.tool;
        const tool = manager
          .getAllActiveTools()
          .find((t) => t.serverName === a.server && toolNameMatches(a.server, t.name, toolName));
        if (!tool) {
          const names = manager
            .getAllActiveTools()
            .filter((t) => t.serverName === a.server)
            .map((t) => t.name);
          return fail(
            `Tool "${toolName}" not found on server "${a.server}". ` +
              `Available: ${names.join(", ") || "(none)"}`
          );
        }
        return text(
          JSON.stringify(
            { name: tool.name, description: tool.description, inputSchema: tool.inputSchema },
            null,
            2
          )
        );
      }

      case "call_tool": {
        const a = parseArgs(CallToolSchema, rawArgs);
        if (isResult(a)) return a;
        router.reloadServersFromDisk();
        const cfg = router.getConfig(a.server);
        if (!cfg || !visible(a.server)) {
          return fail(`Unknown server: "${a.server}". Available: ${visibleNames().join(", ") || "(none)"}`);
        }
        const actErr = await ensureActive(a.server, cfg);
        if (actErr) return actErr;
        const known = manager
          .getAllActiveTools()
          .some((t) => t.serverName === a.server && toolNameMatches(a.server, t.name, a.tool));
        if (!known) {
          const names = manager
            .getAllActiveTools()
            .filter((t) => t.serverName === a.server)
            .map((t) => t.name);
          return fail(
            `Tool "${a.tool}" not found on server "${a.server}". ` +
              `Available: ${names.join(", ") || "(none)"}`
          );
        }
        try {
          return (await manager.callTool(a.server, a.tool, a.args ?? {})) as ToolResult;
        } catch (err) {
          return fail(`Error calling ${a.tool}: ${(err as Error).message}`);
        }
      }

      case "discover_skill": {
        if (!skillRouter) return fail("No skills registry configured.");
        const a = parseArgs(QuerySchema, rawArgs);
        if (isResult(a)) return a;
        skillRouter.reloadFromDisk();
        const ranked = skillRouter
          .rank(a.query)
          .filter((r) => skillVisible(r.name) && r.score >= DISCOVER_MIN_SCORE)
          .slice(0, DISCOVER_TOP_K);

        if (ranked.length === 0) {
          const all = visibleSkillNames();
          return text(
            `No matching skills found for: "${a.query}"\n\nAvailable skills:\n` +
              (all.length
                ? all.map((n) => `• ${n}`).join("\n")
                : "(none installed — open the gateway UI catalog and Install a skill)")
          );
        }

        const lines = ranked.map((r) => {
          const cfg = skillRouter.getConfig(r.name)!;
          return `${r.name} (score: ${r.score})\n  ${cfg.description}\n  Matched ${matchedLine(r.reason, r.descriptionMatches)}`;
        });
        return text(
          `Skills relevant to "${a.query}":\n\n${lines.join("\n\n")}\n\n` +
            `Use load_skill to load a skill's full instructions.`
        );
      }

      case "load_skill": {
        if (!skillRouter) return fail("No skills registry configured.");
        const a = parseArgs(LoadSkillSchema, rawArgs);
        if (isResult(a)) return a;
        if (!skillRouter.getConfig(a.skill_name)) skillRouter.reloadFromDisk();
        const cfg = skillRouter.getConfig(a.skill_name);
        if (!cfg || !skillVisible(a.skill_name)) {
          return fail(
            `Unknown skill: "${a.skill_name}". Available: ${visibleSkillNames().join(", ") || "(none)"}`
          );
        }
        try {
          const body = skillRouter.load(a.skill_name);
          const needsCompose = Boolean(cfg.prompt?.arguments?.length || cfg.prompt?.context?.length || a.args);
          const composed = needsCompose
            ? await composePrompt({
                body,
                config: cfg,
                args: a.args,
                secrets,
                allowPrivateUrls: allowPrivatePromptUrls,
              })
            : { text: body };
          let files: string[] = [];
          try {
            files = skillRouter.listFiles(a.skill_name);
          } catch {
            files = [];
          }
          const fileSection =
            files.length === 0
              ? ""
              : `\n\n## Bundled files\n` +
                files.map((f) => `- ${formatSkillUri(a.skill_name, f)}`).join("\n") +
                `\n\nFetch with read_skill_file or resources/read.`;
          const argHint =
            cfg.prompt?.arguments?.length && !a.args
              ? `\n\n(This skill accepts prompt args: ${cfg.prompt.arguments
                  .map((x) => x.name + (x.required ? "*" : ""))
                  .join(", ")}. Re-call load_skill with args: {…}.)`
              : "";
          return text(`# Skill: ${a.skill_name}\n\n${composed.text}${fileSection}${argHint}`);
        } catch (err) {
          return fail((err as Error).message);
        }
      }

      case "read_skill_file": {
        if (!skillRouter) return fail("No skills registry configured.");
        const a = parseArgs(ReadSkillFileSchema, rawArgs);
        if (isResult(a)) return a;
        let skillName = a.skill_name;
        let relPath = a.path;
        const asUri = parseSkillUri(a.path);
        if (asUri) {
          if (asUri.name !== skillName) {
            return fail(
              `path URI skill "${asUri.name}" does not match skill_name "${skillName}"`
            );
          }
          relPath = asUri.relPath;
        } else if (a.path.startsWith("skill://")) {
          return fail(`Invalid skill URI: "${a.path}"`);
        }
        if (!skillRouter.getConfig(skillName)) skillRouter.reloadFromDisk();
        if (!skillRouter.getConfig(skillName) || !skillVisible(skillName)) {
          return fail(
            `Unknown skill: "${skillName}". Available: ${visibleSkillNames().join(", ") || "(none)"}`
          );
        }
        if (!relPath) {
          return fail("`path` must name a file under the skill (e.g. INSTRUCTIONS.md or scripts/run.sh)");
        }
        try {
          const file = skillRouter.readFile(skillName, relPath);
          if (file.text !== undefined) {
            return text(
              `# ${formatSkillUri(skillName, file.path)} (${file.mimeType}, ${file.size} bytes)\n\n${file.text}`
            );
          }
          return text(
            `# ${formatSkillUri(skillName, file.path)} (${file.mimeType}, ${file.size} bytes)\n\n` +
              `(binary; base64)\n${file.blob!.toString("base64")}`
          );
        } catch (err) {
          return fail((err as Error).message);
        }
      }

      case "run_chain": {
        const a = parseArgs(RunChainSchema, rawArgs);
        if (isResult(a)) return a;
        router.reloadServersFromDisk();
        const bindings = toolChainBindings();
        const run = await runCode({ code: a.code, bindings, callTool: nestedCall });
        const lines: string[] = [];
        if (run.logs) lines.push(`Logs:\n${run.logs}`);
        if (run.error) {
          lines.push(`Error: ${run.error}`);
          return fail(lines.join("\n\n"));
        }
        const failedNote = run.failedCalls > 0 ? ` (${run.failedCalls} nested call${run.failedCalls === 1 ? "" : "s"} failed)` : "";
        lines.push(`Completed${failedNote}; ${run.calls} nested call${run.calls === 1 ? "" : "s"}.`);
        lines.push(
          `Return value: ${run.value === undefined ? "(none)" : JSON.stringify(run.value, null, 2)}`
        );
        return text(lines.join("\n\n"));
      }

      case "connect_server": {
        const a = parseArgs(ServerNameSchema, rawArgs);
        if (isResult(a)) return a;
        if (!access?.connect) {
          return fail(
            "connect_server is only available in gateway mode. For local stdio, activate the server — a browser window opens when OAuth is needed."
          );
        }
        router.reloadServersFromDisk();
        const cfg = router.getConfig(a.server_name);
        if (!cfg || !visible(a.server_name)) {
          return fail(
            `Unknown server: "${a.server_name}". Available: ${visibleNames().join(", ") || "(none)"}`
          );
        }
        try {
          return text(await access.connect(a.server_name, cfg));
        } catch (err) {
          return fail((err as Error).message);
        }
      }

      case "disconnect_server": {
        const a = parseArgs(ServerNameSchema, rawArgs);
        if (isResult(a)) return a;
        if (!access?.disconnect) {
          return fail("disconnect_server is only available in gateway mode.");
        }
        router.reloadServersFromDisk();
        const cfg = router.getConfig(a.server_name);
        if (!cfg || !visible(a.server_name)) {
          return fail(
            `Unknown server: "${a.server_name}". Available: ${visibleNames().join(", ") || "(none)"}`
          );
        }
        try {
          manager.deactivate(a.server_name);
          return text(await access.disconnect(a.server_name, cfg));
        } catch (err) {
          return fail((err as Error).message);
        }
      }
    }

    // ── Proxy to an active server ─────────────────────────────────────────
    let serverName = manager.findServerForTool(name);
    const ns = parseNamespacedTool(name);
    // Prefer the server named in `server__tool` when that prefix is present.
    if (!serverName && ns && visible(ns.server)) {
      router.reloadServersFromDisk();
      const cfg = router.getConfig(ns.server);
      if (cfg) {
        const wasActive = manager.listActive().includes(ns.server);
        try {
          await manager.activate(ns.server, cfg, access?.prepare(ns.server, cfg));
          serverName = manager.findServerForTool(name);
          if (!serverName && !wasActive) manager.deactivate(ns.server);
        } catch (err) {
          console.error(
            `${LOG_PREFIX} auto-activation of "${ns.server}" failed: ${(err as Error).message}`
          );
          if (!wasActive) manager.deactivate(ns.server);
        }
      }
    }

    if (!serverName) {
      // Best-effort auto-activation: exact ToolIndex hits first, then lexical rank.
      // If a candidate activates but does not expose the tool, deactivate and try the next.
      router.reloadServersFromDisk();
      const lookupName = ns?.tool ?? name;
      const indexed = router.serversWithTool(lookupName).filter(visible);
      const scored = router.select(lookupName, 10).filter(visible);
      const preferred = ns && visible(ns.server) ? [ns.server] : [];
      const candidates = [...new Set([...preferred, ...indexed, ...scored])];
      let lastErr: Error | undefined;

      for (const candidate of candidates) {
        const cfg = router.getConfig(candidate);
        if (!cfg) continue;
        const wasActive = manager.listActive().includes(candidate);
        try {
          await manager.activate(candidate, cfg, access?.prepare(candidate, cfg));
          serverName = manager.findServerForTool(name);
          if (serverName) break;
          if (!wasActive) manager.deactivate(candidate);
        } catch (err) {
          lastErr = err as Error;
          console.error(`${LOG_PREFIX} auto-activation of "${candidate}" failed: ${lastErr.message}`);
          if (!wasActive) manager.deactivate(candidate);
        }
      }

      if (!serverName && lastErr && candidates.length > 0) {
        return fail(
          `Tool "${name}" not found, and auto-activating candidates failed: ${lastErr.message}`
        );
      }
    }

    if (!serverName) {
      return fail(`Tool "${name}" not found. Use discover_tools to find and activate the right server.`);
    }

    try {
      return (await manager.callTool(serverName, name, rawArgs ?? {})) as ToolResult;
    } catch (err) {
      return fail(`Error calling ${name}: ${(err as Error).message}`);
    }
  }

  return { listTools, callTool };
}
