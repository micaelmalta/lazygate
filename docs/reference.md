# lazygate reference

Details that don't fit in the [README](../README.md) or [How it works](how-it-works.md): configuration fields, OAuth, routing, migration
and benchmarking.

- [Configuration](#configuration)
- [HTTP servers and OAuth](#http-servers-and-oauth)
- [Skills](#skills)
- [Routing](#routing)
- [Migration](#migration)
- [Benchmark](#benchmark)
- [Upgrading from context-broker](#upgrading-from-context-broker)

---

## Configuration

Files live in `~/.config/lazygate/`:

| File | Purpose |
|---|---|
| `servers.json` | server registry |
| `skills.json` | skill registry |
| `tool-index.json` | learned tool names/descriptions (written by lazygate, safe to delete) |
| `tokens/`, `clients/` | OAuth tokens and registered clients (`0700` dirs, `0600` files) |
| `scripts/` | `session-sync.mjs` and `lib/`, installed by `migrate` |

**Resolution order:** `--config <path>` / `--skills <path>` flag, then `~/.config/lazygate/<file>`. With
neither, lazygate starts with an empty registry and logs where to put one. `config/*.json` in the repo
are examples only and are never loaded implicitly.

Entries are validated on load and on every reload. An invalid entry is skipped and reported once on
stderr by name (``servers.github — keywords: Expected array``) instead of breaking discovery for
everyone. `servers.json` is checked on `discover_tools` / `activate_server` (and related meta-tools)
and `skills.json` on `discover_skill` / `load_skill`; each file is re-parsed only when its mtime
changes, so edits apply without a restart and unchanged files are not re-read every call. A
half-written file keeps the previous config.

### servers.json

```json
{
  "servers": {
    "my-stdio-server": {
      "description": "One sentence — used by discover_tools to match queries",
      "keywords":    ["keyword1", "keyword2"],
      "command":     "npx",
      "args":        ["-y", "my-mcp-server"],
      "env":         { "API_KEY": "${MY_API_KEY}" },
      "inheritEnv":  false,
      "toolTimeoutMs": 300000,
      "autoActivate": false
    },
    "my-http-server": {
      "description": "Remote MCP server over HTTP with static auth",
      "keywords":    ["keyword1", "keyword2"],
      "type":        "http",
      "url":         "https://my-mcp-server.example.com/mcp",
      "headers":     { "Authorization": "Bearer ${MY_TOKEN}" }
    },
    "slack": {
      "description": "Slack — search messages, send communications, manage canvases",
      "keywords":    ["slack", "message", "channel", "canvas"],
      "type":        "http",
      "url":         "https://mcp.slack.com/mcp",
      "oauth":       { "clientId": "xxx", "callbackPort": 3118 }
    }
  }
}
```

| Field | Meaning |
|---|---|
| `description`, `keywords` | what `discover_tools` matches against |
| `command`, `args`, `env` | stdio server. `${VAR}` is resolved from the environment lazygate runs in; an unset variable logs a warning and becomes an empty string |
| `type`, `url`, `headers`, `oauth` | HTTP server (see below) |
| `inheritEnv` | environment passed to a stdio child — see below |
| `toolTimeoutMs` | per-call `tools/call` timeout for stdio and HTTP. Default 5 minutes |
| `autoActivate` | `false` (default): spawned on `activate_server` or auto-activation. `true`: spawned when lazygate starts, in the background after it has connected, so a slow server never delays startup. Use `true` for servers you reach every session; keep heavy ones (`docker build`, `npm install` on first launch) `false` |
| `expose` | which tools merge into the broker's `tools/list` after activate: omit / `"none"` (default) — none, use `describe_tool` / `call_tool`; `"all"` — every schema (legacy); string array — allowlist of tool names (bare upstream names) |
| `namespaceTools` | when `true`, expose and accept tools as `server__tool` so identical upstream names across servers do not collide. Default `false`. Gateway-wide: `lazygate serve --namespace-tools` (per-server `true`/`false` overrides) |
| `toolChain` | lets `run_chain` scripts call this server's tools. `true` allows every tool; an array allows only those bare tool names. Omitted = no script access (use `call_tool`). See [Tool chain](#tool-chain) |
| `auth`, `groups` | gateway mode only — credential sources and access policy; see [gateway.md](gateway.md) |
| `local` | gateway mode: hide from remote users / refuse activate (needs the caller's machine) |
| `migratedFrom`, `disabledPlugins` | set by `migrate`; `revert` relies on them |

**Environment inheritance.** In personal stdio mode, a child gets lazygate's full environment plus its
own `env` by default. In `lazygate serve` (gateway) mode the default is `inheritEnv: false`. Set
`inheritEnv` explicitly to override:

- `false` — only a minimal base set (`PATH`, `HOME`, locale, temp dirs, proxy and CA settings, `XDG_*`, …)
- `["GITHUB_TOKEN", "AWS_*"]` — the base set plus the named variables (trailing `*` is a prefix match)
- `true` / omit (stdio mode) — full parent environment

`LAZYGATE_*` is always stripped from the child environment (vault key, `LAZYGATE_SECRET_*`, …), even
when inherit is full. The server's own `env` entries are always added on top (then stripped if they
use the `LAZYGATE_` prefix).

**Tool names.** By default a server may not expose a tool whose name is already provided by another
active server, or that shadows one of lazygate's meta-tools. Activation fails with a message naming
the clash; deactivate the other server first, or set `namespaceTools: true` (per server or
`--namespace-tools` on the gateway) so tools are exposed as `server__tool`. With namespacing,
`describe_tool` / `call_tool` still accept the bare upstream name when `server` is set; direct
`tools/call` and `tools/list` use the namespaced form.

**Errors** from lazygate and from proxied calls are returned with `isError: true`.

## Response optimization

Response transformations are opt-in and are disabled by default. Add a top-level
`responseOptimization` section to `servers.json`; policy changes reload with the server registry.
Set `enabled` to `true` to apply the global `defaultMode` and per-tool policies. A tool key uses
`server.tool`; `lazygate.run_chain` selects the policy for the final value returned by a script.

```json
{
  "responseOptimization": {
    "enabled": true,
    "defaultMode": "off",
    "maxOutputTokens": 4000,
    "tools": {
      "github.search_issues": {
        "mode": "project",
        "fields": ["id", "title", "state", "assignee.login"]
      },
      "docs.get_documentation": { "mode": "html_reader" },
      "jira.search_issues": {
        "mode": "prune",
        "removeNulls": true,
        "removeEmptyObjects": true
      }
    }
  }
}
```

Supported modes are `off`, `prune`, `project`, `jsonpath`, `schema`, `html_markdown`,
`html_reader`, and `adaptive`. Adaptive mode skips responses below `minInputTokens` (default
`128`), evaluates up to four candidates within the configured `maxTransformMs` limit, and selects
the smallest output that meets `minSavingsPercent` (default `10`). Ties use the faster candidate. If
no candidate meets the threshold, the response is left unchanged apart from any configured output
budget.

Adaptive needs no per-tool setup. Without `candidates` (including `defaultMode: "adaptive"`) it
compares an automatic set: `prune` of nulls and empty strings, arrays and objects, and
`html_markdown`. It adds `schema` for responses of at least `schemaMinInputTokens` (default `8000`),
where a summary plus a result handle beats returning or truncating the payload. A tool can still
list explicit candidates:

```json
{
  "responseOptimization": {
    "enabled": true,
    "defaultMode": "adaptive",
    "maxOutputTokens": 4000
  }
}
```

```json
{
  "responseOptimization": {
    "enabled": true,
    "tools": {
      "github.search_issues": {
        "mode": "adaptive",
        "minInputTokens": 128,
        "minSavingsPercent": 10,
        "candidates": [
          { "mode": "project", "fields": ["issues.id", "issues.title", "issues.state"] },
          { "mode": "prune", "removeNulls": true, "removeEmptyObjects": true }
        ]
      }
    }
  }
}
```

Adaptive metrics include `selectedMode` (`off` when no candidate was selected). Gateway audit rows
and usage summaries retain this value, and the dashboard shows per-mode selection counts. Response
metadata includes it when metadata is requested or the result is incomplete.

**Policy suggestions.** The gateway dashboard (and `usage.recommendations` in the `/ui` dashboard
API) suggests at most one change per upstream tool from the recent audit window, once a tool has
at least five successful calls: review a policy that falls back on 20% or more of calls or whose
transform time exceeds half the call time; turn off a policy that saves under 5%, or adaptive
optimization that almost never selects a candidate; pin a mode that adaptive selects on 80% or more
of calls; add a projection when agents pass `fields` on at least half the calls; and enable
`adaptive` for tools whose median response is 2,000 tokens or more with no policy. Each suggestion
names the `server.tool` key and, where possible, a policy to paste into `responseOptimization.tools`.
They are prompts for review, not automatic changes.

Candidate modes are
`prune`, `project`, `jsonpath`, `schema`, `html_markdown`, and `html_reader`; each candidate can
include the same mode-specific options used by its standalone policy. Projection paths use dot
notation or quoted/numeric bracket notation and continue
through arrays. JSONPath uses `jsonpath-plus` with bounded data filters; function calls and prototype
access are rejected. `prune` removes only the empty values
enabled by its flags and configured `removeFields`; it preserves `false`, `0`, and duplicate array
items. `schema` returns `_count`, an inferred `_schema`, and a bounded `_sample`.

`html_markdown` converts semantic content while keeping navigation and page chrome. `html_reader`
extracts a main or article area and removes navigation, sidebars, headers, and footers. Both strip
scripts, styles, comments, tracking pixels, hidden content, and unsafe link schemes. The optimizer
does not fetch URLs, execute page code, or alter intermediate `run_chain` results.

**Agent-requested fields.** `call_tool` accepts an optional `fields` list of dot-separated paths
(for example `["id", "bodyLength"]`). The response is projected to those fields even when
`enabled` is `false`, because the calling agent asked for it; configured output budgets still apply.
Metrics and metadata carry `intent: "fields"`, and the full response stays retrievable through a
result handle.

**Token counting.** `tokenizer` selects the counter for `maxOutputTokens`, the per-tool `maxTokens`,
adaptive selection, metrics, and gateway audit rows: `chars_per_4` (default), `o200k_base`, or
`cl100k_base`. The last two are exact public encodings (via `js-tiktoken`, loaded on first use);
Claude's tokenizer is not public, so they approximate Claude counts more closely than four
characters per token (JSON typically runs nearer three) without matching them. Inputs over 256 KiB
are counted from a 64 KiB sample and scaled. `--tokenizer <name>` on `lazygate` (stdio) or
`lazygate serve` overrides the config. Embedding hosts can instead pass any object implementing the
exported `Tokenizer` interface (`name` plus `countTokens(serializedJson)`) as `tokenizer` to
`createBroker` or `startGateway`, or directly to `estimateTokens` / `optimizeToolResult`. If a
tokenizer throws or returns a non-integer count, the optimizer falls back to four characters per
token and marks the metric as `<name>_fallback_chars_per_4`. `maxOutputBytes` remains an exact
serialized-byte limit.

**Result handles.** When `call_tool` or `run_chain` returns an incomplete result (projection,
schema, reader mode, lossy pruning, or truncation to a budget), the full response is kept behind
an opaque handle. The handle appears in `_meta.lazygate.responseOptimization.resultHandle` and in a
one-line note appended to the result text, because many clients do not show `_meta` to the model.
Call `get_result` with it:

- Structured results (structured content, or a text block holding JSON): pass `fields`
  (dot-separated paths such as `issues.id`) for just those fields, or omit them for the whole value.
- Text results (HTML, Markdown, plain text): pass `offset` (default `0`) and continue from the
  returned `nextOffset` until it is `null`.

`get_result` defaults to a 4,000-token output cap (`maxTokens`, at most 16,000). When a budget is
larger than 512 tokens, truncation leaves 128 tokens free for the handle note; if the note still
does not fit, the handle is dropped and the bounded response returned without it. Handles are kept
in memory for five minutes, are scoped to the broker session, and are discarded when that session
ends. Each session stores at most 100 results, 2 MiB total, and 1 MiB per result; oversized
results do not receive a handle. Field paths reject prototype-related keys.

Oversized text is cut at paragraph or line boundaries where possible; structured values are cut at
record or property boundaries. Truncation measures the serialized response (so escaped newlines and
quotes count) and leaves room for the incomplete-result metadata. A partial result carries `_meta.lazygate.responseOptimization`
with `complete: false`; `run_chain` also includes a summary in its returned text when needed. Projection, JSONPath, schema,
reader mode, and pruning that removes values are marked incomplete because they intentionally omit
source information. Metrics include original and optimized token estimates, savings, duration, and
failure status; they are emitted to stderr unless the broker caller supplies a metrics sink.

Input and processing safeguards are configurable with `maxInputBytes`, `maxOutputBytes`,
`maxNestingDepth`, `maxHtmlNodes`, and `maxTransformMs`. JSONPath queries are limited to 512
characters, 10,000 matches, and the configured input limits. Parsing failures return the original
result when there is no hard output limit. Tool errors pass through unchanged unless a hard output
limit requires an explicit incomplete-result or budget error. To roll back,
set `enabled` to `false` or remove the `responseOptimization` section; optimization is off when no
section is present.

---

## HTTP servers and OAuth

For `type: "http"` servers, auth is auto-discovered:

1. lazygate connects without credentials. A `401` starts OAuth (`oauth: true` or an object authenticates
   up front; `oauth: false` never uses OAuth). A static `Authorization` header is never replaced.
2. It discovers the authorization server (`/.well-known/oauth-protected-resource`, then AS metadata).
3. If `oauth.clientId` is omitted and the AS has a `registration_endpoint`, it registers a public
   client (dynamic client registration). The client and its callback port are remembered.
4. If `oauth.callbackPort` is omitted, an ephemeral loopback port is used for the PKCE redirect.
5. Authorize and token requests carry the RFC 8707 `resource` parameter. Scopes come from
   `oauth.scopes` or the server's protected-resource metadata, never "everything the AS supports".
6. The callback accepts only `GET /callback` with the matching `state`. The browser is launched without
   a shell (`open` / `xdg-open` / `rundll32`) and the URL is always printed to stderr as a fallback.
7. Tokens are stored under `~/.config/lazygate/tokens/`, bound to the server URL they were issued for.
   On a `401` mid-session a fresh token is obtained (refresh token first) and the call is retried once.

Set `oauth: { clientId, callbackPort }` when the AS has no dynamic registration (e.g. Slack).

Requests send `Accept: application/json, text/event-stream`, parse JSON or SSE bodies (matched by
JSON-RPC `id`), send `MCP-Protocol-Version` after `initialize`, re-initialize once if the session
expires (404), and close the session on deactivate.

---

## Skills

`skills.json` registers file-based skills that are loaded on demand:

```json
{
  "skills": {
    "my-skill": {
      "description": "One sentence — used by discover_skill to match queries",
      "keywords":    ["keyword1", "keyword2"],
      "path":        "/path/to/skills/my-skill/SKILL.md"
    }
  }
}
```

`migrate` and the `SessionStart` hook keep this file in sync. Same-named skills from different sources
are registered as `name` and `name@source`.

Each migrated `SKILL.md` is split into:

- `SKILL.md` — frontmatter plus a one-line `<!-- lazygate: … -->` pointer (what the client injects every session)
- `INSTRUCTIONS.md` — the body, returned by `load_skill`

`revert` merges them back, reproducing the original file.

### Dynamic prompts (arguments + context)

Skills can declare a `prompt` block so the gateway exposes them as parameterized MCP prompts
(`prompts/list` / `prompts/get`) and so `load_skill` can substitute arguments:

```json
{
  "skills": {
    "deploy-check": {
      "description": "Evaluate deployment readiness for a service",
      "keywords": ["deploy", "release"],
      "path": "/path/to/deploy-check/SKILL.md",
      "prompt": {
        "arguments": [
          { "name": "service_name", "description": "Service id", "required": true },
          { "name": "environment", "description": "Target env", "default": "staging" }
        ],
        "context": [
          {
            "name": "status",
            "url": "https://api.example.com/services/{{service_name}}/status",
            "headers": { "Authorization": "Bearer ${secret:status-api}" },
            "optional": true
          }
        ]
      }
    }
  }
}
```

In the skill body (and in context `url` / `headers` / `body`):

- `{{service_name}}` — prompt argument (after defaults)
- `{{context.status}}` — JSON (or text) from the named context fetch
- `${secret:path}` — gateway secret (headers/body/url only)

Context fetches use the same SSRF rules as other outbound HTTP: https only (plain http only to
loopback), and the address DNS returned is validated and then **pinned** for the connection, so a
second lookup cannot rebind the host to an internal address. Redirects are never followed.
Private and link-local targets (RFC 1918, ULA, CGNAT, `169.254.0.0/16` other than the cloud metadata
address, which is always refused) are **off by default**; opt in per context entry with
`"allowPrivate": true`. The gateway no longer allows them globally.
Each response is capped (~64 KB). Set `optional: true` to inject an error note instead of
failing the prompt when a fetch fails.

Clients that support MCP prompts can invoke these as slash commands with parameters.
Agents without prompt UI should call `load_skill` with `args: { "service_name": "…" }`.

---

## Routing

`discover_tools` / `discover_skill` score each entry against the query:

- keywords: +2 each (multi-word keywords match as phrases)
- description words longer than 4 characters: +1 each
- learned tool words (servers only): up to +2 in total
- light plural handling, so `git` does not match "digital" and `pr` does not match "prompt"

**Learned tool descriptions.** Migrated servers only have a generic description. Each time a
shared-scope server is activated (or an admin runs **Index all tools** in the gateway Sessions tab),
lazygate records its tool names and descriptions in `tool-index.json` (keyed by the server's
command/URL, so edits invalidate it). Later `discover_tools` calls also match against that text, shown
as `tools:` in the match line. In gateway mode, user-scoped servers never write to the shared index
(tool lists fetched with one user's credentials must not leak to everyone).

**Auto-activation.** If the client calls a tool that isn't active, lazygate scores all servers against the
tool name, activates the best match and retries once. Failures come back as tool errors.

lazygate sends `notifications/tools/list_changed` whenever the exposed tool set changes: on activate
(when `expose` merges schemas), on deactivate, when a server exits unexpectedly, and when a server
announces a change itself. With the default `expose: "none"`, activation does not add schemas to
`tools/list` — use `describe_tool` / `call_tool`.

**Prompt-cache cost.** In clients that cache prompts (Claude API, etc.), the tools block sits early
in the prompt. A `tools/list_changed` that alters `tools/list` invalidates the cache for
**everything after the tools block** on the next turn — often the whole conversation prefix. Prefer
keeping `expose: "none"` (default) and calling through `describe_tool` / `call_tool` so the
advertised tool list stays stable and list_changed does not churn schemas. Use `expose: "all"` or an
allowlist only when you need upstream tools in `tools/list` and accept the cache cost.

**Clients that ignore `tools/list_changed`** never pick up newly exposed schemas even when `expose`
is set. Prefer `call_tool` / `describe_tool` so those clients still work. There are **13** meta-tools
in `META_TOOLS` (11 listed in stdio; gateway also advertises `connect_server` / `disconnect_server`).

---

## Tool chain

Tool chain runs a multi-step workflow in a script, so intermediate results never reach the model.
The model calls `run_chain` once; the script calls opted-in tools as `servers.<name>.<tool>(args)`
and returns a value. Only the script's `console.log` lines and return value go back to the model.

Use it for chains (list, filter, then fetch details). Use `call_tool` for single calls and for any
tool with side effects that you want Cursor or the client to approve one at a time.

**Opt in per server** in `servers.json`:

```json
"jira": { "command": "...", "toolChain": ["search", "get_issue"] }
```

`toolChain: true` allows every tool on the server, except tools whose upstream annotations say
`destructiveHint: true`: `run_chain` refuses those unless the server's `toolChain` is an array that
names the tool. `describe_tool` shows each tool's `readOnlyHint` / `destructiveHint` annotations. A server without `toolChain` has no binding in
scripts. Tools that are not allowlisted are not bound, so a script that calls them gets a
"not a function" error and nothing reaches upstream.

**Discovery.** `describe_tool` with only `server` returns TypeScript stubs for that server's
tool-chain tools, a compact alternative to full JSON Schemas:

```ts
servers.jira.search(args: { jql: string; maxResults?: number }): Promise<unknown> // Search issues
```

**Results.** A tool result becomes an object (from `structuredContent`, or parsed JSON text).
A tool that returns `isError` becomes `{ error: "..." }` and does not throw, so a script can handle
it and continue. Each run is a fresh scope; nothing carries over between runs.

**Lazy activation.** A tool-chain server is activated the first time a script calls it, not when the
script starts. Every script call goes through the same checks as `call_tool` (visibility, allowlist,
then activation), one at a time for each call.

**Limits (per run).** Each limit fails the run with a message the model can act on:

| Limit | Default |
|---|---|
| Script memory | 64 MiB |
| Stack | 512 KiB |
| Wall-clock deadline | 60 s |
| Nested tool calls | 64 |
| Concurrent calls | 4 (`Promise.all` is capped at this) |
| `console.log` output | 64 KiB (truncated after) |
| Values crossing the boundary (args, results, return) | 1 MiB |
| `run_chain` source | 64 KiB |

**Security model.** The sandbox is QuickJS compiled to WebAssembly (`quickjs-emscripten`). The
script has no `require`, `process`, `fetch`, filesystem or imports; its only reach is the
`servers.*` bindings and `console.log`. Every nested call is a normal tool call: the gateway audits
each one (with `via: "run_chain"`), and redacts credential values from logs and results.

**Gateway.** Set Tool chain per server in the admin UI (off, all tools, or an allowlist).

---

## Migration

```bash
lazygate migrate --from claude        # ~/.claude.json, ~/.claude/skills, plugin cache
lazygate migrate --from cursor        # ~/.cursor/mcp.json
lazygate migrate --from opencode      # ~/.config/opencode/opencode.json
lazygate migrate --from /path/to.json # any file with an mcpServers map

lazygate migrate --from claude --dry-run
lazygate migrate --from claude --servers   # or --skills / --plugins
```

(`lazygate` is the binary from a [source install](../README.md#install); the package is not on npm yet.)

**What it does**

- **Servers** — converts stdio and HTTP entries to lazygate format with `description`, `keywords`,
  `autoActivate: false` and a `migratedFrom` marker (`claude`, `cursor`, `opencode`, or `plugin` for
  servers shipped by Claude Code plugins). Re-running keeps your edits to `description`, `keywords` and
  `autoActivate`. Cursor's `${env:VAR}` syntax is normalised to `${VAR}`. Only *global* Claude servers
  are migrated; project-scoped ones (`projects[path].mcpServers`) are left alone.
- **Registration** — adds `lazygate` to `~/.claude.json`, and to Cursor's (`mcpServers`) or OpenCode's
  (`mcp`, command array) config when you migrate from them.
- **Skills** — registers them in place in `skills.json` (nothing is moved) and splits each `SKILL.md`.
- **Plugins** — registers plugin skills from `~/.claude/plugins/cache/`, installs `session-sync.mjs` and a
  `SessionStart` hook that keeps registrations fresh after plugin updates, and disables plugins whose
  MCP server was migrated (recorded for `revert`).
- **Secrets** — values matching `_TOKEN`, `_KEY`, `_SECRET`, `_PASSWORD` (and secret-looking
  `Authorization` / API-key headers) are moved to your shell config and replaced with `${VAR}`
  references: `~/.config/fish/config.fish` for fish, `~/.bashrc` for bash, `~/.zshenv` otherwise.
  Existing variables are not duplicated and values are escaped.
- **Safety** — every config file it modifies is first copied to `<file>.bak-<timestamp>` and written
  atomically. `servers.json` is written before anything is removed from a source config.

### Undo

```bash
lazygate revert --from claude             # everything
lazygate revert --from claude --dry-run
lazygate revert --from cursor --servers   # or --skills / --plugins
```

- **Servers** — finds entries by `migratedFrom` and writes them back in that client's own format
  (`mcpServers` for Claude/Cursor, `mcp` with a command array for OpenCode, `${env:VAR}` for Cursor).
  `--from plugin` removes plugin-provided entries and re-enables the plugins `migrate` disabled.
- **Registration** — removes `lazygate` from Cursor/OpenCode when their servers are restored, and from
  `~/.claude.json` only once no migrated servers remain, so a partial revert never strands the rest.
- **Skills and plugins** — merges `INSTRUCTIONS.md` back into `SKILL.md`, removes registry entries and
  the `SessionStart` hook.
- Secrets that `migrate` appended to your shell file are left in place; remove them by hand if unwanted.

---

## Benchmark

Measures **your** catalog with `claude -p` (needs `claude` on `PATH` and a working Anthropic
auth). Runs against `~/.config/lazygate/servers.json` and `skills.json` by default.

```bash
npm run build
lazygate benchmark                                      # MCP + skills via `claude -p`
lazygate benchmark --runner codex --model gpt-6-luna    # same via Codex / custom provider
lazygate benchmark --estimate                           # local chars÷4 preview, no API
lazygate benchmark --mcp-only                           # servers only
lazygate benchmark --skills-only                        # skills only
lazygate benchmark --servers github,jira
lazygate benchmark --skills loi,writer,rlm
lazygate benchmark --rounds 3                           # average over rounds
lazygate benchmark --tasks                              # multi-step fixture: direct, call_tool, call_tool+opt, run_chain
lazygate benchmark --tasks --rounds 3                   # same, averaged over 3 runs per strategy
lazygate benchmark --tasks --include-catalog            # also load your real catalog (see warning below)
lazygate benchmark --responses-live --cases cases.json --iterations 5 # live response optimization
lazygate benchmark --responses-live --cases cases.json --tokenizer o200k_base
```

`--tasks` runs Claude with permission checks off, so by default it only loads the tickets fixture
server. `--include-catalog` adds every runnable server from your Lazygate catalog — any destructive
tool in them then runs unprompted. Use it only with a catalog you would trust that way.

`--tasks` runs the tickets fixture four ways and only prints token deltas when each side of a
pair answered correctly. With `--rounds N`, each strategy runs N times; input tokens, turns and
duration are the mean of the correct runs, and each row shows `correct k/N` and the min–max input
range:

- **direct** — Claude connects to the tickets fixture (with `--include-catalog`, also every
  *runnable* server in your Lazygate `servers.json`; OAuth-only HTTP servers are skipped, same as
  the idle benchmark). Classic MCP: all those tool schemas sit in context.
- **call_tool** / **run_chain** — one Lazygate process wrapping that same catalog; only meta-tools
  are advertised, and the task uses the tickets fixture.
- **call_tool+opt** — `call_tool` with response optimization on (`defaultMode: "adaptive"`,
  `maxOutputTokens: 4000`, no per-tool policy), and the model passes `fields` for `get_ticket`.
  This is the end-to-end check for response optimization: a real model must still produce the
  right answer from the optimized responses, and the input-token delta against `call_tool` is what
  optimization saved over the whole task.

### Live response benchmark

`--responses-live` invokes configured MCP tools and measures optimization on the responses they
actually return. The cases file explicitly selects every tool call; the benchmark does not load or
run the rest of the catalog. Since it calls the tool repeatedly, use only read-only operations.
`readOnly: true` is a declaration in the file, not an automatic safety check.

Each case must list an `off` policy and at least one optimizer policy, plus correctness checks:

```json
{
  "cases": [
    {
      "name": "issue-search",
      "server": "your-configured-github-server",
      "tool": "search_issues",
      "args": { "query": "repo:owner/repo is:issue is:open" },
      "readOnly": true,
      "preservePaths": ["$.structuredContent.issues[*].id"],
      "policies": [
        { "name": "off", "mode": "off" },
        { "name": "issue-fields", "mode": "project", "fields": ["issues.id", "issues.title"] }
      ]
    }
  ]
}
```

Adapt the server, tool, arguments, and paths to the MCP server's actual response shape. `preservePaths`
checks that selected JSONPath values stay identical; `preserveText` checks that each listed text
fragment remains in the response. Every sample must pass these checks for the policy to preserve
correctness. The output includes estimated response token counts and median, p95, and standard
deviation for upstream tool latency, transformation latency, and their sum. It also returns policy
recommendations. A recommendation requires at least three samples, successful upstream calls,
passing preservation checks, no optimizer fallbacks, positive median token savings, and median
optimization latency no more than half the median upstream latency. Otherwise it reports `keep_off` or
`insufficient_evidence` with a reason. Adaptive results include their candidate and selected modes.
These thresholds are a starting signal for policy review, not a production performance guarantee.
An `adaptive` policy may omit `candidates` to measure the automatic set (reported as
`candidateModes: "automatic"`). Token counts use serialized JSON characters divided by four unless
`--tokenizer o200k_base` / `cl100k_base` is passed or `responseOptimization.tokenizer` is set in the
selected config; the output's `tokenizer` field names the counter used. This mode makes no model calls and does
not measure model round trips or full task success. `--responses` remains the deterministic,
synthetic local optimizer smoke benchmark.

### What it measures

| Strategy | Meaning |
|---|---|
| `baseline` | No MCP servers |
| `mcp-direct` | All runnable servers loaded upfront |
| `lazygate` | Meta-tools only (idle) |
| `mcp-active` | Meta-tools + every server (worst case) |
| `skills-full` | Every skill body appended to the system prompt |
| `skills-stubs` | Frontmatter + pointer only (post-split) |
| `skills-one` | Stubs for all + the largest skill loaded in full |

Skill strategies model what a client pays when it reads `SKILL.md` into context before vs after
lazygate's split. They do not call `discover_skill` / `load_skill`.

**Runners.** `--runner claude` (default) uses `claude -p` and is the better measure of MCP tool-schema
cost. `--runner codex --model gpt-6-luna` is a solid measure of skill split savings; Codex carries a
large fixed system prompt (~14k tokens) and often does not put MCP tool schemas into `input_tokens`
the same way, so MCP deltas can look near-zero even when servers start.

**Caveats.** Each run is a single cold-cache turn, so dollar figures overstate steady-state cost;
the idle token reduction (context-window space) is real. Activating every server closes most of the
MCP gap (`mcp-active` ≈ `mcp-direct`). HTTP servers are included only when they have a static
`Authorization` header (OAuth can't run under `claude -p`); skipped entries are listed in the
output. Re-run after catalog or meta-tool changes.

---

## Upgrading from context-broker

The project was renamed from `context-broker` to `lazygate`. Existing installs upgrade in place:

- `~/.config/context-broker` is moved to `~/.config/lazygate` the first time lazygate, `migrate`,
  `revert` or `session-sync` runs. The old path is left as a symlink so an old hook keeps working.
  (`--dry-run` moves nothing.)
- Re-run `lazygate migrate` to replace a `context-broker` entry in your client configs and the old
  `SessionStart` hook with `lazygate` ones. `revert` removes either name.
- Skills split before the rename keep their old `<!-- context-broker: -->` pointer; it is still
  recognised when merging back.
- If you registered the broker by hand, point the client at the built `dist/index.js` (or a linked
  `lazygate` binary).
