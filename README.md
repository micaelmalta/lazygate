# lazygate

**Stop paying for every MCP tool on every prompt.**

lazygate sits between your coding agent (Claude Code, Cursor, OpenCode) and your MCP servers. The agent sees a handful of meta-tools; real servers and skills start only when the task needs them.

```
You  →  discover · activate · load skill
              ↓
         lazygate
              ↓
    jira · github · datadog · …  (on demand)
```

**~96% fewer input tokens when idle** across a typical multi-server setup (see [benchmark notes](docs/reference.md#benchmark)).

Formerly `context-broker` — [existing installs upgrade in place](docs/reference.md#upgrading-from-context-broker).

---

## Why teams use it

| Without lazygate | With lazygate |
|---|---|
| Every server’s tool schemas ride along on every turn | Only meta-tools until you activate something |
| Secrets scattered in client JSON | Vault, `${secret:…}`, and per-user credentials |
| Each developer maintains their own MCP zoo | One shared catalog; install what you need |
| Skills dump full instructions into the session | Discover → load the body on demand |

---

## Two ways to run

### Personal (stdio)

One agent, one machine. Migrate your existing MCP config and go.

```bash
npx -y lazygate migrate --from cursor   # or: claude, opencode
# restart the client — ask “list active servers”
```

Requires Node.js ≥ 26. Add `--dry-run` to preview; `npx -y lazygate revert --from cursor` to undo.

### Team gateway (HTTP)

One shared instance for several people or clients — Streamable HTTP, personal access tokens, per-user sessions, and a web catalog.

```bash
npx -y lazygate token create --user you --admin
npx -y lazygate serve
# → MCP  http://127.0.0.1:8787/mcp
# → UI   http://127.0.0.1:8787/ui
```

Open `/ui`, paste a token, **Install** servers and skills, **Connect** credentials. Full guide: [docs/gateway.md](docs/gateway.md).

---

## What the agent sees

Six meta-tools instead of dozens of schemas:

| Tool | Job |
|---|---|
| `discover_tools` | Find the right server for a task |
| `activate_server` / `deactivate_server` | Start or stop it |
| `list_active_servers` | What’s running in this session |
| `discover_skill` / `load_skill` | Find and load playbooks on demand |

Example:

```
You:    Search GitHub for issues labelled bug
Agent:  discover_tools → activate_server("github") → search_issues(...)
```

Unknown tool calls auto-activate the best-matching server and retry. Details: [Routing](docs/reference.md#routing).

---

## Catalog & credentials

- **Servers** — `~/.config/lazygate/servers.json` (stdio or HTTP/OAuth). `description` + `keywords` drive discovery.
- **Skills** — `~/.config/lazygate/skills.json`; bodies load only via `load_skill`.
- **Gateway UI** — browse, install, connect OAuth/API keys; admins manage the catalog, tokens, and shared secrets.
- Edits to config apply without restarting.

Example server entry and every field: [Configuration](docs/reference.md#configuration).

---

## Migrate from Claude, Cursor, or OpenCode

```bash
npx -y lazygate migrate --from claude [--dry-run] [--servers | --skills | --plugins]
npx -y lazygate revert  --from claude [--dry-run]
```

`migrate` converts servers, extracts secrets to your shell, registers skills in place, wires lazygate into the client, and keeps backups of every file it touches. Limits and details: [Migration](docs/reference.md#migration).

---

## Manual install (stdio)

```bash
claude mcp add --scope user lazygate -- npx -y lazygate
```

Or in `~/.claude.json` / Cursor `mcp.json`:

```json
{ "mcpServers": { "lazygate": { "command": "npx", "args": ["-y", "lazygate"] } } }
```

From source: `git clone` → `npm install && npm run build` → point the client at `dist/index.js`. Use the name **`lazygate`** so migrate doesn’t create a second entry.

---

## Docs & development

| Doc | Contents |
|---|---|
| [docs/gateway.md](docs/gateway.md) | HTTP gateway, UI, tokens, vault |
| [docs/reference.md](docs/reference.md) | Config, routing, migrate, benchmark |
| [CLAUDE.md](CLAUDE.md) | Architecture for contributors |

```bash
npm run build && npm test
npm run dev          # run from source
npm run benchmark    # token savings (needs `claude` on PATH)
```
