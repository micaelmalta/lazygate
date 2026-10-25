---
name: lazygate
description: >-
  Use the lazygate MCP gateway (meta-tools, catalogs, credentials, profiles).
  Apply whenever the user mentions lazygate, the gateway UI, discover/activate
  servers or skills, Install/Connect in /ui, or when tools live behind
  user-lazygate instead of a direct MCP server.
---

# Lazygate

lazygate is an MCP proxy. Cursor/Claude see **11 meta-tools** (9 in stdio; gateway also lists `connect_server` / `disconnect_server`). Real servers and skills load on demand. Activated tools stay off `tools/list` by default — use `describe_tool` / `call_tool`.

Clients that ignore `notifications/tools/list_changed` will not see newly exposed schemas in `tools/list`; use `call_tool` / `describe_tool` instead. Changing `tools/list` also invalidates prompt cache for everything after the tools block — keep `expose: "none"` and prefer `call_tool`.

## Meta-tools

| Tool | Use |
|---|---|
| `discover_tools` | Rank servers for a task (`query`) |
| `activate_server` | Start a server by `server_name` (schemas not merged into `tools/list` unless `expose` is set) |
| `describe_tool` | One tool schema on demand (`server`, `tool`) |
| `call_tool` | Invoke without exposing schemas (`server`, `tool`, `args`) |
| `deactivate_server` | Stop a server |
| `list_active_servers` | What is running in this session |
| `discover_skill` | Rank installed skills (`query`). No dedicated list — a non-matching query returns available skills |
| `load_skill` | Fetch full instructions for `skill_name`, then follow them |
| `read_skill_file` | Read a bundled file under a skill (`skill_name`, path) |
| `connect_server` / `disconnect_server` | Gateway only: credentials (not listed in stdio) |

Namespace in Cursor is typically `user-lazygate`.

## Default workflow

1. **Servers:** `discover_tools` → `activate_server` → `describe_tool` (if needed) → `call_tool`. Prefer `call_tool` over expecting upstream tools in `tools/list` (especially if the client ignores `tools/list_changed`).
2. **Skills:** `discover_skill` → `load_skill` → obey the loaded body for the rest of the task.
3. Prefer lazygate over configuring the same upstream MCP directly in Cursor when the gateway already catalogs it.

## Gateway profiles and credentials

- Only **Installed** servers/skills (per user profile) show up in discover/activate/load.
- Catalog: `http://127.0.0.1:8787/ui` (or the gateway’s `/ui`) → Servers / Skills → Install.
- User-scoped keys: Credentials tab, or `connect_server`. OAuth opens a browser; API tokens go in the vault.
- Shared `${secret:…}` values are admin-managed (Configure / All secrets).
- Sessions are isolated: each MCP session has its own ProcessManager and creds; users do not share child processes.

## Do not

- Paste long-lived API tokens into chat or client config when the vault / 1Password path exists.
- Call upstream tools before `activate_server` succeeds.
- Skip `load_skill` when a ranked skill clearly matches the task.
