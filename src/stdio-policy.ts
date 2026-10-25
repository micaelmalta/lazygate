// src/stdio-policy.ts
// Gateway-mode policy for stdio children: command allowlist parsing/checks.
// Full process isolation (nsjail/Docker/Firecracker) is still deferred.

import { basename } from "path";

/**
 * Parse the stdio command allowlist from the environment.
 * Prefers `LAZYGATE_STDIO_ALLOWLIST`; falls back to `LAZYGATE_ALLOWED_COMMANDS`
 * (same list the web UI uses when editing servers). Comma-separated.
 * Empty / unset = no activation restriction (UI still refuses new commands when unset).
 */
export function parseStdioCommandAllowlist(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const raw = (env.LAZYGATE_STDIO_ALLOWLIST ?? env.LAZYGATE_ALLOWED_COMMANDS)?.trim();
  if (!raw) return undefined;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

/** Exact path or basename match against an allowlist entry. */
export function isStdioCommandAllowed(command: string, allowlist: readonly string[] | undefined): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  const base = basename(command);
  return allowlist.some((a) => a === command || a === base);
}

/** Throw when an allowlist is configured and `command` is not on it. */
export function assertStdioCommandAllowed(
  command: string,
  allowlist: readonly string[] | undefined
): void {
  if (isStdioCommandAllowed(command, allowlist)) return;
  throw new Error(
    `stdio command "${command}" is not on the gateway allowlist ` +
      `(set LAZYGATE_STDIO_ALLOWLIST or LAZYGATE_ALLOWED_COMMANDS)`
  );
}
