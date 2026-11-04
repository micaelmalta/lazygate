import { describe, expect, it, jest } from "@jest/globals";
import {
  countingTokenizer,
  EXACT_COUNT_MAX_CHARS,
  loadTokenizer,
  parseTokenizerFlag,
} from "../tokenizers.js";
import { estimateTokens } from "../response-optimizer.js";

describe("built-in tokenizers", () => {
  it("leaves chars_per_4 and unknown names on the default estimate", async () => {
    expect(await loadTokenizer("chars_per_4")).toBeUndefined();
    expect(await loadTokenizer(undefined)).toBeUndefined();
    expect(await loadTokenizer("not-a-tokenizer")).toBeUndefined();
  });

  it("loads o200k_base once and counts JSON more precisely than four characters per token", async () => {
    const first = await loadTokenizer("o200k_base");
    const second = await loadTokenizer("o200k_base");
    expect(first).toBeDefined();
    expect(first).toBe(second);
    expect(first!.name).toBe("o200k_base");
    const value = { items: Array.from({ length: 50 }, (_, id) => ({ id, state: null, tags: [] })) };
    const exact = estimateTokens(value, first);
    expect(exact).toBeGreaterThan(0);
    expect(exact).not.toBe(estimateTokens(value));
    expect(first!.countTokens("<|endoftext|>")).toBeGreaterThan(0);
  });

  it("memoizes counts and samples very large inputs", () => {
    const encode = jest.fn((text: string) => text.length);
    const tokenizer = countingTokenizer("test", encode);
    expect(tokenizer.countTokens("abc")).toBe(3);
    expect(tokenizer.countTokens("abc")).toBe(3);
    expect(encode).toHaveBeenCalledTimes(1);

    const large = "y".repeat(EXACT_COUNT_MAX_CHARS * 2);
    expect(tokenizer.countTokens(large)).toBe(large.length);
    for (const [sample] of encode.mock.calls.slice(1)) expect(sample.length).toBeLessThan(large.length);
  });

  it("samples across the whole input, not just its start", () => {
    // One token per "a", four characters per token for "b": a leading sample alone would see only "a".
    const encode = (text: string) => (text.match(/a/g)?.length ?? 0) + Math.ceil((text.match(/b/g)?.length ?? 0) / 4);
    const tokenizer = countingTokenizer("test", encode);
    const half = EXACT_COUNT_MAX_CHARS;
    const mixed = "a".repeat(half) + "b".repeat(half);
    const exact = encode(mixed);
    const sampled = tokenizer.countTokens(mixed);
    expect(Math.abs(sampled - exact) / exact).toBeLessThan(0.05);
  });

  it("keys the memo by digest so cached entries do not hold response text", () => {
    const encode = jest.fn((text: string) => text.length);
    const tokenizer = countingTokenizer("test", encode);
    const text = "z".repeat(10_000);
    tokenizer.countTokens(text);
    tokenizer.countTokens("z".repeat(10_000));
    expect(encode).toHaveBeenCalledTimes(1);
    tokenizer.countTokens(text + "!");
    expect(encode).toHaveBeenCalledTimes(2);
  });

  it("validates the --tokenizer flag", () => {
    expect(parseTokenizerFlag(undefined)).toBeUndefined();
    expect(parseTokenizerFlag("cl100k_base")).toBe("cl100k_base");
    expect(() => parseTokenizerFlag("claude")).toThrow(/chars_per_4, cl100k_base, o200k_base/);
  });
});
