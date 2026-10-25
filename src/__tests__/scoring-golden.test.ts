// Golden-query recall for the lexical scorer (FEEDBACK 4.2).
// Fixture catalog + queries → expected top server; fails if recall drops.

import { describe, it, expect } from "@jest/globals";
import { scoreEntry, tokenize } from "../scoring.js";
import { ToolRouter, type ServerConfig } from "../router.js";
import { ToolIndex, toolText } from "../tool-index.js";

const server = (o: Partial<ServerConfig> & Pick<ServerConfig, "description" | "keywords">): ServerConfig => ({
  command: "node",
  autoActivate: false,
  ...o,
});

/** Shared catalog shaped like a small gateway install. */
const CATALOG: Record<string, ServerConfig> = {
  github: server({
    description: "GitHub repositories pull requests and code search",
    keywords: ["github", "repo", "pr", "pull request"],
  }),
  jira: server({
    description: "Jira issue tracker for tickets bugs and sprints",
    keywords: ["jira", "ticket", "issue", "bug"],
  }),
  postgres: server({
    description: "PostgreSQL SQL database queries and schemas",
    keywords: ["postgres", "sql", "database", "db"],
  }),
  datadog: server({
    description: "Datadog metrics monitors logs and APM traces",
    keywords: ["datadog", "monitor", "logs", "metrics"],
  }),
  confluence: server({
    description: "Confluence wiki docs and documentation pages",
    keywords: ["confluence", "docs", "wiki", "documentation"],
  }),
  slack: server({
    description: "Slack messaging channels and threads",
    keywords: ["slack", "message", "channel"],
  }),
};

type Golden = { query: string; expect: string };

const GOLDEN: Golden[] = [
  { query: "list github repos", expect: "github" },
  { query: "open a pull request", expect: "github" },
  { query: "createJiraIssue for the bug", expect: "jira" },
  { query: "file a ticket in jira", expect: "jira" },
  { query: "run a sql query", expect: "postgres" },
  { query: "check the database schema", expect: "postgres" },
  { query: "tail the service logs", expect: "datadog" },
  { query: "find the monitor that pages", expect: "datadog" },
  { query: "update the docs page", expect: "confluence" },
  { query: "search confluence documentation", expect: "confluence" },
  { query: "post a slack message", expect: "slack" },
  { query: "search github code repositories", expect: "github" },
];

function topName(query: string, router: ToolRouter): string | undefined {
  return router.rank(query)[0]?.name;
}

describe("golden-query recall", () => {
  const router = new ToolRouter(CATALOG);

  it("hits the expected server for every golden query (recall@1)", () => {
    const misses: string[] = [];
    for (const g of GOLDEN) {
      const got = topName(g.query, router);
      if (got !== g.expect) misses.push(`"${g.query}" → ${got ?? "(none)"} (want ${g.expect})`);
    }
    expect(misses).toEqual([]);
  });

  it("improves recall when tool names are indexed (camelCase / snake_case)", () => {
    const idx = new ToolIndex();
    idx.record("jira", CATALOG.jira, [
      { name: "createJiraIssue", description: "Create a Jira issue from fields" },
    ]);
    idx.record("github", CATALOG.github, [
      { name: "create_pull_request", description: "Open a pull request" },
    ]);
    const withIndex = new ToolRouter(CATALOG, undefined, idx);

    expect(topName("createJiraIssue", withIndex)).toBe("jira");
    expect(topName("create_pull_request", withIndex)).toBe("github");

    // Direct score path: tool text from camelCase name contributes.
    const text = toolText([{ name: "createJiraIssue", description: "Create a Jira issue" }]);
    expect(tokenize(text)).toEqual(expect.arrayContaining(["create", "jira", "issue"]));
    expect(scoreEntry("jira issue", { toolText: text }).score).toBeGreaterThan(0);
  });

  it("reports recall rate for the fixture set", () => {
    let hits = 0;
    for (const g of GOLDEN) {
      if (topName(g.query, router) === g.expect) hits++;
    }
    const recall = hits / GOLDEN.length;
    // Full fixture must stay at 1.0; this assertion documents the metric.
    expect(recall).toBe(1);
    expect(GOLDEN.length).toBeGreaterThanOrEqual(10);
  });
});
