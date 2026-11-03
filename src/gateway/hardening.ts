// src/gateway/hardening.ts
// Defence in depth for the gateway's state on disk: directories 0700, secret-bearing files 0600.
// This does NOT isolate stdio children from the gateway's OS user (see docs/gateway.md).

import { chmodSync, existsSync, lstatSync, readdirSync } from "fs";
import { join } from "path";

/** Files directly inside the gateway dir / config root that hold secrets or identities. */
const PRIVATE_FILES = [
  "token.key",
  "secrets.json",
  "vault.json",
  "vault.key",
  "tokens.json",
  "profiles.json",
  "audit.log",
];
/** Directories whose whole subtree is private (OAuth tokens, registered OAuth clients). */
const PRIVATE_TREES = ["tokens", "clients"];

function chmodQuiet(path: string, mode: number): boolean {
  try {
    chmodSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

function walk(dir: string, fixed: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue; // never chmod through a link
    if (st.isDirectory()) {
      if ((st.mode & 0o077) !== 0 && chmodQuiet(p, 0o700)) fixed.push(p);
      walk(p, fixed);
    } else if (st.isFile() && (st.mode & 0o077) !== 0 && chmodQuiet(p, 0o600)) {
      fixed.push(p);
    }
  }
}

/**
 * Tighten permissions under the lazygate config root (`~/.config/lazygate`) and its `gateway/`
 * subdirectory. Returns the paths that were changed. No-op on Windows.
 */
export function hardenGatewayDirs(configRoot: string, gatewayDir: string): string[] {
  const fixed: string[] = [];
  if (process.platform === "win32") return fixed;
  for (const dir of [configRoot, gatewayDir]) {
    if (!existsSync(dir)) continue;
    const st = lstatSync(dir);
    if (st.isSymbolicLink()) continue;
    if ((st.mode & 0o077) !== 0 && chmodQuiet(dir, 0o700)) fixed.push(dir);
    for (const f of PRIVATE_FILES) {
      const p = join(dir, f);
      try {
        const fst = lstatSync(p);
        if (fst.isFile() && (fst.mode & 0o077) !== 0 && chmodQuiet(p, 0o600)) fixed.push(p);
      } catch {
        /* absent */
      }
    }
    for (const t of PRIVATE_TREES) {
      const p = join(dir, t);
      try {
        const tst = lstatSync(p);
        if (!tst.isDirectory()) continue;
        if ((tst.mode & 0o077) !== 0 && chmodQuiet(p, 0o700)) fixed.push(p);
        walk(p, fixed);
      } catch {
        /* absent */
      }
    }
  }
  return fixed;
}
