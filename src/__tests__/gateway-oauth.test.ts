// src/__tests__/gateway-oauth.test.ts
// Gateway OAuth Connect: remote callback, connect_server / disconnect_server, no browser on the host.

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs";
import { createServer, type Server } from "http";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const home = mkdtempSync(join(tmpdir(), "lzg-goa-"));
const realOs = createRequire(import.meta.url)("os") as typeof import("os");
jest.unstable_mockModule("os", () => ({
  ...realOs,
  default: { ...realOs, homedir: () => home },
  homedir: () => home,
}));

const mockDiscover = jest.fn();
const mockRegister = jest.fn();
jest.unstable_mockModule("@modelcontextprotocol/sdk/client/auth.js", () => ({
  discoverOAuthServerInfo: mockDiscover,
  registerClient: mockRegister,
}));

const { loadRegistry } = await import("../registry.js");
const { startGateway, type Gateway } = await import("../gateway/server.js");
const { TokenStore } = await import("../gateway/tokens.js");
const { SecretStore } = await import("../gateway/credentials.js");
const { UserVault } = await import("../gateway/vault.js");
const { AuditLog } = await import("../gateway/audit.js");
const { hasStoredToken, tokenPath } = await import("../oauth.js");

const MCP_URL = "https://mcp.example.com/mcp";
let as: Server;
let asPort = 0;
let dir: string;
let gw: Gateway;
let alice: string;
let admin: string;
const clients: Client[] = [];

beforeAll(async () => {
  as = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/token") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ access_token: "user-access", refresh_token: "r", expires_in: 3600, token_type: "Bearer" }));
      } else res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => as.listen(0, "127.0.0.1", () => r()));
  asPort = (as.address() as { port: number }).port;

  dir = mkdtempSync(join(tmpdir(), "lzg-goa-cfg-"));
  writeFileSync(
    join(dir, "servers.json"),
    JSON.stringify({
      servers: {
        github: {
          description: "GitHub over OAuth",
          keywords: ["github"],
          type: "http",
          url: MCP_URL,
          oauth: true,
          auth: { scope: "user" },
        },
        sharedoauth: {
          description: "Shared OAuth",
          keywords: ["shared"],
          type: "http",
          url: MCP_URL,
          oauth: { clientId: "pre-shared" },
          auth: { scope: "server" },
        },
      },
    })
  );
  writeFileSync(join(dir, "skills.json"), JSON.stringify({ skills: {} }));

  const tokens = new TokenStore(dir);
  alice = tokens.create({ user: "alice", groups: ["eng"] }).token;
  admin = tokens.create({ user: "root", admin: true }).token;

  gw = await startGateway({
    registry: loadRegistry(["--config", join(dir, "servers.json")], dir),
    tokens,
    secrets: new SecretStore(dir, {}),
    vault: new UserVault(dir, {}),
    audit: new AuditLog(join(dir, "audit.log")),
    port: 0,
    idleMs: 60_000,
    maxSessionsPerUser: 50,
  });
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  await gw.close();
  await new Promise<void>((r) => as.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  mockDiscover.mockImplementation(async () => ({
    authorizationServerUrl: `http://127.0.0.1:${asPort}`,
    authorizationServerMetadata: {
      issuer: `http://127.0.0.1:${asPort}`,
      authorization_endpoint: `http://127.0.0.1:${asPort}/authorize`,
      token_endpoint: `http://127.0.0.1:${asPort}/token`,
      registration_endpoint: `http://127.0.0.1:${asPort}/register`,
      response_types_supported: ["code"],
    },
    resourceMetadata: { resource: MCP_URL, scopes_supported: ["mcp"] },
  }));
  mockRegister.mockResolvedValue({ client_id: "dyn" });
});

async function connect(token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(gw.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "t", version: "1" });
  await client.connect(transport);
  clients.push(client);
  return client;
}
const call = (c: Client, name: string, args: Record<string, unknown> = {}) =>
  c.callTool({ name, arguments: args }) as Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

async function ui(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${gw.publicUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  return { status: res.status, json, text };
}

describe("connect_server / activate without a token", () => {
  it("activate fails with a connect hint; connect_server returns an authorize URL", async () => {
    const client = await connect(alice);
    const refused = await call(client, "activate_server", { server_name: "github" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/connect_server|OAuth/i);

    const linked = await call(client, "connect_server", { server_name: "github" });
    expect(linked.isError).toBeFalsy();
    const m = linked.content[0].text.match(/https?:\/\/\S+/);
    expect(m).toBeTruthy();
    const authUrl = new URL(m![0]);
    expect(authUrl.searchParams.get("redirect_uri")).toBe(`${gw.publicUrl}/oauth/callback`);
    expect(authUrl.searchParams.get("state")).toBeTruthy();
  });

  it("non-admins cannot connect a shared OAuth server", async () => {
    const client = await connect(alice);
    const r = await call(client, "connect_server", { server_name: "sharedoauth" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/admin/i);
  });
});

describe("UI Connect and /oauth/callback", () => {
  it("lists OAuth servers, completes the callback, and stores a per-user token", async () => {
    const list = await ui("GET", "/ui/api/connections", alice);
    expect(list.status).toBe(200);
    const gh = list.json.connections.find((c: any) => c.server === "github");
    expect(gh).toMatchObject({ oauth: true, oauthConnected: false, oauthShared: false });

    const started = await ui("POST", "/ui/api/connections/github/oauth", alice, {});
    expect(started.status).toBe(200);
    const authUrl = new URL(started.json.authorizationUrl);
    const state = authUrl.searchParams.get("state")!;
    expect(authUrl.searchParams.get("redirect_uri")).toBe(`${gw.publicUrl}/oauth/callback`);

    const cb = await fetch(
      `${gw.publicUrl}/oauth/callback?code=ui-code&state=${encodeURIComponent(state)}`
    );
    expect(cb.status).toBe(200);
    expect(await cb.text()).toMatch(/Connected|connected/i);
    expect(hasStoredToken("github", "alice")).toBe(true);
    // Token lives under the real config dir (homedir mock), not the gateway dir.
    expect(existsSync(tokenPath("github", "alice"))).toBe(true);

    const again = await ui("GET", "/ui/api/connections", alice);
    expect(again.json.connections.find((c: any) => c.server === "github").oauthConnected).toBe(true);

    expect((await ui("DELETE", "/ui/api/connections/github/oauth", alice)).status).toBe(204);
    expect(hasStoredToken("github", "alice")).toBe(false);
  });

  it("rejects a bad state on the callback", async () => {
    const cb = await fetch(`${gw.publicUrl}/oauth/callback?code=x&state=nope`);
    expect(cb.status).toBe(400);
    expect(await cb.text()).toMatch(/invalid or expired/i);
  });

  it("lets an admin connect a shared OAuth server", async () => {
    const started = await ui("POST", "/ui/api/connections/sharedoauth/oauth", admin, {});
    expect(started.status).toBe(200);
    const state = new URL(started.json.authorizationUrl).searchParams.get("state")!;
    expect((await fetch(`${gw.publicUrl}/oauth/callback?code=s&state=${state}`)).status).toBe(200);
    expect(hasStoredToken("sharedoauth")).toBe(true);
    expect(hasStoredToken("sharedoauth", "root")).toBe(false);

    expect((await ui("POST", "/ui/api/connections/sharedoauth/oauth", alice, {})).status).toBe(403);
  });
});

describe("disconnect_server", () => {
  it("clears the OAuth token", async () => {
    const client = await connect(alice);
    const linked = await call(client, "connect_server", { server_name: "github" });
    const state = new URL(linked.content[0].text.match(/https?:\/\/\S+/)![0]).searchParams.get("state")!;
    await fetch(`${gw.publicUrl}/oauth/callback?code=d&state=${state}`);
    expect(hasStoredToken("github", "alice")).toBe(true);

    const gone = await call(client, "disconnect_server", { server_name: "github" });
    expect(gone.isError).toBeFalsy();
    expect(gone.content[0].text).toMatch(/OAuth token/);
    expect(hasStoredToken("github", "alice")).toBe(false);
  });
});
