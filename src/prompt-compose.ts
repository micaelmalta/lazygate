// src/prompt-compose.ts
// Compose skill bodies into MCP prompts: argument defaults, {{arg}} / {{context.name}}
// substitution, and optional SSRF-checked context fetches (admin-configured URLs).

import { pinnedFetch } from "./ssrf.js";
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
  // pinnedFetch validates the DNS answer and connects to that exact address (no second lookup).
  return pinnedFetch(
    url,
    {
      method: init.method,
      headers: init.headers as Record<string, string> | undefined,
      body: typeof init.body === "string" ? init.body : undefined,
      signal,
    },
    { allowPrivate }
  );
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

/**
 * Argument values come from the caller, so they must never be able to pull in a secret.
 * Refuse any value containing a secret or credential template.
 */
function assertArgsHaveNoTemplates(args: Record<string, string>): void {
  for (const [key, value] of Object.entries(args)) {
    if (/\$\{(secret|cred):/.test(value)) {
      throw new Error(`Prompt argument "${key}" may not contain \${secret:…} or \${cred:…} templates`);
    }
  }
}

/**
 * Render one admin-authored template: secrets are expanded from the template itself first, then
 * caller arguments are substituted with encoding appropriate to where they land (URL query/path
 * component, or header/body text with control characters stripped). Expanding secrets before
 * substitution means a caller can never inject a `${secret:…}` reference.
 */
function renderContextTemplate(
  template: string,
  argVars: Record<string, string>,
  secrets: SecretLookup | undefined,
  usedSecrets: string[],
  encode: (value: string) => string
): string {
  const withSecrets = expandSecrets(template, secrets, usedSecrets);
  return withSecrets.replace(PLACEHOLDER, (_, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(argVars, key)) return "";
    return encode(argVars[key]!);
  });
}

const encodeUrlPart = (v: string): string => encodeURIComponent(v);
const encodeHeaderOrBody = (v: string): string => v.replace(/[\r\n\0]/g, "");

async function fetchContext(
  ctx: SkillPromptContext,
  argVars: Record<string, string>,
  opts: ComposePromptOptions,
  usedSecrets: string[]
): Promise<string> {
  const maxBytes = opts.contextMaxBytes ?? DEFAULT_CONTEXT_MAX_BYTES;
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_CONTEXT_TIMEOUT_MS;
  const method = (ctx.method ?? "GET").toUpperCase();
  assertArgsHaveNoTemplates(argVars);
  // The URL must have an admin-fixed scheme and host; arguments only fill path/query values.
  if (!/^https?:\/\/[^{}$]/i.test(ctx.url)) {
    throw new Error(`Context "${ctx.name}" URL must start with a literal http(s):// host`);
  }
  const url = renderContextTemplate(ctx.url, argVars, opts.secrets, usedSecrets, encodeUrlPart);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.headers ?? {})) {
    headers[k] = renderContextTemplate(v, argVars, opts.secrets, usedSecrets, encodeHeaderOrBody);
  }
  let body: string | undefined;
  if (ctx.body !== undefined && method !== "GET" && method !== "HEAD") {
    body = renderContextTemplate(ctx.body, argVars, opts.secrets, usedSecrets, encodeHeaderOrBody);
  }

  const res = await fetchConfiguredUrl(
    url,
    { method, headers, body },
    timeoutMs,
    ctx.allowPrivate === true
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
