// src/prompt-compose.ts
// Compose skill bodies into MCP prompts: argument defaults, {{arg}} / {{context.name}}
// substitution, and optional SSRF-checked context fetches (admin-configured URLs).

import { assertSafeUrl, UnsafeUrlError, safeFetch } from "./ssrf.js";
import type { SkillConfig, SkillPromptArgument, SkillPromptContext } from "./skill-router.js";

/** Soft cap on each context response body (UTF-8 bytes). */
export const DEFAULT_CONTEXT_MAX_BYTES = 64_000;

/** Default per-context fetch timeout. */
export const DEFAULT_CONTEXT_TIMEOUT_MS = 10_000;

const PLACEHOLDER = /\{\{\s*([a-zA-Z_][\w.]*)\s*\}\}/g;
const SECRET_TEMPLATE = /\$\{secret:([^}]+)\}/g;

export interface SecretLookup {
  get(path: string): string | undefined;
}

export interface ComposePromptOptions {
  /** Skill body (INSTRUCTIONS.md / SKILL.md). */
  body: string;
  /** Skill config (arguments + context). */
  config: SkillConfig;
  /** Values from prompts/get or load_skill args (string → string). */
  args?: Record<string, string>;
  /** Gateway secret store for `${secret:…}` in context headers/body/url. */
  secrets?: SecretLookup;
  /** Max bytes kept from each context response. */
  contextMaxBytes?: number;
  /**
   * When true (gateway default for admin-configured URLs), allow private/link-local
   * targets the same way ProcessManager does for MCP HTTP hosts. Redirects stay manual.
   */
  allowPrivateUrls?: boolean;
}

export interface ComposePromptResult {
  text: string;
  /** Resolved argument map after defaults (for tests / diagnostics). */
  args: Record<string, string>;
  /** Context keys that were fetched (or failed optionally). */
  contextKeys: string[];
  /** Secret values substituted into context URL/headers/body — for output redaction. */
  secretValues: string[];
}

/** MCP-facing argument list for prompts/list (no defaults — not in the MCP schema). */
export function promptArgumentsForList(
  args: SkillPromptArgument[] | undefined
): Array<{ name: string; description?: string; required?: boolean }> | undefined {
  if (!args?.length) return undefined;
  return args.map((a) => ({
    name: a.name,
    description: a.description,
    required: a.required,
  }));
}

/**
 * Merge caller args with defaults; throw when a required arg is missing.
 * Unknown arg keys from the client are kept (harmless for templates).
 */
export function resolvePromptArgs(
  declared: SkillPromptArgument[] | undefined,
  provided: Record<string, string> | undefined
): Record<string, string> {
  const out: Record<string, string> = { ...(provided ?? {}) };
  for (const a of declared ?? []) {
    if (out[a.name] === undefined || out[a.name] === "") {
      if (a.default !== undefined) out[a.name] = a.default;
    }
    if (a.required && (out[a.name] === undefined || out[a.name] === "")) {
      throw new Error(`Missing required prompt argument: "${a.name}"`);
    }
  }
  return out;
}

/** Expand `${secret:path}` using the lookup; throw when a referenced secret is missing. */
export function expandSecrets(
  template: string,
  secrets: SecretLookup | undefined,
  used?: string[]
): string {
  return template.replace(SECRET_TEMPLATE, (_, path: string) => {
    const value = secrets?.get(path);
    if (value === undefined) {
      throw new Error(`Missing secret "${path}" (set via lazygate secret or LAZYGATE_SECRET_*)`);
    }
    used?.push(value);
    return value;
  });
}

/** Substitute `{{name}}` and `{{context.foo}}` from the vars map. Unknown keys → empty string. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_, key: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) return vars[key]!;
    return "";
  });
}

async function fetchConfiguredUrl(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  allowPrivate: boolean
): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  const withSignal = { ...init, signal, redirect: "manual" as const };
  try {
    await assertSafeUrl(url);
    return await safeFetch(url, withSignal);
  } catch (err) {
    if (
      allowPrivate &&
      err instanceof UnsafeUrlError &&
      /private\/link-local/i.test(err.message)
    ) {
      return fetch(url, withSignal);
    }
    throw err;
  }
}

function formatContextBody(raw: string, asJson: boolean, maxBytes: number): string {
  let text = raw;
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    const buf = Buffer.from(text, "utf8").subarray(0, maxBytes);
    let end = buf.length;
    while (end > 0 && (buf[end - 1]! & 0xc0) === 0x80) end--;
    text = buf.subarray(0, end).toString("utf8") + "\n… [truncated]";
  }
  if (!asJson) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

async function fetchContext(
  ctx: SkillPromptContext,
  argVars: Record<string, string>,
  opts: ComposePromptOptions,
  usedSecrets: string[]
): Promise<string> {
  const maxBytes = opts.contextMaxBytes ?? DEFAULT_CONTEXT_MAX_BYTES;
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_CONTEXT_TIMEOUT_MS;
  const method = (ctx.method ?? "GET").toUpperCase();
  const url = expandSecrets(renderTemplate(ctx.url, argVars), opts.secrets, usedSecrets);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.headers ?? {})) {
    headers[k] = expandSecrets(renderTemplate(v, argVars), opts.secrets, usedSecrets);
  }
  let body: string | undefined;
  if (ctx.body !== undefined && method !== "GET" && method !== "HEAD") {
    body = expandSecrets(renderTemplate(ctx.body, argVars), opts.secrets, usedSecrets);
  }

  const res = await fetchConfiguredUrl(
    url,
    { method, headers, body },
    timeoutMs,
    opts.allowPrivateUrls === true
  );
  const raw = await res.text();
  if (!res.ok) {
    const snippet = formatContextBody(raw, false, 2000);
    throw new Error(`Context "${ctx.name}" fetch failed: HTTP ${res.status} from ${new URL(url).origin}\n${snippet}`);
  }
  return formatContextBody(raw, ctx.json !== false, maxBytes);
}

/**
 * Resolve args, fetch optional context, and render `{{…}}` placeholders in the skill body.
 */
export async function composePrompt(opts: ComposePromptOptions): Promise<ComposePromptResult> {
  const args = resolvePromptArgs(opts.config.prompt?.arguments, opts.args);
  const vars: Record<string, string> = { ...args };
  const contextKeys: string[] = [];
  const secretValues: string[] = [];

  for (const ctx of opts.config.prompt?.context ?? []) {
    contextKeys.push(ctx.name);
    try {
      const value = await fetchContext(ctx, args, opts, secretValues);
      vars[`context.${ctx.name}`] = value;
    } catch (err) {
      if (ctx.optional) {
        vars[`context.${ctx.name}`] = `(unavailable: ${(err as Error).message})`;
      } else {
        throw err;
      }
    }
  }

  return {
    text: renderTemplate(opts.body, vars),
    args,
    contextKeys,
    secretValues,
  };
}
