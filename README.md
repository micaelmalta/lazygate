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

**Large idle-token savings** in multi-server setups (historically ~96% vs loading every schema upfront in one cold-cache run — idle-only; re-run `npm run benchmark` on your catalog). See [benchmark notes](docs/reference.md#benchmark).

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

## Install

The package is **not on npm yet**. Install from this repo (Node.js **≥ 20**):

```bash
git clone https://github.com/micaelmalta/lazygate.git
cd lazygate
npm install && npm run build
# optional: put `lazygate` on your PATH
npm link
```

Or run without linking:

```bash
node /path/to/lazygate/dist/index.js <subcommand>
# tarball:
# npm install -g https://github.com/micaelmalta/lazygate/archive/refs/heads/main.tar.gz
```

Below, `lazygate` means that binary (or `node …/dist/index.js`).

---

## Two ways to run

### Personal (stdio)

One agent, one machine. Migrate your existing MCP config and go.

```bash
lazygate migrate --from cursor   # or: claude, opencode
# restart the client — ask “list active servers”
```

Add `--dry-run` to preview; `lazygate revert --from cursor` to undo.

### Team gateway (HTTP)

One shared instance for several people or clients — Streamable HTTP, personal access tokens, per-user sessions, and a web catalog.

```bash
lazygate token create --user you --admin
lazygate serve
# → MCP  http://127.0.0.1:8787/mcp
# → UI   http://127.0.0.1:8787/ui
```

Open `/ui`, paste a token, **Install** servers and skills, **Connect** credentials. Full guide: [docs/gateway.md](docs/gateway.md).

For remote access, put a **TLS reverse proxy** in front and use `--allow-remote` (the gateway speaks plain HTTP only). See [Remote access / TLS](docs/gateway.md#remote-access--tls).

---

## What the agent sees

**11 meta-tools** in `META_TOOLS` (9 listed in stdio; gateway also advertises `connect_server` / `disconnect_server`). Activated servers stay off `tools/list` by default — use `describe_tool` / `call_tool` (or set `expose` in `servers.json`).

Clients that ignore `notifications/tools/list_changed` never pick up newly exposed schemas: prefer `call_tool` / `describe_tool` instead of expecting upstream tools to appear in `tools/list`. Changing `tools/list` also invalidates prompt cache for everything after the tools block — another reason to keep the default `expose: "none"`.

| Tool | Job |
|---|---|
| `discover_tools` | Find the right server for a task |
| `activate_server` / `deactivate_server` | Start or stop it |
| `describe_tool` / `call_tool` | One schema on demand; call without merging into `tools/list` |
| `list_active_servers` | What’s running in this session |
| `discover_skill` / `load_skill` / `read_skill_file` | Find, load playbooks, and read bundled skill files |
| `connect_server` / `disconnect_server` | Gateway only — credentials (hidden in stdio) |

Example:

```
You:    Search GitHub for issues labelled bug
Agent:  discover_tools → activate_server("github") → describe_tool → call_tool(...)
```

Unknown tool calls can still auto-activate and retry by name when tools are exposed. Details: [Routing](docs/reference.md#routing).

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
lazygate migrate --from claude [--dry-run] [--servers | --skills | --plugins]
lazygate revert  --from claude [--dry-run]
```

`migrate` converts servers, extracts secrets to your shell, registers skills in place, wires lazygate into the client, and keeps backups of every file it touches. Limits and details: [Migration](docs/reference.md#migration).

---

## Manual install (stdio)

Point the client at the built binary:

```bash
claude mcp add --scope user lazygate -- node /path/to/lazygate/dist/index.js
```

Or in `~/.claude.json` / Cursor `mcp.json`:

```json
{
  "mcpServers": {
    "lazygate": {
      "command": "node",
      "args": ["/path/to/lazygate/dist/index.js"]
    }
  }
}
```

Use the name **`lazygate`** so migrate doesn’t create a second entry. After `npm link`, `command` can be `lazygate` with no args.

---

## Docs & development

| Doc | Contents |
|---|---|
| [docs/gateway.md](docs/gateway.md) | HTTP gateway, UI, tokens, vault, TLS proxy |
| [docs/reference.md](docs/reference.md) | Config, routing, migrate, benchmark |
| [CLAUDE.md](CLAUDE.md) | Architecture for contributors |

```bash
npm run build && npm test
npm run dev          # run from source
npm run benchmark    # token savings (needs `claude` on PATH)
```
