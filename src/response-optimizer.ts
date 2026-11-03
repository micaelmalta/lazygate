import { JSONPath } from "jsonpath-plus";
import { parse, serialize } from "parse5";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { z } from "zod";

export const OPTIMIZATION_MODES = [
  "off",
  "prune",
  "project",
  "jsonpath",
  "schema",
  "html_markdown",
  "html_reader",
] as const;

export type OptimizationMode = (typeof OPTIMIZATION_MODES)[number];

export interface OptimizationPolicy {
  mode?: OptimizationMode;
  maxTokens?: number;
  fields?: string[];
  jsonPath?: string;
  removeNulls?: boolean;
  removeEmptyObjects?: boolean;
  removeEmptyArrays?: boolean;
  removeEmptyStrings?: boolean;
  removeFields?: string[];
  sampleSize?: number;
  includeMetadata?: boolean;
}

export interface ResponseOptimizationConfig {
  enabled: boolean;
  defaultMode: OptimizationMode;
  maxOutputTokens?: number;
  maxOutputBytes?: number;
  maxInputBytes: number;
  maxNestingDepth: number;
  maxHtmlNodes: number;
  maxTransformMs: number;
  sampleSize: number;
  includeMetadata: boolean;
  tools: Record<string, OptimizationPolicy>;
}

export interface OptimizationContext {
  serverName: string;
  toolName: string;
  source: "call_tool" | "run_chain";
}

export interface OptimizationMetrics {
  mode: OptimizationMode;
  originalTokens: number;
  optimizedTokens: number;
  savedTokens: number;
  reductionPercent: number;
  durationMs: number;
  changed: boolean;
  complete: boolean;
  failure?: string;
}

export interface OptimizableToolResult {
  content: unknown[];
  isError?: boolean;
  structuredContent?: unknown;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface OptimizedToolResult<T extends OptimizableToolResult> {
  result: T;
  metrics: OptimizationMetrics;
}

export type OptimizationMetricsSink = (
  context: OptimizationContext,
  metrics: OptimizationMetrics
) => void;

const modeSchema = z.enum(OPTIMIZATION_MODES);

const policySchema = z
  .object({
    mode: modeSchema.optional(),
    maxTokens: z.number().int().positive().max(1_000_000).optional(),
    fields: z.array(z.string().min(1).max(256)).max(100).optional(),
    jsonPath: z.string().min(1).max(512).optional(),
    removeNulls: z.boolean().optional(),
    removeEmptyObjects: z.boolean().optional(),
    removeEmptyArrays: z.boolean().optional(),
    removeEmptyStrings: z.boolean().optional(),
    removeFields: z.array(z.string().min(1).max(256)).max(100).optional(),
    sampleSize: z.number().int().min(1).max(100).optional(),
    includeMetadata: z.boolean().optional(),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.mode === "project" && (!policy.fields || policy.fields.length === 0)) {
      ctx.addIssue({ code: "custom", path: ["fields"], message: "project mode requires at least one field" });
    }
    if (policy.mode === "jsonpath" && !policy.jsonPath) {
      ctx.addIssue({ code: "custom", path: ["jsonPath"], message: "jsonpath mode requires a JSONPath expression" });
    }
  });

const configSchema = z
  .object({
    enabled: z.boolean().default(false),
    defaultMode: modeSchema.default("off"),
    maxOutputTokens: z.number().int().positive().max(1_000_000).optional(),
    maxOutputBytes: z.number().int().min(256).max(32_000_000).optional(),
    maxInputBytes: z.number().int().positive().max(16_000_000).default(1_000_000),
    maxNestingDepth: z.number().int().positive().max(512).default(100),
    maxHtmlNodes: z.number().int().positive().max(500_000).default(100_000),
    maxTransformMs: z.number().int().positive().max(30_000).default(250),
    sampleSize: z.number().int().min(1).max(100).default(3),
    includeMetadata: z.boolean().default(false),
    tools: z.record(z.string().min(1), policySchema).default({}),
  })
  .strict();

const DEFAULT_CONFIG: ResponseOptimizationConfig = {
  enabled: false,
  defaultMode: "off",
  maxInputBytes: 1_000_000,
  maxNestingDepth: 100,
  maxHtmlNodes: 100_000,
  maxTransformMs: 250,
  sampleSize: 3,
  includeMetadata: false,
  tools: {},
};

export function parseResponseOptimizationConfig(
  raw: unknown,
  source = "servers.json"
): { config: ResponseOptimizationConfig; errors: string[] } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { config: DEFAULT_CONFIG, errors: [`${source}: expected a JSON object`] };
  }
  const section = (raw as Record<string, unknown>).responseOptimization;
  if (section === undefined) return { config: DEFAULT_CONFIG, errors: [] };
  const parsed = configSchema.safeParse(section);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(section)"}: ${issue.message}`)
      .join("; ");
    return {
      config: DEFAULT_CONFIG,
      errors: [`${source}: responseOptimization — ${detail}`],
    };
  }
  return { config: parsed.data, errors: [] };
}

export function resolveOptimizationPolicy(
  config: ResponseOptimizationConfig | undefined,
  context: OptimizationContext
): OptimizationPolicy & {
  mode: OptimizationMode;
  maxInputBytes: number;
  maxNestingDepth: number;
  maxHtmlNodes: number;
  maxTransformMs: number;
  maxOutputBytes?: number;
} {
  if (!config?.enabled) {
    return {
      mode: "off",
      maxInputBytes: DEFAULT_CONFIG.maxInputBytes,
      maxNestingDepth: DEFAULT_CONFIG.maxNestingDepth,
      maxHtmlNodes: DEFAULT_CONFIG.maxHtmlNodes,
      maxTransformMs: DEFAULT_CONFIG.maxTransformMs,
    };
  }

  const override = config.tools[`${context.serverName}.${context.toolName}`] ?? {};
  return {
    ...override,
    mode: override.mode ?? config.defaultMode,
    maxTokens: override.maxTokens ?? config.maxOutputTokens,
    sampleSize: override.sampleSize ?? config.sampleSize,
    includeMetadata: override.includeMetadata ?? config.includeMetadata,
    maxInputBytes: config.maxInputBytes,
    maxNestingDepth: config.maxNestingDepth,
    maxHtmlNodes: config.maxHtmlNodes,
    maxTransformMs: config.maxTransformMs,
    maxOutputBytes: config.maxOutputBytes,
  };
}

const MISSING = Symbol("missing projection value");
type Missing = typeof MISSING;
type JsonObject = Record<string, unknown>;

interface ValueOutcome {
  value: unknown;
  changed: boolean;
  complete: boolean;
}

function serialized(value: unknown): string {
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error("value is not JSON serializable");
  return result;
}

/** Approximation for budgeting only: one token per four UTF-16 code units. */
export function estimateTokens(value: unknown): number {
  try {
    return Math.ceil(serialized(value).length / 4);
  } catch {
    return 0;
  }
}

function assertInputLimits(value: unknown, maxBytes: number, maxDepth: number): void {
  const encoded = serialized(value);
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) throw new Error("input exceeded maxInputBytes");

  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > 200_000) throw new Error("input exceeded the JSON node limit");
    if (current.depth > maxDepth) throw new Error("input exceeded maxNestingDepth");
    if (Array.isArray(current.value)) {
      for (const item of current.value) stack.push({ value: item, depth: current.depth + 1 });
    } else if (current.value && typeof current.value === "object") {
      for (const item of Object.values(current.value as JsonObject)) {
        stack.push({ value: item, depth: current.depth + 1 });
      }
    }
  }
}

function parseFieldPath(path: string): string[] {
  const normalized = path.replace(/\[(?:"([^"]+)"|'([^']+)'|(\d+))\]/g, (_m, dquote, squote, index) => `.${dquote ?? squote ?? index}`);
  const parts = normalized.split(".").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "__proto__" || part === "prototype" || part === "constructor")) {
    throw new Error(`invalid projection path: ${path}`);
  }
  return parts;
}

function projected(value: unknown, pathGroups: Map<string, string[][]>): unknown | Missing {
  if (Array.isArray(value)) {
    const numeric = [...pathGroups.entries()].filter(([key]) => /^\d+$/.test(key));
    if (numeric.length) {
      const out: unknown[] = [];
      for (const [indexText, tails] of numeric) {
        const index = Number(indexText);
        if (index >= value.length) continue;
        const selected = tails.some((tail) => tail.length === 0)
          ? value[index]
          : projected(value[index], new Map(tails.map((tail) => [tail[0]!, [tail.slice(1)]])));
        if (selected !== MISSING) out[index] = selected;
      }
      return out;
    }
    return value.map((item) => projected(item, pathGroups)).filter((item) => item !== MISSING);
  }
  if (!value || typeof value !== "object") return MISSING;

  const source = value as JsonObject;
  const out: JsonObject = {};
  for (const [key, tails] of pathGroups) {
    if (!Object.hasOwn(source, key)) continue;
    if (tails.some((tail) => tail.length === 0)) {
      Object.defineProperty(out, key, { value: source[key], enumerable: true, configurable: true, writable: true });
      continue;
    }
    const next = new Map<string, string[][]>();
    for (const tail of tails) {
      if (!tail.length) continue;
      const [head, ...rest] = tail;
      const current = next.get(head!) ?? [];
      current.push(rest);
      next.set(head!, current);
    }
    const child = projected(source[key], next);
    if (child !== MISSING) {
      Object.defineProperty(out, key, { value: child, enumerable: true, configurable: true, writable: true });
    }
  }
  return out;
}

function project(value: unknown, fields: string[]): unknown {
  const groups = new Map<string, string[][]>();
  for (const field of fields) {
    const [head, ...tail] = parseFieldPath(field);
    const current = groups.get(head!) ?? [];
    current.push(tail);
    groups.set(head!, current);
  }
  const result = projected(value, groups);
  return result === MISSING ? {} : result;
}

function prune(value: unknown, policy: OptimizationPolicy, path: string[] = [], isRoot = true): ValueOutcome | Missing {
  if (value === null) {
    return policy.removeNulls && !isRoot ? { value: MISSING, changed: true, complete: false } : { value, changed: false, complete: true };
  }
  if (typeof value === "string" && policy.removeEmptyStrings && value.length === 0 && !isRoot) {
    return { value: MISSING, changed: true, complete: false };
  }
  if (Array.isArray(value)) {
    let changed = false;
    let complete = true;
    const out: unknown[] = [];
    for (const item of value) {
      const result = prune(item, policy, path, false);
      if (result === MISSING || ("value" in result && result.value === MISSING)) {
        changed = true;
        complete = false;
        continue;
      }
      if ("value" in result) {
        out.push(result.value);
        changed ||= result.changed;
        complete &&= result.complete;
      } else out.push(item);
    }
    if (policy.removeEmptyArrays && out.length === 0 && !isRoot) {
      return { value: MISSING, changed: true, complete: false };
    }
    return { value: changed ? out : value, changed, complete };
  }
  if (value && typeof value === "object") {
    let changed = false;
    let complete = true;
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(value as JsonObject)) {
      const childPath = [...path, key];
      if (policy.removeFields?.some((field) => field === key || field === childPath.join("."))) {
        changed = true;
        complete = false;
        continue;
      }
      const result = prune(child, policy, childPath, false);
      if (result === MISSING || ("value" in result && result.value === MISSING)) {
        changed = true;
        complete = false;
        continue;
      }
      if ("value" in result) {
        Object.defineProperty(out, key, { value: result.value, enumerable: true, configurable: true, writable: true });
        changed ||= result.changed;
        complete &&= result.complete;
      } else {
        Object.defineProperty(out, key, { value: child, enumerable: true, configurable: true, writable: true });
      }
    }
    if (policy.removeEmptyObjects && Object.keys(out).length === 0 && !isRoot) {
      return { value: MISSING, changed: true, complete: false };
    }
    return { value: changed ? out : value, changed, complete };
  }
  return { value, changed: false, complete: true };
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return typeof value;
}

function inferObjectSchema(items: unknown[]): Record<string, string> {
  const fields = new Map<string, Set<string>>();
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    for (const [key, value] of Object.entries(item as JsonObject)) {
      const types = fields.get(key) ?? new Set<string>();
      types.add(typeOf(value));
      fields.set(key, types);
    }
  }
  return Object.fromEntries([...fields.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, types]) => [key, [...types].sort().join("|")]));
}

function toSchema(value: unknown, sampleSize: number): unknown {
  const items = Array.isArray(value) ? value : [value];
  return {
    _optimization: { mode: "schema", complete: false },
    _count: items.length,
    _schema: inferObjectSchema(items),
    _sample: items.slice(0, sampleSize),
  };
}

function applyJsonMode(value: unknown, policy: OptimizationPolicy): ValueOutcome {
  switch (policy.mode) {
    case "prune": {
      const result = prune(value, policy);
      if (result === MISSING) return { value, changed: false, complete: true };
      return { value: result.value, changed: result.changed, complete: result.complete };
    }
    case "project":
      if (!policy.fields?.length) throw new Error("project mode requires at least one field");
      return { value: project(value, policy.fields ?? []), changed: true, complete: false };
    case "jsonpath": {
      const query = policy.jsonPath ?? "";
      if (!query.startsWith("$") || query.length > 512) throw new Error("JSONPath must be a bounded expression starting with '$'");
      assertSafeJsonPath(query);
      const values = JSONPath({ path: query, json: value, wrap: true, eval: "safe", resultType: "value" }) as unknown[];
      if (values.length > 10_000) throw new Error("JSONPath result exceeded 10000 matches");
      return { value: values, changed: true, complete: false };
    }
    case "schema":
      return { value: toSchema(value, policy.sampleSize ?? 3), changed: true, complete: false };
    default:
      return { value, changed: false, complete: true };
  }
}

function assertSafeJsonPath(query: string): void {
  const withoutStringLiterals = query.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "");
  if (/=~|\/(?:\\.|[^/])*\/[a-z]*/i.test(withoutStringLiterals)) {
    throw new Error("JSONPath regex filters are disabled because their execution time is difficult to bound");
  }
  if ((withoutStringLiterals.match(/\.\./g) ?? []).length > 4 || (withoutStringLiterals.match(/\[\?\(/g) ?? []).length > 8) {
    throw new Error("JSONPath expression exceeded the recursive selector or filter complexity limit");
  }
  if (
    /\b(?:__proto__|prototype|constructor|globalThis|global|process|require|module|Function|eval|this|new|return|function|import|window|document)\b/i.test(withoutStringLiterals) ||
    /[;`{}]|=>|\+\+|--/.test(withoutStringLiterals) ||
    /(?:^|[^=!<>])=(?:[^=]|$)/.test(withoutStringLiterals) ||
    /[A-Za-z_$][\w$]*\s*\(/.test(withoutStringLiterals)
  ) {
    throw new Error("JSONPath expressions may use JSONPath filters, but not JavaScript code or prototype access");
  }
}

interface HtmlNode {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: HtmlNode[];
}

const DROP_TAGS = new Set(["script", "style", "noscript", "template", "iframe", "object", "embed", "head", "meta", "link", "base"]);
const READER_DROP_TAGS = new Set(["nav", "aside", "header", "footer"]);

function attr(node: HtmlNode, name: string): string | undefined {
  return node.attrs?.find((item) => item.name.toLowerCase() === name)?.value;
}

function isTrackingPixel(node: HtmlNode): boolean {
  if (node.tagName?.toLowerCase() !== "img") return false;
  const width = Number(attr(node, "width"));
  const height = Number(attr(node, "height"));
  const src = attr(node, "src") ?? "";
  return (Number.isFinite(width) && width > 0 && width <= 1) ||
    (Number.isFinite(height) && height > 0 && height <= 1) || /(?:pixel|beacon|track(?:ing)?)(?:[./?_-]|$)/i.test(src);
}

function sanitizeHtml(node: HtmlNode, reader: boolean): void {
  const children = node.childNodes;
  if (!children) return;
  node.childNodes = children.filter((child) => {
    const tag = child.tagName?.toLowerCase();
    if (child.nodeName === "#comment" || (tag && (DROP_TAGS.has(tag) || (reader && READER_DROP_TAGS.has(tag)))) || isTrackingPixel(child)) return false;
    if (child.attrs) {
      const inlineStyle = attr(child, "style") ?? "";
      if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(inlineStyle)) return false;
      child.attrs = child.attrs.filter((item) => {
        const name = item.name.toLowerCase();
        if (name.startsWith("on") || name === "style" || name === "srcset") return false;
        if ((name === "href" || name === "src") && /^(?:javascript|vbscript|data|file):/i.test(item.value.trim())) return false;
        return true;
      });
      if (child.attrs.some((item) => item.name.toLowerCase() === "hidden" || (item.name.toLowerCase() === "aria-hidden" && item.value.toLowerCase() === "true"))) return false;
    }
    sanitizeHtml(child, reader);
    return true;
  });
}

function visitHtml(node: HtmlNode, callback: (node: HtmlNode) => void): void {
  const stack = [node];
  while (stack.length) {
    const current = stack.pop()!;
    callback(current);
    if (current.childNodes) stack.push(...current.childNodes);
  }
}

function findReaderContent(document: HtmlNode): HtmlNode {
  let body: HtmlNode | undefined;
  let main: HtmlNode | undefined;
  let article: HtmlNode | undefined;
  let roleMain: HtmlNode | undefined;
  let contentCandidate: HtmlNode | undefined;
  visitHtml(document, (node) => {
    const tag = node.tagName?.toLowerCase();
    if (tag === "body") body = node;
    if (!main && tag === "main") main = node;
    if (!article && tag === "article") article = node;
    if (!roleMain && attr(node, "role")?.toLowerCase() === "main") roleMain = node;
    const identity = `${attr(node, "id") ?? ""} ${attr(node, "class") ?? ""}`;
    if (!contentCandidate && /\b(?:main|content|article|post|entry)\b/i.test(identity)) contentCandidate = node;
  });
  if (main) return main;
  if (roleMain) return roleMain;
  if (article) return article;
  if (contentCandidate) return contentCandidate;
  return body ?? document;
}

function looksLikeHtml(value: string): boolean {
  return /<(?:!doctype\s+html|html|body|main|article|section|div|p|h[1-6]|ul|ol|table|pre|blockquote|a|img|span|strong|em|dl)(?:\s|\/?>)/i.test(value);
}

function htmlToMarkdown(html: string, reader: boolean, maxHtmlNodes: number, maxDepth: number): string {
  const document = parse(html) as unknown as HtmlNode;
  let nodeCount = 0;
  let deepest = 0;
  const stack: Array<{ node: HtmlNode; depth: number }> = [{ node: document, depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    nodeCount += 1;
    deepest = Math.max(deepest, depth);
    if (nodeCount > maxHtmlNodes) throw new Error("HTML exceeded maxHtmlNodes");
    if (node.childNodes) for (const child of node.childNodes) stack.push({ node: child, depth: depth + 1 });
  }
  if (deepest > maxDepth) throw new Error("HTML exceeded maxNestingDepth");
  sanitizeHtml(document, reader);
  const selected = reader ? findReaderContent(document) : document;
  const safeHtml = serialize(selected as never);
  const converter = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
  });
  converter.use(gfm);
  return converter.turndown(safeHtml).replace(/[\t ]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function transformValue(
  value: unknown,
  policy: OptimizationPolicy,
  maxHtmlNodes: number,
  maxInputBytes: number,
  maxNestingDepth: number
): ValueOutcome {
  if (policy.mode === "html_markdown" || policy.mode === "html_reader") {
    if (typeof value !== "string" || !looksLikeHtml(value)) return { value, changed: false, complete: true };
    if (Buffer.byteLength(value, "utf8") > maxInputBytes) throw new Error("input exceeded maxInputBytes");
    const markdown = htmlToMarkdown(value, policy.mode === "html_reader", maxHtmlNodes, maxNestingDepth);
    return { value: markdown, changed: markdown !== value, complete: policy.mode !== "html_reader" };
  }

  const jsonMode = policy.mode === "prune" || policy.mode === "project" || policy.mode === "jsonpath" || policy.mode === "schema";
  if (!jsonMode) return { value, changed: false, complete: true };
  let parsedText = false;
  let input = value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > maxInputBytes) throw new Error("input exceeded maxInputBytes");
    try {
      input = JSON.parse(value) as unknown;
      parsedText = true;
    } catch {
      return { value, changed: false, complete: true };
    }
  }
  if (input === null || typeof input !== "object") return { value, changed: false, complete: true };
  assertInputLimits(input, maxInputBytes, maxNestingDepth);
  const outcome = applyJsonMode(input, policy);
  return {
    ...outcome,
    value: parsedText && outcome.changed ? serialized(outcome.value) : outcome.value,
  };
}

const TRUNCATION_MARKER = "\n\n[Output incomplete: truncated to configured budget.]";

function truncateText(text: string, maxTokens: number): { text: string; complete: boolean } {
  const maxChars = Math.max(0, maxTokens * 4);
  if (text.length <= maxChars) return { text, complete: true };
  const available = maxChars - TRUNCATION_MARKER.length;
  if (available <= 0) {
    return { text: "Output incomplete: configured token budget is too small to return content.", complete: false };
  }
  const prefix = text.slice(0, available);
  const boundary = Math.max(prefix.lastIndexOf("\n\n"), prefix.lastIndexOf("\n"));
  let safe = boundary > available * 0.55 ? prefix.slice(0, boundary) : prefix;
  const fences = (safe.match(/^\s*```/gm) ?? []).length;
  if (fences % 2 === 1) safe = safe.replace(/\s*$/, "\n```");
  return { text: `${safe.trimEnd()}${TRUNCATION_MARKER}`, complete: false };
}

function truncateStructured(value: unknown, maxTokens: number): { value: unknown; complete: boolean } {
  const maxChars = Math.max(0, maxTokens * 4);
  if (serialized(value).length <= maxChars) return { value, complete: true };
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const candidate = [...out, item];
      if (serialized(candidate).length > maxChars) break;
      out.push(item);
    }
    return { value: out, complete: false };
  }
  if (value && typeof value === "object") {
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value as JsonObject)) {
      const candidate = { ...out, [key]: item };
      if (serialized(candidate).length > maxChars) break;
      Object.defineProperty(out, key, { value: item, enumerable: true, configurable: true, writable: true });
    }
    return { value: out, complete: false };
  }
  if (typeof value === "string") {
    const marker = "…[incomplete]";
    return { value: value.slice(0, Math.max(0, maxChars - marker.length)) + marker, complete: false };
  }
  return { value, complete: false };
}

function metadataFor(metrics: OptimizationMetrics): Record<string, unknown> {
  return {
    mode: metrics.mode,
    originalTokens: metrics.originalTokens,
    optimizedTokens: metrics.optimizedTokens,
    savedTokens: metrics.savedTokens,
    reductionPercent: metrics.reductionPercent,
    durationMs: metrics.durationMs,
    complete: metrics.complete,
  };
}

function addMetadata<T extends OptimizableToolResult>(result: T, metrics: OptimizationMetrics): T {
  const rootMeta = result._meta ?? {};
  const current = rootMeta.lazygate;
  if (current !== undefined && (!current || typeof current !== "object" || Array.isArray(current))) {
    return {
      ...result,
      _meta: { ...rootMeta, responseOptimization: metadataFor(metrics) },
    };
  }
  const lazygate = (current as Record<string, unknown> | undefined) ?? {};
  return {
    ...result,
    _meta: {
      ...rootMeta,
      lazygate: { ...lazygate, responseOptimization: metadataFor(metrics) },
    },
  };
}

function errorResult<T extends OptimizableToolResult>(result: T, message: string): T {
  const bounded: OptimizableToolResult = {
    ...result,
    isError: true,
    content: [{ type: "text", text: message }],
  };
  delete bounded.structuredContent;
  return bounded as T;
}

export async function optimizeToolResult<T extends OptimizableToolResult>(
  original: T,
  policy: OptimizationPolicy & {
    mode?: OptimizationMode;
    maxTokens?: number;
    maxInputBytes?: number;
    maxNestingDepth?: number;
    maxHtmlNodes?: number;
    maxTransformMs?: number;
    maxOutputBytes?: number;
  },
  context: OptimizationContext,
  onMetrics?: OptimizationMetricsSink
): Promise<OptimizedToolResult<T>> {
  const started = performance.now();
  const mode = policy.mode ?? "off";
  const originalTokens = estimateTokens(original);
  let result = original;
  let changed = false;
  let complete = true;
  let failure: string | undefined;

  if (!original.isError && mode !== "off") {
    try {
      const next: OptimizableToolResult = { ...original };
      const htmlNodes = policy.maxHtmlNodes ?? DEFAULT_CONFIG.maxHtmlNodes;
      const structured = original.structuredContent;
      const maxInputBytes = policy.maxInputBytes ?? DEFAULT_CONFIG.maxInputBytes;
      const maxNestingDepth = policy.maxNestingDepth ?? DEFAULT_CONFIG.maxNestingDepth;
      if (structured !== undefined) {
        if (typeof structured !== "string") assertInputLimits(structured, maxInputBytes, maxNestingDepth);
        const outcome = transformValue(structured, policy, htmlNodes, maxInputBytes, maxNestingDepth);
        if (outcome.changed) next.structuredContent = outcome.value;
        changed ||= outcome.changed;
        complete &&= outcome.complete;
      }

      let contentChanged = false;
      const content = original.content.map((block) => {
        if (!block || typeof block !== "object") return block;
        const typedBlock = block as Record<string, unknown>;
        if (typedBlock.type === "text" && typeof typedBlock.text === "string") {
          const outcome = transformValue(typedBlock.text, policy, htmlNodes, maxInputBytes, maxNestingDepth);
          if (!outcome.changed) return block;
          contentChanged = true;
          complete &&= outcome.complete;
          return { ...typedBlock, text: outcome.value };
        }
        if (typedBlock.type === "resource" && typedBlock.resource && typeof typedBlock.resource === "object") {
          const resource = typedBlock.resource as Record<string, unknown>;
          if (typeof resource.text !== "string") return block;
          const outcome = transformValue(resource.text, policy, htmlNodes, maxInputBytes, maxNestingDepth);
          if (!outcome.changed) return block;
          contentChanged = true;
          complete &&= outcome.complete;
          return { ...typedBlock, resource: { ...resource, text: outcome.value } };
        }
        return block;
      });
      if (contentChanged) next.content = content;
      changed ||= contentChanged;
      result = next as T;
    } catch (err) {
      failure = (err as Error).message;
      result = original;
      changed = false;
      complete = true;
    }
  }

  const transformDurationMs = performance.now() - started;
  if (transformDurationMs > (policy.maxTransformMs ?? DEFAULT_CONFIG.maxTransformMs) && changed) {
    result = original;
    changed = false;
    complete = true;
    failure = `transformation exceeded maxTransformMs (${policy.maxTransformMs ?? DEFAULT_CONFIG.maxTransformMs}ms)`;
  }

  const byteTokenBudget = policy.maxOutputBytes ? Math.floor(policy.maxOutputBytes / 4) : undefined;
  const outputTokenBudget = policy.maxTokens && byteTokenBudget
    ? Math.min(policy.maxTokens, byteTokenBudget)
    : policy.maxTokens ?? byteTokenBudget;

  if (outputTokenBudget && estimateTokens(result) > outputTokenBudget) {
    const bounded: OptimizableToolResult = { ...result };
    const overhead = estimateTokens({ ...bounded, content: [], structuredContent: undefined });
    const payloadTokens = Math.max(1, outputTokenBudget - overhead - 2);
    let remaining = payloadTokens;
    let budgetComplete = true;

    if (bounded.structuredContent !== undefined) {
      const structureBudget = bounded.content.some((block) =>
        block && typeof block === "object" && (block as { type?: unknown }).type === "text"
      ) ? Math.max(1, Math.floor(remaining / 2)) : remaining;
      try {
        const truncated = truncateStructured(bounded.structuredContent, structureBudget);
        bounded.structuredContent = truncated.value;
        remaining = Math.max(1, remaining - estimateTokens(truncated.value));
        budgetComplete &&= truncated.complete;
      } catch {
        budgetComplete = false;
      }
    }

    const updated: unknown[] = [];
    for (const block of bounded.content) {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string") {
        const boundedText = truncateText((block as { text: string }).text, remaining);
        updated.push({ ...(block as Record<string, unknown>), text: boundedText.text });
        remaining = Math.max(1, remaining - estimateTokens(boundedText.text));
        budgetComplete &&= boundedText.complete;
      } else updated.push(block);
    }
    bounded.content = updated;

    if (estimateTokens(bounded) > outputTokenBudget) {
      result = errorResult(original, "Response exceeded the configured output budget; output is incomplete.");
      complete = false;
      changed = true;
    } else {
      result = bounded as T;
      complete &&= budgetComplete;
      changed = true;
    }
  }

  if (policy.maxOutputBytes && Buffer.byteLength(serialized(result), "utf8") > policy.maxOutputBytes) {
    result = errorResult(original, "Response exceeded the configured output byte limit; output is incomplete.");
    complete = false;
    changed = true;
  }

  const durationMs = performance.now() - started;
  const makeMetrics = (): OptimizationMetrics => {
    const optimizedTokens = estimateTokens(result);
    const savedTokens = Math.max(0, originalTokens - optimizedTokens);
    return {
      mode,
      originalTokens,
      optimizedTokens,
      savedTokens,
      reductionPercent: originalTokens ? Math.round((savedTokens / originalTokens) * 100) : 0,
      durationMs,
      changed,
      complete,
      ...(failure ? { failure } : {}),
    };
  };
  const overBudget = (value: T): boolean =>
    Boolean(
      (outputTokenBudget && estimateTokens(value) > outputTokenBudget) ||
        (policy.maxOutputBytes && Buffer.byteLength(serialized(value), "utf8") > policy.maxOutputBytes)
    );

  let metrics = makeMetrics();
  const metadataRequested = policy.includeMetadata || !metrics.complete;
  if (metadataRequested) {
    result = addMetadata(result, metrics);
    metrics = makeMetrics();
    result = addMetadata(result, metrics);
  }

  // Metadata is part of the protocol response, so limits must be checked after it is attached.
  if (overBudget(result)) {
    const errorMessage = policy.maxOutputBytes && Buffer.byteLength(serialized(result), "utf8") > policy.maxOutputBytes
      ? "Response exceeded the configured output byte limit; output is incomplete."
      : "Response exceeded the configured output budget (token limit); output is incomplete.";
    result = errorResult(original, errorMessage);
    changed = true;
    complete = false;
    metrics = makeMetrics();
    if (metadataRequested) {
      const withMetadata = addMetadata(result, metrics);
      if (!policy.maxOutputBytes || Buffer.byteLength(serialized(withMetadata), "utf8") <= policy.maxOutputBytes) {
        result = withMetadata;
        metrics = makeMetrics();
      }
    }
  }
  try {
    onMetrics?.(context, metrics);
  } catch {
    // Metrics are advisory and must never make a downstream MCP call fail.
  }
  return { result, metrics };
}
