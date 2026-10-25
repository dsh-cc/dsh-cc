# background-task-lifecycle — implementation record

Records run identities, observed code/test anchors, findings and workflow
state. Outside inputDigest by design; routine observations go here, not
into design.md.

## First-use notice (screening)

Effective project rules in this session: the worktree root AGENTS.md is a
7-line self-forwarding stub (references CLAUDE.md, which symlinks back);
the full three-lane review protocol is not loadable from the effective
rules. Screening adoption: not confirmed; review rules: effectively
missing from the stub. Per the skill contract, missing review rules permit
modeling and checking but no claim of workflow approval or an invented
reviewer roster. The user's task requested preflight/check/check-evidence
and a report only — no formal review dispatch was requested or performed.

## Target system selection

"当前后台任务" was ambiguous across four candidates (harness jobs
registry, background subagents, formal-design runner, memory dream jobs).
User selected via question: the memory dream task
(packages/memory/memory-consolidation). Dream jobs are the only candidate
with cancel + completion + retry semantics all present.

## Runs

| Run | Command result | Notes |
|---|---|---|
| 20261025T050540Z-b4765960… | error/config-invalid | Model.tla parse error: invalid `\` line continuations (my TLA+ authoring mistake, not a code finding) — fixed, run superseded |
| 20261025T050626Z-c40a4ca4… | counterexample | intermediate split of probe invariants; superseded by the 3-case layout |
| 20261025T050749Z-89cf5e9f-ed26-410c-8f9a-32f12d500100 | check: counterexample (invariant); check-evidence: valid/fresh, verification=counterexample | convention verified; strict-cancel-window and strict-cancel-write counterexamples (expected probes) |

Current final run (20261025T064209Z-01bfb05e-c7bd-468a-a317-a7d0474e4e5a), inputDigest 0ed6332cca854b0041b11ce46da8bc79b2605f92002a3f59bcfd6497e62a43cb: convention verified; strict-cancel-window and strict-cancel-write counterexample (unchanged verdicts across every run). This run re-ran after retargeting the 〔src:ws:〕 markers to code-anchors.md (the vwa-evidence citation whitelist admits *.md targets only, so direct .ts citations were out-of-bounds; code-anchors.md holds the verbatim excerpts of every cited production/test range, captured at worktree commit 51bc5846). Citation metadata only — no semantic/model change; the digest inputs are design.md/checks.json/Model.tla/cfgs, and the only design.md deltas across runs are citation markers and the recorded adjudication text. Superseded runs with identical case verdicts, retained as references: fca63039… (20261025T050749Z-89cf5e9f…), dd9491c8… (20261025T062210Z-5082ad2c…), daef41d0… (20261025T063536Z-f2d4baae…).
Toolchain: bundled tla2tools.jar v1.7.4 (sha256
936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88), Java
25.0.2 (PATH), runner @dsh-cc/plugin-dsh-cc-agents 0.9.2-rc.1, runnerDigest
06e192d42b33a964ba2fc870ea0a555988b1d649da2a32710595a3273c04d1e2.

Case results (final run):

- convention: verified (166 generated / 104 distinct / 0 queue).
- strict-cancel-window: counterexample on StrictNoCompleteAfterAbort.
- strict-cancel-write: counterexample on StrictCancelledNoWrite.

## Observed code anchors (read this session, worktree @ 51bc5846)

- Outcome mapping (abort-first read, then result, then async write-back):
  packages/memory/memory-consolidation/src/memory-job.ts:139-158 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L298-L320〕.
- Per-attempt AbortController; disposal effect registered per
  startMemoryJob call: memory-job.ts:117 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L250-L253〕, 165-173.
- Non-atomic per-file write-back: @dsh-cc/memory writeback.ts
  (writeMemoryFiles loop), reached from memory-job.ts:148-154 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L329-L338〕.
- Retry policy (one retry, killed never respawns, lock reuse, retry-dispatch
  throw → rollback): packages/memory/memory-consolidation/src/index.ts:353-397 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L38-L85〕.
- Lock acquire/rollback semantics: src/lock.ts:71-124 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L159-L215〕 (read-back verify,
  accepted sub-ms TOCTOU; best-effort rollback).
- dreamInFlight resets at spawn time (index.ts:181-183 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L18-L23〕) — the lock is the
  real mutual exclusion (see design.md A-4).

## Observed regression tests pinning the modeled contract

- dream-diagnostics.spec.ts:233-258 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L353-L381〕 fail→retry completes (same lock, two
  spawns); :260-273 retry fails→rollback, no third; :275-292 retry-dispatch
  throw→rollback; :294-309 killed→no respawn.
- turn-stopping.spec.ts:259-293 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L443-L480〕 rejection→failed; aborted-before-reject→
  killed; completed→write-back lands host-side.
- memory-job-silence.spec.ts:96-118 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L415-L440〕 disposal abort→killed.
- lock.spec.ts:148 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L409-L412〕 killed consolidation leaves a reclaimable lock.

## Findings beyond the model (for user adjudication)

- Adjudication (user, 2026-10-25): A1/B1/C1 accepted — the two probe
  counterexamples are documented behavior (cancel is advisory after the
  abort read; rollback is lock-only with next-window self-healing); staged-
  write transactionality recorded as a candidate future PR; F-5 recorded
  without code change. No production code change in this task.
- Regression-test gap list (proposed, not implemented — production-repo
  change, out of scope here):
  1. abort arriving between the handler's aborted read and write-back
     completion still yields completed (pins the S-6 window).
  2. a write-back throw after partial writes, followed by a killed retry,
     leaves the lock rolled back with the partial writes persisted (pins
     the S-7 shape).
  3. job.abort() on the first attempt's handle after a failed outcome does
     not abort the spawned retry (pins F-5).
- F-5 (observed while modeling, not model-checked): the original job
  handle cannot abort the retry — each startMemoryJob call creates a fresh
  controller (memory-job.ts:117 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L250-L253〕); job.abort() after a failed first attempt
  has no channel into the retry. Only agent disposal reaches the retry
  (its own registered effect, memory-job.ts:165-171 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L341-L350〕). Consequence: a
  caller that aborts "the dream" after attempt 1 failed cannot cancel the
  retry it spawned.
- Test gap: no existing test pins abort arriving DURING the write-back
  (the strict-cancel-window race) or partial-write persistence across a
  killed retry (strict-cancel-write). Both are unverified-by-test
  behaviors; the model is the only current evidence.

## Scope, deviations, remaining work

- No production code modified. Only specs/tla/background-task-lifecycle/
  (3 input files + generated cfgs), .gitignore (/.formal-design/), and this
  record.
- The check aggregate is `counterexample` BY DESIGN: the two strict cases
  are probes of candidate requirements R-1′/R-2′ and are expected to fail;
  do not "fix" this by deleting them. Adjudicate R-1′/R-2′ first.
- Unmodeled (see design.md exclusions): extraction jobs, admission gates,
  cross-process lock contention/stale reclaim, clearPressure/rollbackLock
  I/O failure, lock-acquire TOCTOU, crash/restart persistence, per-file
  write contents.
- Formal review: not dispatched (not requested; review rules unavailable
  from the effective stub). Implementation handoff: not applicable — this
  task changed no production code.
