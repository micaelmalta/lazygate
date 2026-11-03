// src/__tests__/security-regressions.test.ts
// Regression tests for the security review findings (R1, R3, M4, M8, M6). Each test would have
// failed before its fix.

import { describe, it, expect, afterAll } from "@jest/globals";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { composePrompt } from "../prompt-compose.js";
import { SkillRouter, resolveSkillFilePath } from "../skill-router.js";
import { TokenStore } from "../gateway/tokens.js";
import { UserVault } from "../gateway/vault.js";
import { tokenPath } from "../oauth.js";
import type { SkillConfig } from "../skill-router.js";

const root = mkdtempSync(join(tmpdir(), "lg-sec-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SECRET_VALUE = "ghp_SUPERSECRET123";
const secrets = {
  get: (p: string) => (p === "github/token" ? SECRET_VALUE : undefined),
};

describe("R1: caller arguments cannot inject secrets into skill context", () => {
  it("refuses a ${secret:…} template in a prompt argument", async () => {
    const config: SkillConfig = {
      description: "",
      keywords: [],
      path: "/x",
      prompt: {
        arguments: [{ name: "q" }],
        context: [{ name: "search", url: "https://example.com/s?q={{q}}" }],
      },
    };
    await expect(
      composePrompt({ body: "{{context.search}}", config, args: { q: "${secret:github/token}" }, secrets })
    ).rejects.toThrow(/may not contain/);
  });

  it("refuses a context URL that a caller could redirect (not a literal host)", async () => {
    const config: SkillConfig = {
      description: "",
      keywords: [],
      path: "/x",
      prompt: {
        arguments: [{ name: "base" }],
        context: [{ name: "c", url: "{{base}}/x" }],
      },
    };
    await expect(composePrompt({ body: "", config, args: { base: "https://evil.example" }, secrets })).rejects.toThrow(
      /literal http/
    );
  });

  it("still substitutes admin-authored secrets into the template", async () => {
    // Admin template with a secret: must still work after the reordering.
    const config: SkillConfig = {
      description: "",
      keywords: [],
      path: "/x",
      prompt: {
        arguments: [{ name: "q" }],
        context: [{ name: "c", url: "https://127.0.0.1:1/x?k=${secret:github/token}&q={{q}}", optional: true }],
      },
    };
    // The fetch to 127.0.0.1:1 fails (nothing listening) and is optional, so the context value is
    // an "(unavailable: …)" string. The secret must not leak into it.
    const out = await composePrompt({ body: "{{context.c}}", config, args: { q: "hello" }, secrets });
    expect(out.text).not.toContain(SECRET_VALUE);
    expect(out.secretValues).toContain(SECRET_VALUE);
  });
});

describe("M4: symlinks cannot escape a skill directory", () => {
  it("rejects a symlink inside the skill dir that points outside it", () => {
    const skillDir = join(root, "skill");
    const outside = join(root, "outside-secret.txt");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(outside, "TOP SECRET");
    symlinkSync(outside, join(skillDir, "link.txt"));

    expect(() => resolveSkillFilePath(skillDir, "link.txt")).toThrow(/escapes skill directory via symlink/);
  });

  it("still allows a regular file inside the skill dir", () => {
    const skillDir = join(root, "skill2");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "INSTRUCTIONS.md"), "ok");
    expect(resolveSkillFilePath(skillDir, "INSTRUCTIONS.md")).toBe(join(skillDir, "INSTRUCTIONS.md"));
  });

  it("does not read through a symlink via SkillRouter.readFile", () => {
    const skillDir = join(root, "skill3");
    const outside = join(root, "outside2.txt");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(outside, "TOP SECRET 2");
    symlinkSync(outside, join(skillDir, "leak.txt"));
    const router = new SkillRouter({
      s: { description: "", keywords: [], path: join(skillDir, "SKILL.md") },
    });
    expect(() => router.readFile("s", "leak.txt")).toThrow(/escapes skill directory via symlink/);
  });
});

describe("M8: user names and token file names are contained", () => {
  it("TokenStore rejects names that would become path traversal", () => {
    const store = new TokenStore(mkdtempSync(join(root, "tok-")));
    expect(() => store.create({ user: "../../etc" })).toThrow(/Invalid user/);
    expect(() => store.create({ user: ".hidden" })).toThrow(/Invalid user/);
    expect(() => store.create({ user: "a/b" })).toThrow(/Invalid user/);
    expect(() => store.create({ user: "alice" })).not.toThrow();
  });

  it("token file paths never leave the token directory", () => {
    const base = "/t";
    for (const owner of ["..", "../..", "a/b", "x\0y"]) {
      const p = tokenPath("github", owner, base);
      expect(p.startsWith("/t/users/")).toBe(true);
    }
  });

  it("distinct names no longer collide on disk", () => {
    expect(tokenPath("github", "a/b", "/t")).not.toBe(tokenPath("github", "a_b", "/t"));
  });
});

// M6 (OAuth token encryption at rest) is covered end-to-end in oauth.test.ts, which drives the real
// save path and asserts the on-disk file never contains the plaintext access token.

describe("vault key scheme stays consistent with the token store", () => {
  it("UserVault still round-trips with an env-provided key", () => {
    const dir = mkdtempSync(join(root, "vault-"));
    const key = Buffer.alloc(32, 9).toString("base64");
    const v = new UserVault(dir, { LAZYGATE_VAULT_KEY: key });
    v.set("alice", "jira", "token", "abc");
    expect(new UserVault(dir, { LAZYGATE_VAULT_KEY: key }).get("alice").get("jira")?.token).toBe("abc");
  });
});
