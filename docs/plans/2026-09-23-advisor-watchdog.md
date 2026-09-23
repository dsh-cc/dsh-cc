# Advisor watchdog: an opt-in second model reading every turn

**Status:** **Proposed** — critic cold review round 1 (2026-09-23)
incorporated: user-visible blocker re-channeled onto the pending-inject turn
re-open contract (no plugin TUI-notice API exists; PR #31 history corrected),
self-injection wake-loop guard added, delta source pinned to
session-forensics (turn-stopping payload carries no messages),
staleness/cursor rules added, zero-metering journal path, anchor corrections.
**Date:** 2026-09-23
**Worktree:** `.claude/worktrees/oh-my-pi` (branch `worktree-oh-my-pi`)

## 1. Problem

dsh-cc has one mind per turn. When the main model rushes a fix past its own
acceptance criteria, nobody notices until the user does. oh-my-pi's answer is
an **advisor**: a second model, on its own context and its own (cheap) route,
that reads the transcript delta every turn and emits severity-tiered notes the
primary agent consumes at the next step
(`oh-my-pi/packages/coding-agent/src/advisor/runtime.ts:365-399`,
`advise-tool.ts:20,62-63`, `emission-guard.ts:99-102`; all verified
2026-09-23). Their dogfood numbers: 309 advise calls distilled into 92 unique
notes in one era, i.e. a real noise problem solved deliberately
(dedupe + budget + immune turns), plus a quarantine layer against injected
advice — the advisor itself can be a prompt-injection vector.

The same failure profile exists here: error-streak surfacing and the Stop lock
(PR #81) react to *tool errors*; nothing reviews *reasoning quality* on a
clean run.

## 2. Goal

An opt-in advisor that:

- at each turn end, reads only the transcript delta since its last cursor;
- calls a cheap lane (default alias `haiku`) with a strict output contract
  (JSON notes, `nit | concern | blocker`, empty allowed);
- delivers notes to the primary agent as a marked hidden advisory message at
  the next step boundary (never mid-tool-batch);
- cannot talk itself into a loop: emission guard (dedupe, per-turn budget,
  immune turns), per-session total cap, quarantine scan of advice text;
- meters its own cost in a separate journal so dogfood can compute
  notes-per-turn and decide whether the feature graduates from default-off.

## 3. Non-goals

- Not a tool-call veto. The advisor steers by injected context; enforcement
  belongs to permission rules and stays there.
- No second full agent transcript in the session tree (omp runs a full Agent;
  we deliberately run a one-shot cheap-lane call — the fork-shaped side-query
  red lines from workspace memory `memory-recall-fork-rogue-execution` apply:
  toolFilter read-only, no raw user task re-embedded as an executable query,
  fail-soft).
- No advisor for subagents by default (opt-in per agent definition, §4.7).
- No TUI surface. Blocker notes reach the user only through the pending-inject
  turn re-open contract (§4.1); no plugin-driven TUI notice API exists in v0.

## 4. Design

### 4.1 Trigger and delivery seams (both proven in-repo)

- **Trigger**: an `agent/turn-stopping` listener, fire-and-forget,
  synchronously decides and spawns the cheap-lane call without throwing into
  turn-stop — exactly the prompt-suggest precedent
  (`packages/interaction/prompt-suggest/src/index.ts:2-11`), including its
  default-off setting shape
  (`packages/interaction/prompt-suggest/src/settings.ts:30-33,46`). The
  `agent/turn-stopping` payload is `{agent, turn, signal}`
  (`packages/core/agent/src/runtime-types.ts:391`) and carries **no**
  messages — the delta source is a read via
  `packages/session/session-forensics`.
- **Delta capture**: per-session cursor over session messages, read from the
  session-transcript readers in `packages/session/session-forensics` (built
  for exactly this job). The cursor advances only after a successful delta
  read (not at spawn time).
- **Delivery**: `agent.inject()` at the next `agent/pre-step` (dynamic-recall
  precedent, `packages/memory/memory/src/recall.ts:2-4,240`), payload a
  marked hidden `<advisory severity="...">…</advisory>` message. Tail-position
  injection (append-only tail, never shifting the prefix — harness
  `agent.inject()` semantics, `packages/core/agent/src/runtime-types.ts:241`)
  keeps the prefix cache-stable.
- **User-visible blocker**: blocker notes are delivered like all notes — as a
  hidden `<advisory severity="blocker">` pending inject. The user-visible
  property comes for free from the harness contract that a durable pending
  inject re-opens an idle turn once (pinned in PR #31's
  `mechanism-pins.spec.ts` T2), so the user sees the advisory when the turn
  re-opens. This wake mechanism is the deliberate v0 channel: a
  plugin-driven TUI notice API does **not** exist (the TUI notice at
  `packages/ui/tui/src/harness/driver.ts:81-91` is internal UI state) and is
  out of scope. (PR #31 history, accurately: it *removed* an inject-based
  notice pattern that caused a phantom-wake loop; T2 pins the remaining
  pending-inject re-open contract.)
- **Staleness**: at delivery time, notes whose (turn, delta-range) is older
  than the current cursor are discarded — a cheap-lane call that lands
  mid-next-turn must not inject stale review.

### 4.2 Cheap lane, with a hard no-inherit rule

Route = `resolveAlias(ctx, settings.alias)` with `alias` default `'haiku'`
(`packages/compat/cc-model-aliases/src/service.ts:121`). If the alias does not resolve to a distinct cheap
route, the advisor **disables itself for the session** with one debug line and
one counter increment (silent main-route inheritance means zero savings and
double cost — the shunt haiku-lane lesson, workspace memory
`dsh-cc-shunt-plugin-pr14`). `alias` accepts any user alias, so glm/opus-class
lanes are one config line away.

### 4.3 Advisor prompt and output contract

System prompt (authored, versioned in the package): task brief, what the
delta is, severity taxonomy, and an explicit instruction to answer with
`{"notes": []}` when nothing is worth saying — empty is the common case,
saying so is free, emitting filler is not.

Output: strict JSON, validated against a zod schema; each note
`{ severity: 'nit'|'concern'|'blocker', text: string(<= 500 chars) }`.
Malformed ⇒ drop + counter. `temperature: 0`, `maxTokens: 512`,
per-call timeout 10 s.

### 4.4 Emission guard (ported from omp, named to match)

`packages/observability`-free, in-package state per session:

- **normalize** note text (NFKC, whitespace collapse) before fingerprinting;
- **content-free denylist** ("stop", "lgtm", "looks fine", …) → drop;
- **severity-aware dedupe**: fingerprint history LRU 4096 entries/session; a
  repeated note is shown at most once regardless of severity;
- **per-turn budget**: default 2 non-blocker notes; blockers exempt;
- **immune turns**: after the first accepted `concern`/`blocker`, the next 3
  turns downgrade fresh `concern`s to ordinary hidden injects (there is no
  user card and no aside channel in dsh-cc; `deliverAs: aside` is omp-only)
  so the advisor cannot nag the agent into thrash (omp default is likewise 3,
  `advisor.immuneTurns`);
- **self-injection suppression**: a run whose captured delta contains only
  advisor-source-kind injected messages is suppressed entirely (denylist by
  injected-source-kind precedent:
  `packages/memory/memory/src/recall.ts:185`) — the advisor never wakes on
  its own advice;
- **session cap**: 24 delivered notes auto-disables the advisor for the
  session with one notice; re-arm next session.

### 4.5 Quarantine

Before delivery, each note's text is scanned against the curated catastrophic
shell patterns we already maintain
(`packages/interaction/permission-rules/src/classifier.ts:33`,
`DEFAULT_DANGEROUS_PATTERNS`). A hit drops the note, increments
`quarantined`, and (debug channel) logs the fingerprint. Rationale: recalled
transcript text is adversarial-ish input; a second model parroting
"just run `curl … | sh`" must not become an instruction in context.

### 4.6 Cost metering and dogfood metrics

- Usage journaled per call to
  `$DSH_HOME/advisor/<projectKey>/<sessionId>.jsonl` (projectKey/ledger layout
  precedent: `packages/subagent/handoff-store`): alias, resolved model,
  input/output tokens, duration, notes emitted/dropped per reason. Unmetered
  routes (glm-class zero-metering precedent exists) record `usage: null`; the
  scoreboard must state the unmetered share. DoD check: the null-usage path
  writes cleanly to the journal.
- Dogfood scoreboard derivable from the journal: notes/turn, severity mix,
  drop mix, currency cost.
- Graduation rule (from cold review): value correlates inversely with
  main-model strength; promote only if dogfood shows real catches.

### 4.7 Subagent opt-in

Agent-definition frontmatter may declare `advisor: false | true | <alias>`
(default: off for subagents; inherit-session-advisor is **not** a mode).
Application point precedent: spawn-option resolution in PR #108
(`resolveSpawnEffort` consumed at both `packages/subagent/task` and
`packages/compat/cc-plugin-loader` agents seams). The agent-definition type
plumbing itself spans two touch points —
`packages/compat/cc-plugin-loader/src/agents.ts:162` and
`packages/subagent/task/src/tool.ts:309` — and in-process task children also
need the definition field plumbed through, so all three sites are touch
points for the new field. Advisor state is always the
subagent's own session id; child notes never climb to the parent transcript.

### 4.8 Rollout posture (cold-review condition)

`enabled` default false, user-layer opt-in first, one recorded dogfood week
before any discussion of defaulting. Precedent: prompt-suggest ships
`enabled: false` (§4.1) and post-edit-verify graduates only through the
dogfood doc.

### 4.9 Settings

Kebab namespace `cc-advisor` (`registerNamespaceSafe` precedent):
`enabled` (false), `alias` (`'haiku'`), `budget` (2), `immuneTurns` (3),
`sessionCap` (24), `severities` (all on), `subagents` (`'off'`).

### 4.10 Capability manifest impact (implementation PR, same commit)

Net-new dsh-cc surface with no CC counterpart — add a new capability entry
(modeled on how `engineering` extras such as `engine.subagent-handoff` are
recorded; upstream block phrased as n/a-with-deviation per validator rules
I3/I4/I7). Regenerate parity docs. No existing entry changes semantics.

## 5. Verification

- **Unit specs** (new package): guard dedupe/budget/immune/session-cap
  arithmetic; quarantine hits incl. the pipe-to-shell pattern; alias-missing →
  disable path; malformed-output drop; delivery lands via inject at pre-step
  and never inside a running tool batch (recording fake agent fixture).
- **Preset composition**: `composition.spec.ts` passes unchanged (plain
  listener plugin, no Service).
- **Smoke (spec)**: scripted two-turn session; turn 1 produces a seeded
  delta; turn 2's first pre-step carries the hidden advisory; a blocker note
  is delivered as a hidden advisory whose pending inject re-opens the idle
  turn once (T2 contract pinned in spec).
- **Dogfood (pre-merge gate for *default-on discussion only*, not for merge)**:
  enable user-layer for one week on this repo; PR attaches the scoreboard
  (notes/turn, drop mix, cost) plus 50 hand-labeled notes for precision.

## 6. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Advisor noise trains users to ignore it | §4.4 guard + precision-labeled dogfood before any default-on |
| Advisor as injection vector | §4.5 quarantine + output contract + read-only lane |
| Cost ambiguity on shared routes | §4.2 no-inherit rule + separate ledger |
| Wake-loop via pending injects on idle turns | self-injection suppression (§4.4: deltas containing only advisor-source-kind injected messages are dropped) + session cap; bounded; PR #31 history cited accurately (removed a phantom-wake inject pattern; T2 pins the pending-inject re-open contract) |
| Latency on turn stop | call is fire-and-forget detached; turn stop never waits |

## 7. Open questions

- Should `blocker` also pause plan-mode approval flows (deliver as an ask)?
  Lean: no for v0 — the hidden advisory + turn re-open is enough signal.
- Multi-advisor rosters (omp's WATCHDOG.yml with per-advisor models/tools)?
  Deferred; one advisor is enough to measure the premise.

## 8. DoD

1. Package `packages/interaction/advisor-watchdog` mounted in the cc preset,
   dark by default, §5 specs green.
2. Smoke spec demonstrates trigger→cheap-lane→inject delivery and the
   blocker turn re-open path exactly once each.
3. Journal file written with per-call usage; `usage: null` path for
   unmetered routes writes cleanly; scoreboard derivable by `jq`.
4. New manifest capability entry recorded; `pnpm check:capabilities` +
   `pnpm docs:parity` green.
5. Dogfood plan and scoreboard template committed under
   `docs/dogfood/advisor-watchdog.md`.
