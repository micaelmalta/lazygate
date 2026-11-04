import { describe, it, expect } from "@jest/globals";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { DiscoveryRanker, matchTools, type DiscoveryEntry } from "../discovery.js";
import {
  buildEvalRouter,
  evaluateDiscovery,
  generateDistractorServers,
  loadDiscoveryEvalSet,
} from "../discovery-eval.js";
import { isConfidentMatch } from "../router.js";

const here = dirname(fileURLToPath(import.meta.url));
const set = loadDiscoveryEvalSet(resolve(here, "../../scripts/fixtures/discovery-eval.json"));

function entry(name: string, description: string, keywords: string[], tools: Array<[string, string]> = []): DiscoveryEntry {
  const toolList = tools.map(([toolName, toolDescription]) => ({ name: toolName, description: toolDescription }));
  return { name, description, keywords, tools: toolList, sources: [{}, toolList] };
}

describe("DiscoveryRanker", () => {
  const catalog = [
    entry("github", "GitHub repositories and pull requests", ["github", "pr"], [["create_pull_request", "Open a pull request"]]),
    entry("jira", "Jira issue tracker", ["jira", "ticket"], [["createJiraIssue", "Create an issue"]]),
    entry("postgres", "PostgreSQL databases", ["postgres", "sql"], [["run_query", "Run a SQL query"]]),
  ];

  it("lands an exact tool identifier on the server that owns it", () => {
    const ranker = new DiscoveryRanker();
    for (const [query, owner] of [
      ["create_pull_request", "github"],
      ["createJiraIssue", "jira"],
      ["please run_query on the orders", "postgres"],
    ] as const) {
      const [top] = ranker.search(query, catalog);
      expect(top?.name).toBe(owner);
      expect(top?.exactTool).toBe(true);
      expect(top?.toolMatches.length).toBeGreaterThan(0);
    }
  });

  it("expands aliases and ignores stop words", () => {
    const ranker = new DiscoveryRanker();
    expect(ranker.search("open a PR", catalog)[0]?.name).toBe("github");
    expect(ranker.search("the a of", catalog)).toEqual([]);
  });

  it("weights keywords above descriptions", () => {
    const ranker = new DiscoveryRanker();
    const docs = [
      entry("a", "tracks widgets", ["gadget"]),
      entry("b", "tracks gadget", []),
    ];
    expect(ranker.search("gadget", docs).map((h) => h.name)).toEqual(["a", "b"]);
  });

  it("uses call counts only as a small nudge", () => {
    const ranker = new DiscoveryRanker();
    const twins = [entry("one", "report builder", ["report"]), entry("two", "report builder", ["report"])];
    expect(ranker.search("report", twins, { usage: { two: 50 } })[0]?.name).toBe("two");
    // A heavily used server does not outrank a clearly better match.
    const mixed = [entry("weak", "reports", []), entry("strong", "report builder", ["report", "builder"])];
    expect(ranker.search("report builder", mixed, { usage: { weak: 1_000_000 } })[0]?.name).toBe("strong");
  });

  it("rebuilds a document only when its sources change", () => {
    const ranker = new DiscoveryRanker();
    const sources = [{}, []];
    const first: DiscoveryEntry = { name: "x", description: "alpha", keywords: [], tools: [], sources };
    expect(ranker.search("alpha", [first])).toHaveLength(1);
    // Same sources → cached document, even if the description text passed in differs.
    expect(ranker.search("alpha", [{ ...first, description: "beta" }])).toHaveLength(1);
    expect(ranker.search("alpha", [{ ...first, description: "beta", sources: [{}, []] }])).toHaveLength(0);
  });
});

describe("tool-discovery evaluation set", () => {
  it("is labeled with known servers and covers every category", () => {
    const names = new Set(Object.keys(set.servers));
    expect(set.queries.length).toBeGreaterThanOrEqual(80);
    for (const q of set.queries) expect(names.has(q.expect)).toBe(true);
    expect(new Set(set.queries.map((q) => q.category))).toEqual(
      new Set(["brand", "capability", "tool", "alias", "compound"])
    );
  });

  it("distractor catalogs are deterministic and never contain a labeled answer", () => {
    expect(generateDistractorServers(30)).toEqual(generateDistractorServers(30));
    const distractors = generateDistractorServers(100);
    expect(Object.keys(distractors)).toHaveLength(100);
    for (const name of Object.keys(distractors)) expect(set.servers[name]).toBeUndefined();
  });

  it.each([0, 60, 200])("BM25 beats the lexical scorer with %i distractor servers", (distractors) => {
    const router = buildEvalRouter(set, generateDistractorServers(distractors));
    const lexical = evaluateDiscovery(set, "lexical", { router });
    const bm25 = evaluateDiscovery(set, "bm25", { router });
    expect(bm25.recallAt1).toBeGreaterThan(lexical.recallAt1);
    expect(bm25.recallAt3).toBeGreaterThanOrEqual(lexical.recallAt3);
    expect(bm25.wrongTopRate).toBeLessThan(lexical.wrongTopRate);
    // Floors that fail if ranking quality regresses (measured 0.91 / 0.96 / 0.97 without distractors).
    expect(bm25.recallAt1).toBeGreaterThanOrEqual(0.85);
    expect(bm25.recallAt3).toBeGreaterThanOrEqual(0.92);
    expect(bm25.wrongTopRate).toBeLessThanOrEqual(0.13);
    expect(bm25.byCategory.tool!.recallAt1).toBeGreaterThanOrEqual(0.95);
    expect(bm25.byCategory.brand!.recallAt1).toBe(1);
  });

  it("only shows confident matches", () => {
    const router = buildEvalRouter(set);
    const shown = router.rank("zzzz qqqq nothing").filter(isConfidentMatch);
    expect(shown).toEqual([]);
  });
});

describe("held-out discovery set", () => {
  const heldout = loadDiscoveryEvalSet(resolve(here, "../../scripts/fixtures/discovery-heldout.json"));

  it("is a separate catalog of near-duplicate neighbors with labeled, unseen queries", () => {
    const names = new Set(Object.keys(heldout.servers));
    expect(heldout.queries.length).toBeGreaterThanOrEqual(35);
    for (const q of heldout.queries) expect(names.has(q.expect)).toBe(true);
    // Catalog neighbors that share vocabulary (the point of the set).
    for (const neighbor of ["github", "gitlab", "bitbucket", "mysql", "postgres", "sqlite", "s3", "gcs", "azure-blob"]) {
      expect(names.has(neighbor)).toBe(true);
    }
    const tuned = new Set(set.queries.map((q) => q.query.toLowerCase()));
    for (const q of heldout.queries) expect(tuned.has(q.query.toLowerCase())).toBe(false);
    expect(new Set(heldout.queries.map((q) => q.category)).size).toBeGreaterThanOrEqual(3);
  });

  it("is ranked with the same code and only guarded by loose regression floors", () => {
    const router = buildEvalRouter(heldout, generateDistractorServers(30));
    const bm25 = evaluateDiscovery(heldout, "bm25", { router });
    // Floors far below what the ranker scores: they catch a broken ranker, they are not targets to fit.
    expect(bm25.recallAt1).toBeGreaterThanOrEqual(0.75);
    expect(bm25.recallAt3).toBeGreaterThanOrEqual(0.85);
    expect(bm25.wrongTopRate).toBeLessThanOrEqual(0.15);
  });
});

describe("matchTools", () => {
  const tools = [
    { name: "get_order_status", description: "Get the current status, carrier and history of one order by its id." },
    { name: "list_tickets", description: "List ticket ids, statuses, assignees and points (no body)." },
    { name: "get_ticket", description: "Fetch one ticket's full record, including its long discussion body." },
    { name: "fetch_doc", description: "Fetch a documentation page as HTML." },
  ];

  it("picks tools whose name and description overlap the query, best first", () => {
    expect(matchTools("check the status of an order", tools)).toEqual(["get_order_status"]);
    expect(matchTools("list support tickets and fetch ticket details", tools)).toEqual(["list_tickets", "get_ticket"]);
    expect(matchTools("fetch documentation page", tools)).toEqual(["fetch_doc"]);
  });

  it("returns nothing for a lone generic word or an unrelated query", () => {
    expect(matchTools("get", tools)).toEqual([]);
    expect(matchTools("the a of", tools)).toEqual([]);
    expect(matchTools("book a flight to lisbon", tools)).toEqual([]);
  });

  it("honours the limit", () => {
    expect(matchTools("list support tickets and fetch ticket details", tools, 1)).toEqual(["list_tickets"]);
  });
});
