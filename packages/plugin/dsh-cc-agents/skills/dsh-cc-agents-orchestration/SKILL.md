---
name: dsh-cc-agents-orchestration
description: Routing guide for the dsh-cc-agents plugin subagents. Use when deciding whether to delegate work to dsh-cc-agents:deep-reasoner or dsh-cc-agents:fast-worker, choosing foreground vs background execution, or setting expectations for their report contracts.
---

# dsh-cc-agents orchestration

Plugin agents resolve ONLY by exact scoped id — `dsh-cc-agents:deep-reasoner`
and `dsh-cc-agents:fast-worker`. A bare name does not match a plugin
definition.

## When to delegate to whom

- **`dsh-cc-agents:deep-reasoner`** — reasoning-heavy work: complex analysis,
  architectural decisions, adversarial plan review, root-cause analysis,
  judging ambiguous verification results. Choose it when correctness matters
  more than speed.
- **`dsh-cc-agents:fast-worker`** — pre-approved, fully specified mechanical
  work: formatting, simple refactors, boilerplate, renames, tests for
  understood code, docs, running checks. Never hand it an ambiguous spec.

Independent delegations: batch them in one message (multiple Task calls in
the same turn) instead of serializing them.

## Background asymmetry (important)

- **deep-reasoner** is read-only, so it runs in the BACKGROUND by default —
  the delegator keeps working while it reasons. Pass
  `run_in_background: false` to force it foreground when you are blocked on
  its answer.
- **fast-worker** MUTATES the tree, so it defaults to FOREGROUND: verify its
  report before composing on it. Pass `run_in_background: true` only when
  you want hands-free execution and will collect the result later.

## Report contracts

- **deep-reasoner** ends every answer with `Recommendation` /
  `Reasoning` / `Risks-unknowns` — treat an open Risk as unverified, not done.
- **fast-worker** ends every answer with `Changed` / `Checked` /
  `Deviations` / `Blockers` — a Blocker means STOP and re-plan; never let it
  improvise.

## Advisory safety

deep-reasoner carries `Bash` for read-only verification. Its read-only
nature is a PERSONA CONTRACT, not an enforced restriction — the host does
not block a mutating command from a backgrounded reasoner. Do not hand it
tasks that tempt mutation, and review any backgrounded output before acting.
