import { readFileSync } from "fs";
import { resolve } from "path";
import { z } from "zod";

export interface LlmProviderConfig {
  /** OpenAI Responses-compatible API base URL, normally ending in /v1. */
  baseUrl: string;
  /** Resolved at gateway startup from the environment; never read from JSON. */
  apiKey?: string;
}

export interface LlmModelRoute {
  provider: string;
  model: string;
}

export interface LlmGatewayConfig {
  providers: Record<string, LlmProviderConfig>;
  /** Codex-facing model id to provider and upstream model mapping. */
  models: Record<string, LlmModelRoute>;
  maxRequestBytes?: number;
}

const fileSchema = z.object({
  providers: z.record(
    z.string().min(1),
    z.object({
      baseUrl: z.string().url(),
      apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
    }).strict()
  ).refine((providers) => Object.keys(providers).length > 0, "at least one provider is required"),
  models: z.record(
    z.string().min(1),
    z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict()
  ).refine((models) => Object.keys(models).length > 0, "at least one model route is required"),
  maxRequestBytes: z.number().int().positive().max(64 * 1024 * 1024).optional(),
}).strict();

/**
 * Load an optional model gateway configuration. The file stores environment
 * variable names, never provider credentials.
 */
export function loadLlmGatewayConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): LlmGatewayConfig | undefined {
  const index = argv.indexOf("--llm-config");
  if (index < 0) return undefined;
  const file = argv[index + 1];
  if (!file || file.startsWith("--")) throw new Error("--llm-config requires a JSON file path");
  const path = resolve(file);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Could not read LLM gateway config ${path}: ${(err as Error).message}`);
  }
  return parseLlmGatewayConfig(raw, env, path);
}

export function parseLlmGatewayConfig(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
  source = "LLM gateway config"
): LlmGatewayConfig {
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
    throw new Error(`${source}: ${detail}`);
  }

  const providers: LlmGatewayConfig["providers"] = {};
  for (const [name, provider] of Object.entries(parsed.data.providers)) {
    const url = new URL(provider.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error(`${source}: providers.${name}.baseUrl must be an HTTP(S) base URL without credentials, query, or fragment`);
    }
    const apiKey = provider.apiKeyEnv ? env[provider.apiKeyEnv] : undefined;
    if (provider.apiKeyEnv && !apiKey) {
      throw new Error(`${source}: environment variable ${provider.apiKeyEnv} is required for provider ${name}`);
    }
    providers[name] = { baseUrl: url.href.replace(/\/+$/, ""), ...(apiKey ? { apiKey } : {}) };
  }

  for (const [model, route] of Object.entries(parsed.data.models)) {
    if (!providers[route.provider]) throw new Error(`${source}: model ${model} references unknown provider ${route.provider}`);
  }

  return { providers, models: parsed.data.models, maxRequestBytes: parsed.data.maxRequestBytes };
}
