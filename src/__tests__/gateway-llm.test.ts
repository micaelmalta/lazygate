import { createServer, type Server } from "http";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AddressInfo } from "net";
import { loadRegistry } from "../registry.js";
import { startGateway, type Gateway } from "../gateway/server.js";
import { TokenStore } from "../gateway/tokens.js";
import { SecretStore } from "../gateway/credentials.js";
import { UserProfileStore } from "../gateway/profile.js";
import { AuditLog } from "../gateway/audit.js";
import { parseLlmGatewayConfig } from "../gateway/llm-config.js";

const MODEL = "gpt-6.1-sol";
const UPSTREAM_KEY = "provider-key-only-at-gateway";
const STREAM = `event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"Hello"}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}

`;

describe("Codex Responses API gateway", () => {
  let dir: string;
  let gateway: Gateway;
  let upstream: Server;
  let upstreamPort: number;
  let token: string;
  let upstreamRequests: Array<{ path: string; authorization?: string; body: any }>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "lazygate-llm-"));
    upstreamRequests = [];
    upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      upstreamRequests.push({ path: req.url ?? "", authorization: req.headers.authorization, body });
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "X-Request-Id": "provider-req-1" });
      res.end(STREAM);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    upstreamPort = (upstream.address() as AddressInfo).port;

    const configPath = join(dir, "servers.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        servers: {},
        responseOptimization: {
          enabled: true,
          defaultMode: "off",
          tools: {
            "jira.fetch_doc": { mode: "html_markdown" },
            "jira.get_ticket": { mode: "project", fields: ["summary"] },
          },
        },
      })
    );
    const registry = loadRegistry(["--config", configPath], dir);
    const tokens = new TokenStore(dir);
    token = tokens.create({ user: "codex" }).token;
    gateway = await startGateway({
      registry,
      tokens,
      secrets: new SecretStore(dir, {}),
      profiles: new UserProfileStore(dir),
      audit: new AuditLog(null),
      port: 0,
      llmGateway: {
        providers: {
          test: { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: UPSTREAM_KEY },
        },
        models: { [MODEL]: { provider: "test", model: "upstream-codex-model" } },
      },
    });
  });

  afterAll(async () => {
    await gateway.close();
    await new Promise<void>((resolve, reject) => upstream.close((err) => (err ? reject(err) : resolve())));
    rmSync(dir, { recursive: true, force: true });
  });

  async function postResponses(body: unknown, bearer = token) {
    return fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it("routes Codex Responses requests, swaps credentials, and streams the provider response unchanged", async () => {
    const response = await postResponses({ model: MODEL, input: "Say hello", stream: true });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-request-id")).toBe("provider-req-1");
    expect(await response.text()).toBe(STREAM);
    expect(upstreamRequests.at(-1)).toEqual({
      path: "/v1/responses",
      authorization: `Bearer ${UPSTREAM_KEY}`,
      body: { model: "upstream-codex-model", input: "Say hello", stream: true },
    });
    expect(JSON.stringify(upstreamRequests.at(-1))).not.toContain(token);
  });

  it("optimizes matching tool output items before forwarding the Responses request", async () => {
    const html = "<html><body><script>bad()</script><main><h1>Guide</h1><p>Useful text</p></main></body></html>";
    const response = await postResponses({
      model: MODEL,
      input: [
        { type: "function_call", call_id: "call_1", name: "jira__fetch_doc", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: html },
        { type: "function_call", call_id: "call_2", name: "jira__get_ticket", arguments: "{}" },
        { type: "function_call_output", call_id: "call_2", output: JSON.stringify({ summary: "keep", privateDetails: "do not omit" }) },
      ],
      stream: true,
    });

    expect(response.status).toBe(200);
    const forwarded = upstreamRequests.at(-1)?.body.input[1].output as string;
    expect(forwarded).toContain("# Guide");
    expect(forwarded).toContain("Useful text");
    expect(forwarded).not.toContain("<h1>");
    expect(forwarded).not.toContain("<script>");
    expect(upstreamRequests.at(-1)?.body.input[3].output).toBe(JSON.stringify({ summary: "keep", privateDetails: "do not omit" }));
  });

  it("rejects unknown model routes without contacting a provider", async () => {
    const before = upstreamRequests.length;
    const response = await postResponses({ model: "not-configured", input: "hello" });

    expect(response.status).toBe(400);
    expect(upstreamRequests).toHaveLength(before);
  });

  it("lists configured model routes and requires gateway authentication", async () => {
    const unauthorized = await fetch(`http://127.0.0.1:${gateway.port}/v1/models`);
    expect(unauthorized.status).toBe(401);

    const response = await fetch(`http://127.0.0.1:${gateway.port}/v1/models`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: [{ id: MODEL, object: "model" }] });
  });
});

describe("LLM gateway config", () => {
  const raw = {
    providers: { openai: { baseUrl: "https://api.example.com/v1/", apiKeyEnv: "LAZYGATE_TEST_KEY" } },
    models: { "gpt-6.1-sol": { provider: "openai", model: "upstream-model" } },
  };

  it("resolves provider credentials from named environment variables", () => {
    expect(parseLlmGatewayConfig(raw, { LAZYGATE_TEST_KEY: "provider-secret" })).toEqual({
      providers: { openai: { baseUrl: "https://api.example.com/v1", apiKey: "provider-secret" } },
      models: { "gpt-6.1-sol": { provider: "openai", model: "upstream-model" } },
      maxRequestBytes: undefined,
    });
  });

  it("requires configured provider credentials and rejects keys in the config file", () => {
    expect(() => parseLlmGatewayConfig(raw, {})).toThrow(/LAZYGATE_TEST_KEY is required/);
    expect(() => parseLlmGatewayConfig({
      providers: { openai: { baseUrl: "https://api.example.com/v1", apiKey: "do-not-store" } },
      models: { "gpt-6.1-sol": { provider: "openai", model: "upstream-model" } },
    }, {})).toThrow(/Unrecognized key/);
  });
});
