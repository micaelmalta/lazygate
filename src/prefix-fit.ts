// src/prefix-fit.ts
// Bounded search for the longest prefix of a text that fits a token budget.
//
// A plain binary search over [0, text.length] first measures a prefix of half the text, so a
// 1 MB response with a 2,000-token budget tokenizes ~500 KB before narrowing in. Here every probe
// stays near the answer: the first guess comes from a characters-per-token ratio, each later guess
// is re-aimed with the ratio measured on the previous probe, and once the answer is bracketed the
// search bisects, so the worst case stays logarithmic.
//
// Contract: the result is always 0 or a length that was measured to fit the budget, so truncation
// can never overshoot. It is the exact longest prefix only while the measure is non-decreasing in
// the prefix length. Real tokenizers are monotone except at merge boundaries (a multi-byte
// character or a punctuation run can tokenize one token cheaper when one more character
// completes it); there the search may return a slightly shorter prefix than the true maximum,
// never a longer one. Tests pin both properties, including against o200k_base.

/** Characters per token assumed before anything has been measured (matches chars_per_4). */
const INITIAL_CHARS_PER_TOKEN = 4;
/** Re-aimed probes before bisecting a bracket that has both ends. */
const AIMED_PROBES = 4;
/** After this many probes, bisect even if re-aiming has not closed the bracket. */
const MAX_AIMED_PROBES = 12;
/** Overshoot applied to a re-aimed guess after a probe that fit, so the next probe brackets. */
const OVERSHOOT = 1.02;
const UNDERSHOOT = 0.995;

/**
 * Tokens essentially never average more than this many characters, so a value longer than
 * `budget * MAX_PLAUSIBLE_CHARS_PER_TOKEN` can be treated as over budget without counting all of it.
 */
export const MAX_PLAUSIBLE_CHARS_PER_TOKEN = 16;

export interface PrefixFitStats {
  /** Number of `measure` calls made. */
  probes: number;
  /** Sum of the prefix lengths passed to `measure` (a proxy for tokenizer work). */
  probedChars: number;
}

/**
 * Largest `n` in `[0, length]` with `measure(n) <= budget` when `measure` is non-decreasing in `n`;
 * for any other measure, some `n` that was measured to fit (possibly not the largest) or 0.
 * `measure(0)` is taken to fit (callers check the empty case first); `measure(n)` is called at
 * most once per distinct `n`.
 *
 * @param seedCharsPerToken optional hint for the first guess (for example a ratio observed while
 *   estimating the whole text).
 */
export function longestFittingPrefix(
  length: number,
  budget: number,
  measure: (prefixLength: number) => number,
  seedCharsPerToken?: number,
  stats?: PrefixFitStats
): number {
  if (length <= 0) return 0;
  // `fits` is a length known to fit; `over` one known not to (length + 1 means none found yet).
  let fits = 0;
  let over = length + 1;
  const seen = new Map<number, number>();
  const probe = (n: number): number => {
    const cached = seen.get(n);
    if (cached !== undefined) return cached;
    const value = measure(n);
    seen.set(n, value);
    if (stats) {
      stats.probes += 1;
      stats.probedChars += n;
    }
    return value;
  };

  const seed =
    seedCharsPerToken !== undefined && Number.isFinite(seedCharsPerToken) && seedCharsPerToken > 0
      ? seedCharsPerToken
      : INITIAL_CHARS_PER_TOKEN;
  let guess = Math.floor(Math.max(1, budget) * seed);
  let probes = 0;

  while (over - fits > 1) {
    const bracketed = over <= length;
    const bisect = probes >= MAX_AIMED_PROBES || (bracketed && probes >= AIMED_PROBES);
    let next = bisect ? fits + Math.floor((over - fits) / 2) : guess;
    next = Math.min(over - 1, Math.max(fits + 1, Math.floor(next)));

    const tokens = probe(next);
    probes += 1;
    if (tokens <= budget) fits = next;
    else over = next;

    // Re-aim at the budget with the density just observed: slightly past it after a fit (to
    // bracket the answer), slightly short of it after a miss.
    if (Number.isFinite(tokens) && tokens > 0) {
      const target = (budget * next) / tokens;
      guess = tokens <= budget ? Math.max(Math.ceil(target * OVERSHOOT), next + 1) : target * UNDERSHOOT;
    } else {
      guess = next * 2;
    }
  }
  return fits;
}
