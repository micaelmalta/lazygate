// src/__tests__/broker.test.ts
// Handler tests for createBroker (meta-tools + proxying) using stub dependencies.

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { createBroker, summarizeDescription } from "../broker.js";
import { ToolRouter, type ServerConfig } from "../router.js";
import { SkillRouter } from "../skill-router.js";
import { ToolIndex } from "../tool-index.js";
import type { ProcessManager, MCPTool } from "../process-manager.js";
import { estimateTokens, parseResponseOptimizationConfig } from "../response-optimizer.js";

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
        "get_result",
        "discover_skill",
        "load_skill",
      ])
    );
    expect(names).not.toContain("connect_server");
    expect(names).not.toContain("disconnect_server");
    expect(names).toContain("read_skill_file");
    expect(names).toContain("run_chain");
    expect(names).toHaveLength(11);

    await broker.callTool("activate_server", { server_name: "github" });
    expect(broker.listTools().tools).toHaveLength(11);
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
    expect(names).toHaveLength(13);
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

    it("names the upstream tool a query matched and points multi-step work at run_chain", async () => {
      const cfg = { description: "Issue tracker", keywords: ["tracker"], command: "node", autoActivate: false, toolChain: true };
      const index = new ToolIndex();
      index.record("tracker", cfg, [{ name: "close_stale_issues", description: "Close issues that have gone quiet" }]);
      router = new ToolRouter({ tracker: server(cfg), wiki: server({ description: "Wiki pages", keywords: ["wiki"] }) }, undefined, index);
      broker = createBroker({ router, manager: mk.manager as unknown as ProcessManager, skillRouter: null, previewOnDiscover: false });
      const r = await broker.callTool("discover_tools", { query: "close_stale_issues now" });
      expect(text(r)).toContain("tracker");
      expect(text(r)).toContain("Likely tools: close_stale_issues");
      expect(text(r)).toContain("run_chain stubs");
      expect(text(r)).not.toContain("wiki");
    });

    describe("inline signatures", () => {
      const orders = server({ description: "Order management", keywords: ["orders"], command: "node" });
      const tools = [
        { name: "get_order_status", description: "Get the current status of one order.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
        { name: "list_orders", description: "List recent orders.", inputSchema: { type: "object", properties: { limit: { type: "integer" } } } },
        { name: "cancel_order", description: "Cancel an order.", inputSchema: { type: "object", properties: { id: { type: "string" }, reason: { type: "string" } }, required: ["id"] } },
        // Enough tools that the server is not "tiny" (a tiny server shows every signature).
        { name: "export_orders", description: "Export orders to a file.", inputSchema: { type: "object", properties: { format: { type: "string" } } } },
        { name: "archive_orders", description: "Archive old orders.", inputSchema: { type: "object", properties: {} } },
      ];
      const build = (opts: { record?: boolean; active?: boolean; preview?: boolean } = {}) => {
        const index = new ToolIndex();
        if (opts.record !== false) index.record("orders", orders, tools);
        router = new ToolRouter(
          { orders, wiki: server({ description: "Wiki pages", keywords: ["wiki"] }) },
          undefined,
          index
        );
        mk = makeManager();
        if (opts.active) mk.active.set("orders", tools.map((t) => ({ ...t, serverName: "orders" })));
        broker = createBroker({
          router,
          manager: mk.manager as unknown as ProcessManager,
          skillRouter: null,
          previewOnDiscover: opts.preview ?? false,
        });
      };

      it("includes the signature of the best-matching tool from the ToolIndex without activating anything", async () => {
        build();
        const r = await broker.callTool("discover_tools", { query: "check the status of an order" });
        expect(text(r)).toContain("Call signatures");
        expect(text(r)).toContain("get_order_status(args: { id: string })");
        expect(text(r)).not.toContain("cancel_order(");
        expect(mk.manager.activate).not.toHaveBeenCalled();
      });

      it("uses the live schema when the server is already active, and bounds the number of signatures", async () => {
        build({ active: true, record: false });
        const r = await broker.callTool("discover_tools", { query: "list orders and cancel order status" });
        const signatures = text(r).split("\n").filter((line) => /^\s+\w+\(args:/.test(line));
        expect(signatures.length).toBeGreaterThan(0);
        expect(signatures.length).toBeLessThanOrEqual(2);
      });

      it("lists every tool of a tiny server, but adds nothing for a larger one when none matches", async () => {
        const tiny = new ToolIndex();
        tiny.record("orders", orders, tools.slice(0, 3));
        router = new ToolRouter({ orders }, undefined, tiny);
        broker = createBroker({ router, manager: mk.manager as unknown as ProcessManager, skillRouter: null, previewOnDiscover: false });
        const small = text(await broker.callTool("discover_tools", { query: "orders" }));
        expect(small).toContain("get_order_status(args: { id: string })");
        expect(small).toContain("cancel_order(");
        build();
        expect(text(await broker.callTool("discover_tools", { query: "orders" }))).not.toContain("Call signatures");
      });

      it("adds nothing when nothing is indexed or the top two servers are tied", async () => {
        build({ record: false });
        expect(text(await broker.callTool("discover_tools", { query: "check the status of an order" }))).not.toContain("Call signatures");
        const twin = server({ description: "Order management", keywords: ["orders"], command: "node" });
        const index = new ToolIndex();
        index.record("orders", orders, tools);
        index.record("orders2", twin, tools);
        router = new ToolRouter({ orders, orders2: twin }, undefined, index);
        broker = createBroker({ router, manager: mk.manager as unknown as ProcessManager, skillRouter: null, previewOnDiscover: false });
        expect(text(await broker.callTool("discover_tools", { query: "check the status of an order" }))).not.toContain("Call signatures");
      });

      describe("preview of the clearly best server", () => {
        it("loads it and shows its signatures even when nothing was indexed yet", async () => {
          const small = server({ description: "Support tickets: list and fetch", keywords: ["tickets", "support"], command: "node", toolChain: true, previewOnDiscover: true });
          router = new ToolRouter({ tickets: small, wiki: server({ description: "Wiki pages", keywords: ["wiki"] }) });
          mk = makeManager();
          mk.manager.activate.mockImplementation(async (name: string) => {
            const t: MCPTool[] = [
              { name: "list_tickets", description: "List tickets", inputSchema: { type: "object", properties: { status: { type: "string" } } }, serverName: name },
              { name: "get_ticket", description: "Fetch one ticket", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, serverName: name },
            ];
            mk.active.set(name, t);
            return t;
          });
          broker = createBroker({ router, manager: mk.manager as unknown as ProcessManager, skillRouter: null });
          const r = await broker.callTool("discover_tools", { query: "open support tickets for ana" });
          expect(mk.manager.activate).toHaveBeenCalledTimes(1);
          expect(text(r)).toContain("Call signatures");
          expect(text(r)).toContain("list_tickets(args: { status?: string })");
          expect(text(r)).toContain("get_ticket(args: { id: string })");
          expect(text(r)).toContain("servers.tickets.<tool>(args)");
          expect(text(r)).not.toContain("run_chain stubs");
          expect(text(r)).not.toContain("Use activate_server");
        });

        it("does not load anything when the match is ambiguous, needs credentials, or uses OAuth", async () => {
          const twin = server({ description: "Order management", keywords: ["orders"], command: "node" });
          mk = makeManager();
          router = new ToolRouter({ orders: orders, orders2: twin });
          broker = createBroker({ router, manager: mk.manager as unknown as ProcessManager, skillRouter: null, previewOnDiscover: true });
          await broker.callTool("discover_tools", { query: "check the status of an order" });
          expect(mk.manager.activate).not.toHaveBeenCalled();

          const oauth = server({ description: "Order management", keywords: ["orders"], type: "http", url: "https://example.test/mcp", oauth: true });
          router = new ToolRouter({ orders: oauth });
          broker = createBroker({ router, manager: mk.manager as unknown as ProcessManager, skillRouter: null, previewOnDiscover: true });
          await broker.callTool("discover_tools", { query: "orders" });
          expect(mk.manager.activate).not.toHaveBeenCalled();

          router = new ToolRouter({ orders });
          broker = createBroker({
            router,
            manager: mk.manager as unknown as ProcessManager,
            skillRouter: null,
            previewOnDiscover: true,
            access: { canUse: () => true, prepare: () => undefined, missing: () => ["API_KEY"] } as never,
          });
          const r = await broker.callTool("discover_tools", { query: "orders" });
          expect(mk.manager.activate).not.toHaveBeenCalled();
          expect(text(r)).toContain("needs credentials");
        });

        it("never starts a server by default, and a server can opt in or out", async () => {
          const mkBroker = (cfg: ReturnType<typeof server>, previewOnDiscover?: boolean) => {
            mk = makeManager();
            router = new ToolRouter({ orders: cfg });
            broker = createBroker({ router, manager: mk.manager as unknown as ProcessManager, skillRouter: null, ...(previewOnDiscover === undefined ? {} : { previewOnDiscover }) });
          };
          mkBroker(server({ description: "Order management", keywords: ["orders"], command: "node" }));
          const cold = text(await broker.callTool("discover_tools", { query: "orders" }));
          expect(mk.manager.activate).not.toHaveBeenCalled();
          expect(cold).toContain("○ inactive | orders");

          mkBroker(server({ description: "Order management", keywords: ["orders"], command: "node", previewOnDiscover: true }));
          await broker.callTool("discover_tools", { query: "orders" });
          expect(mk.manager.activate).toHaveBeenCalledTimes(1);

          mkBroker(server({ description: "Order management", keywords: ["orders"], command: "node", previewOnDiscover: false }), true);
          await broker.callTool("discover_tools", { query: "orders" });
          expect(mk.manager.activate).not.toHaveBeenCalled();
        });

        it("still answers when the preview activation fails", async () => {
          mk = makeManager();
          mk.manager.activate.mockRejectedValue(new Error("spawn failed"));
          router = new ToolRouter({ orders });
          broker = createBroker({ router, manager: mk.manager as unknown as ProcessManager, skillRouter: null, previewOnDiscover: true });
          const r = await broker.callTool("discover_tools", { query: "orders" });
          expect(r.isError).toBeUndefined();
          expect(text(r)).toContain("orders");
          expect(text(r)).not.toContain("Call signatures");
        });
      });
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
      // Without `tool`, describe_tool returns tool-chain stubs; a server without toolChain says so.
      const noStubs = await broker.callTool("describe_tool", { server: "github" });
      expect(noStubs.isError).toBe(true);
      expect(text(noStubs)).toMatch(/not enabled for tool chain/);
      const bad = await broker.callTool("describe_tool", {});
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

    it("applies a configured JSON projection to successful call_tool results and records metrics", async () => {
      const onOptimizationMetrics = jest.fn();
      const responseOptimization = parseResponseOptimizationConfig({
        responseOptimization: {
          enabled: true,
          defaultMode: "off",
          tools: { "github.github_tool": { mode: "project", fields: ["id", "title"] } },
        },
      }).config;
      broker = createBroker({
        router,
        manager: mk.manager as unknown as ProcessManager,
        skillRouter: null,
        responseOptimization,
        onOptimizationMetrics,
      });
      mk.manager.activate.mockImplementationOnce(async (name: string) => {
        const tools: MCPTool[] = [
          {
            name: `${name}_tool`,
            description: "d",
            inputSchema: {},
            serverName: name,
            annotations: { readOnlyHint: true },
          },
        ];
        mk.active.set(name, tools);
        return tools;
      });
      mk.manager.callTool.mockResolvedValueOnce({
        content: [],
        structuredContent: { id: 7, title: "Issue", state: "open", token: "sensitive" },
      } as never);

      const result = await broker.callTool("call_tool", { server: "github", tool: "github_tool", args: {} });

      expect(result.structuredContent).toEqual({ id: 7, title: "Issue" });
      expect(result._meta).toMatchObject({
        lazygate: {
          tool: "github_tool",
          server: "github",
          annotations: ["read-only"],
          responseOptimization: { mode: "project", complete: false },
        },
      });
      expect(onOptimizationMetrics).toHaveBeenCalledWith(
        { serverName: "github", toolName: "github_tool", source: "call_tool" },
        expect.objectContaining({ changed: true, complete: false })
      );
    });

    it("uses an injected tokenizer throughout call_tool optimization and metrics", async () => {
      const onOptimizationMetrics = jest.fn();
      const tokenizer = {
        name: "broker_test_tokenizer",
        countTokens: (serializedValue: string) => serializedValue.length,
      };
      const responseOptimization = parseResponseOptimizationConfig({
        responseOptimization: { enabled: true, defaultMode: "schema" },
      }).config;
      broker = createBroker({
        router,
        manager: mk.manager as unknown as ProcessManager,
        skillRouter: null,
        responseOptimization,
        tokenizer,
        onOptimizationMetrics,
      });
      const original = {
        content: [],
        structuredContent: { issues: [{ id: 1, title: "Issue", details: "x".repeat(150) }] },
      };
      mk.manager.callTool.mockResolvedValueOnce(original as never);

      const result = await broker.callTool("call_tool", { server: "github", tool: "github_tool", args: {} });

      expect(result._meta).toMatchObject({
        lazygate: { responseOptimization: { tokenizer: "broker_test_tokenizer" } },
      });
      expect(onOptimizationMetrics).toHaveBeenCalledWith(
        { serverName: "github", toolName: "github_tool", source: "call_tool" },
        expect.objectContaining({
          tokenizer: "broker_test_tokenizer",
          originalTokens: JSON.stringify(original).length,
        })
      );
    });

    it("stores incomplete structured results behind a session-scoped handle and returns requested fields", async () => {
      const responseOptimization = parseResponseOptimizationConfig({
        responseOptimization: { enabled: true, defaultMode: "schema" },
      }).config;
      broker = createBroker({
        router,
        manager: mk.manager as unknown as ProcessManager,
        skillRouter: null,
        responseOptimization,
      });
      mk.manager.callTool.mockResolvedValueOnce({
        content: [],
        structuredContent: {
          issues: [
            { id: 1, title: "First", body: "private detail" },
            { id: 2, title: "Second", body: "more private detail" },
          ],
          total: 2,
        },
      } as never);

      const summary = await broker.callTool("call_tool", { server: "github", tool: "github_tool", args: {} });
      const resultHandle = (summary._meta as any)?.lazygate?.responseOptimization?.resultHandle;
      expect(resultHandle).toMatchObject({ tool: "get_result", fields: "dot-separated field paths" });
      expect(typeof resultHandle.handle).toBe("string");

      const details = await broker.callTool("get_result", {
        handle: resultHandle.handle,
        fields: ["issues.id", "issues.title"],
      });
      expect(details.structuredContent).toEqual({
        issues: [{ id: 1, title: "First" }, { id: 2, title: "Second" }],
      });
      expect(text(details)).toContain('"title": "Second"');
      expect(text(details)).not.toContain("private detail");

      const otherBroker = createBroker({
        router,
        manager: mk.manager as unknown as ProcessManager,
        skillRouter: null,
        responseOptimization,
      });
      const isolated = await otherBroker.callTool("get_result", {
        handle: resultHandle.handle,
        fields: ["issues.id"],
      });
      expect(isolated.isError).toBe(true);
      expect(text(isolated)).toMatch(/unknown or expired/);
    });

    it("rejects unsafe result field paths", async () => {
      const responseOptimization = parseResponseOptimizationConfig({
        responseOptimization: { enabled: true, defaultMode: "schema" },
      }).config;
      broker = createBroker({
        router,
        manager: mk.manager as unknown as ProcessManager,
        skillRouter: null,
        responseOptimization,
      });
      mk.manager.callTool.mockResolvedValueOnce({
        content: [],
        structuredContent: { value: { id: 1, title: "A" } },
      } as never);
      const summary = await broker.callTool("call_tool", { server: "github", tool: "github_tool", args: {} });
      const resultHandle = (summary._meta as any)?.lazygate?.responseOptimization?.resultHandle?.handle;
      const invalid = await broker.callTool("get_result", {
        handle: resultHandle,
        fields: ["value.__proto__.title"],
      });
      expect(invalid.isError).toBe(true);
      expect(text(invalid)).toMatch(/unsafe field path/);
    });

    const lastText = (r: { content: unknown[] }) => (r.content[r.content.length - 1] as { text: string }).text;

    it("projects agent-requested fields even with optimization disabled and keeps the rest retrievable", async () => {
      const onOptimizationMetrics = jest.fn();
      broker = createBroker({
        router,
        manager: mk.manager as unknown as ProcessManager,
        skillRouter: null,
        onOptimizationMetrics,
      });
      mk.manager.callTool.mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify({ id: "TKT-1", bodyLength: 9000, body: "x".repeat(9000) }) }],
      } as never);

      const result = await broker.callTool("call_tool", {
        server: "github",
        tool: "github_tool",
        args: {},
        fields: ["id", "bodyLength"],
      });

      expect(JSON.parse(text(result))).toEqual({ id: "TKT-1", bodyLength: 9000 });
      expect(result._meta).toMatchObject({
        lazygate: { responseOptimization: { mode: "project", intent: "fields", complete: false } },
      });
      expect(onOptimizationMetrics).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ mode: "project", intent: "fields" })
      );
      const note = lastText(result);
      expect(note).toMatch(/get_result/);
      const handle = (result._meta as any).lazygate.responseOptimization.resultHandle;
      expect(handle).toMatchObject({ kind: "json" });
      expect(note).toContain(handle.handle);

      const body = await broker.callTool("get_result", { handle: handle.handle, fields: ["body"], maxTokens: 16000 });
      expect((body.structuredContent as { body: string }).body).toHaveLength(9000);
      const offsetOnJson = await broker.callTool("get_result", { handle: handle.handle, offset: 10 });
      expect(offsetOnJson.isError).toBe(true);
      expect(text(offsetOnJson)).toMatch(/pass fields instead of offset/);
    });

    it("stores truncated text behind a handle and pages it by offset", async () => {
      const responseOptimization = parseResponseOptimizationConfig({
        responseOptimization: { enabled: true, defaultMode: "off", maxOutputTokens: 600 },
      }).config;
      broker = createBroker({
        router,
        manager: mk.manager as unknown as ProcessManager,
        skillRouter: null,
        responseOptimization,
      });
      const lines = Array.from({ length: 200 }, (_, i) => `line ${String(i).padStart(3, "0")} of the report`);
      const fullText = lines.join("\n");
      mk.manager.callTool.mockResolvedValueOnce({ content: [{ type: "text", text: fullText }] } as never);

      const result = await broker.callTool("call_tool", { server: "github", tool: "github_tool", args: {} });
      const handle = (result._meta as any).lazygate.responseOptimization.resultHandle;
      expect(handle).toMatchObject({ kind: "text", offset: 0 });
      expect(lastText(result)).toContain('"offset":0');

      let offset = 0;
      let rebuilt = "";
      for (let page = 0; page < 20; page++) {
        const chunk = await broker.callTool("get_result", { handle: handle.handle, offset, maxTokens: 300 });
        expect(chunk.isError).toBeFalsy();
        const meta = (chunk._meta as any).lazygate.resultHandle;
        rebuilt += text(chunk).split("\n\n[lazygate: more text.")[0];
        if (meta.nextOffset === null) break;
        offset = meta.nextOffset;
      }
      expect(rebuilt).toBe(fullText);

      const fieldsOnText = await broker.callTool("get_result", { handle: handle.handle, fields: ["a"] });
      expect(fieldsOnText.isError).toBe(true);
      expect(text(fieldsOnText)).toMatch(/pass offset instead of fields/);
    });

    it("keeps each text page, continuation note included, within maxTokens", async () => {
      const responseOptimization = parseResponseOptimizationConfig({
        responseOptimization: { enabled: true, defaultMode: "off", maxOutputTokens: 600 },
      }).config;
      broker = createBroker({
        router,
        manager: mk.manager as unknown as ProcessManager,
        skillRouter: null,
        responseOptimization,
      });
      const fullText = Array.from({ length: 300 }, (_, i) => `"quoted" line ${i}\twith escapes`).join("\n");
      mk.manager.callTool.mockResolvedValueOnce({ content: [{ type: "text", text: fullText }] } as never);
      const result = await broker.callTool("call_tool", { server: "github", tool: "github_tool", args: {} });
      const handle = (result._meta as any).lazygate.responseOptimization.resultHandle.handle;

      for (const maxTokens of [120, 200, 400]) {
        let offset = 0;
        let rebuilt = "";
        for (let page = 0; page < 500; page++) {
          const chunk = await broker.callTool("get_result", { handle, offset, maxTokens });
          expect(chunk.isError).toBeFalsy();
          expect(estimateTokens(chunk)).toBeLessThanOrEqual(maxTokens);
          rebuilt += text(chunk).split("\n\n[lazygate: more text.")[0];
          const next = (chunk._meta as any).lazygate.resultHandle.nextOffset;
          if (next === null) break;
          offset = next;
        }
        expect(rebuilt).toBe(fullText);
      }

      const tooSmall = await broker.callTool("get_result", { handle, offset: 0, maxTokens: 10 });
      expect(tooSmall.isError).toBe(true);
      expect(text(tooSmall)).toMatch(/maxTokens 10 is too small to page this text; use at least \d+/);
    });

    it("lets the agent recover a field its projection left out, and reports the read", async () => {
      const onResultHandleRead = jest.fn();
      broker = createBroker({
        router,
        manager: mk.manager as unknown as ProcessManager,
        skillRouter: null,
        onResultHandleRead,
      });
      // Large enough that projecting ids saves more than the handle pointer costs.
      const incidents = Array.from({ length: 60 }, (_, i) => ({
        id: `INC-${i}`,
        severity: ["sev1", "sev2", "sev3"][i % 3],
        summary: `Incident ${i}`,
      }));
      mk.manager.callTool.mockResolvedValueOnce({ content: [], structuredContent: { incidents } } as never);

      // The agent first asks for ids only, then realizes it needs severity for the distribution.
      const projected = await broker.callTool("call_tool", {
        server: "github",
        tool: "github_tool",
        args: {},
        fields: ["incidents.id"],
      });
      expect(JSON.stringify(projected.structuredContent)).not.toContain("severity");
      const handle = (projected._meta as any).lazygate.responseOptimization.resultHandle.handle;

      const severities = await broker.callTool("get_result", { handle, fields: ["incidents.severity"] });
      const counts: Record<string, number> = {};
      for (const { severity } of (severities.structuredContent as { incidents: { severity: string }[] }).incidents) {
        counts[severity] = (counts[severity] ?? 0) + 1;
      }
      expect(counts).toEqual({ sev1: 20, sev2: 20, sev3: 20 });
      expect(onResultHandleRead).toHaveBeenCalledWith({ serverName: "github", toolName: "github_tool" });
    });

    it("keeps every row under the default adaptive policy instead of summarizing", async () => {
      const responseOptimization = parseResponseOptimizationConfig({
        responseOptimization: { enabled: true, defaultMode: "adaptive" },
      }).config;
      broker = createBroker({
        router,
        manager: mk.manager as unknown as ProcessManager,
        skillRouter: null,
        responseOptimization,
      });
      const incidents = Array.from({ length: 400 }, (_, i) => ({
        id: `INC-${i}`,
        severity: ["sev1", "sev2", "sev3"][i % 3],
        owner: null,
        assignees: [],
        labels: [],
        resolution: "",
        custom: {},
        summary: `Incident ${i} ${"detail ".repeat(10)}`,
      }));
      mk.manager.callTool.mockResolvedValueOnce({ content: [], structuredContent: { incidents } } as never);

      const result = await broker.callTool("call_tool", { server: "github", tool: "github_tool", args: {} });
      const delivered = (result.structuredContent as { incidents: { severity: string }[] }).incidents;
      expect(delivered).toHaveLength(400);
      expect(delivered.filter((row) => row.severity === "sev1")).toHaveLength(134);
      expect(JSON.stringify(result.structuredContent)).not.toContain("owner");
      expect(result._meta).toMatchObject({ lazygate: { responseOptimization: { selectedMode: "prune" } } });
    });

    it("keeps empty values for tools that declare an outputSchema unless the policy opts back in", async () => {
      mk.active.set("github", [
        { name: "github_tool", description: "d", inputSchema: {}, outputSchema: { type: "object" }, serverName: "github" },
      ]);
      const rows = Array.from({ length: 100 }, (_, i) => ({
        id: i, closedAt: null, assignees: [], resolution: "", custom: {}, title: `Issue ${i}`,
      }));
      const run = async (tools: Record<string, unknown>) => {
        broker = createBroker({
          router,
          manager: mk.manager as unknown as ProcessManager,
          skillRouter: null,
          responseOptimization: parseResponseOptimizationConfig({
            responseOptimization: { enabled: true, defaultMode: "adaptive", tools },
          }).config,
        });
        mk.manager.callTool.mockResolvedValueOnce({ content: [], structuredContent: { rows } } as never);
        return broker.callTool("call_tool", { server: "github", tool: "github_tool", args: {} });
      };

      const strict = await run({});
      expect(strict.structuredContent).toEqual({ rows });

      const optedIn = await run({ "github.github_tool": { keepEmptyValues: false } });
      expect(JSON.stringify(optedIn.structuredContent)).not.toContain("closedAt");
    });

    it("drops the handle instead of failing when its pointer would exceed the output budget", async () => {
      const responseOptimization = parseResponseOptimizationConfig({
        responseOptimization: { enabled: true, defaultMode: "off", maxOutputTokens: 200 },
      }).config;
      broker = createBroker({
        router,
        manager: mk.manager as unknown as ProcessManager,
        skillRouter: null,
        responseOptimization,
      });
      mk.manager.callTool.mockResolvedValueOnce({ content: [{ type: "text", text: "word ".repeat(400) }] } as never);

      const result = await broker.callTool("call_tool", { server: "github", tool: "github_tool", args: {} });
      expect(result.isError).toBeFalsy();
      expect((result._meta as any).lazygate.responseOptimization.resultHandle).toBeUndefined();
      expect(text(result)).toMatch(/incomplete/);
    });

    it("counts tokens with the built-in tokenizer named in servers.json", async () => {
      const onOptimizationMetrics = jest.fn();
      const responseOptimization = parseResponseOptimizationConfig({
        responseOptimization: { enabled: true, defaultMode: "prune", tokenizer: "o200k_base" },
      }).config;
      broker = createBroker({
        router,
        manager: mk.manager as unknown as ProcessManager,
        skillRouter: null,
        responseOptimization,
        onOptimizationMetrics,
      });
      mk.manager.callTool.mockResolvedValueOnce({ content: [], structuredContent: { a: 1, b: null } } as never);

      await broker.callTool("call_tool", { server: "github", tool: "github_tool", args: {} });
      expect(onOptimizationMetrics).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ tokenizer: "o200k_base" })
      );
    });

    describe("call_tool self-correction", () => {
      const schema = { type: "object", properties: { id: { type: "string" }, limit: { type: "integer" } }, required: ["id"] };
      beforeEach(() => {
        mk.active.set("github", [
          { name: "get_issue", description: "Fetch one issue by id", inputSchema: schema, serverName: "github" },
          { name: "list_issues", description: "List repository issues", inputSchema: { type: "object", properties: {} }, serverName: "github" },
        ]);
      });

      it("appends the input schema when the upstream rejects the arguments (isError result)", async () => {
        mk.manager.callTool.mockResolvedValueOnce({
          isError: true,
          content: [{ type: "text", text: "Invalid arguments: id is required" }],
        } as never);
        const r = await broker.callTool("call_tool", { server: "github", tool: "get_issue", args: {} });
        expect(r.isError).toBe(true);
        expect(r.content).toHaveLength(2);
        expect(text(r)).toContain("Invalid arguments");
        const hint = (r.content[1] as { text: string }).text;
        expect(hint).toContain('Input schema for "get_issue"');
        expect(hint).toContain(JSON.stringify(schema));
      });

      it("appends the schema when the upstream answers with a JSON-RPC invalid-params error", async () => {
        const err = Object.assign(new Error("Params did not match"), { code: -32602 });
        mk.manager.callTool.mockRejectedValueOnce(err);
        const r = await broker.callTool("call_tool", { server: "github", tool: "get_issue", args: { id: 3 } });
        expect(r.isError).toBe(true);
        expect(text(r)).toContain("Error calling get_issue: Params did not match");
        expect(text(r)).toContain(JSON.stringify(schema));
      });

      it("does not attach the schema to unrelated failures", async () => {
        mk.manager.callTool.mockResolvedValueOnce({ isError: true, content: [{ type: "text", text: "rate limit hit" }] } as never);
        const r = await broker.callTool("call_tool", { server: "github", tool: "get_issue", args: { id: "1" } });
        expect(r.content).toHaveLength(1);
        mk.manager.callTool.mockRejectedValueOnce(new Error("timed out"));
        const t = await broker.callTool("call_tool", { server: "github", tool: "get_issue", args: { id: "1" } });
        expect(text(t)).not.toContain("Input schema");
      });

      it("bounds the schema: a large one falls back to a compact signature", async () => {
        const props = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`field_${i}`, { type: "string", description: "x".repeat(40) }]));
        mk.active.set("github", [
          { name: "big", description: "d", inputSchema: { type: "object", properties: props }, serverName: "github" },
        ]);
        mk.manager.callTool.mockResolvedValueOnce({ isError: true, content: [{ type: "text", text: "missing required field" }] } as never);
        const r = await broker.callTool("call_tool", { server: "github", tool: "big", args: {} });
        const hint = (r.content[1] as { text: string }).text;
        expect(hint).toContain("is large");
        expect(hint.length).toBeLessThan(1500);
        expect(hint).toContain("describe_tool");
      });

      it("suggests close matches with their signatures for an unknown tool", async () => {
        const r = await broker.callTool("call_tool", { server: "github", tool: "fetch issue", args: {} });
        expect(r.isError).toBe(true);
        expect(text(r)).toContain("not found on server");
        expect(text(r)).toContain("Closest matches:");
        expect(text(r)).toContain("get_issue(args: { id: string; limit?: number })");
        expect(mk.manager.callTool).not.toHaveBeenCalled();
      });
    });

    describe("optimization overhead on small results", () => {
      const optimizing = (overrides: Record<string, unknown> = {}) =>
        createBroker({
          router,
          manager: mk.manager as unknown as ProcessManager,
          skillRouter: null,
          responseOptimization: parseResponseOptimizationConfig({
            responseOptimization: { enabled: true, defaultMode: "adaptive", ...overrides },
          }).config,
        });

      it("returns a tiny result untouched under the adaptive default (no metadata, no handle)", async () => {
        const tiny = { region: "us-east", requests: 10000, errors: null, tags: [] };
        mk.manager.callTool.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify(tiny) }] } as never);
        await broker.callTool("activate_server", { server_name: "github" });
        const plain = await broker.callTool("call_tool", { server: "github", tool: "github_tool", args: {} });
        const opt = await optimizing().callTool("call_tool", { server: "github", tool: "github_tool", args: {} });
        expect(opt).toEqual(plain);
        expect(opt._meta).toBeUndefined();
      });

      it("projects requested fields on a tiny result without metadata or a handle pointer", async () => {
        const tiny = { region: "us-east", requests: 10000, errors: 0, p95Ms: 120 };
        mk.manager.callTool.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify(tiny) }] } as never);
        const opt = optimizing();
        await opt.callTool("activate_server", { server_name: "github" });
        const plain = await optimizing().callTool("call_tool", { server: "github", tool: "github_tool", args: {} });
        const r = await opt.callTool("call_tool", { server: "github", tool: "github_tool", args: {}, fields: ["requests"] });
        expect(JSON.parse(text(r))).toEqual({ requests: 10000 });
        expect(r.content).toHaveLength(1);
        expect(r._meta).toBeUndefined();
        expect(estimateTokens(r)).toBeLessThanOrEqual(estimateTokens(plain));
      });

      it("returns the original when a projection of a mid-size result saves less than the pointer costs", async () => {
        const row = { id: 1, title: "t".repeat(300), body: "b".repeat(450) };
        mk.manager.callTool.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify(row) }] } as never);
        const opt = optimizing();
        const r = await opt.callTool("call_tool", { server: "github", tool: "github_tool", args: {}, fields: ["id", "title"] });
        expect(JSON.parse(text(r))).toEqual(row);
        expect(r._meta).toBeUndefined();
      });

      it("still projects and offers a handle when the saving is material, and still applies budgets", async () => {
        const big = { id: 1, body: "x".repeat(6000) };
        mk.manager.callTool.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify(big) }] } as never);
        const r = await optimizing().callTool("call_tool", { server: "github", tool: "github_tool", args: {}, fields: ["id"] });
        expect(JSON.parse(text(r))).toEqual({ id: 1 });
        expect((r._meta as any).lazygate.responseOptimization.resultHandle).toBeDefined();

        mk.manager.callTool.mockResolvedValue({ content: [{ type: "text", text: "word ".repeat(400) }] } as never);
        const budgeted = await optimizing({ maxOutputTokens: 100 }).callTool("call_tool", { server: "github", tool: "github_tool", args: {} });
        expect(text(budgeted)).toMatch(/incomplete/);
      });

      it("leaves operator-configured projections alone even on tiny results", async () => {
        mk.manager.callTool.mockResolvedValue({ content: [], structuredContent: { id: 7, token: "sensitive" } } as never);
        const r = await optimizing({
          defaultMode: "off",
          tools: { "github.github_tool": { mode: "project", fields: ["id"] } },
        }).callTool("call_tool", { server: "github", tool: "github_tool", args: {} });
        expect(r.structuredContent).toEqual({ id: 7 });
      });
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

    it("composes parameterized skills via load_skill args", async () => {
      const { mkdtempSync, writeFileSync } = await import("fs");
      const { tmpdir } = await import("os");
      const { join } = await import("path");
      const dir = mkdtempSync(join(tmpdir(), "cb-skill-args-"));
      writeFileSync(join(dir, "SKILL.md"), "---\n---\n");
      writeFileSync(join(dir, "INSTRUCTIONS.md"), "Deploy {{service_name}} to {{environment}}.");
      const skills = new SkillRouter({
        deploy: {
          description: "Deploy checks",
          keywords: ["deploy"],
          path: join(dir, "SKILL.md"),
          prompt: {
            arguments: [
              { name: "service_name", required: true },
              { name: "environment", default: "staging" },
            ],
          },
        },
      });
      broker = createBroker({ router, manager: mk.manager as unknown as ProcessManager, skillRouter: skills });
      const missing = await broker.callTool("load_skill", { skill_name: "deploy" });
      expect(missing.isError).toBe(true);
      expect(text(missing)).toMatch(/Missing required/);
      const hint = await broker.callTool("load_skill", {
        skill_name: "deploy",
        args: { service_name: "billing" },
      });
      expect(text(hint)).toContain("Deploy billing to staging.");
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
