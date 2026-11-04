import { describe, it, expect } from "@jest/globals";
import { longestFittingPrefix, type PrefixFitStats } from "../prefix-fit.js";
import { optimizeToolResult, type Tokenizer } from "../response-optimizer.js";
import { textWithinBudget } from "../result-handles.js";

/** Deterministic stand-in for a BPE tokenizer: word runs and punctuation each cost one token. */
const wordTokens = (text: string): number => (text.match(/[A-Za-z0-9]+|[^A-Za-z0-9\s]/g) ?? []).length;

function bruteForce(length: number, budget: number, measure: (n: number) => number): number {
  let best = 0;
  for (let n = 1; n <= length; n++) if (measure(n) <= budget) best = n;
  return best;
}

describe("longestFittingPrefix", () => {
  it("matches an exhaustive search for monotone measures", () => {
    const text = Array.from({ length: 300 }, (_, i) => `word${i} {"k":${i}}`).join(" ");
    const measure = (n: number): number => wordTokens(text.slice(0, n));
    for (const budget of [1, 2, 7, 50, 333, 900, 5000]) {
      const expected = bruteForce(text.length, budget, measure);
      expect(longestFittingPrefix(text.length, budget, measure)).toBe(expected);
    }
  });

  it("returns the full length when everything fits and 0 when nothing does", () => {
    expect(longestFittingPrefix(100, 1_000, (n) => n)).toBe(100);
    expect(longestFittingPrefix(100, 0, (n) => n)).toBe(0);
    expect(longestFittingPrefix(0, 10, (n) => n)).toBe(0);
  });

  it("recovers from badly wrong seed ratios", () => {
    const measure = (n: number): number => Math.ceil(n / 11);
    for (const seed of [0.01, 1, 4, 500]) {
      expect(longestFittingPrefix(100_000, 300, measure, seed)).toBe(3_300);
    }
  });

  it("never probes far past the answer when the budget is a small fraction of the text", () => {
    const stats: PrefixFitStats = { probes: 0, probedChars: 0 };
    const measure = (n: number): number => Math.ceil(n / 3);
    const length = 2_000_000;
    const best = longestFittingPrefix(length, 2_000, measure, undefined, stats);
    expect(best).toBe(6_000);
    expect(stats.probes).toBeLessThan(30);
    // Plain bisection would start at length / 2; every probe here stays within a small multiple of the answer.
    expect(stats.probedChars).toBeLessThan(best * 30);
  });
});

describe("bounded truncation work", () => {
  const context = { serverName: "s", toolName: "t", source: "call_tool" as const };

  function instrument(): { tokenizer: Tokenizer; lengths: number[] } {
    const lengths: number[] = [];
    return {
      lengths,
      tokenizer: {
        name: "words",
        countTokens(value: string) {
          lengths.push(value.length);
          return wordTokens(value);
        },
      },
    };
  }

  it("does not re-count the whole response while truncating text to a small budget", async () => {
    const text = Array.from({ length: 4_000 }, (_, i) => `Line ${i}: the quick brown fox jumps.`).join("\n");
    const { tokenizer, lengths } = instrument();
    const out = await optimizeToolResult(
      { content: [{ type: "text", text }] },
      { mode: "off", maxTokens: 1_000 },
      context,
      undefined,
      tokenizer
    );
    expect(out.metrics.complete).toBe(false);
    expect(out.metrics.optimizedTokens).toBeLessThanOrEqual(1_000);
    expect(out.metrics.optimizedTokens).toBeGreaterThan(800);
    // The original is counted for metrics and the budget check; truncation itself only touches prefixes.
    const wholeCounts = lengths.filter((n) => n >= text.length * 0.5).length;
    expect(wholeCounts).toBeLessThanOrEqual(2);
    const total = lengths.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(text.length * 3);
  });

  it("keeps a leading slice of an oversized array inside a wrapper object", async () => {
    const items = Array.from({ length: 3_000 }, (_, id) => ({ id, title: `Record ${id}`, body: "x y z ".repeat(10) }));
    const { tokenizer, lengths } = instrument();
    const out = await optimizeToolResult(
      { content: [], structuredContent: { items } },
      { mode: "off", maxTokens: 1_500 },
      context,
      undefined,
      tokenizer
    );
    const kept = (out.result.structuredContent as { items?: unknown[] }).items ?? [];
    expect(out.metrics.complete).toBe(false);
    expect(out.metrics.optimizedTokens).toBeLessThanOrEqual(1_500);
    expect(kept.length).toBeGreaterThan(5);
    expect(kept[0]).toEqual(items[0]);
    const serializedLength = JSON.stringify({ items }).length;
    expect(lengths.filter((n) => n >= serializedLength * 0.5).length).toBeLessThanOrEqual(2);
  });

  it("textWithinBudget makes progress and respects the budget on huge text", () => {
    const text = "alpha beta gamma\n".repeat(50_000);
    const chunk = textWithinBudget(text, 400, wordTokens);
    expect(wordTokens(chunk)).toBeLessThanOrEqual(400);
    expect(wordTokens(chunk)).toBeGreaterThan(380);
    expect(chunk.endsWith("\n")).toBe(true);
    expect(textWithinBudget("x".repeat(100), 0, wordTokens).length).toBeGreaterThan(0);
  });
});
