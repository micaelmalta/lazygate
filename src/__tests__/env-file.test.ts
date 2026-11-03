// src/__tests__/env-file.test.ts

import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadEnvFile } from "../env-file.js";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function envFile(contents: string): string {
  dir = mkdtempSync(join(tmpdir(), "lzg-env-"));
  const path = join(dir, ".env");
  writeFileSync(path, contents);
  return path;
}

describe("loadEnvFile", () => {
  it("sets variables from the file and returns their names", () => {
    const path = envFile('LAZYGATE_A=1\n# comment\nexport LAZYGATE_B="two words"\n');
    const env: NodeJS.ProcessEnv = {};

    expect(loadEnvFile(path, env)).toEqual(["LAZYGATE_A", "LAZYGATE_B"]);
    expect(env).toEqual({ LAZYGATE_A: "1", LAZYGATE_B: "two words" });
  });

  it("does not override variables already set in the environment", () => {
    const path = envFile("LAZYGATE_A=from-file\nLAZYGATE_B=from-file\n");
    const env: NodeJS.ProcessEnv = { LAZYGATE_A: "from-shell", LAZYGATE_B: "" };

    expect(loadEnvFile(path, env)).toEqual([]);
    expect(env).toEqual({ LAZYGATE_A: "from-shell", LAZYGATE_B: "" });
  });

  it("returns an empty list when the file does not exist", () => {
    dir = mkdtempSync(join(tmpdir(), "lzg-env-"));
    const env: NodeJS.ProcessEnv = {};

    expect(loadEnvFile(join(dir, ".env"), env)).toEqual([]);
    expect(env).toEqual({});
  });

  it("throws on read errors other than a missing file", () => {
    dir = mkdtempSync(join(tmpdir(), "lzg-env-"));
    mkdirSync(join(dir, ".env"));

    expect(() => loadEnvFile(join(dir, ".env"), {})).toThrow();
  });
});
