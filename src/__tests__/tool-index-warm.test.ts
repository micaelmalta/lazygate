// src/__tests__/tool-index-warm.test.ts
// Shared ToolIndex pre-warm: only shared-scope servers; no user-cred leakage.

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { loadRegistry } from "../registry.js";
import { SecretStore } from "../gateway/credentials.js";
import {
  isSharedIndexable,
  skipReasonForIndex,
  warmSharedToolIndex,
} from "../gateway/tool-index-warm.js";
import { effectiveAuthScope, type ServerConfig } from "../router.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/cred-server.mjs", import.meta.url));

const base = (o: Partial<ServerConfig> = {}): ServerConfig => ({
  description: "t",
  keywords: [],
  command: "node",
  autoActivate: false,
  ...o,
});

describe("isSharedIndexable / skipReasonForIndex", () => {
  it("allows shared-scope stdio and server-scoped HTTP", () => {
    expect(isSharedIndexable(base())).toBe(true);
    expect(isSharedIndexable(base({ auth: { scope: "server" } }))).toBe(true);
    expect(
      isSharedIndexable(
        base({
          command: undefined,
          type: "http",
          url: "https://x.example/mcp",
          auth: { scope: "server" },
        })
      )
    ).toBe(true);
  });

  it("skips user-scoped, disabled, and local servers", () => {
    expect(skipReasonForIndex(base({ auth: { scope: "user" } }))).toMatch(/user-scoped/);
    expect(
      skipReasonForIndex(
        base({ command: undefined, type: "http", url: "https://x.example/mcp" })
      )
    ).toMatch(/user-scoped/);
    expect(skipReasonForIndex(base({ disabled: true }))).toBe("disabled");
    expect(skipReasonForIndex(base({ local: true }))).toMatch(/local/);
    expect(effectiveAuthScope(base({ type: "http", url: "https://x.example/mcp", command: undefined }))).toBe(
      "user"
    );
  });
});

describe("warmSharedToolIndex", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lzg-warm-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("indexes shared-scope stdio servers and skips user-scoped ones", async () => {
    writeFileSync(
      join(dir, "servers.json"),
      JSON.stringify({
        servers: {
          plain: {
            description: "shared stdio",
            keywords: ["plain"],
            command: process.execPath,
            args: [FIXTURE],
            env: { TOOL_PREFIX: "plain", TEST_TOKEN: "shared" },
            inheritEnv: false,
          },
          userish: {
            description: "needs user cred",
            keywords: ["user"],
            command: process.execPath,
            args: [FIXTURE],
            env: { TOOL_PREFIX: "user" },
            inheritEnv: false,
            auth: { scope: "user", env: { TEST_TOKEN: "${cred:token}" } },
          },
        },
      })
    );

    const registry = loadRegistry(["--config", join(dir, "servers.json")], dir);
    const secrets = new SecretStore(dir, {});

    const result = await warmSharedToolIndex({ registry, secrets });

    expect(result.indexed.map((x) => x.name)).toEqual(["plain"]);
    expect(result.indexed[0]!.tools).toBeGreaterThan(0);
    expect(result.skipped).toEqual([
      expect.objectContaining({ name: "userish", reason: expect.stringMatching(/user-scoped/) }),
    ]);
    expect(result.failed).toEqual([]);

    const cfg = registry.router.getConfig("plain")!;
    expect(registry.toolIndex.get("plain", cfg).length).toBeGreaterThan(0);
    expect(registry.toolIndex.get("userish", registry.router.getConfig("userish")!)).toEqual([]);
  }, 30_000);

  it("records a failure when a shared server cannot activate", async () => {
    writeFileSync(
      join(dir, "servers.json"),
      JSON.stringify({
        servers: {
          broken: {
            description: "missing secret",
            keywords: ["x"],
            command: process.execPath,
            args: [FIXTURE],
            inheritEnv: false,
            auth: { scope: "server", env: { TEST_TOKEN: "${secret:missing/token}" } },
          },
        },
      })
    );
    const registry = loadRegistry(["--config", join(dir, "servers.json")], dir);
    const secrets = new SecretStore(dir, {});
    const result = await warmSharedToolIndex({ registry, secrets });
    expect(result.indexed).toEqual([]);
    expect(result.failed).toEqual([
      expect.objectContaining({ name: "broken", error: expect.stringMatching(/credential|secret/i) }),
    ]);
  });
});
