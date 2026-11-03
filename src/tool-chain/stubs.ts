// src/tool-chain/stubs.ts
// Compact TypeScript signatures for a server's tool-chain tools, so the model can write
// `run_chain` scripts without loading full JSON Schemas into its context.

import type { MCPTool } from "../process-manager.js";

const SUMMARY_MAX = 160;

/** First sentence of a tool description, capped in length (shared with activation output). */
export function summarizeDescription(description: string | undefined, max = SUMMARY_MAX): string {
  const flat = (description ?? "").trim().split(/\n\s*\n/)[0].replace(/\s+/g, " ");
  let end = flat.length;
  for (const m of flat.matchAll(/[.!?](?=\s|$)/g)) {
    const i = m.index!;
    if (/(?:e\.g|i\.e|etc|vs)$/i.test(flat.slice(0, i))) continue; // abbreviation, not a sentence end
    end = i + 1;
    break;
  }
  const sentence = flat.slice(0, end);
  return sentence.length > max ? sentence.slice(0, max - 1).trimEnd() + "…" : sentence;
}

/** Limit on how deep nested object shapes are expanded in a stub. */
const MAX_DEPTH = 2;

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function propKey(name: string): string {
  return IDENT.test(name) ? name : JSON.stringify(name);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Convert a JSON Schema node to a TypeScript type expression. Unknown shapes become `unknown`. */
export function schemaToType(schema: unknown, depth = 0): string {
  if (!isObject(schema)) return "unknown";

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const lits = schema.enum.map((v) => JSON.stringify(v));
    return lits.join(" | ");
  }
  if (schema.const !== undefined) return JSON.stringify(schema.const);

  // Union keywords: anyOf / oneOf -> |
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches) && branches.length > 0) {
      return [...new Set(branches.map((b) => schemaToType(b, depth)))].join(" | ");
    }
  }

  const type = schema.type;
  const types = Array.isArray(type) ? type : type !== undefined ? [type] : [];
  if (types.length > 1) {
    return [...new Set(types.map((t) => primitiveType(t, schema, depth)))].join(" | ");
  }
  if (types.length === 1) return primitiveType(types[0], schema, depth);
  if (isObject(schema.properties)) return objectType(schema, depth);
  return "unknown";
}

function primitiveType(type: unknown, schema: Record<string, unknown>, depth: number): string {
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const items = schema.items;
      return `${wrapForArray(items ? schemaToType(items, depth + 1) : "unknown")}[]`;
    }
    case "object":
      return objectType(schema, depth);
    default:
      return "unknown";
  }
}

/** Parenthesize union/function-like element types so `T[]` binds correctly. */
function wrapForArray(t: string): string {
  return /[|&]/.test(t) ? `(${t})` : t;
}

function objectType(schema: Record<string, unknown>, depth: number): string {
  const props = isObject(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const names = Object.keys(props);

  if (names.length === 0) {
    // Free-form object (e.g. a bare `{ "type": "object" }`).
    if (isObject(schema.additionalProperties)) {
      return `Record<string, ${schemaToType(schema.additionalProperties, depth + 1)}>`;
    }
    return "Record<string, unknown>";
  }
  if (depth >= MAX_DEPTH) return "Record<string, unknown>";

  const fields = names.map((name) => {
    const opt = required.has(name) ? "" : "?";
    return `${propKey(name)}${opt}: ${schemaToType(props[name], depth + 1)}`;
  });
  return `{ ${fields.join("; ")} }`;
}

/** First line of a tool's description, used as a doc comment above its signature. */
function docLine(description: string | undefined): string {
  return summarizeDescription(description, SUMMARY_MAX);
}

/**
 * One TypeScript signature for a tool, for example:
 *   search(args: { jql: string; maxResults?: number }): Promise<unknown> // Search issues
 */
export function toolSignature(tool: Pick<MCPTool, "name" | "description" | "inputSchema">): string {
  const schema = isObject(tool.inputSchema) ? tool.inputSchema : {};
  const hasProps = isObject(schema.properties) && Object.keys(schema.properties).length > 0;
  const argType = hasProps ? objectType(schema, 0) : "Record<string, unknown>";
  const name = IDENT.test(tool.name) ? tool.name : JSON.stringify(tool.name);
  const doc = docLine(tool.description);
  return `${name}(args: ${argType}): Promise<unknown>${doc ? ` // ${doc}` : ""}`;
}

/** Header shared by every stub block: how results and errors look inside a script. */
export const STUB_HEADER = [
  "// Results: structured content as an object, JSON text parsed, or plain text as a string.",
  "// Tool errors do not throw: a failed call resolves to { error: string }.",
  "// Each run_chain run is a fresh scope; nothing persists between runs.",
].join("\n");

/**
 * Stub block for one server's tool-chain tools. `tools` are the upstream tools the caller may
 * script (already filtered by toolChain). Returns null when there are none.
 */
export function serverStubs(
  serverName: string,
  tools: Array<Pick<MCPTool, "name" | "description" | "inputSchema">>
): string | null {
  if (tools.length === 0) return null;
  const body = tools.map((t) => `  ${toolSignature(t)}`).join("\n");
  return `${STUB_HEADER}\n// servers.${serverName}\n${serverName}: {\n${body}\n}`;
}
