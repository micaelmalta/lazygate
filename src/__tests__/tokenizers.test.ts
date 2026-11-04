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
    expect(encode.mock.calls[1]![0].length).toBeLessThan(large.length);
  });

  it("validates the --tokenizer flag", () => {
    expect(parseTokenizerFlag(undefined)).toBeUndefined();
    expect(parseTokenizerFlag("cl100k_base")).toBe("cl100k_base");
    expect(() => parseTokenizerFlag("claude")).toThrow(/chars_per_4, cl100k_base, o200k_base/);
  });
});
