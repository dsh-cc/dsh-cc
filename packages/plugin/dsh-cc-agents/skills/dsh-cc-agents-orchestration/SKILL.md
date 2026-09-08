---
name: dsh-cc-agents-orchestration
description: Routing guide for the dsh-cc-agents plugin subagents. Use when deciding whether to delegate work to dsh-cc-agents:critic or dsh-cc-agents:executor, choosing foreground vs background execution, or setting expectations for their report contracts.
---

# dsh-cc-agents orchestration

Plugin agents resolve ONLY by exact scoped id — `dsh-cc-agents:critic`
and `dsh-cc-agents:executor`. A bare name does not match a plugin
definition.

## When to delegate to whom

- **`dsh-cc-agents:critic`** — reasoning-heavy work: complex analysis,
  architectural decisions, adversarial plan review, root-cause analysis,
  judging ambiguous verification results. Choose it when correctness matters
  more than speed.
- **`dsh-cc-agents:executor`** — pre-approved, fully specified mechanical
  work: formatting, simple refactors, boilerplate, renames, tests for
  understood code, docs, running checks. Never hand it an ambiguous spec.

Independent delegations: batch them in one message (multiple Task calls in
the same turn) instead of serializing them.

## Background asymmetry (important)

- **critic** is read-only, so it runs in the BACKGROUND by default —
  the delegator keeps working while it reasons. Pass
  `run_in_background: false` to force it foreground when you are blocked on
  its answer.
- **executor** MUTATES the tree, so it defaults to FOREGROUND: verify its
  report before composing on it. Pass `run_in_background: true` only when
  you want hands-free execution and will collect the result later.
- **One task, one instance**: never re-task a finished background child via
  `send_message`; a new task — even for the same agent type — is a fresh
  `subagent_fork` (plain spawn, never the `fork` sentinel, which inherits
  your context). `send_message` continues only the child's CURRENT
  assignment (steering, same-task follow-ups); a continued child resumes
  inside its full prior conversation and its original definition snapshot.

## Optional MCP tools

Both agents name optional deferred MCP tools in their frontmatter
(serena symbol tools; critic also `sequential_thinking` and context7).
On hosts where those servers are connected, spawn pre-activates them
and the agents use them directly (executor follows a serena-first
editing policy). On other hosts the names drop with a warning and the
agents run on built-in tools alone. Either way the report contracts
below hold.

## Report contracts

- **critic** ends every answer with `Recommendation` /
  `Reasoning` / `Risks-unknowns` — treat an open Risk as unverified, not done.
- **executor** ends every answer with `Changed` / `Checked` /
  `Deviations` / `Blockers` — a Blocker means STOP and re-plan; never let it
  improvise.

## Advisory safety

critic carries `Bash` for read-only verification. Its read-only
nature is a PERSONA CONTRACT, not an enforced restriction — the host does
not block a mutating command from a backgrounded reasoner. Do not hand it
tasks that tempt mutation, and review any backgrounded output before acting.
