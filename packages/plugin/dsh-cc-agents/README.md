# @dsh-cc/plugin-dsh-cc-agents

Official dsh-cc plugin shipping two subagents and an orchestration skill:

- **`dsh-cc-agents:deep-reasoner`** — reasoning-heavy work: complex analysis, architectural decisions, adversarial plan review, root-cause analysis. Runs on the `opus` model alias; read-only persona.
- **`dsh-cc-agents:fast-worker`** — mechanical execution of pre-approved, fully specified plans: formatting, simple refactors, boilerplate, renames, tests, docs, checks. Runs on the `sonnet` model alias.
- **`dsh-cc-agents-orchestration` skill** — routing table for choosing between the two agents, the background asymmetry, and their report contracts.

## Prerequisites

The agents request the `opus` / `sonnet` model aliases. If those aliases are
not configured, the agents still work — unconfigured aliases resolve to
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
resolve only by the exact scoped ids (`dsh-cc-agents:deep-reasoner`).
Both appear in the agent catalog; the plugin copies carry distinct
"official plugin build" descriptions so you can tell them apart.

## Advisory safety: deep-reasoner

`deep-reasoner` retains the `Bash` tool for read-only verification (run a
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
