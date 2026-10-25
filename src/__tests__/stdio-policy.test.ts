// src/__tests__/stdio-policy.test.ts
import { describe, it, expect } from "@jest/globals";
import {
  parseStdioCommandAllowlist,
  isStdioCommandAllowed,
  assertStdioCommandAllowed,
} from "../stdio-policy.js";

describe("stdio-policy", () => {
  it("parses LAZYGATE_STDIO_ALLOWLIST, falling back to LAZYGATE_ALLOWED_COMMANDS", () => {
    expect(parseStdioCommandAllowlist({})).toBeUndefined();
    expect(parseStdioCommandAllowlist({ LAZYGATE_STDIO_ALLOWLIST: "  " })).toBeUndefined();
    expect(parseStdioCommandAllowlist({ LAZYGATE_STDIO_ALLOWLIST: "node, /usr/bin/npx" })).toEqual([
      "node",
      "/usr/bin/npx",
    ]);
    expect(parseStdioCommandAllowlist({ LAZYGATE_ALLOWED_COMMANDS: "python3" })).toEqual(["python3"]);
    expect(
      parseStdioCommandAllowlist({
        LAZYGATE_STDIO_ALLOWLIST: "node",
        LAZYGATE_ALLOWED_COMMANDS: "ignored",
      })
    ).toEqual(["node"]);
  });

  it("matches exact path or basename", () => {
    expect(isStdioCommandAllowed("evil", undefined)).toBe(true);
    expect(isStdioCommandAllowed("evil", [])).toBe(true);
    expect(isStdioCommandAllowed("node", ["node"])).toBe(true);
    expect(isStdioCommandAllowed("/usr/bin/node", ["node"])).toBe(true);
    expect(isStdioCommandAllowed("/usr/bin/node", ["/usr/bin/node"])).toBe(true);
    expect(isStdioCommandAllowed("evil", ["node"])).toBe(false);
  });

  it("assertStdioCommandAllowed throws a clear error", () => {
    expect(() => assertStdioCommandAllowed("evil", ["node"])).toThrow(/allowlist/);
    expect(() => assertStdioCommandAllowed("node", ["node"])).not.toThrow();
  });
});
