// src/__tests__/broker.test.ts
// Handler tests for createBroker (meta-tools + proxying) using stub dependencies.

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { createBroker, summarizeDescription } from "../broker.js";
import { ToolRouter, type ServerConfig } from "../router.js";
import { SkillRouter } from "../skill-router.js";
import type { ProcessManager, MCPTool } from "../process-manager.js";

const server = (o: Partial<ServerConfig> = {}): ServerConfig => ({
  description: "Test server",
  keywords: [],
  command: "node",
  autoActivate: false,
  ...o,
});

function makeManager() {
  const active = new Map<string, MCPTool[]>();
  const manager = {
    activate: jest.fn(async (name: string, _cfg: ServerConfig) => {
      const tools: MCPTool[] = [{ name: `${name}_tool`, description: "d", inputSchema: {}, serverName: name }];
      active.set(name, tools);
      return tools;
    }),
    deactivate: jest.fn((name: string) => active.delete(name)),
    listActive: jest.fn(() => [...active.keys()]),
    getAllActiveTools: jest.fn(() => [...active.values()].flat()),
    findServerForTool: jest.fn((tool: string) =>
      [...active.entries()].find(([, ts]) => ts.some((t) => t.name === tool))?.[0]
    ),
    callTool: jest.fn(async (_s: string, _t: string, _a: Record<string, unknown>) => ({
      content: [{ type: "text", text: "called" }],
    })),
  };
  return { manager, active };
}

const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

describe("createBroker", () => {
  let router: ToolRouter;
  let mk: ReturnType<typeof makeManager>;
  let broker: ReturnType<typeof createBroker>;

  beforeEach(() => {
    router = new ToolRouter({
      github: server({ description: "GitHub repositories and issues", keywords: ["github", "issue"] }),
      postgres: server({ description: "PostgreSQL queries", keywords: ["postgres", "sql"] }),
    });
    mk = makeManager();
    broker = createBroker({
      router,
      manager: mk.manager as unknown as ProcessManager,
      skillRouter: null,
    });
  });

  it("lists meta-tools only by default (activated tools stay off tools/list)", async () => {
    const names = broker.listTools().tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "discover_tools",
        "activate_server",
        "describe_tool",
        "call_tool",
        "discover_skill",
        "load_skill",
      ])
    );
    expect(names).not.toContain("connect_server");
    expect(names).not.toContain("disconnect_server");
    expect(names).toContain("read_skill_file");
    expect(names).toHaveLength(9);

    await broker.callTool("activate_server", { server_name: "github" });
    expect(broker.listTools().tools).toHaveLength(9);
    expect(broker.listTools().tools.map((t) => t.name)).not.toContain("github_tool");
  });

  it("merges activated tools into tools/list when expose is all or an allowlist", async () => {
    router = new ToolRouter({
      github: server({
        description: "GitHub repositories and issues",
        keywords: ["github", "issue"],
        expose: "all",
      }),
    });
    broker = createBroker({
      router,
      manager: mk.manager as unknown as ProcessManager,
      skillRouter: null,
    });
    mk.manager.activate.mockImplementationOnce(async (name: string) => {
      const tools: MCPTool[] = [
        { name: "github_tool", description: "d", inputSchema: {}, serverName: name },
        { name: "other_tool", description: "o", inputSchema: {}, serverName: name },
      ];
      mk.active.set(name, tools);
      return tools;
    });
    await broker.callTool("activate_server", { server_name: "github" });
    const all = broker.listTools().tools;
    expect(all.map((t) => t.name)).toEqual(expect.arrayContaining(["github_tool", "other_tool"]));
    expect(all.find((t) => t.name === "github_tool")!.description).toMatch(/^\[github\]/);

    router = new ToolRouter({
      github: server({ description: "GitHub", keywords: ["github"], expose: ["github_tool"] }),
    });
    mk.active.set("github", [
      { name: "github_tool", description: "d", inputSchema: {}, serverName: "github" },
      { name: "other_tool", description: "o", inputSchema: {}, serverName: "github" },
    ]);
    broker = createBroker({
      router,
      manager: mk.manager as unknown as ProcessManager,
      skillRouter: null,
    });
    const listed = broker.listTools().tools.map((t) => t.name);
    expect(listed).toContain("github_tool");
    expect(listed).not.toContain("other_tool");
  });

  it("hides connect_server / disconnect_server unless access.connect is set", () => {
    expect(broker.listTools().tools.map((t) => t.name)).not.toEqual(
      expect.arrayContaining(["connect_server", "disconnect_server"])
    );

    const withGateway = createBroker({
      router,
      manager: mk.manager as unknown as ProcessManager,
      skillRouter: null,
      access: {
        canUse: () => true,
        prepare: () => undefined,
        connect: async () => "ok",
        disconnect: async () => "ok",
      },
    });
    const names = withGateway.listTools().tools.map((t) => t.name);
    expect(names).toContain("connect_server");
    expect(names).toContain("disconnect_server");
    expect(names).toHaveLength(11);
  });

  describe("argument validation", () => {
    it.each([
      ["discover_tools", {}],
      ["discover_tools", { query: 5 }],
      ["activate_server", undefined],
      ["deactivate_server", { server_name: "" }],
    ])("%s rejects bad args with isError instead of throwing", async (name, args) => {
      const r = await broker.callTool(name, args as Record<string, unknown> | undefined);
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/Invalid arguments/);
    });
  });

  describe("discover_tools", () => {
    it("ranks servers and marks active state", async () => {
      await broker.callTool("activate_server", { server_name: "github" });
      const r = await broker.callTool("discover_tools", { query: "list github issues" });
      expect(r.isError).toBeUndefined();
      expect(text(r)).toContain("✓ active | github");
      expect(text(r)).not.toContain("postgres");
    });

    it("shows description matches when score meets the minimum", async () => {
      // Two description words (≥ DISCOVER_MIN_SCORE) — a single word alone is too weak.
      // "issues" also hits the github keyword, so the line may include keywords + description.
      const r = await broker.callTool("discover_tools", { query: "repositories issues" });
      expect(text(r)).toMatch(/description:.*repositories/);
      expect(text(r)).toContain("github");
    });

    it("on zero matches lists names only (no descriptions)", async () => {
      const r = await broker.callTool("discover_tools", { query: "zzz_unrelated" });
      expect(text(r)).toMatch(/No matching servers/);
      expect(text(r)).toContain("• github");
      expect(text(r)).toContain("• postgres");
      expect(text(r)).not.toContain("GitHub repositories");
      expect(text(r)).not.toContain("PostgreSQL queries");
    });

    it("caps results at DISCOVER_TOP_K", async () => {
      const many: Record<string, ReturnType<typeof server>> = {};
      for (let i = 0; i < 8; i++) {
        many[`s${i}`] = server({ description: "shared topic", keywords: ["alpha"] });
      }
      router = new ToolRouter(many);
      broker = createBroker({ router, manager: mk.manager as unknown as ProcessManager, skillRouter: null });
      const r = await broker.callTool("discover_tools", { query: "alpha" });
      const hits = [...text(r).matchAll(/\| s\d+ \(score:/g)];
      expect(hits).toHaveLength(5);
    });

    it("does not route 'digital' or 'prompt' to a server with keywords 'git'/'pr'", async () => {
      router = new ToolRouter({ gh: server({ description: "Code hosting", keywords: ["git", "pr"] }) });
      broker = createBroker({ router, manager: mk.manager as unknown as ProcessManager, skillRouter: null });
      const r = await broker.callTool("discover_tools", { query: "improve the prompt for a digital app" });
      expect(text(r)).toMatch(/No matching servers/);
    });

    it("reports an empty registry helpfully", async () => {
      router = new ToolRouter({});
      broker = createBroker({ router, manager: mk.manager as unknown as ProcessManager, skillRouter: null });
      const r = await broker.callTool("discover_tools", { query: "anything" });
      expect(text(r)).toMatch(/none configured/);
    });
  });

  describe("activate / deactivate", () => {
    it("activates a known server", async () => {
      const r = await broker.callTool("activate_server", { server_name: "github" });
      expect(text(r)).toMatch(/Activated "github" with 1 tools/);
      expect(text(r)).toMatch(/describe_tool|call_tool/);
    });

    it("lists only the first sentence of each tool description on activation", async () => {
      const long =
        "Generate a plan and open an investigation.\n\nUSE WHEN: the request is to debug.\nRULES:\n1. " + "x".repeat(2000);
      mk.manager.activate.mockResolvedValueOnce([
        { name: "investigate", description: long, inputSchema: {}, serverName: "github" },
      ]);
      const r = await broker.callTool("activate_server", { server_name: "github" });
      expect(text(r)).toContain("• investigate: Generate a plan and open an investigation.");
      expect(text(r)).not.toContain("USE WHEN");
      expect(text(r).length).toBeLessThan(400);
    });

    it("lists names only for servers with many tools", async () => {
      const many = Array.from({ length: 31 }, (_, i) => ({
        name: `tool_${i}`,
        description: "Does a thing. With lots of detail that should not be repeated.",
        inputSchema: {},
        serverName: "github",
      }));
      mk.manager.activate.mockResolvedValueOnce(many);
      const r = await broker.callTool("activate_server", { server_name: "github" });
      expect(text(r)).toMatch(/with 31 tools \(names only/);
      expect(text(r)).toContain("tool_0, tool_1");
      expect(text(r)).not.toContain("Does a thing");
      expect(text(r).length).toBeLessThan(500);
    });

    it("flags unknown servers as errors", async () => {
      const r = await broker.callTool("activate_server", { server_name: "nope" });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/Unknown server/);
    });

    it("flags activation failures as errors", async () => {
      mk.manager.activate.mockRejectedValueOnce(new Error("spawn ENOENT"));
      const r = await broker.callTool("activate_server", { server_name: "github" });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/Failed to activate "github": spawn ENOENT/);
    });

    it("deactivate reports unknown / inactive servers as errors", async () => {
      const r = await broker.callTool("deactivate_server", { server_name: "github" });
      expect(r.isError).toBe(true);
      await broker.callTool("activate_server", { server_name: "github" });
      const ok = await broker.callTool("deactivate_server", { server_name: "github" });
      expect(ok.isError).toBeUndefined();
      expect(text(ok)).toBe('Deactivated "github"');
    });
  });

  describe("list_active_servers", () => {
    it("handles none and some", async () => {
      expect(text(await broker.callTool("list_active_servers", {}))).toBe("No servers currently active.");
      await broker.callTool("activate_server", { server_name: "github" });
      expect(text(await broker.callTool("list_active_servers", {}))).toContain("github_tool");
    });
  });

  describe("describe_tool / call_tool", () => {
    it("describe_tool returns one tool schema and activates if needed", async () => {
      const r = await broker.callTool("describe_tool", { server: "github", tool: "github_tool" });
      expect(r.isError).toBeUndefined();
      expect(mk.manager.activate).toHaveBeenCalledWith("github", expect.anything(), undefined);
      const body = JSON.parse(text(r));
      expect(body).toEqual({
        name: "github_tool",
        description: "d",
        inputSchema: {},
      });
    });

    it("describe_tool rejects unknown tools and bad args", async () => {
      await broker.callTool("activate_server", { server_name: "github" });
      const missing = await broker.callTool("describe_tool", { server: "github", tool: "nope" });
      expect(missing.isError).toBe(true);
      expect(text(missing)).toMatch(/not found/);
      const bad = await broker.callTool("describe_tool", { server: "github" });
      expect(bad.isError).toBe(true);
      expect(text(bad)).toMatch(/Invalid arguments/);
    });

    it("call_tool proxies without merging schemas into tools/list", async () => {
      const r = await broker.callTool("call_tool", {
        server: "github",
        tool: "github_tool",
        args: { a: 1 },
      });
      expect(text(r)).toBe("called");
      expect(mk.manager.callTool).toHaveBeenCalledWith("github", "github_tool", { a: 1 });
      expect(broker.listTools().tools.map((t) => t.name)).not.toContain("github_tool");
    });

    it("call_tool defaults args to {} and surfaces proxy errors", async () => {
      await broker.callTool("activate_server", { server_name: "github" });
      expect(text(await broker.callTool("call_tool", { server: "github", tool: "github_tool" }))).toBe(
        "called"
      );
      expect(mk.manager.callTool).toHaveBeenCalledWith("github", "github_tool", {});
      mk.manager.callTool.mockRejectedValueOnce(new Error("timed out"));
      const err = await broker.callTool("call_tool", { server: "github", tool: "github_tool", args: {} });
      expect(err.isError).toBe(true);
      expect(text(err)).toMatch(/Error calling github_tool: timed out/);
    });

    it("describe_tool / call_tool accept bare names when tools are namespaced", async () => {
      router = new ToolRouter({
        github: server({
          description: "GitHub",
          keywords: ["github"],
          namespaceTools: true,
          expose: "all",
        }),
      });
      mk.manager.activate.mockImplementation(async (name: string) => {
        const tools: MCPTool[] = [
          { name: `${name}__search`, description: "d", inputSchema: {}, serverName: name },
        ];
        mk.active.set(name, tools);
        return tools;
      });
      broker = createBroker({
        router,
        manager: mk.manager as unknown as ProcessManager,
        skillRouter: null,
      });

      const desc = await broker.callTool("describe_tool", { server: "github", tool: "search" });
      expect(JSON.parse(text(desc)).name).toBe("github__search");
      expect(broker.listTools().tools.map((t) => t.name)).toContain("github__search");

      const call = await broker.callTool("call_tool", { server: "github", tool: "search", args: {} });
      expect(text(call)).toBe("called");
      expect(mk.manager.callTool).toHaveBeenCalledWith("github", "search", {});
    });
  });

  describe("proxying", () => {
    it("forwards calls for active tools", async () => {
      await broker.callTool("activate_server", { server_name: "github" });
      const r = await broker.callTool("github_tool", { a: 1 });
      expect(text(r)).toBe("called");
      expect(mk.manager.callTool).toHaveBeenCalledWith("github", "github_tool", { a: 1 });
    });

    it("returns isError when the proxied call throws", async () => {
      await broker.callTool("activate_server", { server_name: "github" });
      mk.manager.callTool.mockRejectedValueOnce(new Error("timed out"));
      const r = await broker.callTool("github_tool", {});
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/Error calling github_tool: timed out/);
    });

    it("auto-activates the best match for an unknown tool name", async () => {
      // 'github_tool' tokenises to github + tool → matches the github server
      const r = await broker.callTool("github_tool", {});
      expect(text(r)).toBe("called");
      expect(mk.manager.activate).toHaveBeenCalledWith("github", expect.anything(), undefined);
    });

    it("prefers an exact ToolIndex hit over a higher lexical score", async () => {
      const { ToolIndex } = await import("../tool-index.js");
      const idx = new ToolIndex();
      const gh = server({ description: "GitHub repositories and issues", keywords: ["github", "issue"] });
      const jira = server({
        description: "Jira issue tracker",
        keywords: ["jira", "issue", "ticket"],
        command: "npx",
        args: ["jira"],
      });
      idx.record("jira", jira, [{ name: "create_issue", description: "Create a Jira issue" }]);
      // github also scores on "issue" but does not index create_issue
      router = new ToolRouter({ github: gh, jira }, undefined, idx);
      broker = createBroker({ router, manager: mk.manager as unknown as ProcessManager, skillRouter: null });

      mk.manager.activate.mockImplementation(async (name: string) => {
        const tools =
          name === "jira"
            ? [{ name: "create_issue", description: "d", inputSchema: {}, serverName: name }]
            : [{ name: `${name}_tool`, description: "d", inputSchema: {}, serverName: name }];
        mk.active.set(name, tools);
        return tools;
      });

      const r = await broker.callTool("create_issue", {});
      expect(r.isError).toBeUndefined();
      expect(mk.manager.activate).toHaveBeenCalledWith("jira", expect.anything(), undefined);
      expect(mk.manager.activate.mock.calls[0][0]).toBe("jira");
    });

    it("deactivates a wrong auto-activated server and tries the next candidate", async () => {
      // Both score on "issue"; first candidate (github) exposes github_tool only.
      mk.manager.activate.mockImplementation(async (name: string) => {
        const tools =
          name === "jira"
            ? [{ name: "create_issue", description: "d", inputSchema: {}, serverName: name }]
            : [{ name: "github_tool", description: "d", inputSchema: {}, serverName: name }];
        mk.active.set(name, tools);
        return tools;
      });
      router = new ToolRouter({
        github: server({ description: "GitHub issues", keywords: ["github", "issue", "create"] }),
        jira: server({ description: "Jira issues", keywords: ["jira", "issue", "create"] }),
      });
      broker = createBroker({ router, manager: mk.manager as unknown as ProcessManager, skillRouter: null });

      const r = await broker.callTool("create_issue", {});
      expect(text(r)).toBe("called");
      expect(mk.manager.activate.mock.calls.map((c) => c[0])).toEqual(["github", "jira"]);
      expect(mk.manager.deactivate).toHaveBeenCalledWith("github");
      expect(mk.active.has("github")).toBe(false);
      expect(mk.active.has("jira")).toBe(true);
    });

    it("turns auto-activation failures into tool errors instead of throwing", async () => {
      mk.manager.activate.mockRejectedValueOnce(new Error("boom"));
      const r = await broker.callTool("github_tool", {});
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/auto-activating candidates failed: boom/);
    });

    it("reports truly unknown tools as errors", async () => {
      const r = await broker.callTool("zzz_unknown", {});
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/not found/);
    });
  });

  describe("skills", () => {
    it("reports a missing registry as an error", async () => {
      expect((await broker.callTool("discover_skill", { query: "x" })).isError).toBe(true);
      expect((await broker.callTool("load_skill", { skill_name: "x" })).isError).toBe(true);
    });

    it("discovers and loads skills", async () => {
      const { mkdtempSync, mkdirSync, writeFileSync } = await import("fs");
      const { tmpdir } = await import("os");
      const { join } = await import("path");
      const dir = mkdtempSync(join(tmpdir(), "cb-skill-"));
      writeFileSync(join(dir, "SKILL.md"), "---\n---\n");
      writeFileSync(join(dir, "INSTRUCTIONS.md"), "Do the thing");
      mkdirSync(join(dir, "scripts"), { recursive: true });
      writeFileSync(join(dir, "scripts", "run.sh"), "#!/bin/sh\necho hi\n");

      const skills = new SkillRouter({
        pdf: { description: "Work with PDF files", keywords: ["pdf"], path: join(dir, "SKILL.md") },
        docx: { description: "Word documents", keywords: ["docx"], path: join(dir, "SKILL.md") },
      });
      broker = createBroker({ router, manager: mk.manager as unknown as ProcessManager, skillRouter: skills });

      const d = await broker.callTool("discover_skill", { query: "merge a pdf" });
      expect(text(d)).toMatch(/pdf \(score: 3\)/);
      const l = await broker.callTool("load_skill", { skill_name: "pdf" });
      expect(text(l)).toContain("# Skill: pdf");
      expect(text(l)).toContain("Do the thing");
      expect(text(l)).toMatch(/Bundled files/);
      expect(text(l)).toContain("skill://pdf/scripts/run.sh");
      const bad = await broker.callTool("load_skill", { skill_name: "nope" });
      expect(bad.isError).toBe(true);

      const read = await broker.callTool("read_skill_file", {
        skill_name: "pdf",
        path: "scripts/run.sh",
      });
      expect(text(read)).toContain("echo hi");
      const viaUri = await broker.callTool("read_skill_file", {
        skill_name: "pdf",
        path: "skill://pdf/INSTRUCTIONS.md",
      });
      expect(text(viaUri)).toContain("Do the thing");
      expect(
        (
          await broker.callTool("read_skill_file", {
            skill_name: "pdf",
            path: "../outside.txt",
          })
        ).isError
      ).toBe(true);

      const none = await broker.callTool("discover_skill", { query: "zzz_unrelated" });
      expect(text(none)).toMatch(/No matching skills/);
      expect(text(none)).toContain("• pdf");
      expect(text(none)).not.toContain("Work with PDF");
    });

    it("truncates oversized skill bodies with a read-more pointer", async () => {
      const { mkdtempSync, writeFileSync } = await import("fs");
      const { tmpdir } = await import("os");
      const { join } = await import("path");
      const dir = mkdtempSync(join(tmpdir(), "cb-skill-big-"));
      const body = "x".repeat(30_000);
      writeFileSync(join(dir, "SKILL.md"), "---\n---\n");
      writeFileSync(join(dir, "INSTRUCTIONS.md"), body);
      const skills = new SkillRouter({
        big: { description: "A large skill", keywords: ["big"], path: join(dir, "SKILL.md") },
      });
      broker = createBroker({ router, manager: mk.manager as unknown as ProcessManager, skillRouter: skills });
      const l = await broker.callTool("load_skill", { skill_name: "big" });
      expect(text(l)).toMatch(/truncated/);
      expect(text(l)).toMatch(/Read more:/);
      expect(text(l).length).toBeLessThan(body.length);
    });

    it("hides skills the caller has not installed when canUseSkill is set", async () => {
      const { mkdtempSync, writeFileSync } = await import("fs");
      const { tmpdir } = await import("os");
      const { join } = await import("path");
      const dir = mkdtempSync(join(tmpdir(), "cb-skill-acl-"));
      writeFileSync(join(dir, "SKILL.md"), "---\n---\n");
      writeFileSync(join(dir, "INSTRUCTIONS.md"), "secret skill");
      const skills = new SkillRouter({
        pdf: { description: "Work with PDF files", keywords: ["pdf"], path: join(dir, "SKILL.md") },
      });
      broker = createBroker({
        router,
        manager: mk.manager as unknown as ProcessManager,
        skillRouter: skills,
        access: {
          canUse: () => true,
          canUseSkill: () => false,
          prepare: () => undefined,
        },
      });
      const d = await broker.callTool("discover_skill", { query: "pdf" });
      expect(text(d)).toMatch(/none installed/i);
      expect((await broker.callTool("load_skill", { skill_name: "pdf" })).isError).toBe(true);
    });
  });
});

describe("summarizeDescription", () => {
  it("takes the first sentence and collapses whitespace", () => {
    expect(summarizeDescription("Search code.  Returns\nchunks. More text.")).toBe("Search code.");
  });
  it("stops at a blank line when there is no full stop", () => {
    expect(summarizeDescription("List all services\n\nUSE WHEN: x")).toBe("List all services");
  });
  it("does not split on e.g. / i.e.", () => {
    expect(summarizeDescription("Find a thing (e.g. a file) by name. Extra.")).toBe("Find a thing (e.g. a file) by name.");
  });
  it("caps long sentences with an ellipsis", () => {
    const out = summarizeDescription("a".repeat(500));
    expect(out).toHaveLength(160);
    expect(out.endsWith("…")).toBe(true);
  });
  it("handles missing descriptions", () => {
    expect(summarizeDescription(undefined)).toBe("");
  });
});
