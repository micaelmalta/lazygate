// src/__tests__/gateway-ui.test.ts
// The gateway web UI: static assets, token-gated API, admin split, stored per-user credentials.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadRegistry } from "../registry.js";
import { startGateway, type Gateway } from "../gateway/server.js";
import { TokenStore } from "../gateway/tokens.js";
import { SecretStore } from "../gateway/credentials.js";
import { UserVault, mergeCreds } from "../gateway/vault.js";
import { UserProfileStore } from "../gateway/profile.js";
import { AuditLog } from "../gateway/audit.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/cred-server.mjs", import.meta.url));
const rev = (s: string) => [...s].reverse().join("");

let dir: string;
let gw: Gateway;
let admin: string;
let alice: string;
let bob: string;
const clients: Client[] = [];

async function ui(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${gw.port}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function connect(token: string, headers: Record<string, string> = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(gw.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, ...headers } },
  });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  clients.push(client);
  return client;
}
const call = (c: Client, name: string, args: Record<string, unknown> = {}) =>
  c.callTool({ name, arguments: args }) as Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lzg-ui-"));
  const server = (prefix: string, auth: unknown) => ({
    description: `${prefix} test server`,
    keywords: [prefix],
    command: process.execPath,
    args: [FIXTURE],
    env: { TOOL_PREFIX: prefix },
    inheritEnv: false,
    auth,
  });
  writeFileSync(
    join(dir, "servers.json"),
    JSON.stringify({
      servers: {
        jira: server("jira", { scope: "user", env: { TEST_TOKEN: "${cred:token}" } }),
        shared: server("shared", { scope: "server", env: { TEST_TOKEN: "${secret:shared/token}" } }),
        plain: server("plain", undefined),
        githubish: {
          description: "PAT via header, not OAuth",
          keywords: ["github"],
          type: "http",
          url: "https://api.example.com/mcp",
          headers: { Authorization: "Bearer ${GITHUB_TOKEN}" },
        },
      },
    })
  );
  const skillPath = join(dir, "docx-skill", "SKILL.md");
  mkdirSync(join(dir, "docx-skill"), { recursive: true });
  writeFileSync(skillPath, "---\nname: docx\n---\nMake a Word doc.\n");
  writeFileSync(
    join(dir, "skills.json"),
    JSON.stringify({
      skills: {
        docx: {
          description: "Create or edit Word documents",
          keywords: ["word", "docx"],
          path: skillPath,
        },
        missing: {
          description: "Skill whose file is gone",
          keywords: ["gone"],
          path: join(dir, "nope", "SKILL.md"),
        },
      },
    })
  );

  const tokens = new TokenStore(dir);
  admin = tokens.create({ user: "root", admin: true }).token;
  alice = tokens.create({ user: "alice", groups: ["eng"] }).token;
  bob = tokens.create({ user: "bob" }).token;
  const secrets = new SecretStore(dir, {});
  secrets.set("shared/token", "shared-secret-value");
  const profiles = new UserProfileStore(dir);
  // Alice (and admin) install every server so credential/MCP tests match pre-profile behavior.
  // Bob stays empty so marketplace install tests can start from uninstalled.
  const registry = loadRegistry(["--config", join(dir, "servers.json")], dir);
  for (const name of registry.router.listAll()) {
    profiles.installServer("alice", name);
    profiles.installServer("root", name);
  }
  for (const name of registry.skillRouter.listAll()) {
    profiles.installSkill("alice", name);
    profiles.installSkill("root", name);
  }

  gw = await startGateway({
    registry,
    tokens,
    secrets,
    vault: new UserVault(dir, {}),
    profiles,
    audit: new AuditLog(join(dir, "audit.log")),
    port: 0,
    idleMs: 60_000,
    maxSessionsPerUser: 50,
  });
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  await gw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("static assets", () => {
  it("serves the page, script and styles with a strict CSP", async () => {
    for (const [path, type] of [
      ["/ui", "text/html"],
      ["/ui/app.js", "text/javascript"],
      ["/ui/app.css", "text/css"],
    ]) {
      const r = await ui("GET", path);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain(type);
      expect(r.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(r.headers.get("content-security-policy")).not.toContain("fonts.googleapis.com");
      expect(r.headers.get("content-security-policy")).toContain("style-src 'self'");
      expect(r.headers.get("x-frame-options")).toBe("DENY");
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
    const page = (await ui("GET", "/ui")).text;
    expect(page).not.toMatch(/<script>[^<]/); // no inline script
    expect(page).not.toContain("fonts.googleapis.com");
  });

  it("ships a script that parses and never uses innerHTML", async () => {
    const js = (await ui("GET", "/ui/app.js")).text;
    expect(() => new Function(js)).not.toThrow();
    expect(js).not.toContain("innerHTML");
    expect(js).not.toMatch(/style\s*:/); // inline styles are blocked by the CSP
    expect(js).toContain("catalog/servers");
    expect(js).toContain("catalog/skills");
    expect(js).toContain("profile/servers/");
    expect(js).toContain("profile/skills/");
    expect(js).toContain("Configure");
    expect(js).toContain("Disable");
    expect(js).toContain("Enable");
    expect(js).toContain("serverSheet");
    expect(js).toContain("skillSheet");
    expect(js).toContain("Manage servers");
    expect(js).toContain("Manage skills");
    expect(js).toContain("USER_TABS");
    expect(js).toContain("ADMIN_TABS");
    expect(js).toContain("manage-mcps");
    expect(js).toContain("manage-skills");
    expect(js).toContain("adminCatalog");
    expect(js).toContain("admin-menu");
    expect(js).toContain("TOKEN_TTL_MS");
    expect(js).toContain("lazygate.tokenAt");
    expect(js).toContain("commandAllowlist");
    expect(js).not.toContain("serversView");
    expect(js).not.toContain("Server settings");
  });

  it("rejects foreign Host headers", async () => {
    const res = await fetch(`http://127.0.0.1:${gw.port}/ui`, { headers: { Host: "evil.example" } }).catch(() => null);
    // fetch forbids overriding Host in some runtimes; when it can, the gateway must refuse.
    if (res && new URL(res.url).host !== `127.0.0.1:${gw.port}`) expect(res.status).toBe(403);
  });
});

describe("API authentication", () => {
  it("needs a token", async () => {
    expect((await ui("GET", "/ui/api/me")).status).toBe(401);
    expect((await ui("GET", "/ui/api/me", "lzg_00000000_nope")).status).toBe(401);
  });

  it("reports who you are", async () => {
    const a = await ui("GET", "/ui/api/me", admin);
    expect(a.json).toMatchObject({ user: "root", admin: true, vault: true });
    const b = await ui("GET", "/ui/api/me", alice);
    expect(b.json).toMatchObject({ user: "alice", admin: false, groups: ["eng"] });
    expect(b.json.configPath).toBeUndefined();
  });

  it("keeps admin endpoints away from non-admins", async () => {
    for (const [m, p] of [
      ["GET", "/ui/api/tokens"],
      ["GET", "/ui/api/secrets"],
      ["GET", "/ui/api/status"],
      ["GET", "/ui/api/servers"],
      ["POST", "/ui/api/tool-index/rebuild"],
    ]) {
      expect((await ui(m, p, alice, m === "POST" ? {} : undefined)).status).toBe(403);
    }
  });
});

describe("tool-index rebuild (admin)", () => {
  it("indexes shared-scope servers and skips user-scoped ones", async () => {
    const r = await ui("POST", "/ui/api/tool-index/rebuild", admin, {});
    expect(r.status).toBe(200);
    const names = (r.json.indexed || []).map((x: { name: string }) => x.name);
    expect(names).toEqual(expect.arrayContaining(["plain", "shared"]));
    expect(names).not.toContain("jira");
    expect(r.json.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "jira", reason: expect.stringMatching(/user-scoped/) }),
      ])
    );
  }, 60_000);
});

describe("tokens (admin)", () => {
  it("creates a working token, lists it without the secret, and revokes it", async () => {
    const made = await ui("POST", "/ui/api/tokens", admin, { user: "carol", groups: ["eng", " sre "], expires: "1d", label: "laptop" });
    expect(made.status).toBe(200);
    expect(made.json.token).toMatch(/^lzg_[0-9a-f]{8}_/);

    expect((await ui("GET", "/ui/api/me", made.json.token)).json).toMatchObject({ user: "carol", groups: ["eng", "sre"], admin: false });

    const list = await ui("GET", "/ui/api/tokens", admin);
    expect(JSON.stringify(list.json)).not.toContain(made.json.token.split("_")[2]);
    expect(list.json.tokens.find((t: any) => t.id === made.json.id)).toMatchObject({ user: "carol", label: "laptop" });

    expect((await ui("DELETE", `/ui/api/tokens/${made.json.id}`, admin)).status).toBe(204);
    expect((await ui("GET", "/ui/api/me", made.json.token)).status).toBe(401);
  });

  it("can mint an admin token, validates input, and won't revoke the token in use", async () => {
    const made = await ui("POST", "/ui/api/tokens", admin, { user: "dave", admin: true });
    expect((await ui("GET", "/ui/api/tokens", made.json.token)).status).toBe(200);

    expect((await ui("POST", "/ui/api/tokens", admin, { user: "bad name!" })).status).toBe(400);
    expect((await ui("POST", "/ui/api/tokens", admin, { user: "ok", expires: "soon" })).status).toBe(400);

    const own = (await ui("GET", "/ui/api/tokens", admin)).json.tokens.find((t: any) => t.user === "root");
    expect((await ui("DELETE", `/ui/api/tokens/${own.id}`, admin)).status).toBe(409);
  });
});

describe("secrets (admin)", () => {
  it("stores, lists names only, and deletes", async () => {
    expect((await ui("PUT", "/ui/api/secrets", admin, { path: "datadog/api_key", value: "dd-super-secret" })).status).toBe(200);
    const list = await ui("GET", "/ui/api/secrets", admin);
    expect(list.json.secrets).toContain("datadog/api_key");
    expect(list.text).not.toContain("dd-super-secret");
    expect(readFileSync(join(dir, "secrets.json"), "utf-8")).toContain("dd-super-secret");
    expect(list.json.required).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "shared/token", servers: ["shared"], stored: true })])
    );

    expect((await ui("PUT", "/ui/api/secrets", admin, { path: "../etc", value: "x" })).status).toBe(400);
    expect((await ui("DELETE", "/ui/api/secrets?path=datadog%2Fapi_key", admin)).status).toBe(204);
    expect((await ui("DELETE", "/ui/api/secrets?path=datadog%2Fapi_key", admin)).status).toBe(404);
  });

  it("exposes secretRefs on servers for the admin settings UI", async () => {
    const r = await ui("GET", "/ui/api/servers", admin);
    const shared = r.json.servers.find((s: any) => s.name === "shared");
    expect(shared.secretRefs).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "shared/token", stored: true })])
    );
  });
});

describe("admin mutation audit", () => {
  it("records token, secret, server and skill mutations with hashes (never secret values)", async () => {
    const prev = process.env.LAZYGATE_ALLOWED_COMMANDS;
    process.env.LAZYGATE_ALLOWED_COMMANDS = process.execPath;
    try {
      const made = await ui("POST", "/ui/api/tokens", admin, { user: "auditee", groups: ["eng"], expires: "1h" });
      expect(made.status).toBe(200);
      expect((await ui("DELETE", `/ui/api/tokens/${made.json.id}`, admin)).status).toBe(204);

      expect((await ui("PUT", "/ui/api/secrets", admin, { path: "audit/probe", value: "never-log-this-secret" })).status).toBe(200);
      expect((await ui("DELETE", "/ui/api/secrets?path=audit%2Fprobe", admin)).status).toBe(204);

      const srv = await ui("POST", "/ui/api/servers", admin, {
        name: "audited-srv",
        command: process.execPath,
        args: ["-e", "1"],
      });
      expect(srv.status).toBe(200);
      expect((await ui("PATCH", "/ui/api/servers/audited-srv", admin, { description: "audited" })).status).toBe(200);
      expect((await ui("DELETE", "/ui/api/servers/audited-srv", admin)).status).toBe(204);

      const sk = await ui("POST", "/ui/api/skills", admin, {
        name: "audited-skill",
        description: "x",
        body: "do the thing",
      });
      expect(sk.status).toBe(200);
      expect((await ui("PUT", "/ui/api/skills/audited-skill", admin, { description: "y", body: "updated" })).status).toBe(200);
      expect((await ui("DELETE", "/ui/api/skills/audited-skill", admin)).status).toBe(204);

      const log = readFileSync(join(dir, "audit.log"), "utf-8");
      expect(log).not.toContain("never-log-this-secret");
      expect(log).not.toContain(made.json.token);

      const events = (await ui("GET", "/ui/api/audit?all=1&limit=500", admin)).json.events as Array<Record<string, unknown>>;
      const actions = new Set(events.map((e) => e.action).filter(Boolean));
      for (const a of [
        "token.create",
        "token.revoke",
        "secret.set",
        "secret.delete",
        "server.create",
        "server.patch",
        "server.delete",
        "skill.create",
        "skill.update",
        "skill.delete",
      ]) {
        expect(actions.has(a)).toBe(true);
      }

      const secretSet = events.find((e) => e.action === "secret.set" && e.target === "audit/probe");
      expect(secretSet).toMatchObject({ user: "root", ok: true });
      expect(typeof secretSet?.beforeHash).toBe("string");
      expect(typeof secretSet?.afterHash).toBe("string");

      const serverPatch = events.find((e) => e.action === "server.patch" && e.target === "audited-srv");
      expect(serverPatch?.beforeHash).toBeTruthy();
      expect(serverPatch?.afterHash).toBeTruthy();
      expect(serverPatch?.beforeHash).not.toBe(serverPatch?.afterHash);
    } finally {
      if (prev === undefined) delete process.env.LAZYGATE_ALLOWED_COMMANDS;
      else process.env.LAZYGATE_ALLOWED_COMMANDS = prev;
    }
  });
});

describe("my credentials (vault)", () => {
  it("lists only servers that need a personal credential", async () => {
    const r = await ui("GET", "/ui/api/connections", alice);
    expect(r.json.connections.map((c: any) => c.server)).toEqual(["jira"]);
    expect(r.json.connections[0].fields[0]).toMatchObject({ name: "token", stored: false, header: "X-Lazygate-Cred-jira-token" });
  });

  it("does not offer OAuth Connect for HTTP servers that already set Authorization", async () => {
    const r = await ui("GET", "/ui/api/connections", admin);
    expect(r.json.connections.find((c: any) => c.server === "githubish")).toBeUndefined();
    expect((await ui("POST", "/ui/api/connections/githubish/oauth", admin, {})).status).toBe(400);
  });

  it("encrypts stored values, never returns them, and uses them in MCP sessions", async () => {
    const KEY = "alice-ui-key-777";
    expect((await ui("PUT", "/ui/api/connections/jira/token", alice, { value: KEY })).status).toBe(200);

    const list = await ui("GET", "/ui/api/connections", alice);
    expect(list.json.connections[0].fields[0].stored).toBe(true);
    expect(list.text).not.toContain(KEY);
    expect(readFileSync(join(dir, "vault.json"), "utf-8")).not.toContain(KEY);
    expect(readdirSync(dir)).not.toContain("vault.key");

    // No credential header: the stored key is used.
    const client = await connect(alice);
    const act = await call(client, "activate_server", { server_name: "jira" });
    expect(act.isError).toBeFalsy();
    expect((await call(client, "jira_probe")).content[0].text).toBe(`len:${KEY.length}:${rev(KEY)}`);
    expect((await call(client, "jira_echo")).content[0].text).toBe("[redacted]");

    // Bob has jira installed but nothing stored: told what to send.
    await ui("POST", "/ui/api/profile/servers/jira", bob, {});
    const other = await connect(bob);
    const refused = await call(other, "activate_server", { server_name: "jira" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("X-Lazygate-Cred-jira-token");
  });

  it("lets a header override the stored value", async () => {
    const client = await connect(alice, { "X-Lazygate-Cred-jira-token": "header-key-999" });
    await call(client, "activate_server", { server_name: "jira" });
    expect((await call(client, "jira_probe")).content[0].text).toBe(`len:14:${rev("header-key-999")}`);
  });

  it("picks up a key saved after the session began", async () => {
    await ui("POST", "/ui/api/profile/servers/jira", bob, {});
    const client = await connect(bob);
    expect((await call(client, "activate_server", { server_name: "jira" })).isError).toBe(true);
    await ui("PUT", "/ui/api/connections/jira/token", bob, { value: "bob-late-key" });
    expect((await call(client, "activate_server", { server_name: "jira" })).isError).toBeFalsy();
    expect((await call(client, "jira_probe")).content[0].text).toBe(`len:12:${rev("bob-late-key")}`);
  });

  it("removes stored credentials", async () => {
    expect((await ui("DELETE", "/ui/api/connections/jira/token", bob)).status).toBe(204);
    expect((await ui("DELETE", "/ui/api/connections/jira/token", bob)).status).toBe(404);
  });

  it("refuses unknown servers, unknown fields and server-scope servers", async () => {
    expect((await ui("PUT", "/ui/api/connections/nope/token", alice, { value: "x" })).status).toBe(404);
    expect((await ui("PUT", "/ui/api/connections/jira/other", alice, { value: "x" })).status).toBe(404);
    expect((await ui("PUT", "/ui/api/connections/shared/token", alice, { value: "x" })).status).toBe(404);
    expect((await ui("PUT", "/ui/api/connections/jira/token", alice, { value: "" })).status).toBe(400);
  });
});

describe("status and activity", () => {
  it("shows live sessions to admins with their active servers", async () => {
    const client = await connect(alice);
    await call(client, "activate_server", { server_name: "jira" }); // stored key from earlier test
    const s = await ui("GET", "/ui/api/status", admin);
    expect(s.json.sessions.length).toBeGreaterThan(0);
    expect(s.json.sessions.some((x: any) => x.user === "alice" && x.servers.includes("jira"))).toBe(true);
    expect(JSON.stringify(s.json)).not.toContain("alice-ui-key-777");
  });

  it("limits the audit view to your own calls unless you are admin", async () => {
    const mine = await ui("GET", "/ui/api/audit", alice);
    expect(mine.json.events.length).toBeGreaterThan(0);
    expect(mine.json.events.every((e: any) => e.user === "alice")).toBe(true);

    const all = await ui("GET", "/ui/api/audit?all=1", admin);
    expect(new Set(all.json.events.map((e: any) => e.user)).size).toBeGreaterThan(1);

    const sneaky = await ui("GET", "/ui/api/audit?all=1", alice);
    expect(sneaky.json.events.every((e: any) => e.user === "alice")).toBe(true);
  });
});

describe("marketplace catalog", () => {
  beforeAll(async () => {
    // Ensure bob starts this suite with an empty install list (other suites may install for him).
    for (const name of ["githubish", "jira", "plain", "shared"]) {
      await ui("DELETE", `/ui/api/profile/servers/${name}`, bob);
    }
    for (const name of ["docx", "missing"]) {
      await ui("DELETE", `/ui/api/profile/skills/${name}`, bob);
    }
  });

  it("lists MCP servers for any signed-in user with connect status", async () => {
    const r = await ui("GET", "/ui/api/catalog/servers", bob);
    expect(r.status).toBe(200);
    const names = r.json.servers.map((s: any) => s.name).sort();
    expect(names).toEqual(["githubish", "jira", "plain", "shared"]);
    const jira = r.json.servers.find((s: any) => s.name === "jira");
    expect(jira).toMatchObject({
      needsCredentials: true,
      connected: false,
      installed: false,
      transport: "stdio",
      keywords: ["jira"],
    });
    expect(jira.target).toBeUndefined();
    const plain = r.json.servers.find((s: any) => s.name === "plain");
    expect(plain).toMatchObject({ needsCredentials: false, connected: true, installed: false });
  });

  it("lists skills including availability on disk", async () => {
    const r = await ui("GET", "/ui/api/catalog/skills", alice);
    expect(r.status).toBe(200);
    expect(r.json.configured).toBe(true);
    expect(r.json.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "docx", available: true, installed: true, keywords: ["word", "docx"] }),
        expect.objectContaining({ name: "missing", available: false, installed: true }),
      ])
    );
    expect(r.json.skills.find((s: any) => s.name === "docx").path).toBeUndefined();
  });

  it("shows catalog target and skill path to admins only", async () => {
    const bobServers = (await ui("GET", "/ui/api/catalog/servers", bob)).json.servers;
    expect(bobServers.every((s: any) => s.target === undefined)).toBe(true);
    const adminServers = (await ui("GET", "/ui/api/catalog/servers", admin)).json.servers;
    expect(adminServers.find((s: any) => s.name === "jira").target).toMatch(/cred-server|node/);

    const bobSkills = (await ui("GET", "/ui/api/catalog/skills", bob)).json.skills;
    expect(bobSkills.every((s: any) => s.path === undefined)).toBe(true);
    const adminSkills = (await ui("GET", "/ui/api/catalog/skills", admin)).json.skills;
    expect(adminSkills.find((s: any) => s.name === "docx").path).toMatch(/SKILL\.md$/);
  });

  it("does not require admin for the catalog", async () => {
    expect((await ui("GET", "/ui/api/catalog/servers", bob)).status).toBe(200);
    expect((await ui("GET", "/ui/api/catalog/skills", bob)).status).toBe(200);
    expect((await ui("GET", "/ui/api/catalog/servers")).status).toBe(401);
  });

  it("lets a user install and uninstall servers and skills", async () => {
    expect((await ui("POST", "/ui/api/profile/servers/jira", bob, {})).status).toBe(200);
    expect((await ui("GET", "/ui/api/catalog/servers", bob)).json.servers.find((s: any) => s.name === "jira").installed).toBe(true);
    expect((await ui("DELETE", "/ui/api/profile/servers/jira", bob)).status).toBe(204);
    expect((await ui("GET", "/ui/api/catalog/servers", bob)).json.servers.find((s: any) => s.name === "jira").installed).toBe(false);

    expect((await ui("POST", "/ui/api/profile/skills/docx", bob, {})).status).toBe(200);
    expect((await ui("GET", "/ui/api/catalog/skills", bob)).json.skills.find((s: any) => s.name === "docx").installed).toBe(true);
    expect((await ui("DELETE", "/ui/api/profile/skills/docx", bob)).status).toBe(204);

    expect((await ui("POST", "/ui/api/profile/servers/nope", bob, {})).status).toBe(404);
    expect((await ui("POST", "/ui/api/profile/servers/jira", alice, {})).status).toBe(200); // already installed → still 200
  });

  it("hides uninstalled servers from discover_tools", async () => {
    const client = await connect(bob);
    const found = await call(client, "discover_tools", { query: "jira" });
    expect(found.content[0].text).not.toMatch(/jira test server/);
    expect((await call(client, "activate_server", { server_name: "jira" })).isError).toBe(true);

    await ui("POST", "/ui/api/profile/servers/jira", bob, {});
    // New session picks up the install list
    const client2 = await connect(bob);
    // Still needs credentials — but server is known
    const act = await call(client2, "activate_server", { server_name: "jira" });
    expect(act.isError).toBe(true);
    expect(act.content[0].text).toMatch(/credentials|Failed to activate|needs/i);
    await ui("DELETE", "/ui/api/profile/servers/jira", bob);
  });
});

describe("admin catalog CRUD", () => {
  it("refuses non-admins", async () => {
    expect((await ui("POST", "/ui/api/servers", alice, { name: "x", command: "echo" })).status).toBe(403);
    expect((await ui("POST", "/ui/api/skills", alice, { name: "x", body: "hi" })).status).toBe(403);
  });

  it("creates, edits and deletes an MCP server", async () => {
    const prev = process.env.LAZYGATE_ALLOWED_COMMANDS;
    process.env.LAZYGATE_ALLOWED_COMMANDS = process.execPath;
    try {
      const created = await ui("POST", "/ui/api/servers", admin, {
        name: "curlish",
        description: "HTTP fetch helper",
        keywords: ["curl", "http"],
        command: process.execPath,
        args: ["-e", "console.log(1)"],
      });
      expect(created.status).toBe(200);
      expect(created.json.name).toBe("curlish");
      const onDisk = JSON.parse(readFileSync(join(dir, "servers.json"), "utf-8"));
      expect(onDisk.servers.curlish.command).toBe(process.execPath);

      const patched = await ui("PATCH", "/ui/api/servers/curlish", admin, {
        description: "Updated fetch helper",
        keywords: ["curl"],
      });
      expect(patched.status).toBe(200);
      expect(patched.json.description).toBe("Updated fetch helper");

      expect((await ui("DELETE", "/ui/api/servers/curlish", admin)).status).toBe(204);
      expect(JSON.parse(readFileSync(join(dir, "servers.json"), "utf-8")).servers.curlish).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.LAZYGATE_ALLOWED_COMMANDS;
      else process.env.LAZYGATE_ALLOWED_COMMANDS = prev;
    }
  });

  it("refuses stdio command edits unless the command is allowlisted", async () => {
    const prev = process.env.LAZYGATE_ALLOWED_COMMANDS;
    const prevStdio = process.env.LAZYGATE_STDIO_ALLOWLIST;
    delete process.env.LAZYGATE_ALLOWED_COMMANDS;
    delete process.env.LAZYGATE_STDIO_ALLOWLIST;
    try {
      const blocked = await ui("POST", "/ui/api/servers", admin, {
        name: "evil",
        command: "/bin/sh",
        args: ["-c", "id"],
      });
      expect(blocked.status).toBe(403);
      expect(blocked.json.error).toMatch(/LAZYGATE_ALLOWED_COMMANDS|allowlist|disabled/i);

      process.env.LAZYGATE_ALLOWED_COMMANDS = process.execPath;
      expect(
        (
          await ui("POST", "/ui/api/servers", admin, {
            name: "evil",
            command: "/bin/sh",
            args: ["-c", "id"],
          })
        ).status
      ).toBe(403);

      const ok = await ui("POST", "/ui/api/servers", admin, {
        name: "oknode",
        command: process.execPath,
        args: ["-e", "1"],
      });
      expect(ok.status).toBe(200);

      // Changing args without an allowlisted command fails; same command may keep args unchanged.
      expect(
        (await ui("PATCH", "/ui/api/servers/oknode", admin, { args: ["-e", "2"] })).status
      ).toBe(200);
      expect(
        (await ui("PATCH", "/ui/api/servers/oknode", admin, { command: "/bin/sh" })).status
      ).toBe(403);

      await ui("DELETE", "/ui/api/servers/oknode", admin);
    } finally {
      if (prev === undefined) delete process.env.LAZYGATE_ALLOWED_COMMANDS;
      else process.env.LAZYGATE_ALLOWED_COMMANDS = prev;
      if (prevStdio === undefined) delete process.env.LAZYGATE_STDIO_ALLOWLIST;
      else process.env.LAZYGATE_STDIO_ALLOWLIST = prevStdio;
    }
  });

  it("creates, edits and deletes a managed skill with inline body", async () => {
    const created = await ui("POST", "/ui/api/skills", admin, {
      name: "memo",
      description: "Write a short memo",
      keywords: ["memo", "note"],
      body: "Always start with a date line.",
    });
    expect(created.status).toBe(200);
    expect(created.json.body).toContain("date line");
    expect(created.json.managed).toBe(true);
    expect(existsSync(created.json.path)).toBe(true);

    const updated = await ui("PUT", "/ui/api/skills/memo", admin, {
      description: "Memos",
      keywords: ["memo"],
      body: "Use bullet points.",
    });
    expect(updated.status).toBe(200);
    expect(updated.json.body).toContain("bullet");

    await ui("POST", "/ui/api/profile/skills/memo", alice, {});
    const client = await connect(alice);
    const loaded = await call(client, "load_skill", { skill_name: "memo" });
    expect(loaded.isError).toBeFalsy();
    expect(loaded.content[0].text).toContain("bullet points");

    const memoPath = created.json.path as string;
    const memoDir = join(dir, "managed-skills", "memo");
    expect(existsSync(memoDir)).toBe(true);

    // Sibling under managed-skills must survive delete of memo only.
    const keep = await ui("POST", "/ui/api/skills", admin, {
      name: "keep-sibling",
      description: "Stay",
      body: "Do not delete me.",
    });
    expect(keep.status).toBe(200);
    const keepDir = join(dir, "managed-skills", "keep-sibling");

    expect((await ui("DELETE", "/ui/api/skills/memo", admin)).status).toBe(204);
    expect(existsSync(memoDir)).toBe(false);
    expect(existsSync(memoPath)).toBe(false);
    expect(existsSync(keepDir)).toBe(true);
    expect(existsSync(join(dir, "managed-skills"))).toBe(true);
    expect((await ui("GET", "/ui/api/catalog/skills", alice)).json.skills.find((s: any) => s.name === "memo")).toBeUndefined();

    // Path aimed at the managed root must not wipe other skills.
    const skillsPath = join(dir, "skills.json");
    const skillsFile = JSON.parse(readFileSync(skillsPath, "utf-8"));
    skillsFile.skills["bogus-root"] = {
      description: "unsafe path",
      keywords: [],
      path: join(dir, "managed-skills"),
    };
    writeFileSync(skillsPath, JSON.stringify(skillsFile, null, 2) + "\n");
    expect((await ui("DELETE", "/ui/api/skills/bogus-root", admin)).status).toBe(204);
    expect(existsSync(keepDir)).toBe(true);

    await ui("DELETE", "/ui/api/skills/keep-sibling", admin);
  });

  it("disables servers and skills for non-admins while admins still see them", async () => {
    await ui("POST", "/ui/api/profile/servers/plain", bob, {});
    expect((await ui("GET", "/ui/api/catalog/servers", bob)).json.servers.find((s: any) => s.name === "plain")).toBeTruthy();

    const disabled = await ui("PATCH", "/ui/api/servers/plain", admin, { disabled: true });
    expect(disabled.status).toBe(200);
    expect(disabled.json.disabled).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "servers.json"), "utf-8")).servers.plain.disabled).toBe(true);

    expect((await ui("GET", "/ui/api/catalog/servers", bob)).json.servers.find((s: any) => s.name === "plain")).toBeUndefined();
    const adminPlain = (await ui("GET", "/ui/api/catalog/servers", admin)).json.servers.find((s: any) => s.name === "plain");
    expect(adminPlain).toMatchObject({ disabled: true });

    const client = await connect(bob);
    const act = await call(client, "activate_server", { server_name: "plain" });
    expect(act.isError).toBe(true);
    expect(act.content[0].text).toMatch(/Unknown server|"plain"/);

    await ui("PATCH", "/ui/api/servers/plain", admin, { disabled: false });
    expect((await ui("GET", "/ui/api/catalog/servers", bob)).json.servers.find((s: any) => s.name === "plain")).toBeTruthy();

    await ui("POST", "/ui/api/skills", admin, {
      name: "gated",
      description: "Temporarily gated",
      keywords: ["gated"],
      body: "Secret instructions.",
    });
    await ui("POST", "/ui/api/profile/skills/gated", bob, {});
    expect((await ui("PUT", "/ui/api/skills/gated", admin, { disabled: true })).json.disabled).toBe(true);
    expect((await ui("GET", "/ui/api/catalog/skills", bob)).json.skills.find((s: any) => s.name === "gated")).toBeUndefined();
    expect((await ui("GET", "/ui/api/catalog/skills", admin)).json.skills.find((s: any) => s.name === "gated").disabled).toBe(true);

    const client2 = await connect(bob);
    const load = await call(client2, "load_skill", { skill_name: "gated" });
    expect(load.isError).toBe(true);

    await ui("PUT", "/ui/api/skills/gated", admin, { disabled: false });
    const client3 = await connect(bob);
    expect((await call(client3, "load_skill", { skill_name: "gated" })).isError).toBeFalsy();
    await ui("DELETE", "/ui/api/skills/gated", admin);
    await ui("DELETE", "/ui/api/profile/servers/plain", bob);
  });

  it("restricts skill catalog/install by groups (parity with servers)", async () => {
    const created = await ui("POST", "/ui/api/skills", admin, {
      name: "sre-only-skill",
      description: "SRE runbook",
      keywords: ["sre", "runbook"],
      groups: ["sre"],
      body: "Page the on-call.",
    });
    expect(created.status).toBe(200);
    expect(created.json.groups).toEqual(["sre"]);
    expect(JSON.parse(readFileSync(join(dir, "skills.json"), "utf-8")).skills["sre-only-skill"].groups).toEqual([
      "sre",
    ]);

    // alice is eng — cannot see or install
    expect(
      (await ui("GET", "/ui/api/catalog/skills", alice)).json.skills.find((s: any) => s.name === "sre-only-skill")
    ).toBeUndefined();
    expect((await ui("POST", "/ui/api/profile/skills/sre-only-skill", alice, {})).status).toBe(404);

    // Create a token in the sre group and install
    const sreTok = (await ui("POST", "/ui/api/tokens", admin, { user: "sam", groups: ["sre"] })).json.token as string;
    expect(
      (await ui("GET", "/ui/api/catalog/skills", sreTok)).json.skills.find((s: any) => s.name === "sre-only-skill")
    ).toMatchObject({ name: "sre-only-skill", groups: ["sre"] });
    expect((await ui("POST", "/ui/api/profile/skills/sre-only-skill", sreTok, {})).status).toBe(200);

    const client = await connect(sreTok);
    const loaded = await call(client, "load_skill", { skill_name: "sre-only-skill" });
    expect(loaded.isError).toBeFalsy();
    expect(loaded.content[0].text).toContain("on-call");
    expect(loaded.content[0].text).toMatch(/Bundled files|skill:\/\//);

    // Clear groups → everyone can see again
    expect((await ui("PUT", "/ui/api/skills/sre-only-skill", admin, { groups: [] })).status).toBe(200);
    expect(
      (await ui("GET", "/ui/api/catalog/skills", alice)).json.skills.find((s: any) => s.name === "sre-only-skill")
    ).toBeTruthy();

    await ui("DELETE", "/ui/api/skills/sre-only-skill", admin);
  });
});

describe("skill resources and prompts", () => {
  it("exposes installed skill files via resources and prompts", async () => {
    const created = await ui("POST", "/ui/api/skills", admin, {
      name: "pack",
      description: "Packaged helpers",
      keywords: ["pack"],
      body: "Use the helper script.",
    });
    expect(created.status).toBe(200);
    const skillDir = join(dir, "managed-skills", "pack");
    mkdirSync(join(skillDir, "scripts"), { recursive: true });
    writeFileSync(join(skillDir, "scripts", "helper.sh"), "#!/bin/sh\necho pack\n");

    await ui("POST", "/ui/api/profile/skills/pack", alice, {});
    const client = await connect(alice);

    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toEqual(expect.arrayContaining(["skill://pack/scripts/helper.sh", "skill://pack/INSTRUCTIONS.md"]));

    const read = await client.readResource({ uri: "skill://pack/scripts/helper.sh" });
    const text = (read.contents[0] as { text?: string }).text ?? "";
    expect(text).toContain("echo pack");

    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("pack");
    const prompt = await client.getPrompt({ name: "pack" });
    expect(prompt.messages[0]?.content).toMatchObject({ type: "text" });
    expect((prompt.messages[0]!.content as { text: string }).text).toContain("helper script");

    const viaTool = await call(client, "read_skill_file", {
      skill_name: "pack",
      path: "skill://pack/scripts/helper.sh",
    });
    expect(viaTool.content[0].text).toContain("echo pack");

    await ui("DELETE", "/ui/api/skills/pack", admin);
  });
});

describe("servers (admin)", () => {
  it("lists servers with templates but no values", async () => {
    const r = await ui("GET", "/ui/api/servers", admin);
    expect(r.json.editable).toBe(true);
    const jira = r.json.servers.find((s: any) => s.name === "jira");
    expect(jira.auth).toEqual({ scope: "user", fallback: false, env: { TEST_TOKEN: "${cred:token}" }, headers: {} });
    expect(r.text).not.toContain("shared-secret-value");
  });

  it("edits groups and credentials, writes servers.json, and applies immediately", async () => {
    const r = await ui("PATCH", "/ui/api/servers/plain", admin, {
      groups: ["sre"],
      auth: { scope: "user", fallback: true, env: { SVC_TOKEN: "${cred:key}" } },
    });
    expect(r.status).toBe(200);
    const onDisk = JSON.parse(readFileSync(join(dir, "servers.json"), "utf-8"));
    expect(onDisk.servers.plain.groups).toEqual(["sre"]);
    expect(onDisk.servers.plain.auth).toEqual({ scope: "user", fallback: "server", env: { SVC_TOKEN: "${cred:key}" } });
    expect(onDisk.servers.plain.command).toBe(process.execPath); // untouched fields survive
    expect(readdirSync(dir)).toContain("servers.json.bak-ui");

    // alice (eng) is outside "sre": the server is hidden and its credentials can't be set.
    expect((await ui("PUT", "/ui/api/connections/plain/key", alice, { value: "x" })).status).toBe(404);
    const client = await connect(alice);
    const found = await call(client, "discover_tools", { query: "plain" });
    expect(found.content[0].text).not.toContain("plain test server");
  });

  it("clears credentials and groups again", async () => {
    await ui("PATCH", "/ui/api/servers/plain", admin, { groups: [], auth: null });
    const onDisk = JSON.parse(readFileSync(join(dir, "servers.json"), "utf-8"));
    expect(onDisk.servers.plain.groups).toBeUndefined();
    expect(onDisk.servers.plain.auth).toBeUndefined();
  });

  it("rejects bad edits without touching the file", async () => {
    const before = readFileSync(join(dir, "servers.json"), "utf-8");
    expect((await ui("PATCH", "/ui/api/servers/nope", admin, { groups: [] })).status).toBe(404);
    expect((await ui("PATCH", "/ui/api/servers/plain", admin, { auth: { scope: "user" } })).status).toBe(400);
    expect((await ui("PATCH", "/ui/api/servers/plain", admin, { auth: { scope: "user", env: { A: 1 } } })).status).toBe(400);
    expect(readFileSync(join(dir, "servers.json"), "utf-8")).toBe(before);
  });
});

describe("UserVault", () => {
  it("round-trips, lower-cases fields, and binds values to their owner", () => {
    const d = mkdtempSync(join(tmpdir(), "lzg-vault-"));
    const env = { LAZYGATE_VAULT_KEY: Buffer.alloc(32, 3).toString("base64") };
    try {
      const v = new UserVault(d, env);
      v.set("alice", "jira", "Token", "s3cret-value");
      expect(v.get("alice").get("jira")).toEqual({ token: "s3cret-value" });
      expect(v.list("alice")).toEqual({ jira: ["token"] });
      expect(v.get("bob").size).toBe(0);
      expect(v.getKeySource()).toBe("env");
      expect(readdirSync(d)).not.toContain("vault.key");

      // Moving alice's ciphertext under bob must not decrypt.
      const file = JSON.parse(readFileSync(join(d, "vault.json"), "utf-8"));
      file.bob = file.alice;
      writeFileSync(join(d, "vault.json"), JSON.stringify(file), { mode: 0o600 });
      expect(new UserVault(d, env).get("bob").size).toBe(0);
      expect(new UserVault(d, env).get("alice").get("jira")).toEqual({ token: "s3cret-value" });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("reads an existing vault.key but never creates a new one", () => {
    const withFile = mkdtempSync(join(tmpdir(), "lzg-vault-file-"));
    const ephemeral = mkdtempSync(join(tmpdir(), "lzg-vault-eph-"));
    try {
      writeFileSync(join(withFile, "vault.key"), Buffer.alloc(32, 9).toString("base64") + "\n", { mode: 0o600 });
      const fromFile = new UserVault(withFile, {});
      fromFile.set("alice", "jira", "token", "from-file-key");
      expect(fromFile.getKeySource()).toBe("file");
      expect(new UserVault(withFile, {}).get("alice").get("jira")).toEqual({ token: "from-file-key" });

      const eph = new UserVault(ephemeral, {});
      eph.set("alice", "jira", "token", "ephemeral-only");
      expect(eph.getKeySource()).toBe("ephemeral");
      expect(readdirSync(ephemeral)).not.toContain("vault.key");
      // A new process-equivalent instance cannot decrypt without the in-memory key.
      expect(new UserVault(ephemeral, {}).get("alice").size).toBe(0);
    } finally {
      rmSync(withFile, { recursive: true, force: true });
      rmSync(ephemeral, { recursive: true, force: true });
    }
  });

  it("fails closed with the wrong key, and honours LAZYGATE_VAULT_KEY", () => {
    const d = mkdtempSync(join(tmpdir(), "lzg-vault-"));
    try {
      const key = Buffer.alloc(32, 7).toString("base64");
      const v = new UserVault(d, { LAZYGATE_VAULT_KEY: key });
      v.set("alice", "jira", "token", "abc123456");
      expect(readdirSync(d)).not.toContain("vault.key");
      expect(new UserVault(d, { LAZYGATE_VAULT_KEY: Buffer.alloc(32, 8).toString("base64") }).get("alice").size).toBe(0);
      expect(() => new UserVault(d, { LAZYGATE_VAULT_KEY: "c2hvcnQ=" }).get("alice")).not.toThrow(); // empty vault path
      expect(() => new UserVault(d, { LAZYGATE_VAULT_KEY: "c2hvcnQ=" }).set("alice", "j", "t", "v")).toThrow(/32 bytes/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("mergeCreds lets request headers win field by field", () => {
    const merged = mergeCreds(
      new Map([["jira", { token: "stored", extra: "kept" }]]),
      new Map([["jira", { token: "sent" }]])
    );
    expect(merged.get("jira")).toEqual({ token: "sent", extra: "kept" });
  });
});
