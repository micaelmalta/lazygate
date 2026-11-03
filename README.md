# LAZYGATE

**Give your coding agent every tool and skill your team has, without paying for them on every turn.**

lazygate sits between your agent and your MCP servers and skills. The agent starts with a short
menu, and lazygate loads Jira, GitHub, Datadog, or your release-notes playbook only when the task
needs it.

Works with Claude Code, Cursor, and OpenCode, on your laptop or as a shared team gateway.

[Why lazygate](#why-lazygate) · [What you get](#what-you-get) · [Install](#install) · [For teams](#for-teams) · [Docs](#docs)

---

## Why lazygate

Every MCP server you connect sends its full tool list to the model on every turn, whether you use
it or not. Every skill and plugin you install adds more text to each session. Connect a handful of
servers and collect a few dozen skills, and your agent spends thousands of tokens on reading the menu
before it does any work.

That costs you three ways:

- **Money.** You pay for those tokens on every request.
- **Room to think.** Context spent on unused schemas is context the agent can't use for your code.
- **Accuracy.** A long tool list makes it harder for the model to pick the right tool.

So people end up rationing: they disconnect servers, uninstall skills, and keep a different setup
for each project. lazygate removes the trade-off. Connect everything once, and the agent only pulls
in what the current task needs.

## What you get

- **A lighter agent.** Until a server or skill is needed, the agent carries a dozen small
  meta-tools and one line per skill. On a 40-skill catalog, idle input dropped from 81,865 to
  21,244 tokens per request, about **74% fewer**.
- **A skill library that scales.** Install as many skills as you like; each one costs a line until
  it's used.
- **Cheaper, faster multi-step work.** For "find, filter, then fetch" tasks, the agent can run the
  whole chain in one step and get back only the answer. The intermediate results never enter the
  conversation (see [the task benchmark](#on-a-real-task)).
- **Move in with one command.** lazygate imports your existing servers and skills from Claude Code,
  Cursor or OpenCode, backs up every file it touches, and reverts cleanly.
- **Secrets out of config files.** Tokens move out of client JSON into your shell environment or an
  encrypted per-user vault.
- **Remote servers too,** including ones that sign in with OAuth.

### On a real task

The task benchmark gives Claude one multi-step job: count the open tickets assigned to one person
and add up a field from each ticket's details. It runs the job three ways and only compares answers
that are correct. "Classic MCP" means Claude connected directly to the same 16 servers, so every
tool schema sits in context.

| Setup | Input tokens | Agent turns | Time | vs classic MCP |
|---|---:|---:|---:|---:|
| Classic MCP (16 servers) | 537,456 | 10.3 | 6.2 s | — |
| lazygate, one call at a time | 225,877 | 10 | 5.8 s | **−58%** |
| lazygate, one chained script | 206,200 | 3 | 5.0 s | **−62%** |

Averages of 3 cold runs per setup; all 9 runs answered correctly. Most of the saving comes from not
loading every schema. Chaining cuts a further 9% and drops the job from 10 agent turns to 3. lazygate
is also steadier: its runs varied by under 50 tokens, while classic MCP ranged from 479,132 to
654,070, because every extra turn re-sends all 16 servers' schemas.

Measure it on your own setup:

```bash
lazygate benchmark --estimate    # free local preview, no model calls
lazygate benchmark --tasks       # the multi-step task above (needs a logged-in `claude`)
lazygate benchmark --responses-live --cases benchmark-cases.json --iterations 5
```

`--responses-live` calls the named MCP tools in the cases file and applies each listed optimizer
policy to the same live response. Mark every case `"readOnly": true`, provide at least one `off`
policy and one optimizer policy, and add `preservePaths` or `preserveText` checks. It reports
estimated response tokens and median, p95, and standard deviation for tool and transformation
latency. It makes no model calls; its latency and correctness numbers do not represent full agent
task success. See [the benchmark case format](docs/reference.md#live-response-benchmark).

## Install

lazygate isn't on npm yet. Build it from source (Node.js 20 or later):

```bash
git clone https://github.com/micaelmalta/lazygate.git
cd lazygate
npm install && npm run build
npm link          # puts `lazygate` on your PATH
```

Then move your existing servers and skills behind it:

```bash
lazygate migrate --from claude --dry-run   # preview what changes
lazygate migrate --from claude             # servers, skills and plugins
lazygate migrate --from cursor             # or: opencode
```

Restart your client and try *"list active servers"* or *"find a skill for writing release notes"*.

Changed your mind? `lazygate revert --from claude` puts everything back.

## How it feels

You keep asking for what you want. The agent finds the right server or skill on its own:

```
You:    Find open GitHub issues labelled "bug"
Agent:  finds the GitHub server → starts it → reads one tool's schema → runs the search

You:    Write release notes for v2.3
Agent:  finds the release-notes skill → loads its instructions → follows them
```

Nothing changes in how you work; the agent just stops carrying what it isn't using. The full
mechanics are in [How it works](docs/how-it-works.md).

## For teams

Run one lazygate for the whole team instead of every developer maintaining their own collection of
MCP servers, skills and API keys.

```bash
lazygate token create --user you --admin
lazygate serve
# MCP → http://127.0.0.1:8787/mcp
# UI  → http://127.0.0.1:8787/ui
```

- **One catalog.** Admins curate the shared list of servers and skills; developers **Install** the
  ones they want from the web UI.
- **Personal credentials.** Each user **Connects** their own accounts. Keys are stored encrypted per
  user and never shared across sessions.
- **Isolated sessions.** Every user gets their own session and personal access token.
- **An audit trail.** Every tool call is logged, with credentials redacted.

The gateway speaks plain HTTP, so put a TLS reverse proxy in front of it for anything beyond
localhost. Stdio servers are refused in gateway mode unless `LAZYGATE_GATEWAY_ALLOW_STDIO=1` (they
share the gateway's OS user; this is not isolation). Skill `prompt.context` fetches reach private
networks only with `"allowPrivate": true`. `lazygate benchmark --tasks` loads only its fixture
server unless you pass `--include-catalog`. Setup guide: [docs/gateway.md](docs/gateway.md).

## Docs

| | |
|---|---|
| [How it works](docs/how-it-works.md) | Architecture, meta-tools, skill split, tool chain, manual setup, development |
| [Gateway guide](docs/gateway.md) | HTTP gateway, web UI, tokens, vault, TLS |
| [Reference](docs/reference.md) | Every server and skill setting, routing, migration, benchmark |
| [Upgrading from context-broker](docs/reference.md#upgrading-from-context-broker) | The old name still works; installs upgrade in place |
| [CLAUDE.md](CLAUDE.md) | Source map for contributors |
