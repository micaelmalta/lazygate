// src/tool-chain/results.ts
// Converts an upstream MCP tool result into the value a script sees. Only what the script
// returns or logs goes back to the model, so this is where raw upstream text is reduced.

export interface ScriptError {
  error: string;
}

interface McpLike {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

/** Text of a content block, if it is one. */
function blockText(block: unknown): string | undefined {
  if (typeof block !== "object" || block === null) return undefined;
  const b = block as { type?: unknown; text?: unknown };
  return b.type === "text" && typeof b.text === "string" ? b.text : undefined;
}

/** Concatenated text of an upstream error result, for the script's `{ error }` value. */
function errorText(result: McpLike): string {
  const texts = (result.content ?? []).map(blockText).filter((t): t is string => t !== undefined);
  const joined = texts.join("\n").trim();
  return joined || "tool returned an error with no text";
}

/**
 * Turn a successful MCP result into a script value:
 * - `structuredContent` wins when present (already an object)
 * - a single text block is parsed as JSON when it parses, otherwise returned as a string
 * - several text blocks become an array of their parsed values
 * - non-text blocks (images, resources) are passed through as objects
 */
export function toScriptValue(result: McpLike): unknown {
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    return result.structuredContent;
  }
  const blocks = result.content ?? [];
  if (blocks.length === 0) return null;
  const values = blocks.map((block) => {
    const text = blockText(block);
    if (text === undefined) return block;
    return parseMaybeJson(text);
  });
  return values.length === 1 ? values[0] : values;
}

function parseMaybeJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* not JSON: fall through */
    }
  }
  return text;
}

/**
 * Convert a tool result for the script. `isError` becomes `{ error }` (never a thrown exception),
 * so a script can branch on it the same way it would on a value.
 */
export function toScriptResult(result: McpLike): { value: unknown } | { value: ScriptError; failed: true } {
  if (result.isError) return { value: { error: errorText(result) }, failed: true };
  return { value: toScriptValue(result) };
}
