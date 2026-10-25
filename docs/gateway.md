# HTTP gateway (POC)

`lazygate serve` runs lazygate as an MCP server over Streamable HTTP, so several people (or several
clients) can share one instance. Each MCP session gets its own active servers, child processes and
credentials. It is built for a locally hosted proof of concept: plain HTTP on `127.0.0.1`, personal access
tokens for identity, no OIDC. The plan beyond the POC is in
[design/http-gateway.md](design/http-gateway.md) (on the design branch).

## Quick start

```bash
# 1. Create an access token for yourself (shown once) — see README for source install
lazygate token create --user alice --groups eng --expires 90d

# 2. Start the gateway (binds to 127.0.0.1:8787)
lazygate serve

# 3. Point a client at it
claude mcp add --transport http lazygate http://127.0.0.1:8787/mcp \
  --header "Authorization: Bearer lzg_..."
```

Or in `.mcp.json` / Cursor's `mcp.json`:

```json
{
  "mcpServers": {
    "lazygate": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp",
      "headers": {
        "Authorization": "Bearer ${LAZYGATE_TOKEN}",
        "X-Lazygate-Cred-jira-token": "${JIRA_API_TOKEN}"
      }
    }
  }
}
```

The gateway reads the same `~/.config/lazygate/servers.json` (or `--config`) as stdio mode.

## Identity

Requests must carry `Authorization: Bearer lzg_<id>_<secret>`.

```bash
lazygate token create --user alice --groups eng,sre [--expires 90d] [--label ci]
lazygate token list
lazygate token revoke <id>
```

Only a hash of each token is stored (`~/.config/lazygate/gateway/tokens.json`, mode 0600). Revoking takes
effect immediately on a running gateway. The `Authorization` header identifies you to lazygate and is
**never forwarded** to upstream servers. A session id only works for the user who created it.

## Web UI

Open `http://127.0.0.1:8787/ui` and paste a token. It is a single page served by the gateway (no build
step, no extra dependencies, strict CSP, nothing stored in cookies — the token lives in
`sessionStorage` and is sent as a bearer header).

| Tab | Who | What |
|---|---|---|
| Servers | everyone | Catalog of shared MCP servers (group-filtered; disabled entries hidden). **Install** / **Remove** into your profile; only installed servers appear in `discover_tools` / `activate_server`. **Connect** jumps to Credentials when needed. |
| Skills | everyone | Catalog of skills (disabled entries hidden). **Install** / **Remove** into your profile; only installed skills appear in `discover_skill` / `load_skill`. |
| Credentials | everyone | Save API keys (`auth.scope: "user"`) and **Connect** OAuth servers. Keys are encrypted; OAuth uses `/oauth/callback` on this gateway. A key sent in an `X-Lazygate-Cred-…` header still wins. |
| Activity | everyone (admins see all users) | Recent tool calls and admin mutations from the audit log |
| Manage servers | admin | Same catalog with **Enable** / **Disable** (soft-hide; config kept), **Delete**, **Add**, and **Configure** (basics, access, `${secret:…}` values). Disabled entries stay visible here and cannot be activated. |
| Manage skills | admin | Same catalog with **Enable** / **Disable**, **Delete**, **Add**, and **Configure** (inline body under `managed-skills/`). Disabled skills stay visible here and cannot be loaded. |
| Sessions | admin | Live sessions, plus **Index all tools** to pre-warm the shared discovery index (shared-scope servers only — never user-credential tool lists) |
| Tokens | admin | Create (optionally `admin`, groups, expiry, label) and revoke tokens. The new token is shown once. |
| All secrets | admin | Advanced: set or delete any shared secret path. Lists paths referenced by auth templates and highlights missing ones; values are never shown. Prefer the per-server Configure sheet for day-to-day secret setup. |

Primary nav is Servers / Skills / Credentials / Activity. Admins also get an **Admin** menu (Manage servers, Manage skills, Sessions, Tokens, All secrets). User tabs stay install-only; catalog CRUD lives only under Manage.

Create the first admin from the CLI: `lazygate token create --user you --admin`. The page can't revoke
the token you're signed in with.

Profiles (install lists) live in `gateway/profiles.json` (0600). New users start with nothing
installed — open the catalog and Install what you need. Group ACL still gates which catalog
entries you can see or install.

Stored user credentials live in `gateway/vault.json`, encrypted with AES-256-GCM and bound to the
user, server and field. Prefer setting `LAZYGATE_VAULT_KEY` (base64, 32 bytes) in the gateway
environment so the key is not stored beside the ciphertext — when that env var is set, lazygate
never writes `vault.key`. If the env var is unset, an existing `gateway/vault.key` (0600) is read
for compatibility, but **serve never creates a new `vault.key` on disk**. Without env or an
existing file, the process uses an ephemeral in-memory key (credentials encrypt for this run only
and will not decrypt after restart). Back `LAZYGATE_VAULT_KEY` (or a retained `vault.key`) up with
`vault.json`; without the key stored credentials are unreadable.

## Credentials

Each server says where its credentials come from, in `servers.json`:

```json
{
  "servers": {
    "jira": {
      "command": "jira-mcp",
      "inheritEnv": false,
      "auth": { "scope": "user", "env": { "JIRA_API_TOKEN": "${cred:token}" } }
    },
    "datadog": {
      "type": "http",
      "url": "https://mcp.datadoghq.com/v1/mcp",
      "auth": { "scope": "server", "headers": { "DD-API-KEY": "${secret:datadog/api_key}" } }
    },
    "wiki": {
      "command": "wiki-mcp",
      "auth": { "scope": "user", "fallback": "server", "env": { "WIKI_TOKEN": "${cred:token}" } },
      "groups": ["eng"]
    }
  }
}
```

| `auth.scope` | Credential | Where it comes from |
|---|---|---|
| `"user"` | the caller's own | request header `X-Lazygate-Cred-<server>-<field>` |
| `"server"` (default) | one for everybody | the gateway's secret store |
| `"user"` + `fallback: "server"` | the caller's, else the shared one | header, else secret `<server>/<field>` |

- `auth.env` (stdio servers) and `auth.headers` (HTTP servers) are templates. `${cred:field}` is a user
  credential, `${secret:path}` is a server secret.
- **User credentials** are either saved in the web UI or sent as headers, one per field: `X-Lazygate-Cred-jira-token: …` (a header overrides a saved value). The server
  name is matched against your configured servers, so hyphenated names (`request-mcp`) work. If one is
  missing, `activate_server` fails with the exact header to add, and `discover_tools` shows
  `⚠ needs credentials`.
- **Server secrets** live in `~/.config/lazygate/gateway/secrets.json` (0600) or in environment variables:

  ```bash
  printf '%s' "$KEY" | lazygate secret set datadog/api_key   # or LAZYGATE_SECRET_DATADOG_API_KEY=…
  lazygate secret list      # names only
  lazygate secret delete datadog/api_key
  ```

- **OAuth servers** (HTTP servers with `oauth` or that answer 401): with `auth.scope: "user"` each user's
  tokens are stored separately (`tokens/users/<user>/<server>.json`); otherwise the token is shared. The
  authorization flow still uses the loopback callback, so it works when the gateway runs on the machine of
  the person authorizing.

Rules the gateway enforces:

- A credential reaches only the server it is configured for, as that server's env var or header.
- A user can't override a server-scope credential by sending a header.
- Credential values are never re-expanded (a value that looks like `${HOME}` stays literal).
- Credential values are redacted from tool results, error messages and the audit log.
- Changing a credential starts a fresh process or HTTP session for that server; two users never share one.
- In `serve` mode, stdio children default to `inheritEnv: false`. `LAZYGATE_*` (vault key, secrets,
  allowlist, …) is always stripped from child env even when a server opts into full inherit.
- Set `LAZYGATE_STDIO_ALLOWLIST` (or `LAZYGATE_ALLOWED_COMMANDS`) to a comma-separated list of
  allowed `command` values; activation of any other stdio command fails. The web UI uses
  `LAZYGATE_ALLOWED_COMMANDS` the same way when creating or editing servers.
- Mark servers that need the caller's machine with `"local": true` — they are hidden from non-admin
  catalog users and cannot be installed or activated through the gateway.

## Access policy

`"groups": ["sre"]` on a server hides it from everyone outside those groups: it is missing from
`discover_tools` and `activate_server` answers "Unknown server". Groups come from the token
(`token create --groups`). No `groups` means everyone. `"local": true` likewise hides the server
from remote gateway users (admins still see it labelled).

## Operations

```
lazygate serve [--host 127.0.0.1] [--port 8787] [--config servers.json] [--skills skills.json]
               [--idle-timeout-min 30] [--max-sessions 100]
               [--namespace-tools]
               [--allow-remote --allowed-host gw.example.com:443]
               [--public-url https://gw.example.com]
```

`--namespace-tools` exposes every activated tool as `server__tool` (unless a server sets
`namespaceTools: false`), so identical upstream names do not collide.

- Binds to loopback by default. Any other host needs `--allow-remote`, and you must put TLS in front
  (see [Remote access / TLS](#remote-access--tls)).
  Requests whose `Host` or `Origin` isn't the gateway's own are rejected (DNS-rebinding protection).
- Sessions are closed after 30 minutes idle (and their servers are stopped), on `DELETE`, and on shutdown.
  Limits: 100 sessions in total, 10 per user.
- `GET /healthz` answers without auth.
- Audit log: `~/.config/lazygate/gateway/audit.log` (JSON lines: time, user, session, tool/action,
  server/target, ok, duration; admin mutations also carry before/after content hashes). Arguments,
  results and secret values are not logged.
- `autoActivate` servers start when a session finishes initializing, if their credentials resolve.

## Remote access / TLS

The gateway speaks **plain HTTP only**. For anything beyond loopback:

1. Terminate TLS on a reverse proxy (Caddy, nginx, Traefik, a cloud LB).
2. Proxy to `127.0.0.1:8787` (or whatever `--port` you use).
3. Start with `--allow-remote --allowed-host <public-host>[:port]` matching the `Host` clients send,
   and `--public-url https://…` so OAuth redirect URIs match the provider registration.

Example (Caddy):

```
gw.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

```bash
lazygate serve --allow-remote --allowed-host gw.example.com \
  --public-url https://gw.example.com
```

Do not expose the gateway port directly on the public internet without TLS and Host checks.

## OAuth Connect

For HTTP servers with `oauth` (and usually `auth.scope: "user"`):

1. Call `connect_server` from the client, or click **Connect** in the UI.
2. Open the returned `/oauth/start` URL, confirm “connecting as …”, continue to the provider, and land
   on `/oauth/callback` (a short-lived HttpOnly cookie binds the flow to that browser).
3. Call `activate_server` — the gateway uses the stored per-user token (no browser on the host).

Shared OAuth (`auth.scope: "server"`, the default) is connected once by an admin. Pass
`--public-url https://gw.example.com` so the redirect URI matches what you registered with the provider
(and with dynamic client registration).

`disconnect_server` removes your API keys and OAuth token for that server.

## What the POC does not do

- No OIDC / corporate SSO; TLS is expected at a reverse proxy (see above). OAuth Connect uses the
  gateway's own `/oauth/callback` (set `--public-url` when behind a proxy). The vault is a local
  encrypted file, not a database.
- Upstream processes are per session, not pooled across a user's sessions.
- Per-user skills, containers for stdio servers, rate limits and metrics.
