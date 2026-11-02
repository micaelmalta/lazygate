// src/oauth-cli.ts
// `lazygate oauth login <server>` — stdio-style loopback OAuth (localhost:<callbackPort>/callback).

import { loadRegistry } from "./registry.js";
import { effectiveAuthScope, type ServerConfig } from "./router.js";
import { getAccessToken, hasStoredToken, tokenPath, type OAuthConfig } from "./oauth.js";
import { LOG_PREFIX } from "./version.js";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}
const has = (args: string[], name: string) => args.includes(name);

function normalizeOAuth(oauth: ServerConfig["oauth"]): OAuthConfig | undefined {
  if (oauth === undefined || oauth === false) return undefined;
  if (oauth === true) return {};
  return oauth;
}

/**
 * Interactive PKCE login using the same loopback callback as Claude Code / Cursor stdio
 * (`http://localhost:<callbackPort>/callback` when clientId is set).
 */
export async function runOauth(args: string[]): Promise<void> {
  const [action, serverName, ...rest] = args;
  if (action !== "login" || !serverName) {
    throw new Error(
      "usage: lazygate oauth login <server> [--user <id>] [--force]\n" +
        "  Opens a browser and listens on localhost:<callbackPort>/callback (Claude/Cursor style).\n" +
        "  For gateway HTTP servers (default auth.scope=user), pass --user matching your PAT user."
    );
  }

  // Drop oauth subcommand args so --config / --skills still work.
  const registryArgv = process.argv.filter((a) => a !== "oauth" && a !== "login" && a !== serverName);
  const { serverConfigs } = loadRegistry(registryArgv);
  const cfg = serverConfigs[serverName];
  if (!cfg) {
    const names = Object.keys(serverConfigs).sort().join(", ");
    throw new Error(`Unknown server "${serverName}". Available: ${names || "(none)"}`);
  }
  if (!cfg.url) throw new Error(`"${serverName}" is not an HTTP server — OAuth login applies to HTTP/MCP URLs`);
  if (cfg.oauth === false) throw new Error(`"${serverName}" has oauth: false`);

  const scope = effectiveAuthScope(cfg);
  const user = flag(rest, "--user");
  if (scope === "user" && !user) {
    throw new Error(
      `"${serverName}" uses per-user OAuth (HTTP default). Pass --user <id> (same as your gateway PAT user), e.g.\n` +
        `  lazygate oauth login ${serverName} --user mmalta`
    );
  }
  const owner = scope === "user" ? user : undefined;
  const force = has(rest, "--force");

  const oauth = normalizeOAuth(cfg.oauth) ?? {};
  if (oauth.clientId && oauth.callbackPort == null) {
    console.error(
      `${LOG_PREFIX} tip: set oauth.callbackPort (e.g. 3118 for Slack/Claude) so the redirect URI matches the registered app`
    );
  }

  if (!force && hasStoredToken(serverName, owner)) {
    console.error(
      `${LOG_PREFIX} ${serverName} already has a stored token` +
        (owner ? ` for ${owner}` : "") +
        ` (${tokenPath(serverName, owner)}). Pass --force to re-authorize.`
    );
    return;
  }

  const port = oauth.callbackPort ?? "(ephemeral)";
  const host = oauth.clientId ? "localhost" : "127.0.0.1";
  console.error(
    `${LOG_PREFIX} OAuth login for ${serverName}` +
      (owner ? ` (user ${owner})` : " (shared)") +
      `\n${LOG_PREFIX} Expect redirect: http://${host}:${port}/callback`
  );

  const token = await getAccessToken(serverName, cfg.url, oauth, { force: true, owner, interactive: true });
  console.error(`${LOG_PREFIX} Authorized. Token saved to ${tokenPath(serverName, owner)}`);
  console.error(`${LOG_PREFIX} access_token length=${token.length}. You can activate_server("${serverName}") now.`);
}
