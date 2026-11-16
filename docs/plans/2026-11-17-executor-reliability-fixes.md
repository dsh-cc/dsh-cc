# Executor reliability fixes — unattended-subagent ask guidance, contract hardening, dispatch pre-flight

Status: final (r1 three-seat blind review folded; r2 delta: critic GO,
codex GO, grok GO-WITH-CHANGES with both P1s and both critic P2s folded)
Date: 2026-11-17
Worktree: `executor-eval` (branch `worktree-executor-eval`)
Depends on: nothing hard

## 0. Problem

A two-week log audit (2026-11-03 → 2026-11-16, `~/.dsh/sessions`, 95 identified
`dsh-cc-agents:executor` runs) shows the executor's delivered work is
structurally sound (76/95 final reports carry the full
Changed/Checked/Deviations/Blockers contract; file:line density is high) but
three systemic frictions waste most of its non-productive budget:

| # | Friction | Measured evidence |
|---|---|---|
| P1 | Subagent sessions run under the delegated approval policy `never`, so every permission ASK is deterministically auto-rejected; the model receives a USER-phrased rejection ("the user rejected tool …"), treats it as retryable, and either burns retries or improvises an environment workaround | 70/95 runs hit at least one ask; 274 asks, **all rejected**; worst single run: 21 rejections of `bash`; observed workarounds: hand-made `node_modules` symlinks (one run: 95 symlinks), hand-edited `pnpm-lock.yaml`, mirror scripts, "commit step is blocked by the sandbox" reports |
| P2 | Mutating delegations land in worktrees whose environment is not ready; the executor bootstraps it itself or degrades | 55/95 runs show `node_modules`-related ENOENT; 12 runs attempt `pnpm install` (most denied → more asks); 8 reports mention manual symlinks; 2 report gates "not machine-verified" because `node_modules` was absent |
| P3 | Tool discipline drifts against the contract: scripted file edits, bash-cat fallback under the serena read reminder, guessed paths, full-suite test runs | 64/95 runs mutate repo files via python heredoc / `sed -i` / `node -e` / `cat >` (≈270 occurrences); 96 read/grep denials from serena's "consecutive raw reads" reminder are followed by bash `cat`/`sed -n` fallbacks (bash accounts for 12.4M of 20.6M total tool-output chars); 136 ENOENT events from guessed paths; 89 near-full-suite vitest invocations |

The fixes live on three surfaces, all inside the dsh-cc repo:

- **D1 (code)** — the `@dsh-cc/tools` fork's ask-materialization copy: when
  an ask from a delegated session under approval policy `never` (or with no
  approval channel at all) is rejected, replace the USER-phrased rejection
  with structured guidance addressed to an unattended agent, with a
  trigger-category-scoped retry policy.
- **D2 (prompt)** — `dsh-cc-agents` plugin `executor.md` contract hardening:
  environment/permission-blocker fail-fast, no improvised scripted file
  edits, read-burst discipline, report-contract extension.
- **D3 (prompt)** — `dsh-cc-agents-orchestration` skill: mandatory
  pre-flight checklist before any mutating delegation, generic over target
  repos, plus the report-contracts list update.
- **D4 (tooling, optional P2)** — a metrics script so the before/after
  effect of D1–D3 is re-measurable with §0's definitions.

## 1. Evidence base and method

Identification: every `session.v4.jsonl.zstd` / `session.jsonl.zstd` under
`~/.dsh/sessions/**` with mtime ≥ 2026-11-03 was decoded and its first
`system/message` scanned for the executor persona head sentence
(`You are a fast, precise executor.`). 95 sessions matched; all are
`origin: subagent`, model `deepseek-v4.1-flash`, spanning 16 worktrees of
`dsh-cc` and `dsh-cc.github.io`.

Per-session extraction: tool calls by name, bash command lists, tool-result
error signatures (regex classes: sandbox-denied, EPERM, ENOENT, test-fail,
TS errors, pnpm errors, git fatal), `approval/asked` / `approval/decided`
pairs, first user message (the dispatch prompt) and last assistant text (the
report).

Key aggregates behind P1–P3 (so reviewers can check the arithmetic):

- 95 runs, 25.0 wall-clock hours total, median 11 min, p90 32 min, max 82 min.
- 6,239 bash calls (median 60/run), 1,593 edit + 333 write, 474 serena calls
  (57/95 runs made ZERO serena calls while making a median 18 builtin edits).
- Tool errors: bash 273, read 99, edit 39. Of the bash errors, 188 carry
  `gauge allow below threshold`, 43 `target/scope under-specified`, 19
  `deny downgraded`, 14 `systemone validation`.
- The 99 read errors are almost entirely the serena reminder
  (`Too many consecutive read calls … the counter was reset`) — an
  availability nudge from serena itself, external to this repo.

Two environment facts the design depends on (r1-verified against live
sessions and source):

- **Delegated children are pinned `approval/policy = never`.** Every audited
  executor session's log carries
  `approval/policy {policy: "never", source: "delegation"}` (e.g. the
  issue-337 run), stamped by the harness at delegation
  (`captureDelegatedPolicyOverrides` / `appendDelegatedPolicyOverrides` in
  `deepseek-harness/packages/subagent/subagent/src/child-agent.ts`). The
  harness's approval service resolves policy `never` at the TOP of
  `request()` — before any answerer listener runs — and returns
  `'rejected'` deterministically
  (`deepseek-harness/packages/interaction/user-approval/src/index.ts:296-301`,
  comment: "only the service's own request path can").
- **An ask is therefore not unanswerable merely because the session is a
  subagent.** A child's policy can later be switched to `ask`
  (harness `setApprovalPolicy` accepts `'ask'`; "later child switches still
  win"), and the TUI approval modal queues requests from tracked subagent
  sessions and can answer them, including "always"-derived child allow rules
  (`packages/ui/tui/src/harness/driver-approvals.ts:70-86`, pinned by
  `packages/ui/tui/tests/driver-approval.spec.ts:214-230`). D1 must
  distinguish "policy `never` rejected this" from "a human rejected this".

Honest boundary: session logs show behavior inside the run, not the eventual
PR fate; worktrees are mostly deleted, so report claims were not re-verified
against trees. The 95-sample set is dsh-cc-repo-shaped; the fix design does
not assume anything about other repos beyond the shared plugin.

## 2. Root causes

**RC1 (P1).** The `@dsh-cc/tools` fork materializes a rejected ask as
`the user rejected tool "bash" (the ask was raised because: …). This is a
permission decision … ask the user` (`packages/core/tools/src/pipeline.ts`,
`serviceAsk`'s `'rejected'` branch). For a delegated session under policy
`never` there is no user to ask and no retry that changes the outcome, but
the message addresses a user and invites retry/escalation reasoning. The
model obeys the message: it retries (21 rejections in one run) or works
around (symlinks, lockfile edits). The information needed to say this
precisely — the session's approval policy and ancestry — is available at
the materialization site.

**RC2 (P2).** Worktrees hold only tracked files; `pnpm install
--frozen-lockfile` must run before any pnpm/vitest gate. The dispatch side
(orchestration skill) has no pre-flight checklist, so whether the
environment is ready depends on the delegating session's memory of the
worktree lessons — which the logs show is not reliable.

**RC3 (P3).** The executor contract says "serena-first" and "follow the
spec", but it does not (a) forbid improvised scripted file mutation, (b) say
what to do when a read burst hits the serena reminder, (c) require the
report to state the FINAL verification command + exit code and the gates
NOT run, (d) say how to resolve package paths in this repo's
`packages/<domain>/<pkg>` layout, or (e) cap full-suite test runs. Under
pressure the model fills these gaps with whatever is locally cheapest
(python heredocs, bash cat, guessed paths, full vitest).

## 3. Design

### D1 — `@dsh-cc/tools` fork: structured ask-rejection guidance for unattended delegated sessions

**Semantic.** ASK decisions themselves are NOT touched. The
`tools/pre-execute` waterfall, task grants, session-allow rules, PreToolUse
hook `allow` (which suppresses an ask downstream), the TUI modal, and the
approval service flow all behave exactly as today. The change is confined
to the DENY COPY that `serviceAsk` materializes when an ask from a delegated
(ancestor-subagent) session is rejected by the deterministic policy `never`
path, or when no approval channel exists at all:

- Today, both cases produce a user-addressed rejection
  (`the user rejected tool …` / channel-guidance) that invites retry loops.
- After D1, both produce guidance addressed to an unattended agent: a
  stable structural prefix, the sanitized original trigger, and exactly one
  category-scoped instruction (retry policy below).
- A rejection that came from an actual answerer (policy `ask`, human clicked
  no — including the TUI modal on a tracked child) keeps the exact current
  CC-parity message. This is the r1 P0 fold: answerability is decided by
  the folded approval policy, never by ancestry alone.

**New module `packages/core/tools/src/ask-guidance.ts`** (all logic lives
here; `pipeline.ts` is baselined at 806 lines by
`scripts/check-file-size.baseline.json` and must NOT grow — see
implementation notes):

```ts
/**
 * Ask-rejection guidance for unattended delegated sessions.
 * Extracted from pipeline.ts (file-size ratchet: pipeline.ts must not grow).
 * @module @dsh-cc/tools/ask-guidance
 */

/** Stable prefix identifying the structured subagent ask rejection. */
export const SUBAGENT_ASK_PREFIX = 'no approval channel can answer this request in this delegated session'

/**
 * Last-wins fold of the session's approval/policy events.
 * True iff the CURRENT effective policy is 'never' (the deterministic
 * rejection path; harness user-approval resolves it before any answerer).
 * Tolerant wire read: an unparseable event is skipped, never throws.
 */
export function approvalPolicyIsNever(events: readonly unknown[]): boolean

/**
 * Delegated-ancestry predicate, fail closed: a malformed agent SHAPE (one
 * that has a session but cannot be read) counts as a child (tool-use-summary
 * isTopLevel precedent,
 * packages/compaction/tool-use-summary/src/index.ts:64-74). An UNDEFINED
 * agent is NOT delegated (the precedent treats an agent-less call as
 * top-level) — it keeps today's channel-guidance copy. Combines BOTH
 * depth signals — header.delegationDepth and agent.options.subagentDepth —
 * plus header.origin === 'subagent'.
 */
export function isDelegatedSession(agent: unknown): boolean

/**
 * Trigger category for one ask reason (closed prefix table over the
 * reason constants the permission-rules lanes emit):
 * - 'underspecified' — 'target/scope under-specified' (the only lane where
 *   a narrower command is a real move)
 * - 'transient' — classifier/gauge infrastructure failures:
 *   'state truncated by gateway', 'gauge output unusable',
 *   'gauge allow probability missing or invalid', 'unrecognized gauge choice'
 * - 'structural' — everything else, INCLUDING unknown/unmatched reasons
 *   (fail closed against retry loops) and rule-derived asks.
 */
export function classifyAskReason(reason: string | undefined): 'underspecified' | 'transient' | 'structural'

/**
 * Build the structured deny reason for one rejected ask of a delegated
 * session. Reuses the moved sanitizeAskReason (control-strip + 120-cap)
 * on the trigger. Global text only — no executor-specific workaround
 * lists here (those live in the executor contract, D2).
 */
export function subagentAskGuidance(toolName: string, reason: string | undefined): string
```

`sanitizeAskReason` and `askRaisedClause` (currently private in
`pipeline.ts:84-93`) MOVE into this module and are re-imported by
`pipeline.ts`; the two guidance constants `ASK_CHANNEL_GUIDANCE` /
`ASK_DENIAL_GUIDANCE` (`pipeline.ts:69-77`) move with them. The move plus
the new call sites must leave `pipeline.ts` at ≤ 806 lines (the ratchet
baseline; `node scripts/check-file-size.mjs` green is a PR gate).

**Fork-drift gate (r2 fold — PR-A fails CI without this).** The tools
package's vendoring gate `packages/core/tools/tests/upstream-drift.spec.ts`
pins the fork's `src/*.ts` set against `PAIRS + FORK_ONLY_FILES` and pins
`pipeline.ts`'s fork-only lines in `DRIFT_ALLOWANCE['src/pipeline.ts']` —
including the exact `sanitizeAskReason` / `askRaisedClause` /
`ASK_*_GUIDANCE` lines this design moves. PR-A must, in the same commit:
add `'ask-guidance.ts'` to `FORK_ONLY_FILES` (with a why-comment: delegated
ask-rejection guidance, fork-owned); move the five moved-helper forkOnly
lines from the `pipeline.ts` entry to a new
`DRIFT_ALLOWANCE['src/ask-guidance.ts']` entry (plus the new module's
load-bearing lines); add the new import line and the three branch-condition
lines to the `pipeline.ts` entry; and extend the README FORK DRIFT section
with the new delta item. The json-schema-value.ts `EXTRACTED_FILES` pattern
is the in-repo precedent for a moved-and-re-imported helper.

**Session-event read precedent.** `approvalPolicyIsNever` reads
`exec.agent.session.snapshotEvents()`. The harness deprecates NEW
production callers of synchronous event readers (harness agent note
2026-09-09), but dsh-cc production precedent is established — the
permission-rules package folds session events this way in ten-plus files
(`foldPermissionMode` / `foldPlanMode`, e.g. `decide.ts:90`), and dsh-cc
runs no `typescript/no-deprecated` lint over these calls. The fold helper
follows that exact pattern; no new waiver surface is introduced.

**Message text (verbatim, the whole model-facing reason for the deny):**

- Prefix + trigger, e.g.
  `no approval channel can answer this request in this delegated session (the ask was raised because: gauge allow below threshold (P(allow)=0.430, t=0.5)).`
- Then exactly one category sentence:
  - underspecified: `The trigger is an under-specified target or scope: you may retry ONCE with a materially narrower, explicitly scoped command; if this message appears again, stop.`
  - transient: `The trigger is a transient classifier failure: you may retry the identical command ONCE; if this message appears again, stop.`
  - structural: `Do not retry the call and do not work around the permission system; report this message and the exact command as a Blocker in your final report.`

**Naming: two layers, do not conflate them.** `SUBAGENT_ASK_PREFIX` is the
exported constant holding the bare sentence; the `serviceAsk` deny **reason**
starts with it. The pipeline's `prepare()` then materializes the tool result
as `Error: ${denialReason}` (`pipeline.ts:245-254`), so the persisted
`tool/result` **content** starts with `Error: ` + that sentence. Unit cases
below assert on the deny reason (constant, no `Error:`); the live probe and
the §5 routing invariant assert on tool-result content (with `Error: `).
Implementers must not "fix" one to match the other.

**Call sites — `serviceAsk` (`packages/core/tools/src/pipeline.ts:464-508`)
exactly three branches change:**

1. `approval === undefined` (no approval service composed): if
   `isDelegatedSession(exec.agent)` → return the structured deny
   (`subagentAskGuidance(exec.name, ask.reason)`); else today's
   channel-guidance text unchanged.
2. `outcome === 'rejected'`: if `isDelegatedSession(exec.agent)` AND
   `approvalPolicyIsNever(exec.agent.session.snapshotEvents())` →
   structured deny. Otherwise (policy `ask`, a human/answerer said no, or a
   main session) → today's `ASK_DENIAL_GUIDANCE` message byte-identical.
3. `outcome === 'unavailable'`: same condition as (2) → structured deny;
   else unchanged.

The `exec.agent === undefined` and `'cancelled'` / `'allowed-once'`
branches are untouched. The approval `request()` call itself is NOT
skipped: the harness resolves policy `never` at the top of `request()`
before any listener, so the call is a no-op waterfall-wise, and the
`approval/asked` / `approval/decided` telemetry pair keeps flowing — which
the re-measurement (§5) depends on.

**Why this insertion point and not `permission-rules` pre-execute (r1
fold).** Converting the ASK to a DENY at the waterfall exit would (a) break
the TUI modal's answerable asks for tracked children whenever ancestry is
used as the trigger, (b) break PreToolUse hook `allow` (downstream deny
always wins over a hook allow; only an ask can be suppressed), (c) bypass
the approval seam's telemetry. Specializing only the rejection COPY keeps
every decision path bit-identical and changes only what the model reads
when the outcome was already deterministic.

**Capability manifest.** The model-facing copy for subagent policy-`never`
rejections changes; CC behavior (prompt the user) is unchanged for every
attended surface. Per the r1 review, this is recorded as a deviation
paragraph appended to the EXISTING `permissions.rules` entry in
`docs/claude-code-capabilities.yaml` (not a new id): state that asks from
delegated sessions under approval policy `never` receive structured
agent-addressed rejection copy instead of the user-rejection sentence.
Regenerate the parity trio (`pnpm docs:parity`) in the same commit.

**Tests.**

Unit (`packages/core/tools/tests/ask-guidance.spec.ts`, new): export-level
tests with synthetic inputs, no plugin mount —

1. `approvalPolicyIsNever`: last-wins (a `never` then `ask` event folds to
   false; `ask` then `never` folds to true), no events → false, malformed
   events skipped.
2. `isDelegatedSession`: header origin `subagent` → true;
   `delegationDepth: 1` → true; `agent.options.subagentDepth: 2` with clean
   header → true (the r1 fail-closed fold); main session (all absent) →
   false; `undefined` agent → false (agent-less calls are top-level per the
   precedent); malformed agent shape WITH a session → true (fail closed);
   negative runtime depth → true.
3. `classifyAskReason`: one case per closed prefix (underspec literal →
   underspecified; each transient literal → transient; gauge-below-threshold
   and deny-downgraded → structural; unknown string → structural;
   undefined → structural).
4. `subagentAskGuidance`: embeds `SUBAGENT_ASK_PREFIX`, embeds the sanitized
   trigger (control characters stripped, >120 chars truncated with
   ellipsis), and picks the category sentence. Include a multiline + CJK +
   control-character trigger case and an oversized trigger case.

Behavior (`serviceAsk` branches, in the existing tools pipeline spec rig —
stub `exec.agent` with `snapshotEvents()` returning synthetic event arrays
and a stub approval service):

5. delegated session + folded policy `never` + approval request resolving
   `'rejected'` → deny reason starts with `SUBAGENT_ASK_PREFIX`, embeds the
   trigger, correct category sentence; the `approval/asked` request still
   flowed (stub records the call).
6. delegated session + folded policy `ask` + `'rejected'` → today's
   `ASK_DENIAL_GUIDANCE` message byte-identical (the human-said-no path).
7. main session + policy `never` + `'rejected'` → today's message
   byte-identical (ancestry gate holds even if a main session somehow logs
   policy `never`).
8. approval service `undefined` + delegated session → structured deny;
   main session → channel guidance unchanged.
9. `'unavailable'` + delegated session → structured deny; main session
   unchanged.
10. `'allowed-once'` / `'cancelled'` branches unchanged (regression).
11. Grant-catch style oversized reason (`String(error)` of a multiline
    error) → sanitized and capped inside the structured deny.
12. Policy-switch regression: events `[never, ask]` then the stub approval
    returns `'rejected'` → user-message path (case 6 shape), proving a
    mid-session switch to `ask` restores attended semantics on the very
    next call.

Composition (regression, already-covered surfaces stay green — no new
assertions required beyond running them): the TUI
`driver-approval.spec.ts` tracked-child case and the hooks-claude-code
PreToolUse-allow case must stay green unchanged in PR-A's presubmit (they
live in other packages; they are the tripwires for the r1 P0).

**Known trade-off (carried from v1, sharpened).** For `structural` triggers
the new copy stops retries that today sometimes eventually "succeed" by
rephrasing past the gauge. The re-measurement (§5) tracks the blocker rate
explicitly; if blockers spike without a matching drop in wasted retries,
the category table (not the insertion point) is revisited.

### D2 — `executor.md` contract hardening (prompt change)

`packages/plugin/dsh-cc-agents/agents/executor.md` (137 lines; no repo
file-size gate applies to `.md` — the check walks `.ts` only — the 500-line
note in v1 was wrong). All insertions go OUTSIDE the `actor-contract:start/end`
marker blocks (read-only region). Insert two new sections after the current
"What to avoid" section, extend the serena-first section with one bullet,
extend the Output contract with two bullets, and add one line under "How to
work". Verbatim text:

**New section A (after "What to avoid"):**

```markdown
## Environment and permission blockers — fail fast, never bootstrap
Some tool errors are STRUCTURAL: retrying the same operation or a trivial
variant wastes the run. Recognize three signatures:
1. An error starting with "no approval channel can answer this request in
   this delegated session" — a permission ask that provably cannot be
   answered. Follow its category sentence exactly: the one permitted retry
   (underspecified/transient triggers) or stop (structural trigger).
2. An error saying the user rejected the call or no approval channel is
   available — same treatment: stop attempting that operation class.
3. A sandbox denial whose message says escalation is unavailable or was
   refused — same treatment. (A denial OFFERING an escalation retry is NOT
   structural: take the offered retry.)
When one lands: finish everything the edit, search, and read tools can do
without the blocked operation; NEVER repair the environment yourself (no
manual `node_modules` symlinks, no hand-edited `pnpm-lock.yaml`, no mirror
or stub that imitates an install); and report it under Blockers with the
exact command, the error's reason text, and the one command a maintainer
would run to unblock it (for a missing install, the target repo's declared
bootstrap — in a pnpm workspace, `pnpm install --frozen-lockfile`).
A run that stops early with a precise blocker is a success; a run that
silently hand-builds the environment is a failure.
```

**New section B (after section A):**

```markdown
## File edits: editing tools, never improvised scripts
Modify repository files ONLY with Edit/Write or the serena symbolic edit
tools. NEVER mutate repo files through ad hoc bash heredocs (`python3 - <<`,
`sed -i`, `node -e`, `cat >`, `tee`) — they bypass exact-match safety and
are invisible to review tooling. Two exceptions, and only these:
- scratch files under `.scratch/` or the system tempdir (never committed);
- commands the dispatch or the repo's own tooling explicitly names as
  generators (e.g. `pnpm docs:parity`, formatters, snapshot-update
  commands) — run them as named, review their diff like any edit.
If a task seems to need bulk scripted mutation of repo files outside these
exceptions, that is a spec smell: report it as a Deviation instead of
scripting around it.
```

**Serena-first section, one additional bullet (after the "Trust successful
serena edits" bullet):**

```markdown
- **Read bursts**: when a `read`/`grep` call is denied with serena's
  "too many consecutive" reminder, switch to the serena symbol tools
  (`get_symbols_overview`, `find_symbol`) for the next navigation. If the
  serena tools are unavailable in this run, use builtin Read/Grep — never
  a bash `cat`/`sed -n` dump, which moves the cost from a cheap symbolic
  query to a full file in the tool result.
```

**"How to work", one additional numbered line (after item 4):**

```markdown
5. **Track long runs**: if you expect the task to exceed ~50 steps, write
   the slice list to TodoWrite first and keep it current as you go.
```

**Output contract, two additional bullets (after the Blockers bullet):**

```markdown
- **Final verification**: the last verification command you ran for this
  task and its literal exit code, as `<command> — exit <N>`. If the last
  state you observed was not green, say so in plain words — a final
  successful command never conceals an earlier unresolved failure; if no
  verification ran, say why. An empty or copy-only bullet is a contract
  violation.
- **Gates not run**: every check the dispatch named that you could not
  execute in this run, each with its one-line structural reason
  (environment, permission, out of scope). `none` is a valid entry; a
  missing or content-free bullet is not.
```

**Config-is-prompt discipline.** The commit message for this file states
the expected observable behavior change (fewer improvised scripted edits,
blocker-faithful reports with non-empty Final verification / Gates not run,
serena-or-Read on read bursts) and the follow-up verification is a real
delegated session observed against those behaviors (§5 step 4). No
observation, no claim.

### D3 — orchestration skill: pre-flight before a mutating delegation

`packages/plugin/dsh-cc-agents/skills/dsh-cc-agents-orchestration/SKILL.md`
(151 lines). Insert one section after "Background asymmetry", and update
the "Report contracts" list in the SAME edit (otherwise orchestrators keep
grading the old four headings). Verbatim:

```markdown
## Pre-flight before a mutating delegation
Before dispatching executor/marathon into a worktree or any checkout that
is not the one you are sitting in:
1. **Environment ready for the child-owned commands**: determine the
   target repo's declared bootstrap and make the commands the CHILD will
   run actually work before dispatch (for the dsh-cc pnpm workspace:
   `pnpm install --frozen-lockfile` in the target worktree, then confirm
   `node_modules/.bin/vitest` exists). Never let the child bootstrap the
   environment — a delegation that starts with "no node_modules" will
   either stall on permission asks or improvise symlinks. Docs-only
   dispatches with no child-owned commands need no install.
2. **Command ownership split**: put in the dispatch prompt (a) the
   child-owned verification commands — for an executor behavior change,
   the focused red/green test commands stay child-owned per its TDD
   contract — and (b) "Gates I will run: …" for the broader suites and
   repo gates you keep. The child lists under Gates-not-run exactly the
   (b)-class checks it could not run; it never skips (a)-class commands
   silently.
3. **Dispatch prompt minimums**: absolute worktree path; forbidden
   operations (git write commands unless delegated, improvised scripted
   file edits, environment bootstrap); the report contract pointer
   (Changed / Checked / Deviations / Blockers + Final verification + Gates
   not run — executor shape; marathon reports per its own native
   contract).
```

And in the existing "Report contracts" section, extend the executor row to
name the two new fields (Final verification, Gates not run) with the same
wording as D2's bullets.

### D4 — session-log metrics script (optional P2 slice)

`scripts/agent-session-metrics.mjs` (new, no dependencies, not wired into
CI): walks `$DSH_HOME/sessions/**/session*.jsonl.zstd` (mtime ≥ argv
cutoff; the glob covers both `session.jsonl.zstd` and
`session.v4.jsonl.zstd`), shells out to the `zstd` CLI for decompression,
identifies executor/critic/marathon runs by persona head sentence, and
emits the §0 table plus the §5 reliability-outcome rates as JSON.
Degradation is explicit: a missing `zstd` binary or an unreadable session
file is reported as `skipped` with a count — an incomplete scan must never
render as a successful zero-count result.

## 4. PR split

Serial review, independent landing:

- **PR-A (D1)** — `feat(tools): structured ask-rejection guidance for delegated sessions under approval policy never`. Files: new `ask-guidance.ts`, `pipeline.ts` (branch changes + moved helpers, net ≤ 806 lines), new spec, `tests/upstream-drift.spec.ts` (FORK_ONLY_FILES + DRIFT_ALLOWANCE updates per the fork-drift gate note), package README FORK DRIFT delta item, `docs/claude-code-capabilities.yaml` deviation paragraph + regenerated parity trio. Tests: cases 1–12 + full tools package suite (drift gate included) + TUI/hooks tripwire suites green.
- **PR-B (D2+D3)** — `feat(agents): executor contract hardening and delegation pre-flight checklist`. Files: `executor.md`, `dsh-cc-agents-orchestration/SKILL.md` (pre-flight section + report-contracts row). Prompt-only; the commit message carries the config-is-prompt behavior statement.
- **PR-C (D4, optional)** — `feat(scripts): agent session metrics script for executor re-measurement`.

PR-A and PR-B are independent (different packages). PR-C depends on
nothing and may be dropped without affecting the verification plan (§5
step 5 falls back to the §1 ad-hoc method).

## 5. Verification plan

1. **PR-A unit/behavior**: cases 1–12 of §D1, plus the existing tools
   package suite green, plus the two composition tripwires
   (`driver-approval.spec.ts` tracked-child case, hooks-claude-code
   PreToolUse-allow case) green unchanged.
2. **PR-A live probe (one-off, before merge)**: with the patched tools fork
   built into a scratch profile, spawn an executor with a deliberately
   underspecified bash dispatch. Observe: exactly one ask → policy-`never`
   rejection materialized as a tool-result error whose content starts with
   `Error: no approval channel can answer this request in this delegated
   session` (the pipeline's `prepare()` prefixes `Error: ` to the deny
   reason — match the content, not the bare prefix) embedding the
   underspec reason and the underspecified category sentence; the child's
   final report carries it under Blockers; `git status` in the worktree
   shows zero symlink or lockfile workarounds. Probe artifacts deleted
   after the observation (probe-first discipline).
3. **PR-A regression gates**: `node scripts/check-file-size.mjs` (pipeline
   ≤ 806), `pnpm check:capabilities`, `pnpm docs:parity`, package suite in
   presubmit.
4. **PR-B dogfood**: after profile sync, one real delegated implementation
   slice in a prepared worktree, scored on four observables, each requiring
   non-empty content (a present-but-empty field scores as miss):
   (a) zero repo-file mutations via improvised bash heredoc/sed -i/node -e
   (session-log bash scan; `.scratch/`, tempdir, and named generators
   excluded); (b) report ends with `<command> — exit <N>` and a concrete
   Gates-not-run entry or `none`; (c) on an injected
   missing-`node_modules` dispatch, the child reports the blocker and the
   bootstrap command instead of building symlinks; (d) any read-burst
   reminder is followed by serena or builtin Read — not a bash dump. One
   observed session is the minimum; no observation, no claim.
5. **Re-measurement (two weeks after PR-A and PR-B land)**, on ≥50
   executor runs, rates normalized per run (never absolute counts against
   the 95-run baseline):
   - **Routing invariant** (correctness of D1, not friction): asks in
     executor runs that resolve rejected still emit `approval/asked` /
     `approval/decided` pairs; the tool-result errors for the
     policy-`never` subset carry content starting with
     `Error: no approval channel can answer this request in this delegated
     session`. Residual non-matching rejections should be exactly the
     sandbox-escalation and policy-`ask` (human-said-no) populations,
     counted separately and expected unchanged.
   - **Reliability outcomes**: improvised scripted repo-file mutation rate
     64/95 → ≤ 20%; runs reporting environment self-bootstrap (symlink /
     lockfile hand-edits in report text or bash scan) → 0; report contract
     completeness (four sections + non-empty Final verification + concrete
     Gates-not-run) ≥ 90% of runs; Blockers-reported rate tracked
     explicitly (expected to RISE — that is the fix working — but a rise
     without a matching fall in wasted retries routes back to the D1
     category table per the known trade-off).
   Not-hit thresholds do not auto-revert; they route back to this design
   doc's owner with the numbers.

## 6. Explicitly not shipped

- **Any change to ASK decisions or the permission waterfall** — the r1
  reviews established that converting asks to denies at pre-execute breaks
  answerable TUI-modal asks for tracked children and PreToolUse hook
  `allow`. D1 touches only rejection copy at materialization.
- **Auto-allow lane for subagent bash**: a security-posture change dressed
  as a convenience fix; rejected.
- **Any harness-side change** (approval service, subagent spawn, policy
  plumbing): the harness repo is read-only by directive; nothing D1 needs
  lives there (the policy-`never` resolution and the `approval/policy`
  events already exist).
- **serena-side changes** (the read-burst reminder itself): external
  project; D2's read-burst bullet is the repo-side adaptation.
- **Gauge tuning** (raising the allow threshold, whitelisting command
  shapes): orthogonal; changes risk posture for attended sessions too.
- **New settings namespaces** for any of the above.

## 7. Open questions — resolved in r1

1. **Deny vs keep-ask**: resolved by moving the fix to the
   materialization copy. ASKs survive everywhere; only the
   deterministic-rejection copy specializes, gated on folded policy
   `never` + ancestry, so answerable asks (TUI modal, policy `ask`,
   hook allow) keep today's behavior byte-identical.
2. **One-narrowed-retry**: resolved by the category table — underspecified
   → one materially narrower retry; transient → one identical retry;
   structural (including all unknown reasons, fail-closed) → no retry,
   report blocker. D2 section A names the prefix and defers to the
   category sentence, so the two surfaces state one policy.
3. **Report contract growth**: resolved by non-empty content requirements
   in both the D2 bullets and the §5 dogfood scoring.
4. **D4 script value**: demoted to an optional slice with explicit
   skip-reporting; §5 step 5 falls back to the ad-hoc method if dropped.

## 8. Review ledger

### r1 (2026-11-17, three blind seats: critic, codex, grok)

- **critic: NO-GO** — F1 P0 (origin-only conversion breaks TUI-modal
  answerable asks; verified `driver-approvals.ts:70-86`), F2 P1 (D1/D2
  retry contradiction), F3 P1 (transient infra asks get structural text),
  F4 P1 (header-only depth detection is fail-open vs the repo's own
  `agent.options.subagentDepth` max-idiom), plus P2s (self-fulfilling
  metric; `.md` not size-gated; missing test lanes).
- **codex: NO-GO** — F1 P0 (policy-switch answerability; verified harness
  `setApprovalPolicy` + child-agent pinning), F2 P1 (sanitization bypass —
  verified `sanitizeAskReason` pipeline.ts:84), F3 P1 (retry
  incompatibility), F4 P1 (generator conflict with the edit prohibition),
  F5/F6 P1 (D3 over-specific to dsh-cc; gate ownership vs TDD), F7 P1
  (test matrix omits the auto-stage ask path), F8 P1 (approval/asked
  metric self-fulfilling).
- **grok: GO-WITH-CHANGES** — F1 P0 (same answerability root; proposed the
  serviceAsk copy-specialization insertion point adopted by this v2),
  F2 P1 (retry copy), F3 P1 (metric), F4 P1 (PreToolUse allow — verified
  hooks `{prepend:true}`), F5 P1 (D3 hard-codes a JS workspace), F6 P1
  (manifest shape — deviation paragraph under `permissions.rules`
  adopted), F7/F8/F9/F10 P2s (global vs executor copy; rig naming; skill
  report-contracts drift; probe/glob looseness).
- **Disposition**: all findings folded into v2; none rejected. The three
  seats' P0s converged on one root (ancestry ≠ unanswerability) with
  three remedies; v2 adopts grok's insertion point (materialization copy)
  combined with codex's policy fold (`approval/policy` last-wins) and
  critic's fail-closed ancestry (header + runtime depth). Verified
  anchors: harness user-approval `request()` policy-`never` short-circuit
  (index.ts:296-301), executor-session `approval/policy {never,
  source:delegation}` events (issue-337 run), `sanitizeAskReason`
  (pipeline.ts:84-93), `driver-approvals.ts:70-86` + its spec,
  `tool-use-summary` isTopLevel max-idiom (index.ts:64-74), pipeline.ts
  baseline 806 in `check-file-size.baseline.json`.

### r2 (2026-11-17, delta round, three blind seats; v2 revision)

- **critic: GO** — all 16 fold checks RESOLVED; all v2-specific claims
  verified (806-line baseline; `approval/policy {never, source:
  delegation}` present in the issue-337 executor log; `snapshotEvents`
  available). Two P2s: `isDelegatedSession(undefined)` unspecified
  (folded: undefined agent → not delegated), citation drift (folded:
  serviceAsk 464-508, tool-use-summary 64-74).
- **codex: GO** — all 16 fold checks RESOLVED, zero new findings; verified
  the harness `decide()` policy-`never` short-circuit, the 806 baseline,
  and the 21 asked/rejected pairs in the issue-337 log. Its investigation
  also surfaced the harness agent note deprecating new synchronous
  `snapshotEvents` production callers — folded as the session-event read
  precedent note in §D1 (dsh-cc precedent: permission-rules folds in
  ten-plus production files; no `no-deprecated` lint in dsh-cc).
- **grok: GO-WITH-CHANGES** — all fold checks RESOLVED; two new P1s, both
  folded: (1) the tools fork-drift gate pins `pipeline.ts`'s fork-only
  lines and the `src/*.ts` set, so PR-A must register `ask-guidance.ts`
  in `FORK_ONLY_FILES`, move the DRIFT_ALLOWANCE lines, and extend the
  README FORK DRIFT section (verified:
  `tests/upstream-drift.spec.ts:65-73,212-241`); (2) `prepare()`
  materializes `Error: ${denialReason}`, so the probe and the routing
  invariant match `Error: no approval channel can answer this request in
  this delegated session` on tool-result content (verified
  `pipeline.ts:245-254`).
- **Disposition**: r2 introduced no open P0/P1. The final revision folds
  all four r2 notes; no third round is needed (no seat returned NO-GO and
  no new P0/P1 remains open).

