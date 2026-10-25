// src/child-env.ts
// Builds the environment for a spawned stdio MCP server.

/**
 * Variables every child realistically needs to run (shell, temp dirs, locale,
 * proxies/CAs, npm config for `npx`, Windows system vars). A trailing `*`
 * means "prefix". Matching is case-insensitive.
 */
export const BASE_ENV_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "TZ", "LANG", "LC_*",
  "TMPDIR", "TEMP", "TMP",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "NPM_CONFIG_*", "XDG_*",
  "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "SYSTEMDRIVE", "COMSPEC",
  "PATHEXT", "WINDIR", "PROGRAMFILES", "PROGRAMDATA", "HOMEDRIVE", "HOMEPATH",
];

/**
 * Always removed from child env (even when inheritEnv is true). Covers the vault
 * key (`LAZYGATE_VAULT_KEY`), shared secrets (`LAZYGATE_SECRET_*`), allowlist and
 * other gateway-only settings. Case-insensitive prefix match.
 */
export const STRIP_ENV_PREFIXES = ["LAZYGATE_"];

function matcher(patterns: string[]): (key: string) => boolean {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const p of patterns) {
    const u = p.toUpperCase();
    if (u.endsWith("*")) prefixes.push(u.slice(0, -1));
    else exact.add(u);
  }
  return (key) => {
    const k = key.toUpperCase();
    return exact.has(k) || prefixes.some((p) => k.startsWith(p));
  };
}

const isStripped = matcher(STRIP_ENV_PREFIXES.map((p) => (p.endsWith("_") ? `${p}*` : p)));

function stripSensitive(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (isStripped(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * @param inherit  undefined | true  → whole parent environment (default in stdio mode)
 *                 false             → only BASE_ENV_KEYS
 *                 string[]          → BASE_ENV_KEYS plus the listed names (`PREFIX_*` allowed)
 * @param extra    the server's own resolved `env` entries (always applied last)
 *
 * `LAZYGATE_*` is always stripped from the result so gateway vault/secret env never
 * reaches a child, even when inheritEnv is true.
 */
export function buildChildEnv(
  parent: NodeJS.ProcessEnv,
  inherit: boolean | string[] | undefined,
  extra: Record<string, string>
): NodeJS.ProcessEnv {
  if (inherit === undefined || inherit === true) {
    return stripSensitive({ ...parent, ...extra });
  }

  const allowed = matcher([...BASE_ENV_KEYS, ...(Array.isArray(inherit) ? inherit : [])]);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parent)) {
    if (allowed(k)) out[k] = v;
  }
  return stripSensitive({ ...out, ...extra });
}

/**
 * Resolve inheritEnv for a spawn: server config wins; otherwise `defaultInherit`
 * (gateway mode passes `false`).
 */
export function resolveInheritEnv(
  configured: boolean | string[] | undefined,
  defaultInherit?: boolean | string[]
): boolean | string[] | undefined {
  if (configured !== undefined) return configured;
  return defaultInherit;
}
