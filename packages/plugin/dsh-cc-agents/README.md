# @dsh-cc/plugin-dsh-cc-agents

English | [中文](README.zh.md)

Official dsh-cc plugin shipping three subagents and two skills:

- **`dsh-cc-agents:critic`** — reasoning-heavy work: complex analysis, architectural decisions, adversarial plan review, root-cause analysis. Runs on the `opus` model alias; read-only persona.
- **`dsh-cc-agents:executor`** — mechanical execution of pre-approved, fully specified plans: formatting, simple refactors, boilerplate, renames, tests, docs, checks. Runs on the `sonnet` model alias.
- **`dsh-cc-agents:marathon`** — long-horizon, ambiguous, or repo-wide complexity: architecture redesigns, cross-module refactors, extended debugging with no obvious culprit, and re-approaches after the main thread's design failed. Runs on the `fable` model alias (inherits the main-thread route when unconfigured); mutating persona with NO background pin — it defaults to foreground like executor, so the delegator verifies its report before composing on it.
- **`dsh-cc-agents-orchestration` skill** — routing table for choosing between the agents, the background asymmetry, and their report contracts.
- **`data-analysis` skill** — data-analysis tasks (caliber doubt, reconciliation, external reports; 数据分析/口径/对账) route through critic/executor with review/verification/execution meta-rules inlined into the dispatch prompts.

## Prerequisites

The agents request the `opus` / `sonnet` / `fable` model aliases. If those
aliases are not configured, the agents still work — unconfigured aliases resolve to
inherit-the-parent-route — but lane separation (heavy reasoning on a stronger
model, mechanical work on a faster one) is lost until you configure them.
Optional, not required.

## Install

From your Claude-compatible client with plugin support:

1. `/plugin marketplace add dsh-cc/dsh-cc`
2. `/plugin install dsh-cc-agents@dsh-cc`
3. Restart the session.

## Update

Updates are **two commands** — a marketplace re-pull alone does NOT refresh
the installed plugin cache:

1. `/plugin marketplace update dsh-cc`
2. `/plugin update dsh-cc-agents@dsh-cc`

## Name collisions

If your workspace defines file-based agents named `deep-reasoner` or
`fast-worker` (e.g. `.claude/agents/deep-reasoner.md`), the bare names
(`deep-reasoner`) resolve to your workspace definitions; the plugin copies
resolve only by the exact scoped ids (`dsh-cc-agents:critic` /
`dsh-cc-agents:executor`).
Both appear in the agent catalog; the plugin copies carry distinct
"official plugin build" descriptions so you can tell them apart.

## MCP-enhanced tool surfaces (optional)

All agents name deferred MCP tools in their frontmatter. When the host
connects those servers, the names survive spawn-time filtering and are
pre-activated before the child's first turn, so the agents call them
directly:

- **critic** — five read-only serena symbol tools
  (`mcp__serena__find_symbol`, `get_symbols_overview`,
  `find_referencing_symbols`, `search_for_pattern`,
  `get_diagnostics_for_file`), `mcp__sequential_thinking__sequentialthinking`,
  and the two context7 documentation lookups.
- **executor** — twelve serena symbol tools, including the
  reference-aware editing family (`replace_symbol_body`,
  `insert_before/after_symbol`, `rename_symbol`, `replace_content`,
  `replace_in_files`, `get_diagnostics_for_file`,
  `restart_language_server`); its serena-first editing policy activates
  with them.
- **marathon** — the executor editing family plus the critic reasoning set:
  all twelve serena symbol tools (editing included),
  `mcp__sequential_thinking__sequentialthinking` for multi-branch
  exploration, and the two context7 documentation lookups.

Hosts without these servers are unaffected: the names are dropped with a
startup warning and the agents run on built-in tools alone.

**Portability note:** the drop-with-warning degradation is a property of
the dsh-cc Task dispatch path, which sanitizes a definition's tool list
against the live registry at spawn. The plugin loader's own exported
`AgentProvider.start` overlays the raw tool restriction UNSANITIZED and
may fail in the backend when a named server is absent — if you dispatch
these definitions through provider.start directly (or embed them outside
dsh-cc), strip the `mcp__*` entries or sanitize first. The enhancement
also assumes the servers keep their conventional aliases (`serena`,
`sequential_thinking`, `context7`); a renamed server degrades to the
same drop-with-warning path.

## Serena hooks (optional)

The plugin ships two Claude-Code hooks for projects that use
[Serena](https://github.com/oraios/serena) symbolic code tools:

- **PreToolUse** on `read`/`grep` (and serena tool calls) reminds the model
  to reach for symbolic tools after a burst of raw reads/greps — a short
  deny + nudge, at most once per two minutes per session.
- **SessionEnd** cleans up the session's hook state
  (`<project>/.serena/hook_data/<session-id>/`) when the session is disposed.

Both hooks are double-gated and stay silent no-ops unless the current
session's project is serena-onboarded (`<repo>/.serena/project.yml`, found by
walking up from the session cwd through the git toplevel) **and** the
`serena-hooks` binary resolves on `PATH`:

```sh
uv tool install git+https://github.com/oraios/serena@v1.7.0
```

Hook state is pinned into the project (`SERENA_HOME=<repo>/.serena`) because
the session sandbox makes serena's `~/.serena` default unwritable. Keep
`.serena/hook_data/` out of version control.

Two operational notes:

- **One channel per behavior.** If a repository also ships its own
  `hooks.json` serena-remind entry, both fire and the shared counter
  double-counts bursts. Keep the reminder in exactly one place — this plugin
  or the repo.
- **Cost on non-serena projects**: one ~50 ms gated node spawn per Read/Grep
  and no python. Disable the plugin to opt out entirely; conversely, run
  `/plugin update` after a dsh-cc release to pick up hook changes.

## Advisory safety: critic

`critic` retains the `Bash` tool for read-only verification (run a
test, reproduce a failure, inspect history). Its read-only nature is a
**persona contract, not an enforced restriction** — the host does not block
a mutating command from a (by default backgrounded) reasoner. Avoid handing
it mutation-tempting tasks and review its output before acting on it.

## Advanced: pluginDirs

You can skip the marketplace and load the plugin from any local copy — a
checkout of this repository, or a standalone `npm install
@dsh-cc/plugin-dsh-cc-agents` — by pointing the host's `pluginDirs`
composition-level setting at the package directory. This knob is
configuration-level and unreachable from the CLI plugin commands; the
marketplace flow above is the recommended path.
