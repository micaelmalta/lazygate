import { describe, it, expect, afterEach } from "@jest/globals";
import { spawn } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { buildManifest, MANIFEST_MAX_CHARS } from "../manifest.js";
import { ToolIndex } from "../tool-index.js";
import { parseServersConfig } from "../config.js";
import type { ServerConfig } from "../router.js";

const server = (o: Partial<ServerConfig> = {}): ServerConfig => ({
  description: "d",
  keywords: [],
  command: "node",
  args: ["a.js"],
  autoActivate: false,
  ...o,
});

const schema = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required });

describe("buildManifest", () => {
  it("lists opted-in servers with their indexed signatures, in registry order", () => {
    const index = new ToolIndex();
    const a = server({ manifest: true, toolChain: true });
    const b = server({ manifest: true, args: ["b.js"] });
    const c = server({ args: ["c.js"] });
    index.record("tickets", a, [{ name: "get_ticket", description: "Get", inputSchema: schema({ id: { type: "string" } }, ["id"]) }]);
    index.record("orders", b, [{ name: "get_order", description: "Get", inputSchema: schema({ id: { type: "string" } }, ["id"]) }]);
    index.record("other", c, [{ name: "ping", description: "Ping" }]);
    const text = buildManifest({ tickets: a, orders: b, other: c }, index)!;
    expect(text).toContain("- tickets (run_chain): get_ticket(args: { id: string })");
    expect(text).toContain("- orders: get_order(args: { id: string })");
    expect(text).not.toContain("other");
    expect(text.indexOf("tickets")).toBeLessThan(text.indexOf("orders"));
    expect(text).toContain("discover_tools");
    expect(text.length).toBeLessThan(MANIFEST_MAX_CHARS);
  });

  it("is empty when nothing is opted in or nothing is indexed yet, and starts nothing", () => {
    const index = new ToolIndex();
    expect(buildManifest({ a: server({ manifest: true }) }, index)).toBeUndefined();
    index.record("a", server(), [{ name: "t", description: "" }]);
    expect(buildManifest({ a: server() }, index)).toBeUndefined();
  });

  it("honours a tool allowlist and ignores an index entry for a changed server", () => {
    const index = new ToolIndex();
    const cfg = server({ manifest: ["keep"] });
    index.record("a", cfg, [
      { name: "keep", description: "" },
      { name: "drop", description: "" },
    ]);
    const text = buildManifest({ a: cfg }, index)!;
    expect(text).toContain("keep(args)");
    expect(text).not.toContain("drop");
    expect(buildManifest({ a: { ...cfg, args: ["changed.js"] } }, index)).toBeUndefined();
  });

  it("stays within its budget, dropping whole servers and saying so", () => {
    const index = new ToolIndex();
    const servers: Record<string, ServerConfig> = {};
    for (let i = 0; i < 12; i++) {
      const cfg = server({ manifest: true, args: [`s${i}.js`] });
      servers[`srv${i}`] = cfg;
      index.record(`srv${i}`, cfg, Array.from({ length: 6 }, (_, n) => ({
        name: `tool_${n}`,
        description: "",
        inputSchema: schema({ q: { type: "string" }, limit: { type: "number" } }, ["q"]),
      })));
    }
    const text = buildManifest(servers, index)!;
    expect(text.length).toBeLessThanOrEqual(MANIFEST_MAX_CHARS + 80);
    expect(text).toMatch(/\d+ more servers? omitted/);
    expect(text).toContain("- srv0");
  });

  it("is deterministic, so the prompt cache stays valid", () => {
    const index = new ToolIndex();
    const cfg = server({ manifest: true });
    index.record("a", cfg, [{ name: "t", description: "" }]);
    expect(buildManifest({ a: cfg }, index)).toBe(buildManifest({ a: cfg }, index));
  });
});

describe("manifest config", () => {
  it("accepts true or a tool list and rejects other values", () => {
    const parse = (manifest: unknown) =>
      parseServersConfig({ servers: { a: { description: "d", keywords: [], command: "node", manifest } } }, "x");
    expect(Object.keys(parse(true).entries)).toEqual(["a"]);
    expect(Object.keys(parse(["t"]).entries)).toEqual(["a"]);
    expect(Object.keys(parse("yes").entries)).toEqual([]);
  });
});

describe("MCP instructions over stdio", () => {
  let home: string | undefined;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

  function initialize(env: NodeJS.ProcessEnv, configPath: string): Promise<{ instructions?: string }> {
    return new Promise((done, fail) => {
      const child = spawn(process.execPath, [resolve(repoRoot, "dist/index.js"), "--config", configPath], {
        env,
        stdio: ["pipe", "pipe", "ignore"],
      });
      let buf = "";
      const timer = setTimeout(() => {
        child.kill();
        fail(new Error("no initialize response"));
      }, 15_000);
      child.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const line = buf.split("\n").find((l) => l.includes('"id":1'));
        if (!line) return;
        clearTimeout(timer);
        child.kill();
        done((JSON.parse(line) as { result: { instructions?: string } }).result);
      });
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } },
        }) + "\n"
      );
    });
  }

  it("sends the manifest as server instructions, only once the server has been indexed", async () => {
    home = mkdtempSync(join(tmpdir(), "lazygate-manifest-"));
    const dir = join(home, ".config", "lazygate");
    mkdirSync(dir, { recursive: true });
    const cfg = { description: "tickets", keywords: ["tickets"], command: "node", args: ["t.js"], manifest: true };
    const configPath = join(dir, "servers.json");
    writeFileSync(configPath, JSON.stringify({ servers: { tickets: cfg } }));
    const env = { ...process.env, HOME: home };

    expect((await initialize(env, configPath)).instructions).toBeUndefined();

    new ToolIndex(join(dir, "tool-index.json")).record("tickets", cfg as ServerConfig, [
      { name: "get_ticket", description: "Get", inputSchema: schema({ id: { type: "string" } }, ["id"]) },
    ]);
    const result = await initialize(env, configPath);
    expect(result.instructions).toContain("- tickets: get_ticket(args: { id: string })");
  });
});
