---
name: dsh-cc-agents-orchestration
description: Routing guide for the dsh-cc-agents plugin subagents. Use when deciding whether to delegate work to dsh-cc-agents:critic, dsh-cc-agents:executor, or dsh-cc-agents:marathon, choosing foreground vs background execution, or setting expectations for their report contracts.
---

# dsh-cc-agents orchestration

Plugin agents resolve ONLY by exact scoped id — `dsh-cc-agents:critic`,
`dsh-cc-agents:executor`, and `dsh-cc-agents:marathon`. A bare name does not
match a plugin definition.

## When to delegate to whom

- **`dsh-cc-agents:critic`** — reasoning-heavy work: complex analysis,
  architectural decisions, adversarial plan review, root-cause analysis,
  judging ambiguous verification results. Choose it when correctness matters
  more than speed.
- **`dsh-cc-agents:executor`** — pre-approved, fully specified mechanical
  work: formatting, simple refactors, boilerplate, renames, tests for
  understood code, docs, running checks. Never hand it an ambiguous spec.
- **`dsh-cc-agents:marathon`** — long-horizon, ambiguous, or repo-wide
  complexity: architecture redesigns, refactors spanning many modules,
  extended debugging with no obvious culprit, and re-approaches after the
  main thread's design failed. Choose it when a task needs sustained
  discipline over many steps; critic judges a plan, marathon RUNS one to
  ground and lands the changes itself.

Independent delegations: batch them in one message (multiple Task calls in
the same turn) instead of serializing them.

Data-analysis tasks (metrics-caliber/口径 doubt, cross-caliber
reconciliation/对账, external deliverable reports) route per the
`data-analysis` skill; routine single-caliber queries stay single-agent —
no multi-agent escalation.

Document tasks that require source evidence and argument checks use the
`vwa-writing` skill. This includes research writing and review of an existing
article. Load its preflight and tool contract before delegation. A critic
opinion does not replace `argument.review`. Routine copy editing stays outside
this workflow unless the user requests evidence review.

## Formal design

For protocol/state-machine changes involving shared-state ordering, retry or
late delivery, crash recovery, or asynchronous authorization/lease ownership,
load `formal-design` before the existing design review. Main dialog owns
modeling and semantics; critic can advise read-only, while executor may run
explicit checks and implement approved plans. Use that skill's complete
evidence and coverage contract; review identities and pass criteria remain in
the effective project rules. Installation alone does not adopt project-wide
screening; use its manual agents snippet. Re-screen scope changes.

## Background asymmetry (important)

- **critic** is read-only, so it runs in the BACKGROUND by default —
  the delegator keeps working while it reasons. Pass
  `run_in_background: false` to force it foreground when you are blocked on
  its answer.
- **executor and marathon** MUTATE the tree, so they default to
  FOREGROUND: verify the report before composing on it. Pass
  `run_in_background: true` only when you want hands-free execution and
  will collect the result later.
- **One task, one instance**: never re-task a finished background child via
  `send_message`; a new task — even for the same agent type — is a fresh
  `subagent_fork` (plain spawn, never the `fork` sentinel, which inherits
  your context). `send_message` continues only the child's CURRENT
  assignment (steering, same-task follow-ups); a continued child resumes
  inside its full prior conversation and its original definition snapshot.

## Optional MCP tools

All agents name optional deferred MCP tools in their frontmatter
(serena symbol tools; critic and marathon also `sequential_thinking`
and context7).
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
- **marathon** ends every answer with `Verdict` / `What changed` /
  `Evidence trail` / `Dead ends` / `Open threads` — treat an unverified
  claim as open, and never re-walk a listed dead end.

## Advisory safety

critic carries `Bash` for read-only verification. Its read-only
nature is a PERSONA CONTRACT, not an enforced restriction — the host does
not block a mutating command from a backgrounded reasoner. Do not hand it
tasks that tempt mutation, and review any backgrounded output before acting.

## Writing subagent prompts (authoring rules)

Order: identity → tool surface → evidence/contract → evaluation criteria.
Evaluation never precedes capability: state what the agent has and lacks
before what you will grade it on. The tool surface is one positive sentence
("You have file-edit, search, and shell tools.") followed by negative
exclusions that name behaviorally ABSENT surfaces only (e.g. "no tool that
asks a person anything") — never enumerate the frontmatter tool list, and
never copy surface names from other harnesses that do not exist in dsh-cc.

Gateable blocks: sections wrapped in `<!-- actor-contract:start -->` /
`<!-- actor-contract:end -->` (whole lines) are stripped at spawn unless the
resolved child model matches the `actor-contract.models` settings patterns
(default `['glm-*']`). Agents whose contract is GLM-specific (actor framing,
evidence rules) opt in by adding their own marked block near the identity
line; content outside markers reaches every model.

## Review briefs (plan, design, architecture)

A review is only as deep as its brief. Send the same four parts to
`dsh-cc-agents:critic` and to an external bridge lane, and point at the
material instead of summarizing it:

1. **Role and prohibition** — "adversarial design review of `<subject>`; do not
   modify any files."
2. **The material, versioned** — pin each part's exact bytes: the plan or
   design (a committed path, or a snapshot materialized for the review when it
   is not yet committed), and the source baseline (a named commit, or the live
   tree explicitly declared as such). Never point at both a sha and "the
   current worktree" — a dirty tree or an uncommitted plan makes two reviewers
   read different bytes. Say "read the material itself, not a diff and not a
   summary": a reviewer fed a summary reviews the summary. The reviewer states
   what version it actually read; material it cannot read or that does not
   match the pinned version is reported BLOCKED, never reviewed from memory.
   Freeze the pinned material while reviews are in flight — no edits to it;
   if it must change, re-dispatch with a fresh brief. The reviewer restates
   the pinned version in its report, and a restatement that differs across
   seats is a BLOCKED, not a discrepancy to argue: prefer a commit or a
   snapshot whenever one exists, because a live-tree pin is only as good as
   that restatement.
3. **Self-check anchors** — the entry points that decide the verdict, named
   explicitly: where the load-bearing claims live. Anchors are a start, not a
   boundary — the reviewer follows the related calls, state transitions and
   failure paths from there; a review confined to the dispatcher's pre-named
   risks is only half a review.
4. **Output contract and stakes** — verdict first, numbered findings with
   severity and `file:line`, and what makes a missed defect expensive
   (irreversible, public API, data model, migration). Add that the implementer
   will carry the reviewed text out verbatim, so ambiguity is a defect.

Send the same brief blind to more than one seat; never feed one seat's findings
into another's brief. A brief edit is a prompt change: name the expected
behavior change when you commit it, then observe it in a later real review.
