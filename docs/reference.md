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
| `expose` | which tools merge into the broker's `tools/list` after activate: omit / `"none"` (default) — none, use `describe_tool` / `call_tool`; `"all"` — every schema (legacy); string array — allowlist of tool names (bare upstream names). **Pin** the few tools an agent uses in nearly every session (with `autoActivate: true`): they are callable by name with no `discover_tools` / `describe_tool` turns, at the price of their schemas in every turn and a `tools/list_changed` prompt-cache hit when the set changes. Leave everything else on `"none"`. See [When to pin](#when-to-pin-expose) |
| `namespaceTools` | when `true`, expose and accept tools as `server__tool` so identical upstream names across servers do not collide. Default `false`. Gateway-wide: `lazygate serve --namespace-tools` (per-server `true`/`false` overrides) |
| `manifest` | `true` (or an array of bare tool names) lists this server's tool signatures in the broker's MCP `instructions`, so the model can `call_tool` / script it with no lookup turn. Signatures come from `tool-index.json`, so a server is listed once it has been activated once. Fixed at startup; costs prompt tokens every turn. See *Manifest* below |
| `previewOnDiscover` | `true` lets `discover_tools` start this server when it is a clear match and has no cached signatures yet, so the reply can show them. Default off: discovery has no side effects. See *Preview of a clear match* under discovery |
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
compares an automatic set that keeps every row and every non-empty value: `html_markdown`, and
`prune` of nulls and empty strings, arrays, and objects. Pruning is still lossy: `null`, `[]`, or
`{}` can mean something different from a missing field, so a pruned result is marked incomplete
and offers a result handle. Tools that declare an `outputSchema` keep their empty values by
default; any tool can opt out of pruning with `"keepEmptyValues": true` (or back in with `false`).

The `schema` summary (field shapes plus a few samples) is never chosen automatically, because the
smallest response is not the most useful one when the agent needs every row: the agent would have
to call `get_result`, and the extra call can cost more than the tokens saved. A tool whose callers
usually want an overview can opt in with `"allowSummary": true`, which adds `schema` for responses
of at least `schemaMinInputTokens` (default `8000`); listing `schema` in `candidates` does the
same explicitly.

Candidates are ranked by serialized size; only the original and the winner go through the
configured tokenizer, which also confirms the winner still meets `minSavingsPercent`. Output
budgets apply once, to the selected result. A tool can still list explicit candidates:

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
`adaptive` for tools whose median response is 2,000 tokens or more with no policy. Before any of
those, it flags tools where agents call `get_result` after 30% or more of the responses that
offered a handle: the reduction is removing data they need. The dashboard's "Result reads" figure
is the same rate across all tools. Both count `get_result` tool calls; the gateway cannot see model
turns, and a read made alongside other calls adds no turn. `lazygate benchmark --tasks` measures
turns end to end. Each suggestion
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

`discover_tools` / `discover_skill` rank each entry against the query. Three strategies exist
(`RankStrategy` in `router.ts`); the default is **`bm25`**.

- **`bm25`** (default) — field-weighted BM25 (`discovery.ts`), no embeddings. Server name and
  keywords count 3×, tool names 2×, the server description 1.5× and tool descriptions 0.7×. Stop
  words are dropped and light stemming plus an alias table (`k8s` ↔ `kubernetes`, `vm` ↔ `instance`,
  `mail` ↔ `email`, …, in `scoring.ts`) expand the query at half weight. An exact tool identifier
  in the query (`create issue`, `list_tickets`) adds a bonus, a partial tool-name hit adds a smaller
  one, and a keyword phrase adds a little more. Usage from the audit log can nudge ties by at most
  12%.
- **`lexical`** — the original word scorer: keywords +2 each (multi-word keywords match as
  phrases), description words longer than 4 characters +1 each, learned tool words up to +2, light
  plural handling (`git` does not match "digital", `pr` does not match "prompt").
- **`hybrid`** — BM25 order with the lexical score kept as detail for every server.

A result is returned when it is a **confident match**: a score of at least 2, an exact or partial
tool-name hit, or the single best BM25 hit with a positive score. `discover_tools` also appends the
tools that matched (`Likely tools: …`). Auto-activation (below) always ranks lexically so that a
tool name keeps resolving to the same server.

**Inline call signatures.** When the best match is clear (no runner-up within 85% of its relevance),
`discover_tools` appends the compact signature of the one or two tools the query points at, for
example `get_order_status(args: { id: string })`, so the agent can `call_tool` right away instead of
spending a `describe_tool` turn. Tools are chosen by tool-name hits first, then by name/description
overlap with the query (`matchTools` in `discovery.ts`). The signature comes from the live schema
when the server is already active, otherwise from the signature learned in `tool-index.json`. A server with four tools or fewer shows all of them
(the tools the query matched first), because that is cheaper than another lookup turn.

**Preview of a clear match (opt-in).** `discover_tools` never starts a server by default: it is a
read-only lookup, so it answers from the config and `tool-index.json` only. After a server has been
activated once, its signatures are in the index and discovery shows them with nothing running. To
show signatures for a server that has never been activated (an empty index, a cold install), set
`"previewOnDiscover": true` on that server in `servers.json` (or pass `previewOnDiscover: true` to
`createBroker` for every server; a per-server `false` still wins). With it on, a *clear* match on an
inactive server (no runner-up within 0.85x of its relevance, no OAuth, no missing credentials) is
loaded first, which costs the server's startup time and runs its process; a failed start just means
no signatures. Only enable it for servers that are cheap and safe to start. For a tool-chain server
the reply also says to call `servers.<server>.<tool>(args)` in `run_chain` scripts, so no
`describe_tool` turn is needed for the stubs. Without the preview, a server that has never been activated simply
shows none. Each signature is capped at 360 characters (a longer one ends in `…`).

**Self-correcting `call_tool`.** When the upstream rejects the arguments (an `isError` result or a
JSON-RPC `-32602` that reads like a validation error), the error comes back with the tool's input
schema (minified JSON up to 1,200 characters, otherwise the compact signature and a pointer to
`describe_tool`). An unknown tool name lists the closest matches with their signatures. Other
failures are unchanged.

The labeled evaluation sets are part of the benchmark suite. The **tuned** set
(`scripts/fixtures/discovery-eval.json`: 40 servers, 92 queries in the categories brand,
capability, tool, alias and compound) is what the ranker and alias table were developed against.
The **held-out** set (`scripts/fixtures/discovery-heldout.json`: 38 servers, 40 queries) was written
afterwards with its own catalog of near-duplicate neighbors (github / gitlab / bitbucket, mysql /
postgres / sqlite, s3 / gcs / azure-blob, datadog / newrelic / prometheus, …) and nothing was
tuned to it; it is the number to trust, and the published report prints it as a separate row set
next to the tuned one (with only 40 queries, one query is 2.5 points: read the difference between
sets with that in mind). With 0 / 60 / 200 generated distractor servers, BM25 keeps Recall@1 on the
tuned set around 0.89–0.91 while the lexical scorer falls from 0.82 to 0.77, and wrong-top-result
rates are about 9–11% against 17–22%. Some queries are still missed (for example "show the cpu
graph for the api"); those stay in the set.

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

### Manifest (`manifest`)

A cold agent needs one extra model call to find a tool (`discover_tools`), and that call re-reads the
whole prompt, so on raw input it can cost more than it saves. `manifest: true` on a server puts its
call signatures in the MCP `instructions` the broker returns at initialize, which clients place in
the model's context from the first turn:

```
Call these tools directly with call_tool(server, tool, args); no discover_tools or describe_tool turn is needed. …
- tickets (run_chain): list_tickets(args: { status?: … }); get_ticket(args: { id: string })
Anything else: discover_tools.
```

Unlike `expose`, nothing is added to `tools/list` (no schemas, no `list_changed`, no cache churn), the
server is not started, and the text is deterministic so the prompt cache stays valid. The
trade-off is a fixed cost on every turn (about 400 tokens at most: the whole manifest is capped at
1,600 characters, 12 tools per server, and a server that does not fit is left out with a note) against
one model call per cold task. Use it for the few servers most sessions need; keep the long tail on
`discover_tools`. Limits: the signatures come from the learned index, so a server must have run once
(`lazygate` records it on first activation), and the text is read at startup, so a change shows up in
the next session. It applies to stdio mode; gateway sessions do not send it yet. A client that ignores server
`instructions` falls back to `discover_tools`.

What it is for: a **returning** session whose index already knows the server, not a first-ever run
(there is nothing to list until a server has run once). The cold-path benchmark variants
(`--cold-discovery` with `--index fresh | warm`, `--preview`, `--manifest`) compare those cases with
identical agent instructions, so the manifest is measured on its own.

**Staleness.** The text is built once at startup. If a server's tools change mid-session, the
manifest keeps the old signatures until the next session. A call with outdated arguments is not
silent: `call_tool` returns the server's error together with the current input schema (or the
closest signatures for an unknown tool), so the model can correct itself without a lookup. A client
may also not propagate `instructions` to the model; check with the `lookups` column of
`benchmark --tasks` (a manifest that works shows none).

### When to pin (`expose`)

Pinning trades schema tokens for turns. A pinned tool costs its schema (roughly 100–300 tokens) in
every turn of every session, but needs no lookup turns: `discover_tools` → `describe_tool` → call
becomes one call. Pin a tool when it is used in most sessions (a ticket lookup, the team's
database query) and the pinned set stays small (a handful of tools); keep `expose: "none"` for
long-tail servers, big schemas and anything used rarely. Pin on the server with `autoActivate: true`
so the schemas are in `tools/list` from the start, and expect a prompt-cache write whenever the
pinned set changes. In the suite, the `pinned` strategy (four of the six fixture tools) is the
fastest on workloads made only of pinned tools and no better than `call_tool` on the rest; see
[the published run](#end-to-end-suite---suite).

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
| Concurrent calls | 8 (`Promise.all` is capped at this) |
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
lazygate benchmark --tasks                              # 4 fixture tasks x (direct, call_tool, call_tool+opt, run_chain)
lazygate benchmark --tasks --rounds 3                   # same, averaged over 3 runs per strategy and task
lazygate benchmark --tasks --task orders,cross          # only some tasks (tickets, orders, logs, cross)
lazygate benchmark --tasks --json out.json              # also write every row and the cross-task summary
lazygate benchmark --tasks --cold-discovery             # lazygate starts cold: the model must discover the server and tools
lazygate benchmark --tasks --include-catalog            # also load your real catalog (see warning below)
lazygate benchmark --responses-live --cases cases.json --iterations 5 # live response optimization
lazygate benchmark --responses-live --cases cases.json --tokenizer o200k_base
```

`--tasks` runs Claude with permission checks off, so by default it only loads the fixture
servers (tickets, orders, logs). `--include-catalog` adds every runnable server from your Lazygate catalog — any destructive
tool in them then runs unprompted. Use it only with a catalog you would trust that way.

`--tasks` runs four tasks (`--task` picks some) against three fixture servers
(`scripts/fixtures/{tickets,orders,logs}-server.mjs`, data in `task-data.mjs`; tasks, instructions and
expected answers in `scripts/lib/tasks.mjs`). Every run's catalog holds all three servers, so the
model also has to pick the right one:

| Task | Servers | What it asks |
|---|---|---|
| `tickets` | tickets | count ana's open tickets, sum each ticket's `bodyLength` |
| `orders` | orders | count acme's refunded orders, sum each order's `refundCents` (each record has ~90 line items) |
| `logs` | logs | count billing's ERROR entries, sum each entry's `stackFrames` (each record has a stack trace) |
| `cross` | tickets + orders | ana's open ticket count, plus acme's total `refundCents` |

Each task runs four ways and only prints token deltas when each side of a
pair answered correctly. With `--rounds N`, each strategy runs N times; input tokens, turns and
duration are the mean of the correct runs, and each row shows `correct k/N` and the min–max input
range:

**`--cold-discovery`** is the live-model check of the suite's cold-start finding. By default the
`--tasks` instructions name the server and its tools (a "known tools" agent). With the flag, the
prompt and the lazygate instructions say nothing about which servers or tools exist: the model has
to `discover_tools` (which now returns the call signature of a clear match), optionally
`describe_tool`, then call. It reports the same turns, input tokens, duration and correctness per
strategy, so run it with and without the flag (`--rounds 3` or more) and compare turns: the
difference is what discovery costs a real model, and whether it uses the inline signatures or
still spends a `describe_tool` turn. `--estimate` together with `--tasks` is a dry run that prints
the instructions each strategy would get.

**Reading the live columns.** The runs go through `claude -p` with your settings, hooks and memory
plugins switched off (`--setting-sources ""`, `disableAllHooks`), but a Claude Code install still
puts a large system prompt in front of every API call (about 82,000 input tokens here), and that
dwarfs the schema and result differences. The benchmark therefore measures that fixed overhead once
(a no-MCP call), counts the **API calls** (`num_turns` counts tool calls, and a model that batches
eight `get_ticket` calls into one response still reports ten), and shows **net** input tokens =
raw − calls × overhead next to the raw figure. Compare strategies on net tokens and API calls.

Published runs (`benchmarks/results/tasks-*.json`; 4 tasks, strict answer check: the final line of
the reply must be exactly the expected integers, in order; fixed overhead about 81,700 input tokens
per call). Every run is in the JSON (`runDetails`: answer, tokens, API calls, cost, duration), so
wrong answers and errors can be audited. All 188 runs below answered correctly.

**Known tools** (`tasks-known.json`; 4 strategies × 3 rounds; the instructions name the server and
tools; run before the private-`HOME` isolation below, with `previewOnDiscover` on, which cannot matter
here because no lookup is needed):

| Strategy | net input | raw input | cost | API calls | vs `direct`: net / raw / cost |
|---|--:|--:|--:|--:|--:|
| `direct` | 33,381 | 278,379 | $0.184 | 3 | — |
| `call_tool` | 11,447 | 256,445 | $0.130 | 3 | −65.7% / −7.9% / −29.2% |
| `call_tool+opt` | 11,582 | 256,580 | $0.098 | 3 | −65.3% / −7.8% / −46.6% |
| `run_chain` | 8,703 | 253,701 | $0.067 | 3 | −73.9% / −8.9% / −63.5% |

**Cold discovery** (`tasks-cold-{fresh,warm-index,manifest}.json`; 5 rounds each). The model is not
told which servers or tools exist, and the wording is the same in every variant (it does not even
say to call `discover_tools`), so the variants differ only in what lazygate already knows. The
lazygate runs get a private `HOME`, so no run sees an index another run left behind:

| Variant | Strategy | API calls | lookups | raw input | cost | vs `direct`: raw / cost |
|---|---|--:|--:|--:|--:|--:|
| (baseline) | `direct` | 3 | 0 | 277,695 | $0.159 | — |
| fresh index (first ever run) | `call_tool` | 5 | 2.3 | 426,522 | $0.176 | **+53.6%** / +10.7% |
| | `run_chain` | 4.1 | 2.3 | 347,058 | $0.089 | +25.0% / −44.2% |
| warm index (server ran before) | `call_tool` | 4 | 1.3 | 341,488 | $0.117 | +23.0% / −26.4% |
| | `run_chain` | 3.9 | 1.9 | 331,184 | $0.086 | +19.3% / −45.6% |
| warm index + `manifest` | `call_tool` | 3.1 | 0 | 261,682 | $0.097 | **−5.8%** / −38.8% |
| | `run_chain` | 2.3 | 0.5 | 198,321 | $0.071 | **−28.6%** / −55.5% |

The comparison that isolates the manifest is warm index against warm index plus manifest: it removes
the lookup turns (`call_tool` 1.3 → 0, `run_chain` 1.9 → 0.5), takes `call_tool` from 4 to 3.1 API
calls and `run_chain` from 3.9 to 2.3, and cuts raw input by 23% and 40% and reported cost by 17%
and 18%. The manifest here lists the three fixture servers (six tools, well under the cap). A fresh
index is the worst case, about two extra model calls, and a manifest cannot help it because there is
nothing to list until a server has run once.

How to read and not read this:

- **Net input is modeled; raw input is what is billed before caching.** Net input subtracts a
  constant overhead per API call (for the fresh index: `call_tool` −43.6%, `run_chain` −61.9% against
  `direct`), but a cold lookup turn is an extra API call that re-reads the whole system prompt, so on
  raw input a cold lazygate run is *higher* than `direct` until the manifest removes that turn.
- **Cost follows the prompt cache.** The same strategy cost anywhere from $0.06 to $0.30 per run
  depending on whether the call wrote or read the cache. Treat cost as indicative, not as
  steady-state pricing; the call counts and raw input are the sturdier figures.
- **`run_chain` still looks things up sometimes** with the manifest (0.5 on average; `tickets` 0.6
  and `cross` 1.2): the model occasionally asks for stubs or discovery anyway.
- **Clients must pass `instructions` to the model.** Claude Code does here (the lookups drop to
  zero); the benchmark's `lookups` column is how to check another client.
- **`call_tool+opt` is within noise of `call_tool` on tokens** (about +1% net input in the
  known-tools run). The model issues its per-record calls as one parallel batch, so the large records
  reach its context once, and the benchmark does not record whether it passed `fields`. Earlier
  single-task runs (see [how it works](how-it-works.md)) measured 5–8% token savings with a model
  that went turn by turn; treat optimization's end-to-end benefit as task- and model-dependent.
- The catalog is three small servers, so the schema savings of lazy loading are not what this
  measures (see the suite for 20–500 tool catalogs). `direct` starts all three fixture servers in
  every run; lazygate starts one (two for `cross`).
- Five rounds per cell on one machine and one model; read differences of a few percent as noise.
  The `--preview` variant was not re-run with the neutral wording. Re-run with `--rounds` for
  tighter numbers, and `--include-catalog` for a realistic `direct` baseline.

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

### End-to-end suite (`--suite`)

`lazygate benchmark --suite` is the reproducible benchmark. It needs no API key and no model: a
scripted "oracle agent" drives a real MCP stdio fixture server through a real `ProcessManager` and
broker, so every number comes from actual protocol traffic. It answers the question
"what does the proxy cost, and when does it pay off?" and is the input for the regression gate in
CI. (`--tasks` is the live-LLM counterpart; it measures model behaviour, the suite measures the
system.)

```bash
npm run build
lazygate benchmark --suite                              # full: 20 / 100 / 250 / 500 tools, 15 rounds
lazygate benchmark --suite --quick                      # 20 / 100 tools, 3 rounds (what CI runs)
lazygate benchmark --suite --workloads large_json,html_docs --strategies direct,run_chain
lazygate benchmark --suite --merged-discovery           # main tables: the agent trusts inline signatures
lazygate benchmark --suite --known-tools                # main tables: an agent that already knows the tool
lazygate benchmark --suite --schema-tokens-per-tool 300 # size filler schemas like a real catalog
lazygate benchmark --suite --catalog-from ~/.config/lazygate/servers.json   # ...from your tool-index.json
lazygate benchmark --suite --direct-output-cap 0        # drop the capped-client row
lazygate benchmark --suite --json > suite.json          # JSON on stdout instead of Markdown
```

**Workloads.** `single_lookup` (one known tool), `dependent_chain` (look up, then use the result),
`parallel_calls` (independent calls to eight regions), `large_json` (aggregate 1,000 events) and
`html_docs` (extract a fact from a ~27 KB HTML page).

**Strategies.** `direct` (every tool schema in context, no proxy), `direct_capped` (the same, but a
client that truncates MCP output at `--direct-output-cap` tokens, default 25,000; `0` removes the
row), `call_tool` (meta-tools only), `call_tool_opt` (adaptive response optimization plus
`fields`), `run_chain` (one script) and `pinned` (lazygate with `expose` for four of the six
fixture tools, so those are called by name with no lookup, and the rest through the meta-tools).

**Lookup modes** (how a lazygate agent learns the call shape; a column in the cold-start section and
the choice for the main tables):

| Mode | Turns before the call | Meaning |
|---|---|---|
| `cold` (default) | 2 | `discover_tools`, then `describe_tool` (the agent ignores inline signatures) |
| `merged` (`--merged-discovery`) | 1 | `discover_tools` returns the signature of the best match; a `describe_tool` turn is added only when a needed signature is missing |
| `known` (`--known-tools`) | 0 | the agent already knows the server and signatures (a skill or AGENTS.md told it) |

**Per cell** the report records correctness against a known answer, turns, tokens (schemas,
requests, responses, context, cumulative input), and:

- **Effective input** — a *model*, not a measurement, of prompt caching: the static prefix (prompt
  and tool schemas) is written to the cache on the first turn (`--cache-write-premium`, default
  1.25×) and read at `--cache-read-discount` (default 0.1×) on every later turn, while calls and
  results are billed at full price on every re-read. Raw input (no caching) stays next to it.
- **Tool ms** — measured wall-clock of all tool traffic in a round (a fresh server process each
  time): median with min–max over the rounds (MAD is in the JSON). A 95th percentile is only
  reported from 20 samples on; below that the report shows the range instead. No model is involved.
- **Model ms and modeled ms** — an *assumed* model time (`turns × --turn-ms` plus `input ÷ 1000 ×
  --prefill-ms-per-1k`) kept separate from the measured tool time; modeled ms is their sum.
  `--turn-ms-sweep` (default 500,1500,3000) repeats it, and the sweep table shows where the fastest
  strategy flips.
- **Exp. turns / exp. ms** — lazygate strategies only: the held-out wrong-tool rate × `--retry-turns`
  (default 1) extra discovery turns for every run that used `discover_tools`. A modeled penalty;
  the oracle itself never picks the wrong server.

Filler tool schemas default to a small 3-property template (about 86–101 tokens per tool, printed
for each catalog). `--schema-tokens-per-tool N` grows or shrinks them toward N serialized tokens
and `--catalog-from FILE` derives N from a real catalog: a `tools/list` dump (measured as is), a
`tool-index.json` (name and description measured, schema assumed to be the template's) or the
`servers.json` next to one. Real catalogs are often 150–400 tokens per tool; direct MCP's cost
scales with that, lazygate's does not.

Token figures use `--tokenizer` (default `o200k_base`) and the median of the rounds, with the spread
reported because optimized responses carry random result handles. The report also has a cold-start
section (the three lookup modes side by side), the discovery section on the tuned and the held-out
set (Recall@1/3/5, wrong-top rate, latency per ranker and catalog size, and the held-out misses)
and a truncation section (optimizer latency and tokenizer work with an uncached tokenizer).

**Outputs.** `suite.json` and `suite.md` are written to `--out-dir` (default `benchmark-results/`,
git-ignored). The checked-in run is in [`benchmarks/results/`](../benchmarks/results/suite.md).

**Baseline gate.** `benchmarks/baseline.json` holds the deterministic subset (correctness, turns,
token counts, the lookup-mode comparison, discovery metrics for both sets, tokenizer work), not
wall-clock time or any modeled time.

```bash
npm run benchmark:ci                # compare a quick run with the baseline; exit 1 on regression
npm run benchmark:baseline          # rewrite the baseline after an intended change
lazygate benchmark --suite --quick --baseline benchmarks/baseline.json --tolerance 0.05
```

A regression is: a cell that stopped answering correctly, more turns, more input tokens than the
tolerance allows (default 5%), a discovery metric that got worse on either set, or more optimizer
tokenizing. Correctness failures of a strategy that loses information (`direct_capped` on
`large_json`) are reported but only baseline regressions change the exit code. Commit the
regenerated baseline together with the change that caused it, and say why in the commit message.

**What the published run shows** ([`benchmarks/results/`](../benchmarks/results/suite.md), Node 24,
Apple silicon, 15 rounds, default filler schemas of ~86–101 tokens per tool; tokens and turns are
exact, milliseconds are one machine):

- **Cold start is the main cost of lazygate, and merged discovery recovers a turn.** A cold agent
  needs `discover_tools` → `describe_tool` → call: 4 turns on a single lookup and about 6.2 s
  modeled (1.5 s per turn). With inline signatures it is 3 turns and about 4.6 s (−25%); an agent
  that already knows the tool needs 2 turns and about 3.1 s. The same one-turn steps hold for
  every workload and strategy (`dependent_chain` with `call_tool`: 5 → 4 → 3 turns; `run_chain`:
  4 → 3 → 2), and the signature was present at every catalog size up to 500 tools. The
  held-out wrong-tool rate adds only 0.03–0.05 expected turns.
- **Direct MCP wins on small catalogs, and the cache model moves the break-even.** With about 20
  tools, `direct` costs fewer raw input tokens on a single lookup (3,676 vs 5,880 for cold
  `call_tool`, +60%); counting a cached prefix the gap is +11% (2,515 vs 2,791). Break-even is (interpolated) at
  roughly 30 tools raw and 22 with caching. At 100 tools `call_tool` is −70% raw and −79%
  effective; at 500 tools −94% raw (6,276 vs 101,214) and −95% effective. Prompt caching shrinks
  the schema penalty of `direct` (it is read at 0.1×) but not its size: at 500 tools the cached
  direct run still reads about 68k effective tokens against about 3k.
- **`large_json` was overstated by an uncapped `direct`.** A client that truncates MCP output at
  25,000 tokens (`direct_capped`) cannot answer the 1,000-event aggregation at any catalog size
  (it sees about a third of the events and returns the wrong count): the uncapped 87,010 tokens
  at 20 tools are an upper bound, not something every client delivers. Strategies that keep the
  payload out of the context do answer it: `call_tool_opt` −80% against uncapped `direct`
  (17,498 vs 87,010 at 20 tools) and `run_chain` −93% (6,249). `direct_capped` matches `direct`
  on every other workload, whose results fit under the cap.
- **`run_chain` is the cheapest strategy on dependent chains, large JSON and HTML** (6.2–6.9k
  input tokens at 100–500 tools against 36–158k for `direct` on the dependent chain), and on
  eight independent calls all strategies take about 90–100 ms of tool time.
- **`call_tool_opt` is no longer costlier on tiny results.** Tiny or barely-shrinking results are
  returned as they came (no `_meta`, no handle note), and a tiny result the agent projected with
  `fields` comes back as just those fields: `single_lookup` 5,816 vs 5,880 tokens for `call_tool`
  and `parallel_calls` 6,653 vs 6,735 at 20 tools (before: +145 and +1,566 tokens). It still
  saves on dependent chains (−24% vs `call_tool`), HTML (−31%) and large JSON (−80%).
- **`pinned` removes the lookup turns for the pinned tools and nothing else.** Single lookup,
  dependent chain and parallel calls take 2, 3 and 2 turns, the same as `direct`; at 100 tools
  the dependent chain reads 10,890 tokens against 36,030 for `direct` and 15,046 for `call_tool`,
  and the schema (1,438 tokens: the meta-tools plus four tools, +237 over `call_tool`) does not grow with
  the catalog. The two workloads that use unpinned tools (`large_json`, `html_docs`) take the
  `call_tool` path (4 turns) and pay the bigger schema on top (+237 tokens per turn, about +1k over four turns). In the turn-time sweep
  `pinned` is the fastest strategy on every workload made of pinned tools at every catalog size.
  The price is its schemas in every turn and a cache write whenever the pinned set changes; see
  [When to pin](#when-to-pin-expose).
- **The fastest strategy depends on how slow the model is.** `large_json` flips from `run_chain`
  (500 ms per turn) to `direct` (1,500 and 3,000 ms) at 20–250 tools, and at 500 tools `run_chain`
  still wins at 1,500 ms and `direct` only at 3,000 ms; HTML flips at 250 and 500 tools. Where
  `direct` wins it wins on fewer turns, not tokens.
- **Discovery.** On the tuned set BM25 reaches Recall@1 0.91 and a 9% wrong-tool rate at 41 servers;
  on the held-out set (38 near-duplicate servers, 40 queries) it reaches Recall@1 0.95, Recall@3
  0.95 and a 2.5% wrong-tool rate, and 0.925–0.95 with 134 servers. The held-out set is therefore
  *not* worse than the tuned set. With only 40 queries one query is 2.5 points, so read this as
  "no evidence of overfitting", not as a better ranker, and the held-out queries may simply be
  easier (explicit brands and distinctive tool words). Its two misses are an indirect symptom
  query ("why is this endpoint throwing exceptions in production" finds no server) and a
  compound query ("find errors in the logs and open a ticket for the bug" ranks sentry first,
  not jira). The lexical scorer stays at 0.83–0.85 Recall@1 and 12–15% wrong-tool.
- **Held-out wrong-tool rate in the cost model.** Folding it in adds 0.025 expected turns per
  cold or merged run (0.05 at 500 tools): about +40 ms modeled, negligible next to the lookup
  turns.

**Honest limits.** The oracle agent is scripted: it measures cost and information loss, not whether
a model would choose `run_chain`, trust an inline signature or write a correct script (use `--tasks`
or `--tasks --cold-discovery`, which needs a logged-in `claude`, or the audit log's chain adoption
numbers for that). Catalog sizes are generated filler
tools with small schemas, so the direct-MCP cost is probably understated for real catalogs (use
`--schema-tokens-per-tool`). Effective input, modeled ms and expected turns are models with the
assumptions printed in the report's Method section. Latency is single-machine and meant for
comparing strategies, not as an absolute figure; rounds are few (15), so a p95 is not claimed.

**Truncation.** When the optimizer must cut a response to a token budget it uses a bounded
prefix search (`prefix-fit.ts`): it aims with the measured characters per token, brackets the answer
and bisects, with at most 12 tokenizer probes, and skips counting values that cannot fit
(more than 16 characters per budgeted token). Nested structures keep a partial array instead of
dropping the entry. Against the previous bisection this cut the optimizer's p50/p95 latency by
about 73% with an uncached `o200k_base` tokenizer (text, budget 500: 142/179 ms → 38/40 ms).

**Chain adoption.** The gateway audit summary and the web UI report `run_chain` calls, `call_tool`
calls, adoption rate, success rate and nested calls per chain (calls made by a script are excluded
from the `call_tool` count).

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
