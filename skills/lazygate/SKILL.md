---
name: lazygate
description: >-
  Use the lazygate MCP gateway (meta-tools, catalogs, credentials, profiles).
  Apply whenever the user mentions lazygate, the gateway UI, discover/activate
  servers or skills, Install/Connect in /ui, or when tools live behind
  user-lazygate instead of a direct MCP server.
---

# Lazygate

lazygate is an MCP proxy. Cursor/Claude see a few **meta-tools**; real servers and skills load on demand. Do not expect full upstream tool lists until you activate a server.

## Meta-tools

| Tool | Use |
|---|---|
| `discover_tools` | Rank servers for a task (`query`) |
| `activate_server` | Start a server by `server_name`; tools appear after this |
| `deactivate_server` | Stop a server |
| `list_active_servers` | What is running in this session |
| `discover_skill` | Rank installed skills (`query`). No dedicated list — a non-matching query returns available skills |
| `load_skill` | Fetch full instructions for `skill_name`, then follow them |
| `connect_server` | Gateway only: link to save OAuth/API key, then activate |

Namespace in Cursor is typically `user-lazygate`.

## Default workflow

1. **Servers:** `discover_tools` → `activate_server` → call that server’s tools. If a tool is unknown, activate the best match and retry.
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
