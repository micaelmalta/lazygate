import { once } from "events";
import type { IncomingMessage, ServerResponse } from "http";
import {
  optimizeToolResult,
  resolveOptimizationPolicy,
  type OptimizationContext,
  type OptimizationMetrics,
  type OptimizableToolResult,
  type ResponseOptimizationConfig,
  type Tokenizer,
} from "../response-optimizer.js";
import type { UserIdentity } from "./tokens.js";
import type { AuditLog } from "./audit.js";
import { readBody, sendJson } from "./http-util.js";
import type { LlmGatewayConfig, LlmModelRoute } from "./llm-config.js";

const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024 * 1024;

interface OptimizedToolOutput {
  context: OptimizationContext;
  metrics: OptimizationMetrics;
}

export interface LlmRequestDependencies {
  config: LlmGatewayConfig;
  user: UserIdentity;
  audit: AuditLog;
  responseOptimization: ResponseOptimizationConfig;
  tokenizer?: Tokenizer;
}

function openAiError(
  res: ServerResponse,
  status: number,
  message: string,
  type = "invalid_request_error",
  code?: string
): void {
  sendJson(res, status, { error: { message, type, ...(code ? { code } : {}) } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function routeForModel(config: LlmGatewayConfig, model: string): LlmModelRoute | undefined {
  return config.models[model];
}

function responseEndpoint(baseUrl: string): string {
  return new URL("responses", `${baseUrl.replace(/\/+$/, "")}/`).toString();
}

function modelList(config: LlmGatewayConfig): unknown {
  return {
    object: "list",
    data: Object.keys(config.models).sort().map((id) => ({ id, object: "model", created: 0, owned_by: "lazygate" })),
  };
}

function toolContext(name: string | undefined): OptimizationContext {
  if (name) {
    const separator = name.indexOf("__");
    if (separator > 0 && separator < name.length - 2) {
      return { serverName: name.slice(0, separator), toolName: name.slice(separator + 2), source: "llm_gateway" };
    }
    return { serverName: "llm", toolName: name, source: "llm_gateway" };
  }
  return { serverName: "llm", toolName: "function_call_output", source: "llm_gateway" };
}

function outputText(result: OptimizableToolResult): string | undefined {
  const text = result.content
    .filter((part): part is { type?: string; text: string } => isRecord(part) && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
  if (text) return text;
  if (result.structuredContent !== undefined) {
    try {
      return JSON.stringify(result.structuredContent);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function optimizeInputToolOutputs(
  body: Record<string, unknown>,
  config: ResponseOptimizationConfig,
  tokenizer?: Tokenizer
): Promise<{ body: Record<string, unknown>; outputs: OptimizedToolOutput[] }> {
  if (!config.enabled || !Array.isArray(body.input)) return { body, outputs: [] };

  const items = body.input;
  const namesByCallId = new Map<string, string>();
  for (const item of items) {
    if (!isRecord(item) || item.type !== "function_call") continue;
    if (typeof item.call_id === "string" && typeof item.name === "string") namesByCallId.set(item.call_id, item.name);
  }

  const outputs: OptimizedToolOutput[] = [];
  const input: unknown[] = [];
  for (const item of items) {
    if (!isRecord(item) || item.type !== "function_call_output" || typeof item.output !== "string") {
      input.push(item);
      continue;
    }
    const context = toolContext(typeof item.call_id === "string" ? namesByCallId.get(item.call_id) : undefined);
    const policy = resolveOptimizationPolicy(config, context);
    if (policy.mode === "off") {
      input.push(item);
      continue;
    }
    const originalOutput = item.output;
    const original: OptimizableToolResult = { content: [{ type: "text", text: originalOutput }] };
    const optimized = await optimizeToolResult(original, policy, context, undefined, tokenizer).catch(() => undefined);
    if (!optimized) {
      input.push(item);
      continue;
    }
    outputs.push({ context, metrics: optimized.metrics });
    const transformed = outputText(optimized.result);
    // A model request cannot carry LazyGate's MCP result handle. Apply only
    // information-preserving transforms here; incomplete reductions stay intact.
    if (optimized.metrics.changed && optimized.metrics.complete && !optimized.metrics.failure && transformed !== undefined) {
      input.push({ ...item, output: transformed });
    } else {
      input.push(item);
    }
  }
  return { body: { ...body, input }, outputs };
}

function recordOptimization(audit: AuditLog, user: UserIdentity, output: OptimizedToolOutput): void {
  const { context, metrics } = output;
  audit.record({
    user: user.id,
    tool: "responses.input",
    server: context.serverName,
    target: context.toolName,
    ok: true,
    ms: metrics.durationMs,
    originalTokens: metrics.originalTokens,
    optimizedTokens: metrics.optimizedTokens,
    savedTokens: metrics.savedTokens,
    optimizationMode: metrics.mode,
    optimizationSelectedMode: metrics.selectedMode,
    optimizationTokenizer: metrics.tokenizer,
    optimizationDurationMs: metrics.durationMs,
    optimizationFallback: Boolean(metrics.failure),
    optimizationComplete: metrics.complete,
  });
}

async function sendProviderResponse(
  upstream: Response,
  res: ServerResponse,
  controller: AbortController
): Promise<void> {
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel().catch(() => undefined);
    openAiError(res, 502, "The model provider returned a redirect", "server_error", "upstream_redirect");
    return;
  }
  const headers: Record<string, string> = {};
  for (const name of ["content-type", "cache-control", "retry-after", "x-request-id", "openai-processing-ms", "openai-version"]) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  res.writeHead(upstream.status, headers);
  if (!upstream.body) {
    res.end();
    return;
  }
  try {
    for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
      if (controller.signal.aborted || res.destroyed) return;
      if (!res.write(Buffer.from(chunk))) await once(res, "drain");
    }
    if (!res.destroyed) res.end();
  } catch (err) {
    if (!controller.signal.aborted) throw err;
  }
}

export async function handleLlmGatewayRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: LlmRequestDependencies
): Promise<void> {
  if (path === "/v1/models") {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return openAiError(res, 405, "Method not allowed", "invalid_request_error", "method_not_allowed");
    }
    return sendJson(res, 200, modelList(deps.config));
  }
  if (path !== "/v1/responses") return openAiError(res, 404, "Not found", "invalid_request_error", "not_found");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return openAiError(res, 405, "Method not allowed", "invalid_request_error", "method_not_allowed");
  }

  let rawBody: unknown;
  try {
    rawBody = await readBody(req, deps.config.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES);
  } catch (err) {
    const tooLarge = (err as Error).message === "Request body too large";
    return openAiError(res, tooLarge ? 413 : 400, tooLarge ? "Request body too large" : "Invalid JSON request body");
  }
  if (!isRecord(rawBody)) return openAiError(res, 400, "Expected a JSON object request body");
  if (typeof rawBody.model !== "string" || !rawBody.model) return openAiError(res, 400, "The model field is required");

  const model = rawBody.model;
  const route = routeForModel(deps.config, model);
  if (!route) return openAiError(res, 400, `The model '${model}' is not available`, "invalid_request_error", "model_not_found");
  const provider = deps.config.providers[route.provider];
  if (!provider) return openAiError(res, 500, "The configured model provider is unavailable", "server_error", "provider_not_configured");

  const routedBody = { ...rawBody, model: route.model };
  const optimized = await optimizeInputToolOutputs(routedBody, deps.responseOptimization, deps.tokenizer);
  const headers = new Headers({
    "Content-Type": "application/json",
    Accept: req.headers.accept ?? "application/json",
  });
  if (provider.apiKey) headers.set("Authorization", `Bearer ${provider.apiKey}`);
  if (typeof req.headers["openai-beta"] === "string") headers.set("OpenAI-Beta", req.headers["openai-beta"]);

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.once("aborted", onAbort);
  res.once("close", onClose);
  const started = Date.now();
  let status: number | undefined;
  let failure: string | undefined;
  try {
    const upstream = await fetch(responseEndpoint(provider.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(optimized.body),
      signal: controller.signal,
      redirect: "manual",
    });
    status = upstream.status;
    if (status >= 300 && status < 400) failure = "upstream_redirect";
    for (const output of optimized.outputs) recordOptimization(deps.audit, deps.user, output);
    await sendProviderResponse(upstream, res, controller);
  } catch (err) {
    failure = err instanceof Error ? err.name : "upstream_error";
    if (!controller.signal.aborted && !res.headersSent) {
      openAiError(res, 502, "The model provider request failed", "server_error", "upstream_error");
    } else if (!res.destroyed) {
      res.destroy();
    }
  } finally {
    req.off("aborted", onAbort);
    res.off("close", onClose);
    deps.audit.record({
      user: deps.user.id,
      tool: "responses",
      server: "llm",
      target: model,
      ok: status !== undefined && status < 400 && !failure,
      ms: Date.now() - started,
      error: failure ?? (status !== undefined && status >= 400 ? `provider_http_${status}` : undefined),
    });
  }
}
