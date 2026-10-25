# lazygate — Project Review

**Date:** 2026-10-25 · **Scope:** whole repo (`src/`, `scripts/`, `docs/`) · **State:** `main` @ `dafa5cc`
**Health (at review):** `npm test` passes (14 suites, 328 tests) · `npm run typecheck` is clean

**Goal under review:**
1. A **central Gateway for MCP servers and Skills**, so users don't have to install MCPs or skills locally.
2. **Keep the agent's context window from bloating.**

---

## Implementation status (post-review)

Implemented in-tree against this review. Verified: `npm test` **19 suites / 402 tests**, `npm run typecheck` clean.

| Area | Status |
|---|---|
| **§1 Critical/High** | Done except full process sandbox (nsjail/Docker/Firecracker / separate uid + private HOME). Env strip, `inheritEnv: false` in serve, allowlist, `local: true`, vault key not written on serve, OAuth admin-clear + user-default scope, admin audit, dispose leak fix. |
| **§2 Context** | Done: `describe_tool` / `call_tool`, default `expose: "none"`, idle TTL + LRU budgets, discover/skill caps, hide connect without `access.connect`, prompt-cache docs. |
| **§3 Remote skills** | Done: `skill://` resources, `read_skill_file`, MCP prompts, group ACLs. Deferred: script→MCP wrappers, publish review / version pins. |
| **§4 Routing** | Done: ToolIndex-first auto-activate + fallback, camelCase/aliases/golden tests, optional `namespaceTools`, admin Index-all (shared-scope only). Deferred: embeddings. |
| **§5 Robustness** | Done: mtime reloads, HTTP re-init, activation signature key, cancelled on timeout, servers.json mtime cache, session active budgets. Deferred: external session store, sampling/elicitation SSE, Prometheus/rate limits. |
| **§6 Security** | Done: SSRF guards, OAuth bind cookie, deep redaction + LRU, admin-only target/path, disabled checks, TLS docs, safe skill delete, no Google Fonts. |
| **§7 DX** | Done: git/tarball install docs, `engines.node >= 20`, meta-tool counts aligned (11 / 9 stdio), ~96% claim qualified. Deferred: npm publish. |

**Still required for hardened multi-tenant production:** sandboxed stdio children, durable session store, npm publish, skill publish review, upstream sampling/elicitation.

---

## Verdict (at review time)

**Good enough as a personal tool or a trusted-team POC. Not good enough yet as a shared, multi-user gateway.**

| Goal | Status | Why |
|---|---|---|
| Lazy loading / idle context savings | ✅ Met | Only 8 meta-tools until something is activated. Activation output is summarized. |
| Context stays small *during real work* | ⚠️ Partial | Activating a server pushes **all** of its tool schemas into `tools/list`. Nothing deactivates servers automatically. A 40-tool server costs the same as loading it directly. |
| No local MCPs (remote HTTP servers) | ✅ Met | Client needs only the gateway URL and a PAT. Credentials go in the vault or headers; OAuth is done in the browser. |
| No local MCPs (stdio servers) | ⚠️ Works, but unsafe | They run on the gateway host as the gateway user, with its full environment and filesystem. |
| No local Skills | ⚠️ Partial | `load_skill` returns only the markdown body. Bundled `scripts/`, templates and references stay on the gateway host and the client can't reach them. |
| Multi-user security | ❌ Not ready | Children can read the vault key, other users' OAuth tokens and the gateway secrets. Any user can delete a shared OAuth token. |
| Scale / ops | ❌ Single host | All state is in memory and local files. A restart drops every session. No caps on child processes. |

The core idea is sound and the code quality is high: clean separation (`broker.ts` doesn't depend on the transport), strong tests, careful PAT/PKCE/CSP work. The gaps are about **isolation** and **context discipline after activation**, not about the basic design.

*(Sections below are the original review findings that drove the work above.)*

---

## 1. Must fix before sharing with a team (Critical / High)

### 1.1 Stdio children can read every other user's secrets — CRITICAL
- `src/child-env.ts:44`: when `inheritEnv` is `undefined` (the default), the child gets the whole `process.env`, including `LAZYGATE_VAULT_KEY` and every `LAZYGATE_SECRET_*`.
- Scrubbing the env isn't enough. Children run as the gateway uid with its HOME, so they can read `~/.config/lazygate/` directly:
  - `vault.key`, which sits **next to** `vault.json` (`src/gateway/vault.ts:27-42`)
  - `secrets.json`
  - every user's OAuth tokens under `tokens/users/*`
- Any catalog server with file or shell tools (filesystem, git, a compromised npm package) can therefore read all of it.
- **Change:**
  1. In `serve` mode, default `inheritEnv: false` and always strip `LAZYGATE_*`.
  2. Run children as a separate unprivileged uid or in a container (nsjail, Docker, Firecracker), with no access to the config dir, and a per-user temp HOME/cwd.
  3. Load the vault key from a KMS or the env only. Never write it beside the data.
  4. Implement `local: true` hiding and the command allowlist that `docs/design/http-gateway.md:291-305` already promises.

### 1.2 A non-admin can delete the shared OAuth token — HIGH (bug)
- `src/gateway/server.ts:233`: `clearStoredToken(name, oauthOwner(user.id, cfg))`.
- For `scope: "server"`, `oauthOwner` returns `undefined`, so this deletes the **shared** token. The admin check on line 234 comes too late to stop it.
- **Change:** only clear the owner-less token when `user.admin` is true.

### 1.3 Shared OAuth means everyone acts as the admin — HIGH
- `auth.scope` defaults to `"server"` (`server.ts:139`), so every user calls GitHub, Atlassian and others with one account. That's a privilege-escalation risk, and the upstream provider has no per-user audit trail.
- **Change:** default HTTP/OAuth servers to `scope: "user"`. Warn in the UI and at startup when a shared-token server is visible to more than one group.

### 1.4 Admin actions are unaudited and amount to code execution on the host — HIGH
- Admins can set `command`, `args`, `env` and `inheritEnv` from the UI (`ui-api.ts:548-629`).
- `AuditLog.record` is only called for MCP tool calls (`server.ts:266`). Token create/revoke, secret set, and server or skill edits leave no trace.
- **Change:**
  - Audit every admin mutation (actor, what changed, before/after hash).
  - Allow stdio `command` only from an allowlist, or make it CLI-only.
  - Keep admin tokens short-lived. They currently sit in `sessionStorage` (`ui-assets.ts:619`).

### 1.5 Child processes leak when a session closes mid-activation — HIGH (bug)
- `closeSession` (`server.ts:150-156`) only deactivates servers in `listActive()`.
- An activation that is still in flight (the handshake can wait up to 600s, `process-manager.ts:19`) finishes afterwards and calls `this.active.set` (`:391`). That leaves an orphaned child.
- **Change:** add a `disposed`/epoch flag to `ProcessManager`, re-check it after each `await` in `doActivate`, and add `dispose()` to cancel entries in `activating`.

---

## 2. Context-window discipline (the main product goal)

Idle savings are real. But in a real session the agent activates something, and from then on the savings mostly disappear.

### 2.1 Activation re-bloats the context — HIGH
- `listTools()` returns `[...META_TOOLS, ...manager.getAllActiveTools()]` with full schemas (`src/broker.ts:118-125`).
- `DETAILED_LIST_MAX_TOOLS` only shortens the *message* text.
- Your own benchmark shows the effect: "activated" is 30,352 tokens against "direct" 30,076 (`docs/reference.md:237-241`).
- **Change (pick one or both):**
  - **`describe_tool(server, tool)` + `call_tool(server, tool, args)` meta-tools.** The agent pulls one schema on demand and calls through it. `tools/list` never changes, so this also fixes 2.3 and helps clients that ignore `tools/list_changed`. **Recommended: this is the biggest single win for your goal.**
  - A per-server `tools` allowlist/denylist and `expose: "none" | "all" | [..]` in `servers.json`.

### 2.2 Nothing ever deactivates — HIGH
- `deactivate_server` only runs when the agent calls it, and agents rarely do.
- The gateway idle sweep closes whole sessions after 30 minutes (`server.ts:458-466`), not individual servers.
- **Change:** a per-server idle TTL plus a `maxActiveServers` / `maxActiveTools` budget with LRU eviction.

### 2.3 Tool-list churn breaks prompt caching — MED
- Every activate and deactivate sends `notifications/tools/list_changed` (`src/index.ts:65-70`).
- Tools sit at the front of the prompt, so each change invalidates the cache for everything after it.
- The `call_tool` route from 2.1 avoids this entirely. At minimum, document the cost.

### 2.4 Discovery and skill output aren't capped — MED
- `discover_tools` and `discover_skill` return every entry with score > 0 (`broker.ts:142-161, 220-235`).
- On zero matches they dump the **whole catalog** with descriptions (`broker.ts:146-150, 224-228`). That grows with the size of the shared catalog.
- `load_skill` returns the whole file (`skill-router.ts:86`).
- **Change:** top-K of about 5, a minimum score, names only on zero matches, and a byte cap on skill bodies with a "read more" pointer.

### 2.5 Wasted meta-tools in stdio mode — LOW
- `connect_server` and `disconnect_server` are always advertised but only work in gateway mode (`broker.ts:262-285`).
- Hide them when `access.connect` is absent. That saves about 120 tokens on every turn.

---

## 3. "No local Skills" — make skills truly remote

Today a remote client can only use **prose-only** skills.

- **Expose skill files as MCP resources** (`skill://<name>/<path>`), with a `read_skill_file` meta-tool as a fallback. List the available files in the `load_skill` output.
- **Turn executable helpers into gateway tools.** Wrap a skill's scripts as an MCP server, so they run on the gateway in the sandbox from 1.1 rather than on the client.
- **Optionally also expose skills as MCP `prompts`.** Clients then show them as native slash commands, which cost context only when invoked. Right now the gateway only advertises `tools` (`server.ts:160`).
- **Add group ACLs for skills.** Today any user can install any skill (`ui-api.ts:442`).
- **Review skills before publishing.** Skill bodies and third-party tool descriptions are a prompt-injection channel into *every* user's agent. Add publish review, pin server versions, and label tool output as untrusted.

---

## 4. Routing & auto-activation quality

### 4.1 Auto-activation can pick the wrong server and leave it running — HIGH
- `broker.ts:304-325` activates the top-scoring server. If that server doesn't have the tool, the call fails, but the server stays active, adding its schemas and a child process. It never tries the second candidate.
- **Change:**
  1. Look up the exact tool name in `ToolIndex` first.
  2. If the activated server doesn't expose the tool, deactivate it and try the next candidate.

### 4.2 The lexical scorer is weak for a large shared catalog — MED
- The tokenizer doesn't split camelCase (`scoring.ts:26`), so `createJiraIssue` becomes one token.
- Description words of 4 characters or fewer are ignored (`scoring.ts:62`), which drops `jira`, `repo`, `sql`, `logs` and `docs`.
- There are no synonyms (ticket vs issue, repo vs github) and no fuzzy matching.
- **Change:**
  - Split camelCase and snake_case, and lower the minimum word length to 3.
  - Add an alias map.
  - Optionally add embeddings in gateway mode.
  - Add a **golden-query test set** to measure recall.

### 4.3 Tool-name collisions reject activation — MED
- With a big catalog, `search`, `fetch` and similar names will clash often (`process-manager.ts:482-501`).
- **Change:** offer optional `server__tool` namespacing.

### 4.4 Pre-warm the shared `ToolIndex` — LOW
- Today it only learns when someone activates a server.
- Have an admin "index all" action activate each catalog server once, so discovery works well for new users from day one.
- Make sure the index doesn't leak tool lists fetched with one user's credentials to everyone else (`server.ts:171`).

---

## 5. Gateway robustness & scale

| # | Issue | Evidence | Change |
|---|---|---|---|
| 5.1 | All state is in memory or local files; a restart drops sessions (404 "Session not found") | `server.ts:120, 419-421` | Put the stores behind an interface (file → DB/KV). On re-init, re-activate the servers the session had active. Use sticky sessions per replica. |
| 5.2 | `UserProfileStore` and `ToolIndex` load once; the index is last-writer-wins | `profile.ts:35` (unused `mtime`), `tool-index.ts:41,76` | Reload on mtime change, or use pub/sub. |
| 5.3 | HTTP upstream re-init mutates shared `server.headers` while calls are in flight; it skips the collision check and `emitChanged` | `process-manager.ts:679-682, 786` | One in-flight re-init promise per server, a fresh headers object, and the same post-activation steps as a normal activation. |
| 5.4 | No caps on children per session, per user or globally; no rate limiting | `server.ts:117-118, 279` | Budgets, pooling for stateless servers, and metrics (Prometheus/OTel). |
| 5.5 | Server→client traffic is dropped: sampling, elicitation and `roots/list` get -32601; the HTTP upstream GET SSE stream is never opened | `process-manager.ts:414-418` | Open the GET stream and forward elicitation/sampling to the downstream session. |
| 5.6 | Activation dedup is keyed on name only, ignoring credentials | `process-manager.ts:290` | Key on name plus spawn/HTTP signature. |
| 5.7 | Stdio timeouts don't send `notifications/cancelled` | `process-manager.ts:951-955` | Send it. |
| 5.8 | `servers.json` is re-read synchronously on every discover/activate | `broker.ts:141,171,308`, `router.ts:102` | Cache it and re-read only when the mtime changes. |

---

## 6. Other security items (Medium / Low)

- **SSRF:**
  - OAuth discovery follows server-supplied metadata to arbitrary hosts (`oauth.ts:280-293`), and `httpFetch` follows redirects (`process-manager.ts:604`).
  - Fix: block private and link-local ranges after DNS resolution, require https, use `redirect: "manual"`, and require the token endpoint to match the issuer's origin.
- **OAuth callback isn't bound to the browser** (`server.ts:336`).
  - User A can send the authorization URL to user B. B's provider token is then saved under A.
  - Fix: set a short-lived HttpOnly cookie at Connect and check it in the callback, or show a "connecting as X" confirmation.
- **Redaction gaps** (`redact.ts:23`):
  - Only `content[].text` is redacted. `structuredContent`, embedded resources and `_meta` are not.
  - `${VAR}`-expanded env/headers and OAuth access tokens are never registered with the redactor.
  - Child stderr is logged raw (`process-manager.ts:348`).
- **Info leaks to non-admins:** the catalog shows `target` (command, args, URL, which can contain keys) and skill `path`s (`ui-api.ts:381, 416`). Show these to admins only.
- **Low-severity items:**
  - PAT id is 4 bytes and collisions aren't checked (`tokens.ts:68`).
  - The managed-skill prefix check has no trailing slash (`ui-api.ts:501`).
  - `deleteSkill` removes `dirname(path)` recursively (`:777`).
  - The per-session redactor set grows without bound (`server.ts:425`).
  - `connect` and `disconnect` ignore `cfg.disabled`.
  - The CSP allows Google Fonts.
  - Document that a TLS reverse proxy is required for remote use.

**What's done well:**
- PATs: 256-bit secret, stored only as a hash, compared timing-safe.
- Sessions are bound to their owner, and admin routes go through a single gate.
- Vault uses AES-GCM with AAD that binds user, server and field.
- Server-scope credentials can't be overridden through headers.
- Host and Origin are checked against DNS rebinding, and request bodies are capped.
- The UI uses a strict CSP and no cookies.
- OAuth uses PKCE with single-use `state`, 0600 file permissions and atomic writes.

---

## 7. DX, docs & distribution

- **The package isn't on npm.** `npm view lazygate` returns 404, yet every onboarding command in the README uses `npx -y lazygate …`. Publish it, or document a git/tarball install.
- **`engines.node >= 26` blocks adoption.** Most team machines and CI images are on Node 20 or 22 LTS. Lower it unless a Node 26 API is truly required.
- **Docs disagree on the meta-tool count. The real number is 8.**

  | Source | Count stated |
  |---|---|
  | `src/meta-tools.ts:2` | "six" |
  | README | six |
  | `docs/reference.md` | 6 |
  | `skills/lazygate/SKILL.md` | 7 |
  | `CLAUDE.md` | both 8 and 6 |

- **The "~96%" claim is weakly supported.**
  - It comes from one run (9 servers, 2 rounds) on an older build with 4 meta-tools. The 8 current meta-tools alone are about 550 tokens.
  - The claim covers idle state only.
  - Re-run it on the current build, add a "1–2 servers activated, multi-turn" strategy, and report a range.
- **Clients that ignore `tools/list_changed`** never see activated tools. Document this; the `call_tool` route from 2.1 fixes it.

---

## 8. Recommended roadmap

1. **Week 1 — safety:**
   - fix 1.2 (shared-token deletion) and 1.5 (child leak)
   - default to `inheritEnv: false` and strip `LAZYGATE_*` in serve mode
   - move the vault key out of the config dir
   - audit admin mutations
2. **Week 2 — context discipline:**
   - `describe_tool` + `call_tool` meta-tools
   - per-server tool allowlist
   - idle TTL and LRU of active servers
   - cap discover and skill output
   - hide gateway-only meta-tools in stdio mode
3. **Week 3 — remote skills:**
   - skill files as MCP resources
   - skills as MCP prompts
   - skill ACLs and publish review
4. **Week 4 — routing:**
   - exact ToolIndex lookup and fallback in auto-activation
   - camelCase splitting, aliases, golden-query recall tests
   - optional tool namespacing
5. **Then — production:**
   - sandboxed children (uid or container)
   - per-user OAuth by default
   - SSRF guards
   - external state store, re-activation on reconnect
   - resource budgets and metrics
   - publish to npm and lower the Node requirement
