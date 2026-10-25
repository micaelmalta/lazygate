// src/__tests__/config.test.ts
// Config validation, scoring semantics, and on-disk reload behaviour.

import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseServersConfig, parseSkillsConfig } from "../config.js";
import { scoreEntry, tokenize } from "../scoring.js";
import { ToolRouter, effectiveAuthScope, sharedScopeMultiGroup } from "../router.js";
import { SkillRouter } from "../skill-router.js";

describe("parseServersConfig", () => {
  it("applies defaults and keeps valid entries", () => {
    const { entries, errors } = parseServersConfig({ servers: { a: { command: "node" } } });
    expect(errors).toEqual([]);
    expect(entries.a).toMatchObject({ command: "node", keywords: [], description: "", autoActivate: false });
  });

  it("names the offending entry and keeps the good ones", () => {
    const { entries, errors } = parseServersConfig(
      {
        servers: {
          good: { command: "node", keywords: ["x"] },
          noTransport: { description: "x" },
          badKeywords: { command: "node", keywords: "oops" },
          badOauth: { type: "http", url: "https://x.example/mcp", oauth: { callbackPort: "nope" } },
        },
      },
      "servers.json"
    );
    expect(Object.keys(entries)).toEqual(["good"]);
    expect(errors).toHaveLength(3);
    expect(errors.join("\n")).toMatch(/servers\.noTransport — .*command.*url/);
    expect(errors.join("\n")).toMatch(/servers\.badKeywords — keywords/);
    expect(errors.join("\n")).toMatch(/servers\.badOauth/);
  });

  it("accepts oauth as boolean or object, and unknown extra fields", () => {
    const { entries, errors } = parseServersConfig({
      servers: {
        a: { url: "https://x.example/mcp", type: "http", oauth: true },
        b: { url: "https://x.example/mcp", type: "http", oauth: { clientId: "c", callbackPort: 3118 } },
        c: { command: "node", somethingNew: 1 },
      },
    });
    expect(errors).toEqual([]);
    expect(Object.keys(entries)).toEqual(["a", "b", "c"]);
  });

  it("accepts local: true for gateway-hidden desktop servers", () => {
    const { entries, errors } = parseServersConfig({
      servers: { desktop: { command: "fs-mcp", local: true, description: "local files" } },
    });
    expect(errors).toEqual([]);
    expect(entries.desktop.local).toBe(true);
  });

  it("accepts expose as none, all, or a tool-name allowlist", () => {
    const { entries, errors } = parseServersConfig({
      servers: {
        a: { command: "node", expose: "none" },
        b: { command: "node", expose: "all" },
        c: { command: "node", expose: ["search", "get"] },
      },
    });
    expect(errors).toEqual([]);
    expect(entries.a.expose).toBe("none");
    expect(entries.b.expose).toBe("all");
    expect(entries.c.expose).toEqual(["search", "get"]);
  });

  it("accepts namespaceTools boolean", () => {
    const { entries, errors } = parseServersConfig({
      servers: {
        a: { command: "node", namespaceTools: true },
        b: { command: "node", namespaceTools: false },
        c: { command: "node" },
      },
    });
    expect(errors).toEqual([]);
    expect(entries.a.namespaceTools).toBe(true);
    expect(entries.b.namespaceTools).toBe(false);
    expect(entries.c.namespaceTools).toBeUndefined();
  });

  it("defaults HTTP auth scope to user and stdio to server", () => {
    const { entries } = parseServersConfig({
      servers: {
        http: { url: "https://x.example/mcp", type: "http", oauth: true },
        httpShared: { url: "https://x.example/mcp", type: "http", oauth: true, auth: { scope: "server" } },
        stdio: { command: "node" },
        stdioUser: { command: "node", auth: { scope: "user" } },
      },
    });
    expect(effectiveAuthScope(entries.http)).toBe("user");
    expect(effectiveAuthScope(entries.httpShared)).toBe("server");
    expect(effectiveAuthScope(entries.stdio)).toBe("server");
    expect(effectiveAuthScope(entries.stdioUser)).toBe("user");
  });

  it("flags shared-scope HTTP servers visible to more than one group", () => {
    const base = { url: "https://x.example/mcp", type: "http" as const, oauth: true, auth: { scope: "server" as const } };
    expect(sharedScopeMultiGroup({ ...base, description: "", keywords: [], autoActivate: false })).toBe(true);
    expect(
      sharedScopeMultiGroup({ ...base, description: "", keywords: [], autoActivate: false, groups: ["eng", "sre"] })
    ).toBe(true);
    expect(
      sharedScopeMultiGroup({ ...base, description: "", keywords: [], autoActivate: false, groups: ["eng"] })
    ).toBe(false);
    expect(
      sharedScopeMultiGroup({
        description: "",
        keywords: [],
        autoActivate: false,
        url: "https://x.example/mcp",
        type: "http",
        oauth: true,
      })
    ).toBe(false);
  });

  it("throws on structurally invalid files", () => {
    expect(() => parseServersConfig(null)).toThrow(/JSON object/);
    expect(() => parseServersConfig({ servers: [] })).toThrow(/keyed by name/);
  });

  it("treats a missing servers key as empty", () => {
    expect(parseServersConfig({}).entries).toEqual({});
  });
});

describe("parseSkillsConfig", () => {
  it("requires a path", () => {
    const { entries, errors } = parseSkillsConfig({ skills: { ok: { path: "/x/SKILL.md" }, bad: { description: "x" } } });
    expect(Object.keys(entries)).toEqual(["ok"]);
    expect(errors[0]).toMatch(/skills\.bad — path/);
  });
});

describe("scoring", () => {
  it("matches whole words only", () => {
    expect(scoreEntry("a digital prompt", { keywords: ["git", "pr"] }).score).toBe(0);
    expect(scoreEntry("open a git pr", { keywords: ["git", "pr"] }).score).toBe(4);
  });

  it("ignores punctuation", () => {
    const e = { description: "Manage repositories and issues", keywords: [] };
    expect(scoreEntry("list repositories,", e).score).toBe(1);
    expect(scoreEntry("list repositories", e).score).toBe(1);
  });

  it("matches multi-word keywords as phrases", () => {
    const e = { keywords: ["pull request"] };
    expect(scoreEntry("review this pull request", e).keywords).toEqual(["pull request"]);
    expect(scoreEntry("pull the request", e).keywords).toEqual([]);
  });

  it("handles simple plurals on both sides", () => {
    expect(scoreEntry("show my issues", { keywords: ["issue"] }).score).toBe(2);
    expect(scoreEntry("show my issue", { keywords: ["issues"] }).score).toBe(2);
  });

  it("reports description matches separately and counts each word once", () => {
    const r = scoreEntry("search repositories", {
      description: "repositories repositories everywhere",
      keywords: ["search"],
    });
    expect(r.keywords).toEqual(["search"]);
    expect(r.descriptionWords).toEqual(["repositories"]);
    expect(r.score).toBe(3);
  });

  it("splits camelCase and snake_case tool names", () => {
    expect(tokenize("createJiraIssue")).toEqual(["create", "jira", "issue"]);
    expect(tokenize("create_jira_issue")).toEqual(["create", "jira", "issue"]);
    expect(scoreEntry("createJiraIssue", { keywords: ["jira"] }).score).toBe(2);
  });

  it("matches short catalog words of length 3+", () => {
    for (const w of ["jira", "repo", "sql", "logs", "docs"]) {
      expect(scoreEntry(w, { description: `Work with ${w} daily` }).score).toBeGreaterThan(0);
    }
  });

  it("matches aliases (ticket↔issue, repo↔github)", () => {
    expect(scoreEntry("open a ticket", { keywords: ["issue"] }).keywords).toEqual(["issue"]);
    expect(scoreEntry("list my repos", { keywords: ["github"] }).keywords).toEqual(["github"]);
  });

  it("tolerates missing fields", () => {
    expect(scoreEntry("x", {}).score).toBe(0);
    expect(tokenize("Hello, World!")).toEqual(["hello", "world"]);
  });
});

describe("reload from disk", () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("ToolRouter picks up edits and keeps the old config on a bad file", () => {
    dir = mkdtempSync(join(tmpdir(), "cb-cfg-"));
    const path = join(dir, "servers.json");
    writeFileSync(path, JSON.stringify({ servers: { a: { command: "node", keywords: ["alpha"] } } }));
    const router = new ToolRouter(parseServersConfig(JSON.parse(JSON.stringify({ servers: { a: { command: "node", keywords: ["alpha"] } } }))).entries, path);

    expect(router.reloadServersFromDisk()).toBe(false); // mtime unchanged

    // mtime granularity can hide a same-millisecond rewrite; force a distinct mtime
    writeFileSync(path, JSON.stringify({ servers: { a: { command: "node" }, b: { command: "node" } } }));
    utimesSync(path, new Date(), new Date(Date.now() + 1000));
    expect(router.reloadServersFromDisk()).toBe(true);
    expect(router.listAll()).toEqual(["a", "b"]);
    expect(router.reloadServersFromDisk()).toBe(false);

    writeFileSync(path, "{ half written");
    utimesSync(path, new Date(), new Date(Date.now() + 2000));
    expect(router.reloadServersFromDisk()).toBe(false);
    expect(router.listAll()).toEqual(["a", "b"]);
  });

  it("SkillRouter reloads skills.json lazily", () => {
    dir = mkdtempSync(join(tmpdir(), "cb-cfg-"));
    const path = join(dir, "skills.json");
    writeFileSync(path, JSON.stringify({ skills: {} }));
    const skills = new SkillRouter({}, path);

    expect(skills.reloadFromDisk()).toBe(false);

    writeFileSync(path, JSON.stringify({ skills: { s: { description: "x", keywords: ["s"], path: "/x/SKILL.md" } } }));
    utimesSync(path, new Date(), new Date(Date.now() + 1000));
    expect(skills.reloadFromDisk()).toBe(true);
    expect(skills.listAll()).toEqual(["s"]);
    expect(skills.reloadFromDisk()).toBe(false);

    writeFileSync(path, "");
    utimesSync(path, new Date(), new Date(Date.now() + 2000));
    expect(skills.reloadFromDisk()).toBe(false);
    expect(skills.listAll()).toEqual(["s"]);
  });
});
