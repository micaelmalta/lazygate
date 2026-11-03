// src/__tests__/broker-tool-chain.test.ts
// run_chain and describe_tool stubs through createBroker, with a fake ProcessManager.

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { createBroker, type BrokerAccess } from "../broker.js";
import { ToolRouter, type ServerConfig } from "../router.js";
import type { ProcessManager, MCPTool } from "../process-manager.js";

const server = (o: Partial<ServerConfig> = {}): ServerConfig => ({
  description: "Test server",
  keywords: [],
  command: "node",
  autoActivate: false,
  ...o,
});

/** Upstream tools each server exposes once activated. */
const UPSTREAM: Record<string, string[]> = {
  jira: ["search", "delete_issue"],
  notes: ["read"],
  scoped: ["search", "delete_issue"],
};

function makeManager() {
  const active = new Map<string, MCPTool[]>();
  const upstreamResult = jest.fn(async (_s: string, t: string, _a: Record<string, unknown>) => ({
    content: [{ type: "text", text: JSON.stringify({ tool: t }) }],
  }));
  const manager = {
    activate: jest.fn(async (name: string) => {
      const tools: MCPTool[] = (UPSTREAM[name] ?? [`${name}_tool`]).map((t) => ({
        name: t,
        description: `${t} description.`,
        inputSchema: {},
        serverName: name,
      }));
      active.set(name, tools);
      return tools;
    }),
    deactivate: jest.fn((name: string) => active.delete(name)),
    listActive: jest.fn(() => [...active.keys()]),
    getAllActiveTools: jest.fn(() => [...active.values()].flat()),
    findServerForTool: jest.fn((tool: string) =>
      [...active.entries()].find(([, ts]) => ts.some((t) => t.name === tool))?.[0]
    ),
    callTool: upstreamResult,
  };
  return { manager, active, upstreamResult };
}

const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

describe("run_chain", () => {
  let router: ToolRouter;
  let mk: ReturnType<typeof makeManager>;

  beforeEach(() => {
    router = new ToolRouter({
      jira: server({ description: "Jira issues", keywords: ["jira"], toolChain: ["search"] }),
      notes: server({ description: "Notes", keywords: ["notes"], toolChain: true }),
      plain: server({ description: "No tool chain", keywords: ["plain"] }),
    });
    mk = makeManager();
  });

  function build(access?: BrokerAccess) {
    return createBroker({
      router,
      manager: mk.manager as unknown as ProcessManager,
      skillRouter: null,
      access,
    });
  }

  it("is listed as a meta-tool", () => {
    const names = build().listTools().tools.map((t) => t.name);
    expect(names).toContain("run_chain");
  });

  it("runs a script and returns logs plus the return value", async () => {
    const broker = build();
    const r = await broker.callTool("run_chain", {
      code: 'console.log("starting"); const r = await servers.jira.search({ q: 1 }); return r.tool;',
    });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("Logs:\nstarting");
    expect(text(r)).toContain('Return value: "search"');
    expect(text(r)).toContain("Completed; 1 nested call.");
  });

  it("activates the server lazily on its first call", async () => {
    const broker = build();
    expect(mk.manager.listActive()).toEqual([]);
    await broker.callTool("run_chain", { code: "return 1;" });
    expect(mk.manager.activate).not.toHaveBeenCalled();
    await broker.callTool("run_chain", { code: "return await servers.jira.search({});" });
    expect(mk.manager.activate).toHaveBeenCalledWith("jira", expect.anything(), undefined);
  });

  it("keeps non-allowlisted tools out of the script and never calls upstream", async () => {
    const broker = build();
    // jira's toolChain allowlist is ["search"]: delete_issue is not bound, so the script gets an
    // error from calling an undefined function instead of reaching upstream.
    const r = await broker.callTool("run_chain", {
      code: "return await servers.jira.delete_issue({ id: 1 });",
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not a function/);
    expect(mk.upstreamResult).not.toHaveBeenCalled();
  });

  it("gives a server without toolChain no binding at all", async () => {
    const broker = build();
    const r = await broker.callTool("run_chain", {
      code: "return await servers.plain.anything({});",
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Hint: tools are only reachable/);
    expect(mk.manager.activate).not.toHaveBeenCalledWith("plain", expect.anything(), undefined);
  });

  it("turns an upstream isError into an error value and counts it", async () => {
    mk.upstreamResult.mockResolvedValueOnce({
      isError: true,
      content: [{ type: "text", text: "quota exceeded" }],
    } as never);
    const broker = build();
    const r = await broker.callTool("run_chain", {
      code: "const x = await servers.jira.search({}); return x.error;",
    });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('"quota exceeded"');
    expect(text(r)).toContain("(1 nested call failed)");
  });

  it("returns only logs and the return value, never raw upstream text", async () => {
    mk.upstreamResult.mockResolvedValueOnce({
      content: [{ type: "text", text: "RAW_SECRET_PAYLOAD" }],
    } as never);
    const broker = build();
    const r = await broker.callTool("run_chain", {
      code: "const x = await servers.jira.search({}); return 'done';",
    });
    expect(text(r)).not.toContain("RAW_SECRET_PAYLOAD");
    expect(text(r)).toContain("Return value:");
  });

  it("reports a script error as isError with the line", async () => {
    const broker = build();
    const r = await broker.callTool("run_chain", { code: "const a = 1;\nthrow new Error('nope');" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Error: nope \(line 2\)/);
  });

  it("rejects an empty or oversize code argument", async () => {
    const broker = build();
    expect((await broker.callTool("run_chain", { code: "" })).isError).toBe(true);
    const big = "x".repeat(64 * 1024 + 1);
    const r = await broker.callTool("run_chain", { code: big });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/KiB limit/);
  });

  it("calls onNestedCall once per tool call", async () => {
    const onNestedCall = jest.fn();
    const broker = build({
      canUse: () => true,
      prepare: () => undefined,
      onNestedCall,
    });
    await broker.callTool("run_chain", {
      code: "await servers.jira.search({ a: 1 }); await servers.jira.search({ a: 2 }); await servers.notes.read({});",
    });
    expect(onNestedCall).toHaveBeenCalledTimes(3);
    expect(onNestedCall.mock.calls.map((c) => (c[0] as { server: string }).server)).toEqual(["jira", "jira", "notes"]);
    expect(onNestedCall.mock.calls[0][0]).toMatchObject({ server: "jira", tool: "search", ok: true });
  });

  it("does not bind a server the caller cannot see, so no nested call happens", async () => {
    const onNestedCall = jest.fn();
    const broker = build({ canUse: (name) => name !== "jira", prepare: () => undefined, onNestedCall });
    const r = await broker.callTool("run_chain", { code: "return await servers.jira.search({});" });
    expect(r.isError).toBe(true);
    expect(onNestedCall).not.toHaveBeenCalled();
    expect(mk.upstreamResult).not.toHaveBeenCalled();
  });

  it("uses the access check for every nested call, not only the first", async () => {
    // Hidden from the caller after the first call (e.g. a mid-run policy change).
    let hidden = false;
    const broker = build({
      canUse: () => !hidden,
      prepare: () => undefined,
      onNestedCall: () => {
        hidden = true;
      },
    });
    const r = await broker.callTool("run_chain", {
      code: "const a = await servers.notes.read({}); const b = await servers.notes.read({}); return [a.tool, b.error];",
    });
    expect(text(r)).toContain('"read"');
    expect(text(r)).toContain("Unknown server");
    expect(mk.upstreamResult).toHaveBeenCalledTimes(1);
  });
});

describe("describe_tool stubs", () => {
  let router: ToolRouter;
  let mk: ReturnType<typeof makeManager>;

  beforeEach(() => {
    router = new ToolRouter({
      jira: server({ description: "Jira", keywords: ["jira"], toolChain: true }),
      plain: server({ description: "Plain", keywords: ["plain"] }),
      scoped: server({ description: "Scoped", keywords: ["scoped"], toolChain: ["search"] }),
    });
    mk = makeManager();
  });

  const build = () =>
    createBroker({ router, manager: mk.manager as unknown as ProcessManager, skillRouter: null });

  it("returns stubs when tool is omitted, activating the server first", async () => {
    const broker = build();
    const r = await broker.callTool("describe_tool", { server: "jira" });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("// servers.jira");
    expect(text(r)).toContain("search(args: Record<string, unknown>): Promise<unknown>");
    expect(text(r)).toContain("delete_issue(");
    expect(mk.manager.activate).toHaveBeenCalledWith("jira", expect.anything(), undefined);
  });

  it("limits stubs to the toolChain allowlist", async () => {
    const r = await build().callTool("describe_tool", { server: "scoped" });
    expect(text(r)).toContain("search(");
    expect(text(r)).not.toContain("delete_issue");
  });

  it("refuses stubs for a server without toolChain", async () => {
    const r = await build().callTool("describe_tool", { server: "plain" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not enabled for tool chain/);
  });

  it("still returns the full schema when a tool is named", async () => {
    const r = await build().callTool("describe_tool", { server: "jira", tool: "search" });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r))).toMatchObject({ name: "search" });
  });
});
