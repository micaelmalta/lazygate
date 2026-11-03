// Unit tests for parameterized skill prompt composition.

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import type { AddressInfo } from "net";
import { describe, it, expect, afterEach } from "@jest/globals";
import {
  composePrompt,
  expandSecrets,
  promptArgumentsForList,
  renderTemplate,
  resolvePromptArgs,
} from "../prompt-compose.js";
import type { SkillConfig } from "../skill-router.js";

function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ port: number; close: () => Promise<void> }> {
  const srv = createServer(handler);
  return new Promise((resolve, reject) => {
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        port,
        close: () =>
          new Promise((r, j) => srv.close((e) => (e ? j(e) : r()))),
      });
    });
    srv.on("error", reject);
  });
}

const baseCfg = (over: Partial<SkillConfig> = {}): SkillConfig => ({
  description: "d",
  keywords: [],
  path: "/tmp/x/SKILL.md",
  ...over,
});

describe("resolvePromptArgs", () => {
  it("applies defaults and requires missing args", () => {
    expect(
      resolvePromptArgs(
        [
          { name: "a", required: true },
          { name: "b", default: "staging" },
        ],
        { a: "svc" }
      )
    ).toEqual({ a: "svc", b: "staging" });

    expect(() => resolvePromptArgs([{ name: "a", required: true }], {})).toThrow(/Missing required/);
  });
});

describe("renderTemplate / expandSecrets", () => {
  it("substitutes known placeholders and blanks unknown ones", () => {
    expect(renderTemplate("hi {{name}} {{missing}}", { name: "x" })).toBe("hi x ");
  });

  it("expands secrets or errors", () => {
    expect(expandSecrets("Bearer ${secret:tok}", { get: (p) => (p === "tok" ? "secret" : undefined) })).toBe(
      "Bearer secret"
    );
    expect(() => expandSecrets("${secret:nope}", { get: () => undefined })).toThrow(/Missing secret/);
  });
});

describe("promptArgumentsForList", () => {
  it("omits defaults from the MCP argument list", () => {
    expect(
      promptArgumentsForList([
        { name: "a", description: "A", required: true, default: "x" },
      ])
    ).toEqual([{ name: "a", description: "A", required: true }]);
    expect(promptArgumentsForList(undefined)).toBeUndefined();
  });
});

describe("composePrompt", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    while (servers.length) await servers.pop()!.close();
  });

  it("renders args without context", async () => {
    const r = await composePrompt({
      body: "Check {{service_name}} in {{environment}}.",
      config: baseCfg({
        prompt: {
          arguments: [
            { name: "service_name", required: true },
            { name: "environment", default: "staging" },
          ],
        },
      }),
      args: { service_name: "billing" },
    });
    expect(r.text).toBe("Check billing in staging.");
    expect(r.args).toEqual({ service_name: "billing", environment: "staging" });
  });

  it("fetches context and injects {{context.name}}", async () => {
    const srv = await listen((req, res) => {
      expect(req.url).toBe("/services/billing/status");
      expect(req.headers.authorization).toBe("Bearer tok");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ health: "ok", error_rate_5m: "0.1%" }));
    });
    servers.push(srv);

    const r = await composePrompt({
      body: "Service {{service_name}}\n\nStatus:\n{{context.status}}\n\nDone.",
      config: baseCfg({
        prompt: {
          arguments: [{ name: "service_name", required: true }],
          context: [
            {
              name: "status",
              url: `http://127.0.0.1:${srv.port}/services/{{service_name}}/status`,
              headers: { Authorization: "Bearer ${secret:api}" },
            },
          ],
        },
      }),
      args: { service_name: "billing" },
      secrets: { get: (p) => (p === "api" ? "tok" : undefined) },
    });
    expect(r.text).toContain("Service billing");
    expect(r.text).toContain('"health": "ok"');
    expect(r.text).toContain('"error_rate_5m": "0.1%"');
    expect(r.contextKeys).toEqual(["status"]);
  });

  it("optional context failures inject a note instead of throwing", async () => {
    const srv = await listen((_req, res) => {
      res.writeHead(503);
      res.end("down");
    });
    servers.push(srv);

    const r = await composePrompt({
      body: "ctx={{context.status}}",
      config: baseCfg({
        prompt: {
          context: [
            {
              name: "status",
              url: `http://127.0.0.1:${srv.port}/x`,
              optional: true,
            },
          ],
        },
      }),
    });
    expect(r.text).toMatch(/^ctx=\(unavailable:.*HTTP 503/);
  });

  it("fails hard on required context fetch errors", async () => {
    const srv = await listen((_req, res) => {
      res.writeHead(500);
      res.end("nope");
    });
    servers.push(srv);

    await expect(
      composePrompt({
        body: "{{context.status}}",
        config: baseCfg({
          prompt: {
            context: [{ name: "status", url: `http://127.0.0.1:${srv.port}/x` }],
          },
        }),
      })
    ).rejects.toThrow(/HTTP 500/);
  });
});
