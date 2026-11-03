// src/__tests__/security-followups.test.ts
// Follow-up fixes from the security review: M3 (audit + rate limit), M5 (allowPrivate + pinned IP),
// R2 (scratch cwd + file modes), M11/M12 (annotations, skill hashes), M2 (startup warnings).

import { jest, describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import type { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { AuditLog, TAIL_BYTES } from "../gateway/audit.js";
import { AuthFailureLimiter } from "../gateway/rate-limit.js";
import { hardenGatewayDirs } from "../gateway/hardening.js";
import { gatewayStartupWarnings } from "../gateway/warnings.js";
import { startGateway, type Gateway } from "../gateway/server.js";
import { TokenStore } from "../gateway/tokens.js";
import { SecretStore } from "../gateway/credentials.js";
import { UserProfileStore } from "../gateway/profile.js";
import { loadRegistry } from "../registry.js";
import { composePrompt } from "../prompt-compose.js";
import { pinnedFetch, resolveSafeUrl, UnsafeUrlError } from "../ssrf.js";
import { parseSkillsConfig } from "../config.js";
import { ProcessManager, type MCPTool } from "../process-manager.js";
import { createBroker } from "../broker.js";
import { SkillRouter } from "../skill-router.js";
import { SkillHashStore } from "../skill-hashes.js";
import { ToolRouter, type ServerConfig } from "../router.js";
import type { SkillConfig } from "../skill-router.js";

const root = mkdtempSync(join(tmpdir(), "lg-follow-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const srv = createServer(handler);
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
    srv.listen(0, "127.0.0.1", () =>
      resolve({
        port: (srv.address() as AddressInfo).port,
        close: () => new Promise((r) => srv.close(() => r())),
      })
    );
  });
}

function listenDualStack(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const srv = createServer(handler);
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
    srv.listen(0, () =>
      resolve({
        port: (srv.address() as AddressInfo).port,
        close: () => new Promise((r) => srv.close(() => r())),
      })
    );
  });
}

// ── M3 ────────────────────────────────────────────────────────────────────────

describe("M3: AuthFailureLimiter", () => {
  it("blocks after the limit and recovers after the window", () => {
    let now = 1_000_000;
    const l = new AuthFailureLimiter(3, 60_000, () => now);
    for (let i = 0; i < 3; i++) {
      expect(l.retryAfterSec("1.2.3.4")).toBe(0);
      l.fail("1.2.3.4");
    }
    expect(l.retryAfterSec("1.2.3.4")).toBeGreaterThan(0);
    expect(l.retryAfterSec("5.6.7.8")).toBe(0);
    now += 61_000;
    expect(l.retryAfterSec("1.2.3.4")).toBe(0);
  });
});

describe("M3: AuditLog.tail reads from the end", () => {
  it("returns the newest events of a log far larger than the tail window", () => {
    const path = join(root, "big-audit.log");
    const filler = JSON.stringify({ ts: "t", user: "old", tool: "x".repeat(900) }) + "\n";
    const count = Math.ceil((TAIL_BYTES * 3) / filler.length);
    writeFileSync(path, filler.repeat(count));
    const log = new AuditLog(path);
    log.record({ user: "newest", tool: "last" });
    const events = log.tail(5);
    expect(events[0].user).toBe("newest");
    expect(events).toHaveLength(5);
    // Everything returned is a complete, parsed event (the partial first line was dropped).
    expect(events.every((e) => typeof e.user === "string")).toBe(true);
  });

  it("filters by user and handles a small file", () => {
    const log = new AuditLog(join(root, "small-audit.log"));
    log.record({ user: "a", tool: "1" });
    log.record({ user: "b", tool: "2" });
    log.record({ user: "a", tool: "3" });
    expect(log.tail(10, "a").map((e) => e.tool)).toEqual(["3", "1"]);
  });
});

describe("M3: gateway audits auth failures, denials and session creation", () => {
  let dir: string;
  let gw: Gateway;
  let adminToken: string;
  let aliceToken: string;
  let bobToken: string;
  let skillFile: string;
  let hashes: SkillHashStore;
  const auditPath = () => join(dir, "audit.log");
  const events = () =>
    readFileSync(auditPath(), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
  const mcp = (headers: Record<string, string>, body: unknown = init) =>
    fetch(`http://127.0.0.1:${gw.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(body),
    });
  const ui = (path: string, token?: string, method = "GET") =>
    fetch(`http://127.0.0.1:${gw.port}${path}`, {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

  beforeAll(async () => {
    dir = mkdtempSync(join(root, "gw-"));
    writeFileSync(join(dir, "servers.json"), JSON.stringify({ servers: {} }));
    mkdirSync(join(dir, "docx"), { recursive: true });
    skillFile = join(dir, "docx", "SKILL.md");
    writeFileSync(skillFile, "original body");
    writeFileSync(
      join(dir, "skills.json"),
      JSON.stringify({ skills: { docx: { description: "d", keywords: [], path: skillFile } } })
    );
    const tokens = new TokenStore(dir);
    adminToken = tokens.create({ user: "root", admin: true }).token;
    aliceToken = tokens.create({ user: "alice" }).token;
    bobToken = tokens.create({ user: "bob" }).token;
    const registry = loadRegistry(["--config", join(dir, "servers.json")], dir);
    hashes = registry.skillHashes;
    gw = await startGateway({
      registry,
      tokens,
      secrets: new SecretStore(dir, {}),
      profiles: new UserProfileStore(dir),
      audit: new AuditLog(auditPath()),
      port: 0,
    });
  });
  afterAll(async () => {
    await gw.close();
  });

  it("records 401 on /mcp and /ui/api without logging the token", async () => {
    const bad = "lzg_deadbeef_notarealsecretnotarealsecretXYZ";
    expect((await mcp({ Authorization: `Bearer ${bad}` })).status).toBe(401);
    expect((await ui("/ui/api/me", bad)).status).toBe(401);
    const raw = readFileSync(auditPath(), "utf-8");
    expect(raw).not.toContain("notarealsecret");
    const failed = events().filter((e) => e.action === "auth.failed");
    expect(failed.map((e) => e.session)).toEqual(expect.arrayContaining(["mcp", "ui"]));
    expect(failed.every((e) => e.ok === false && typeof e.ip === "string")).toBe(true);
  });

  it("records session creation and a session-id/user mismatch (404)", async () => {
    const created = await mcp({ Authorization: `Bearer ${aliceToken}` });
    expect(created.status).toBe(200);
    const sid = created.headers.get("mcp-session-id")!;
    expect(events().some((e) => e.action === "session.create" && e.user === "alice" && e.ok === true)).toBe(true);

    const stolen = await mcp(
      { Authorization: `Bearer ${bobToken}`, "Mcp-Session-Id": sid },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }
    );
    expect(stolen.status).toBe(404);
    const mismatch = events().find((e) => e.action === "session.mismatch");
    expect(mismatch).toMatchObject({ user: "bob", ok: false });
    expect(JSON.stringify(mismatch)).not.toContain(sid); // only a prefix of the id
  });

  it("records an admin-required denial (403)", async () => {
    expect((await ui("/ui/api/tokens", aliceToken)).status).toBe(403);
    expect(events().some((e) => e.action === "auth.denied" && e.user === "alice" && e.ok === false)).toBe(true);
  });

  it("exposes a `changed` flag in the skills catalog and lets an admin acknowledge it", async () => {
    hashes.observe("docx", "original body");
    const before = (await (await ui("/ui/api/catalog/skills", adminToken)).json()) as { skills: Array<{ name: string; changed: boolean }> };
    expect(before.skills.find((s) => s.name === "docx")?.changed).toBe(false);

    writeFileSync(skillFile, "tampered body");
    const after = (await (await ui("/ui/api/catalog/skills", adminToken)).json()) as { skills: Array<{ name: string; changed: boolean }> };
    expect(after.skills.find((s) => s.name === "docx")?.changed).toBe(true);

    expect((await ui("/ui/api/skills/docx/ack-hash", aliceToken, "POST")).status).toBe(403);
    expect((await ui("/ui/api/skills/docx/ack-hash", adminToken, "POST")).status).toBe(200);
    const acked = (await (await ui("/ui/api/catalog/skills", adminToken)).json()) as { skills: Array<{ name: string; changed: boolean }> };
    expect(acked.skills.find((s) => s.name === "docx")?.changed).toBe(false);
  });

  it("rate limits repeated failures per IP with 429 + Retry-After (runs last)", async () => {
    let last = 0;
    let retry: string | null = null;
    for (let i = 0; i < 25; i++) {
      const r = await mcp({ Authorization: "Bearer lzg_aaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
      last = r.status;
      retry = r.headers.get("retry-after");
      if (last === 429) break;
    }
    expect(last).toBe(429);
    expect(Number(retry)).toBeGreaterThan(0);
    // A valid token from the same address is also held back during the lockout window.
    expect((await ui("/ui/api/me", adminToken)).status).toBe(429);
    expect(events().some((e) => e.action === "auth.rate_limited")).toBe(true);
  });
});

// ── M5 ────────────────────────────────────────────────────────────────────────

describe("M5: private targets are opt-in; the connection is pinned to the validated IP", () => {
  const cfg = (ctx: Record<string, unknown>): SkillConfig => ({
    description: "",
    keywords: [],
    path: "/x",
    prompt: { context: [{ name: "c", ...ctx } as never] },
  });

  it("refuses an https URL on a private address unless the entry sets allowPrivate", async () => {
    const config = cfg({ url: "https://10.255.255.1/x", timeoutMs: 300 });
    await expect(composePrompt({ body: "{{context.c}}", config })).rejects.toThrow(/private\/link-local/);

    const optIn = cfg({ url: "https://10.255.255.1/x", timeoutMs: 300, allowPrivate: true });
    // Passes the SSRF check; fails later on the (unroutable) connection instead.
    const err = (await composePrompt({ body: "{{context.c}}", config: optIn }).then(
      () => undefined,
      (e: unknown) => e
    )) as { message?: string } | undefined;
    expect(err).toBeDefined();
    expect(String(err?.message)).not.toMatch(/private\/link-local/);
  });

  it("never allows the cloud metadata address, even with allowPrivate", async () => {
    await expect(resolveSafeUrl("https://169.254.169.254/latest", { allowPrivate: true })).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(resolveSafeUrl("https://127.0.0.2/", { allowPrivate: true })).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(resolveSafeUrl("https://192.168.1.5/", { allowPrivate: true })).resolves.toMatchObject({ address: "192.168.1.5" });
    await expect(resolveSafeUrl("https://192.168.1.5/")).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("accepts allowPrivate in the skills.json schema", () => {
    const { entries, errors } = parseSkillsConfig(
      { skills: { s: { path: "/x/SKILL.md", prompt: { context: [{ name: "c", url: "https://x.internal/y", allowPrivate: true }] } } } },
      "skills.json"
    );
    expect(errors).toEqual([]);
    expect(entries.s.prompt?.context?.[0].allowPrivate).toBe(true);
  });

  it("pinnedFetch connects to the resolved address and keeps the original Host header", async () => {
    let seenHost: string | undefined;
    const srv = await listenDualStack((req, res) => {
      seenHost = req.headers.host;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("pinned-ok");
    });
    try {
      const r = await pinnedFetch(`http://localhost:${srv.port}/p?q=1`);
      expect(r.status).toBe(200);
      expect(await r.text()).toBe("pinned-ok");
      expect(seenHost).toBe(`localhost:${srv.port}`);
    } finally {
      await srv.close();
    }
  });

  it("composePrompt still fetches loopback http context without any opt-in", async () => {
    const srv = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    try {
      const r = await composePrompt({ body: "{{context.c}}", config: cfg({ url: `http://127.0.0.1:${srv.port}/` }) });
      expect(r.text).toContain('"ok": true');
    } finally {
      await srv.close();
    }
  });
});

// ── R2 ────────────────────────────────────────────────────────────────────────

describe("R2: scratch cwd and private file modes", () => {
  it("creates a per-manager scratch dir outside the config dir and removes it on dispose", () => {
    const pm = new ProcessManager({ scratchCwd: true, idleTtlMs: 0 });
    const dir = pm.scratchDirectory()!;
    expect(existsSync(dir)).toBe(true);
    expect(dir).not.toContain(".config");
    expect(pm.scratchDirectory()).toBe(dir); // stable within a session
    pm.dispose();
    expect(existsSync(dir)).toBe(false);
  });

  it("runs stdio children through the operator's LAZYGATE_STDIO_WRAPPER-style prefix", async () => {
    const fixture = join(process.cwd(), "src", "__tests__", "fixtures", "tickets-server.mjs");
    const marker = join(root, "wrapped.txt");
    const wrapper = join(root, "wrap.sh");
    writeFileSync(wrapper, `#!/bin/sh\necho wrapped > "${marker}"\nexec "$@"\n`);
    chmodSync(wrapper, 0o755);
    const pm = new ProcessManager({ idleTtlMs: 0, stdioWrapper: [wrapper] });
    try {
      await pm.activate("t", { description: "t", keywords: [], command: "node", args: [fixture], autoActivate: false });
      expect(readFileSync(marker, "utf8").trim()).toBe("wrapped");
    } finally {
      pm.dispose();
    }
  });

  it("does nothing when scratchCwd is off", () => {
    const pm = new ProcessManager({ idleTtlMs: 0 });
    expect(pm.scratchDirectory()).toBeUndefined();
    pm.dispose();
  });

  it("tightens gateway state files to 0600 and directories to 0700", () => {
    if (process.platform === "win32") return;
    const cfg = join(root, "cfg");
    const gwd = join(cfg, "gateway");
    mkdirSync(join(cfg, "tokens", "users", "alice"), { recursive: true });
    mkdirSync(gwd, { recursive: true });
    const files = [
      join(cfg, "token.key"),
      join(cfg, "tokens", "users", "alice", "s.json"),
      join(gwd, "secrets.json"),
      join(gwd, "vault.json"),
    ];
    for (const f of files) {
      writeFileSync(f, "x");
      chmodSync(f, 0o644);
    }
    chmodSync(join(cfg, "tokens"), 0o755);
    chmodSync(join(cfg, "tokens", "users"), 0o755);
    chmodSync(gwd, 0o755);
    const fixed = hardenGatewayDirs(cfg, gwd);
    expect(fixed.length).toBeGreaterThanOrEqual(files.length);
    for (const f of files) expect(statSync(f).mode & 0o077).toBe(0);
    for (const d of [gwd, join(cfg, "tokens"), join(cfg, "tokens", "users")]) expect(statSync(d).mode & 0o077).toBe(0);
    expect(hardenGatewayDirs(cfg, gwd)).toEqual([]); // idempotent
  });
});

// ── M11 / M12 ────────────────────────────────────────────────────────────────

const srv = (o: Partial<ServerConfig> = {}): ServerConfig => ({
  description: "Test server",
  keywords: [],
  command: "node",
  autoActivate: false,
  ...o,
});

function fakeManager() {
  const active = new Map<string, MCPTool[]>();
  const call = jest.fn(async (_s: string, t: string) => ({ content: [{ type: "text", text: JSON.stringify({ tool: t }) }] }));
  const manager = {
    activate: jest.fn(async (name: string) => {
      const tools: MCPTool[] = [
        { name: "read_items", description: "Read.", inputSchema: {}, annotations: { readOnlyHint: true }, serverName: name },
        { name: "wipe", description: "Wipe all.", inputSchema: {}, annotations: { destructiveHint: true }, serverName: name },
      ];
      active.set(name, tools);
      return tools;
    }),
    deactivate: jest.fn((n: string) => active.delete(n)),
    listActive: jest.fn(() => [...active.keys()]),
    getAllActiveTools: jest.fn(() => [...active.values()].flat()),
    findServerForTool: jest.fn(() => undefined),
    callTool: call,
  };
  return { manager, call };
}

describe("M11: upstream annotations", () => {
  it("surfaces readOnlyHint/destructiveHint in describe_tool and the tool list", async () => {
    const mk = fakeManager();
    const router = new ToolRouter({ s: srv({ toolChain: true, expose: "all" }) });
    const broker = createBroker({ router, manager: mk.manager as unknown as ProcessManager, skillRouter: null });
    const d = await broker.callTool("describe_tool", { server: "s", tool: "wipe" });
    const t = (d.content[0] as { text: string }).text;
    expect(t).toContain("destructive");
    expect(t).toContain('"destructiveHint": true');
    const ro = (await broker.callTool("describe_tool", { server: "s", tool: "read_items" })).content[0] as { text: string };
    expect(ro.text).toContain("read-only");
    const listed = broker.listTools().tools.find((x) => x.name === "wipe");
    expect(listed?.description).toContain("destructive");
  });

  it("call_tool results carry the upstream hints in _meta", async () => {
    const mk = fakeManager();
    const router = new ToolRouter({ s: srv() });
    const broker = createBroker({ router, manager: mk.manager as unknown as ProcessManager, skillRouter: null });
    const r = (await broker.callTool("call_tool", { server: "s", tool: "wipe", args: {} })) as { _meta?: { lazygate?: { annotations: string[] } } };
    expect(r._meta?.lazygate?.annotations).toContain("destructive");
    const ro = (await broker.callTool("call_tool", { server: "s", tool: "read_items", args: {} })) as { _meta?: { lazygate?: { annotations: string[] } } };
    expect(ro._meta?.lazygate?.annotations).toEqual(["read-only"]);
  });

  it("run_chain refuses a destructive tool under toolChain: true, allows it when named explicitly", async () => {
    const run = async (toolChain: ServerConfig["toolChain"]) => {
      const mk = fakeManager();
      const router = new ToolRouter({ s: srv({ toolChain }) });
      const broker = createBroker({ router, manager: mk.manager as unknown as ProcessManager, skillRouter: null });
      const r = await broker.callTool("run_chain", {
        code: "const a = await servers.s.read_items({}); const b = await servers.s.wipe({}); return [a, b];",
      });
      return { r, mk, text: (r.content[0] as { text: string }).text };
    };

    const open = await run(true);
    expect(open.text).toMatch(/marked destructive/);
    expect(open.mk.call).toHaveBeenCalledTimes(1); // read_items only
    expect(open.mk.call).not.toHaveBeenCalledWith("s", "wipe", expect.anything());

    const explicit = await run(["read_items", "wipe"]);
    expect(explicit.text).not.toMatch(/marked destructive/);
    expect(explicit.mk.call).toHaveBeenCalledWith("s", "wipe", expect.anything());
  });
});

describe("M12: skill hashes and provenance", () => {
  function setup(extra: Partial<SkillConfig> = {}) {
    const dir = mkdtempSync(join(root, "skill-"));
    writeFileSync(join(dir, "SKILL.md"), "---\n---\n");
    writeFileSync(join(dir, "INSTRUCTIONS.md"), "v1 body");
    const skills = new SkillRouter({ s: { description: "d", keywords: ["s"], path: join(dir, "SKILL.md"), ...extra } });
    const hashFile = join(dir, "skills-hashes.json");
    const skillHashes = new SkillHashStore(hashFile);
    const mk = fakeManager();
    const broker = createBroker({
      router: new ToolRouter({}),
      manager: mk.manager as unknown as ProcessManager,
      skillRouter: skills,
      skillHashes,
    });
    const load = async () => ((await broker.callTool("load_skill", { skill_name: "s" })).content[0] as { text: string }).text;
    return { dir, hashFile, load, skillHashes };
  }

  it("records a SHA-256 baseline in a 0600 state file and warns when the body changes", async () => {
    const { dir, hashFile, load } = setup();
    const first = await load();
    expect(first).not.toContain("WARNING");
    const saved = JSON.parse(readFileSync(hashFile, "utf-8")) as Record<string, { sha256: string }>;
    expect(saved.s.sha256).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== "win32") expect(statSync(hashFile).mode & 0o077).toBe(0);

    expect(await load()).not.toContain("WARNING"); // unchanged

    writeFileSync(join(dir, "INSTRUCTIONS.md"), "v2 body — now with telemetry");
    const changed = await load();
    expect(changed).toMatch(/WARNING: skill "s" content has changed/);
    expect(changed.indexOf("WARNING")).toBeLessThan(changed.indexOf("# Skill: s"));
  });

  it("persists the baseline across store instances", async () => {
    const { dir, hashFile, skillHashes } = setup();
    skillHashes.observe("s", "v1 body");
    const reopened = new SkillHashStore(hashFile);
    expect(reopened.peek("s", "v1 body").changed).toBe(false);
    expect(reopened.peek("s", "other").changed).toBe(true);
    reopened.acknowledge("s", "other");
    expect(new SkillHashStore(hashFile).peek("s", "other").changed).toBe(false);
    expect(dir).toBeTruthy();
  });

  it("labels plugin and migratedFrom provenance ahead of the skill", async () => {
    const plugin = await setup({ plugin: "security-analyst" }).load();
    expect(plugin.startsWith("> Source: plugin:security-analyst")).toBe(true);
    const migrated = await setup({ migratedFrom: "claude" }).load();
    expect(migrated.startsWith("> Source: migratedFrom:claude")).toBe(true);
    const local = await setup().load();
    expect(local.startsWith("# Skill: s")).toBe(true);
  });
});

// ── M2 ────────────────────────────────────────────────────────────────────────

describe("M2: startup warnings", () => {
  const stdio = (o: Partial<ServerConfig> = {}): ServerConfig => srv({ command: "node", ...o });
  const http = (o: Partial<ServerConfig> = {}): ServerConfig => srv({ command: undefined, url: "https://x.example/mcp", type: "http", auth: { scope: "server" }, ...o });

  it("warns about stdio and http shared-scope servers visible to several groups", () => {
    const w = gatewayStartupWarnings({
      servers: {
        sh: stdio({ groups: ["a", "b"] }),
        ht: http(),
        ok: stdio({ groups: ["a"] }),
        perUser: stdio({ auth: { scope: "user" } }),
      },
      skills: {},
      userCount: 1,
    });
    expect(w.some((x) => x.includes('stdio server "sh"'))).toBe(true);
    expect(w.some((x) => x.includes('server "ht"'))).toBe(true);
    expect(w.some((x) => x.includes('"ok"'))).toBe(false);
    expect(w.some((x) => x.includes('"perUser"'))).toBe(false);
  });

  it("warns about entries without groups only when more than one user has a token", () => {
    const input = {
      servers: { a: stdio({ auth: { scope: "user" } }) },
      skills: { sk: { description: "", keywords: [], path: "/x" } as SkillConfig },
    };
    expect(gatewayStartupWarnings({ ...input, userCount: 1 })).toEqual([]);
    const w = gatewayStartupWarnings({ ...input, userCount: 2 });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('server "a"');
    expect(w[0]).toContain('skill "sk"');
  });
});
