// src/__tests__/tool-chain-sandbox.test.ts
// The QuickJS sandbox: bindings, error values, and each resource limit.

import { describe, it, expect } from "@jest/globals";
import { runCode, DEFAULT_LIMITS, type NestedCall } from "../tool-chain/sandbox.js";

const ok = (value: unknown) => ({ value, failed: false });
const echo: NestedCall = async (server, tool, args) => ok({ server, tool, args });
const bindings = [{ server: "jira", tools: ["search", "boom"] }];

/** Small limits so each test stays well under the jest timeout. */
const small = { deadlineMs: 4000, memoryBytes: 16 * 1024 * 1024 };

describe("runCode: results", () => {
  it("returns the script's return value and logs", async () => {
    const out = await runCode({
      code: 'console.log("hi", 1, { a: 2 }); return { answer: 42 };',
      bindings: [],
      callTool: echo,
      limits: small,
    });
    expect(out.error).toBeUndefined();
    expect(out.value).toEqual({ answer: 42 });
    expect(out.logs).toBe('hi 1 {"a":2}');
  });

  it("returns undefined when the script returns nothing", async () => {
    const out = await runCode({ code: 'console.log("only log");', bindings: [], callTool: echo, limits: small });
    expect(out.value).toBeUndefined();
    expect(out.logs).toBe("only log");
  });

  it("starts each run in a fresh scope", async () => {
    const first = await runCode({ code: "globalThis.leak = 7; return 1;", bindings: [], callTool: echo, limits: small });
    expect(first.value).toBe(1);
    const second = await runCode({ code: "return typeof globalThis.leak;", bindings: [], callTool: echo, limits: small });
    expect(second.value).toBe("undefined");
  });

  it("exposes no require, process, fetch or host globals", async () => {
    const out = await runCode({
      code: "return [typeof require, typeof process, typeof fetch, typeof Buffer];",
      bindings: [],
      callTool: echo,
      limits: small,
    });
    expect(out.value).toEqual(["undefined", "undefined", "undefined", "undefined"]);
  });
});

describe("runCode: nested calls", () => {
  it("routes servers.<name>.<tool>(args) to the host callback", async () => {
    const calls: Array<[string, string, unknown]> = [];
    const out = await runCode({
      code: 'return await servers.jira.search({ jql: "x" });',
      bindings,
      callTool: async (s, t, a) => {
        calls.push([s, t, a]);
        return ok({ hit: true });
      },
      limits: small,
    });
    expect(out.value).toEqual({ hit: true });
    expect(calls).toEqual([["jira", "search", { jql: "x" }]]);
    expect(out.calls).toBe(1);
  });

  it("supports Promise.all over several calls", async () => {
    const out = await runCode({
      code: "const r = await Promise.all([1, 2, 3].map((n) => servers.jira.search({ n }))); return r.map((x) => x.args.n);",
      bindings,
      callTool: echo,
      limits: small,
    });
    expect(out.value).toEqual([1, 2, 3]);
  });

  it("caps concurrent calls at maxConcurrent", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow: NestedCall = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      return ok(null);
    };
    const out = await runCode({
      code: "await Promise.all(Array.from({ length: 10 }, (_, i) => servers.jira.search({ i }))); return 'done';",
      bindings,
      callTool: slow,
      limits: { ...small, maxConcurrent: 3 },
    });
    expect(out.value).toBe("done");
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it("turns a failed upstream result into an error value without aborting the script", async () => {
    const out = await runCode({
      code: "const r = await servers.jira.boom({}); return { keepsGoing: true, err: r.error };",
      bindings,
      callTool: async () => ({ value: { error: "upstream exploded" }, failed: true }),
      limits: small,
    });
    expect(out.error).toBeUndefined();
    expect(out.value).toEqual({ keepsGoing: true, err: "upstream exploded" });
    expect(out.failedCalls).toBe(1);
  });

  it("turns a host exception into an error value", async () => {
    const out = await runCode({
      code: "const r = await servers.jira.search({}); return r;",
      bindings,
      callTool: async () => {
        throw new Error("connection reset");
      },
      limits: small,
    });
    expect(out.value).toEqual({ error: "connection reset" });
    expect(out.failedCalls).toBe(1);
  });

  it("accepts any tool name when the binding is a wildcard", async () => {
    const out = await runCode({
      code: "return await servers.jira.anything({ q: 1 });",
      bindings: [{ server: "jira", tools: "*" }],
      callTool: echo,
      limits: small,
    });
    expect(out.value).toEqual({ server: "jira", tool: "anything", args: { q: 1 } });
  });

  it("reports a missing named tool as undefined rather than calling the host", async () => {
    const out = await runCode({
      code: "return typeof servers.jira.nope;",
      bindings,
      callTool: echo,
      limits: small,
    });
    expect(out.value).toBe("undefined");
    expect(out.calls).toBe(0);
  });
});

describe("runCode: errors", () => {
  it("reports a thrown error with its line number and a hint", async () => {
    const out = await runCode({
      code: 'const a = 1;\nthrow new Error("bad thing");',
      bindings: [],
      callTool: echo,
      limits: small,
    });
    expect(out.error).toMatch(/Error: bad thing \(line 2\)/);
    expect(out.error).toMatch(/fresh scope/);
  });

  it("reports a syntax error", async () => {
    const out = await runCode({ code: "const x = ;", bindings: [], callTool: echo, limits: small });
    expect(out.error).toMatch(/SyntaxError/);
    expect(out.value).toBeUndefined();
  });

  it("hints at servers.* when a host-only global is used", async () => {
    const out = await runCode({ code: "return require('fs');", bindings: [], callTool: echo, limits: small });
    expect(out.error).toMatch(/require/);
    expect(out.error).toMatch(/servers\.\*/);
  });

  it("stops an infinite loop at the deadline", async () => {
    const started = Date.now();
    const out = await runCode({
      code: "while (true) {}",
      bindings: [],
      callTool: echo,
      limits: { deadlineMs: 800, memoryBytes: 16 * 1024 * 1024 },
    });
    expect(out.error).toMatch(/time limit/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("stops a memory bomb with a clear error", async () => {
    const out = await runCode({
      code: 'let a = []; while (true) { a.push("x".repeat(100000)); }',
      bindings: [],
      callTool: echo,
      limits: { deadlineMs: 20000, memoryBytes: 8 * 1024 * 1024 },
    });
    expect(out.error).toMatch(/memory limit/);
  });

  it("reports a promise that never settles instead of hanging", async () => {
    const out = await runCode({
      code: "await new Promise(() => {}); return 1;",
      bindings: [],
      callTool: echo,
      limits: small,
    });
    expect(out.error).toMatch(/never settles/);
  });
});

describe("runCode: limits", () => {
  it("refuses calls beyond maxCalls and counts them as failures", async () => {
    const out = await runCode({
      code: "const out = []; for (let i = 0; i < 10; i++) out.push(await servers.jira.search({ i })); return out.filter((r) => r.error).length;",
      bindings,
      callTool: echo,
      limits: { ...small, maxCalls: 4 },
    });
    expect(out.value).toBe(6);
    expect(out.calls).toBe(4);
    expect(out.failedCalls).toBe(6);
  });

  it("truncates a log flood at maxLogBytes", async () => {
    const out = await runCode({
      code: "for (let i = 0; i < 5000; i++) console.log('line ' + i);",
      bindings: [],
      callTool: echo,
      limits: { ...small, maxLogBytes: 200 },
    });
    expect(out.logs).toContain("[log output truncated]");
    expect(Buffer.byteLength(out.logs, "utf-8")).toBeLessThan(400);
  });

  it("rejects a return value over maxValueBytes", async () => {
    const out = await runCode({
      code: "return 'x'.repeat(5000);",
      bindings: [],
      callTool: echo,
      limits: { ...small, maxValueBytes: 1024 },
    });
    expect(out.error).toMatch(/return value exceeds/);
  });

  it("rejects an oversize tool result before it reaches the script", async () => {
    const out = await runCode({
      code: "const r = await servers.jira.search({}); return r.error;",
      bindings,
      callTool: async () => ok("y".repeat(5000)),
      limits: { ...small, maxValueBytes: 1024 },
    });
    expect(out.value).toMatch(/tool result exceeds/);
  });

  it("rejects oversize arguments", async () => {
    const out = await runCode({
      code: "return await servers.jira.search({ big: 'z'.repeat(5000) });",
      bindings,
      callTool: echo,
      limits: { ...small, maxValueBytes: 1024 },
    });
    expect(out.value).toEqual({ error: expect.stringMatching(/arguments exceeds/) });
  });

  it("exposes the documented default limits", () => {
    expect(DEFAULT_LIMITS.memoryBytes).toBe(64 * 1024 * 1024);
    expect(DEFAULT_LIMITS.maxCalls).toBe(64);
    expect(DEFAULT_LIMITS.maxConcurrent).toBe(8);
    expect(DEFAULT_LIMITS.maxLogBytes).toBe(64 * 1024);
    expect(DEFAULT_LIMITS.maxValueBytes).toBe(1024 * 1024);
  });
});
