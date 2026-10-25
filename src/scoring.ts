// src/scoring.ts
// Shared query → entry scoring used by ToolRouter and SkillRouter.
// Matching is token based (whole words, light plural stemming) so that short
// keywords such as "git" or "pr" do not fire on "digital" or "prompt".

export interface Scorable {
  description?: string;
  keywords?: string[];
  /** Tool names + descriptions learned from the server (see tool-index.ts). */
  toolText?: string;
}

/** Tool-derived matches are weak evidence (common verbs everywhere), so they are capped. */
const MAX_TOOL_SCORE = 2;

/** Minimum length for description/tool-word matches (keywords are unrestricted). */
const MIN_WORD_LEN = 3;

export interface ScoreResult {
  score: number;
  /** Keywords that matched the query. */
  keywords: string[];
  /** Description words (length ≥ 3) that matched the query. */
  descriptionWords: string[];
  /** Words from the server's tool names/descriptions that matched (score capped at 2). */
  toolWords: string[];
}

const TOKEN_RE = /[\p{L}\p{N}]+/gu;

/**
 * Synonyms so common agent phrasing still hits catalog text
 * (ticket↔issue, repo↔github, …). Keys and values are stemmed forms.
 */
const ALIASES: Record<string, readonly string[]> = {
  ticket: ["issue"],
  issue: ["ticket"],
  repo: ["github", "repository"],
  repository: ["repo"],
  github: ["repo"],
  pr: ["pull"],
  pull: ["pr"],
  bug: ["issue", "defect"],
  defect: ["bug", "issue"],
  db: ["database", "sql"],
  database: ["db", "sql"],
  sql: ["database", "db"],
  doc: ["docs", "documentation"],
  docs: ["doc", "documentation"],
  documentation: ["doc", "docs"],
  log: ["logs"],
  logs: ["log"],
};

function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) {
    return word.slice(0, -1);
  }
  return word;
}

/** Insert spaces at camelCase / snake_case / kebab-case boundaries before tokenizing. */
export function splitCompounds(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_-]+/g, " ");
}

/** Tokens after camelCase / snake_case splits (for tool names like createJiraIssue). */
export function tokenize(text: string): string[] {
  return (splitCompounds(text).toLowerCase().match(TOKEN_RE) ?? []).map(stem);
}

/** Whole-word tokens only (keeps brand names like "GitHub" → "github"). */
function tokenizeRaw(text: string): string[] {
  return (text.toLowerCase().match(TOKEN_RE) ?? []).map(stem);
}

function aliasesOf(token: string): string[] {
  return [...(ALIASES[token] ?? [])];
}

/** Query token set expanded with one-hop aliases (split + unsplitted forms). */
function expandQuerySet(queryTokens: string[]): Set<string> {
  const set = new Set(queryTokens);
  for (const t of queryTokens) {
    for (const a of aliasesOf(t)) set.add(a);
  }
  return set;
}

function tokensEqual(a: string, b: string): boolean {
  if (a === b) return true;
  return aliasesOf(a).includes(b) || aliasesOf(b).includes(a);
}

function containsSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (!tokensEqual(haystack[i + j], needle[j])) continue outer;
    }
    return true;
  }
  return false;
}

function keywordMatches(queryTokens: string[], kw: string): boolean {
  // Prefer split tokens so createJiraIssue↔jira; also try raw so GitHub↔github.
  return (
    containsSequence(queryTokens, tokenize(kw)) || containsSequence(queryTokens, tokenizeRaw(kw))
  );
}

export function scoreEntry(query: string, entry: Scorable): ScoreResult {
  // Query set includes both split and raw forms (createJiraIssue + brand names).
  const queryTokens = tokenize(query);
  const querySet = expandQuerySet([...queryTokens, ...tokenizeRaw(query)]);

  const keywords = (entry.keywords ?? []).filter((kw) => keywordMatches(queryTokens, kw));

  const seen = new Set<string>();
  const descriptionWords: string[] = [];
  // Prefer unsplitted surface forms ("github" not "git"+"hub"); add camelCase parts after.
  const matchWord = (word: string): boolean =>
    querySet.has(word) || aliasesOf(word).some((a) => querySet.has(a));

  for (const raw of (entry.description ?? "").toLowerCase().match(TOKEN_RE) ?? []) {
    if (raw.length < MIN_WORD_LEN) continue;
    const word = stem(raw);
    if (seen.has(word)) continue;
    seen.add(word);
    if (matchWord(word)) descriptionWords.push(raw);
  }
  for (const part of tokenize(entry.description ?? "")) {
    if (part.length < MIN_WORD_LEN || seen.has(part)) continue;
    if (matchWord(part)) {
      seen.add(part);
      descriptionWords.push(part);
    }
  }

  const toolWords: string[] = [];
  if (entry.toolText) {
    const known = new Set([...seen, ...keywords.flatMap((kw) => [...tokenize(kw), ...tokenizeRaw(kw)])]);
    for (const raw of (entry.toolText.toLowerCase().match(TOKEN_RE) ?? [])) {
      if (raw.length < MIN_WORD_LEN) continue;
      const word = stem(raw);
      if (known.has(word)) continue;
      known.add(word);
      if (matchWord(word)) toolWords.push(raw);
    }
    for (const part of tokenize(entry.toolText)) {
      if (part.length < MIN_WORD_LEN || known.has(part)) continue;
      known.add(part);
      if (matchWord(part)) toolWords.push(part);
    }
  }

  return {
    score:
      keywords.length * 2 +
      descriptionWords.length +
      Math.min(toolWords.length, MAX_TOOL_SCORE),
    keywords,
    descriptionWords,
    toolWords,
  };
}
