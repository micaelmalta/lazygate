// src/discovery.ts
// BM25-style lexical ranking of servers for discover_tools.
//
// Each server is one document with weighted fields (name, keywords, tool names, description, tool
// descriptions). Query terms are normalized (camelCase / snake_case split, light stemming, stop
// words dropped) and expanded with aliases at a lower weight. Exact and partial tool-name matches
// add a bonus, so a query that is just an upstream tool identifier lands on the server that owns
// it. An optional usage signal nudges ties toward servers the user actually calls.
//
// No embeddings: this is dependency-free and runs in well under a millisecond per server.

import { aliasesOf, normalizeWord, splitCompounds, stem } from "./scoring.js";
import type { IndexedTool } from "./tool-index.js";

export interface DiscoveryEntry {
  name: string;
  description: string;
  keywords: string[];
  tools: IndexedTool[];
  /**
   * Identity of the data the entry was built from (config object, tool list). Rankers cache the
   * analyzed document per name and rebuild it only when a source reference changes.
   */
  sources: readonly object[];
}

export interface DiscoveryHit {
  name: string;
  /** BM25 score plus tool-name bonus (and usage nudge); higher is better. */
  relevance: number;
  /** Tool names that matched the query (exact identifier first). */
  toolMatches: string[];
  /** True when the query contains a whole upstream tool identifier of 2+ words. */
  exactTool: boolean;
}

export interface DiscoveryOptions {
  /** Calls per server name (for example from the audit log). Optional tie-break signal. */
  usage?: Readonly<Record<string, number>>;
}

/** Field weights: where a term appears says how much it should count. */
export const FIELD_WEIGHTS = {
  name: 3,
  keyword: 3,
  toolName: 2,
  description: 1.5,
  toolDescription: 0.7,
} as const;

const K1 = 1.2;
const B = 0.6;
/** Aliased and secondary query terms count for less than what the user literally wrote. */
const ALIAS_WEIGHT = 0.5;
const EXACT_TOOL_BONUS = 6;
const PARTIAL_TOOL_BONUS = 2;
const KEYWORD_PHRASE_BONUS = 1.5;
/** At most this much of a score can come from the usage signal (a multiplier of 1 + x). */
const MAX_USAGE_BOOST = 0.12;

const STOP_WORDS = new Set([
  "a", "an", "the", "to", "for", "of", "in", "on", "at", "by", "and", "or", "my", "me", "our", "is",
  "are", "was", "it", "its", "this", "that", "these", "those", "with", "from", "as", "be", "do",
  "does", "i", "we", "you", "your", "can", "could", "would", "should", "please", "then", "so", "up",
  "about", "any", "some", "all", "what", "which", "who", "how", "when", "where", "there", "has", "have",
]);

const WORD_RE = /[\p{L}\p{N}]+/gu;

/** Normalized terms of a text: stemmed words, plus the parts of camelCase words. */
export function analyzeTerms(text: string): string[] {
  const terms: string[] = [];
  for (const raw of text.match(WORD_RE) ?? []) {
    const parts = splitCompounds(raw).split(/\s+/).filter(Boolean);
    terms.push(normalizeWord(raw));
    if (parts.length > 1) for (const part of parts) terms.push(normalizeWord(part));
  }
  return terms;
}

interface Doc {
  /** Weighted term frequencies. */
  tf: Map<string, number>;
  length: number;
  /** Tool name as a space-joined, lowercased word sequence (for phrase matching) → original name. */
  toolPhrases: Array<{ name: string; words: string[]; phrase: string }>;
  keywordPhrases: string[][];
}

function addField(tf: Map<string, number>, text: string, weight: number): number {
  let length = 0;
  for (const term of analyzeTerms(text)) {
    if (term.length < 2) continue;
    tf.set(term, (tf.get(term) ?? 0) + weight);
    length += weight;
  }
  return length;
}

function buildDoc(entry: DiscoveryEntry): Doc {
  const tf = new Map<string, number>();
  let length = 0;
  length += addField(tf, entry.name, FIELD_WEIGHTS.name);
  for (const keyword of entry.keywords) length += addField(tf, keyword, FIELD_WEIGHTS.keyword);
  length += addField(tf, entry.description, FIELD_WEIGHTS.description);
  const toolPhrases: Doc["toolPhrases"] = [];
  for (const tool of entry.tools) {
    length += addField(tf, tool.name, FIELD_WEIGHTS.toolName);
    length += addField(tf, tool.description, FIELD_WEIGHTS.toolDescription);
    const words = splitCompounds(tool.name)
      .toLowerCase()
      .match(WORD_RE)
      ?.map(stem) ?? [];
    if (words.length) toolPhrases.push({ name: tool.name, words, phrase: ` ${words.join(" ")} ` });
  }
  const keywordPhrases = entry.keywords
    .map((keyword) => analyzeTerms(keyword))
    .filter((terms) => terms.length > 1);
  return { tf, length: Math.max(1, length), toolPhrases, keywordPhrases };
}

interface CachedDoc {
  sources: readonly object[];
  doc: Doc;
}

export class DiscoveryRanker {
  private readonly docs = new Map<string, CachedDoc>();
  private stats?: { signature: string; idf: Map<string, number>; avgLength: number; docCount: number };

  /** Rank entries against a query; entries with no evidence are omitted. Sorted best first. */
  search(query: string, entries: DiscoveryEntry[], options: DiscoveryOptions = {}): DiscoveryHit[] {
    if (entries.length === 0) return [];
    const docs = entries.map((entry) => this.docFor(entry));
    const stats = this.statsFor(entries, docs);

    const queryTerms = this.queryTerms(query);
    if (queryTerms.size === 0 && !query.trim()) return [];

    // Tool-name matching uses the unfiltered word sequence of the query.
    const queryWords = splitCompounds(query).toLowerCase().match(WORD_RE)?.map(stem) ?? [];
    const queryPhrase = ` ${queryWords.join(" ")} ` ;
    const queryWordSet = new Set(queryWords);
    const queryPhrases = [queryPhrase];
    // A raw identifier ("createJiraIssue", "create_pull_request") is the same word sequence once split.
    for (const token of query.match(/[\p{L}\p{N}_-]+/gu) ?? []) {
      const words = splitCompounds(token).toLowerCase().match(WORD_RE)?.map(stem) ?? [];
      if (words.length > 1) queryPhrases.push(` ${words.join(" ")} `);
    }

    const hits: DiscoveryHit[] = [];
    for (let i = 0; i < entries.length; i++) {
      const doc = docs[i]!;
      let relevance = 0;
      for (const [term, weight] of queryTerms) {
        const tf = doc.tf.get(term);
        if (!tf) continue;
        const idf = stats.idf.get(term) ?? 0;
        const norm = tf + K1 * (1 - B + (B * doc.length) / stats.avgLength);
        relevance += weight * idf * ((tf * (K1 + 1)) / norm);
      }

      const toolMatches: string[] = [];
      let exactTool = false;
      for (const tool of doc.toolPhrases) {
        const multiWord = tool.words.length > 1;
        if (multiWord && queryPhrases.some((phrase) => phrase.includes(tool.phrase))) {
          exactTool = true;
          relevance += EXACT_TOOL_BONUS;
          toolMatches.unshift(tool.name);
        } else if (multiWord && tool.words.every((word) => queryWordSet.has(word))) {
          relevance += PARTIAL_TOOL_BONUS;
          toolMatches.push(tool.name);
        } else if (!multiWord && queryWordSet.has(tool.words[0]!) && queryWords.length === 1) {
          // The whole query is one bare tool name ("aggregate", "plan").
          relevance += PARTIAL_TOOL_BONUS;
          toolMatches.push(tool.name);
        }
      }

      for (const keyword of doc.keywordPhrases) {
        if (containsSequence(queryWords, keyword)) relevance += KEYWORD_PHRASE_BONUS;
      }

      if (relevance <= 0) continue;
      const calls = options.usage?.[entries[i]!.name] ?? 0;
      if (calls > 0) relevance *= 1 + Math.min(MAX_USAGE_BOOST, 0.02 * Math.log1p(calls));
      hits.push({ name: entries[i]!.name, relevance, toolMatches, exactTool });
    }
    return hits.sort((a, b) => b.relevance - a.relevance || a.name.localeCompare(b.name));
  }

  /** Weighted query terms: what was typed (1), plus aliases of it (reduced). */
  private queryTerms(query: string): Map<string, number> {
    const terms = new Map<string, number>();
    const bump = (term: string, weight: number): void => {
      if (term.length < 2 || STOP_WORDS.has(term)) return;
      if ((terms.get(term) ?? 0) < weight) terms.set(term, weight);
    };
    const typed = analyzeTerms(query);
    for (const term of typed) bump(term, 1);
    for (const term of typed) for (const alias of aliasesOf(term)) bump(alias, ALIAS_WEIGHT);
    return terms;
  }

  private docFor(entry: DiscoveryEntry): Doc {
    const cached = this.docs.get(entry.name);
    if (cached && sameSources(cached.sources, entry.sources)) return cached.doc;
    const doc = buildDoc(entry);
    this.docs.set(entry.name, { sources: entry.sources, doc });
    this.stats = undefined;
    return doc;
  }

  private statsFor(entries: DiscoveryEntry[], docs: Doc[]) {
    // The corpus is the current entry set; its statistics only change when documents do.
    const signature = entries.map((entry) => entry.name).join("\u0000");
    if (this.stats && this.stats.signature === signature) return this.stats;
    const df = new Map<string, number>();
    let totalLength = 0;
    for (const doc of docs) {
      totalLength += doc.length;
      for (const term of doc.tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
    }
    const docCount = docs.length;
    const idf = new Map<string, number>();
    for (const [term, n] of df) idf.set(term, Math.log(1 + (docCount - n + 0.5) / (n + 0.5)));
    this.stats = { signature, idf, avgLength: totalLength / docCount, docCount };
    return this.stats;
  }
}

function sameSources(a: readonly object[], b: readonly object[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function containsSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * Tools of one server that a query points at, best first. Used to inline signatures in
 * discover_tools and to suggest near-misses for a mistyped tool name. A tool counts when the
 * query overlaps its name (2 points per shared term) and description (1 per shared term) by at
 * least 3 points, so a lone generic word ("get", "list") never selects anything.
 */
export function matchTools(
  query: string,
  tools: ReadonlyArray<{ name: string; description?: string }>,
  limit = 2
): string[] {
  const queryTerms = new Set(analyzeTerms(query).filter((term) => term.length >= 2 && !STOP_WORDS.has(term)));
  if (queryTerms.size === 0) return [];
  const scored: Array<{ name: string; score: number }> = [];
  for (const tool of tools) {
    const nameTerms = new Set(analyzeTerms(tool.name));
    const descTerms = new Set(analyzeTerms(tool.description ?? ""));
    let nameHits = 0;
    for (const term of nameTerms) if (queryTerms.has(term)) nameHits++;
    let descHits = 0;
    for (const term of descTerms) if (!nameTerms.has(term) && queryTerms.has(term) && !STOP_WORDS.has(term)) descHits++;
    const score = 2 * nameHits + descHits;
    if (score >= 3) scored.push({ name: tool.name, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((t) => t.name);
}
