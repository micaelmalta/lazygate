// src/tokenizers.ts
// Built-in token counters for response optimization, loaded lazily so the default path stays light.

import { TOKENIZER_NAMES, type Tokenizer } from "./response-optimizer.js";
import { LOG_PREFIX } from "./version.js";

export const BUILTIN_TOKENIZERS = TOKENIZER_NAMES;
export type BuiltinTokenizerName = (typeof BUILTIN_TOKENIZERS)[number];

/** Above this many characters, count a leading sample and scale (exact encoding costs ~190 ms/MB). */
export const EXACT_COUNT_MAX_CHARS = 256 * 1024;
const SAMPLE_CHARS = 64 * 1024;
const MEMO_ENTRIES = 32;

const loaded = new Map<BuiltinTokenizerName, Promise<Tokenizer | undefined>>();

export function isBuiltinTokenizer(name: unknown): name is BuiltinTokenizerName {
  return typeof name === "string" && (BUILTIN_TOKENIZERS as readonly string[]).includes(name);
}

/** Wraps an encoder with a small memo and sampled counting for very large inputs. */
export function countingTokenizer(name: string, encode: (text: string) => number): Tokenizer {
  const memo = new Map<string, number>();
  return {
    name,
    countTokens(text: string): number {
      const cached = memo.get(text);
      if (cached !== undefined) return cached;
      const count =
        text.length <= EXACT_COUNT_MAX_CHARS
          ? encode(text)
          : Math.ceil((encode(text.slice(0, SAMPLE_CHARS)) * text.length) / SAMPLE_CHARS);
      if (memo.size >= MEMO_ENTRIES) memo.delete(memo.keys().next().value!);
      memo.set(text, count);
      return count;
    },
  };
}

async function loadEncoding(name: Exclude<BuiltinTokenizerName, "chars_per_4">): Promise<Tokenizer | undefined> {
  try {
    const { Tiktoken } = await import("js-tiktoken/lite");
    const ranks =
      name === "cl100k_base"
        ? (await import("js-tiktoken/ranks/cl100k_base")).default
        : (await import("js-tiktoken/ranks/o200k_base")).default;
    const encoding = new Tiktoken(ranks);
    return countingTokenizer(name, (text) => encoding.encode(text, [], []).length);
  } catch (err) {
    console.error(`${LOG_PREFIX} tokenizer ${name} unavailable (${(err as Error).message}); using chars_per_4`);
    return undefined;
  }
}

/**
 * Resolve a built-in tokenizer by name. `chars_per_4` (and unknown names) resolve to undefined,
 * which selects the optimizer's default four-characters-per-token estimate.
 */
export function loadTokenizer(name: string | undefined): Promise<Tokenizer | undefined> {
  if (!isBuiltinTokenizer(name) || name === "chars_per_4") return Promise.resolve(undefined);
  let pending = loaded.get(name);
  if (!pending) {
    pending = loadEncoding(name);
    loaded.set(name, pending);
  }
  return pending;
}

/** Parse a `--tokenizer <name>` CLI value; throws with the accepted names on a typo. */
export function parseTokenizerFlag(value: string | undefined): BuiltinTokenizerName | undefined {
  if (value === undefined) return undefined;
  if (!isBuiltinTokenizer(value)) {
    throw new Error(`--tokenizer must be one of: ${BUILTIN_TOKENIZERS.join(", ")}`);
  }
  return value;
}
