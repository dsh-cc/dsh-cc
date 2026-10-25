# Background dream-task lifecycle (cancel, completion, bounded retry)

Formal model of the memory-consolidation dream background task: one dream
window from lock acquisition through at most one retry to its terminal
outcome, under cancellation, child failures and write-back faults.

## Formal design

- mode: auto
- decision: enabled
- triggerIds: FD-T1, FD-T2
- rationale: the dream outcome-mapping handler reads the abort flag and the
  child result, then performs an async host-side write-back — independent
  actors (fork child, aborting caller) change shared state where event
  ordering (cancel vs completion vs retry) determines the final outcome.
- modelDir: specs/tla/background-task-lifecycle
- userDirective: "使用 formal-design，对当前后台任务的取消、完成和重试行为建立形式化模型…重点检查：取消被接受后迟到的完成消息；重试后旧 attempt 的结果；取消与完成不同顺序。不要修改生产代码；发现语义歧义先问。" (target system confirmed by the user: the memory dream task, packages/memory/memory-consolidation.)

## Requirements (restated from code and tests, not assumed)

The dream background task (`runDream` → `startMemoryJob`, at most one retry):

- R-1 (Q1 — late completion after accepted cancel): once cancel is accepted
  while the fork result has not yet settled, the arriving completion message
  is neutralized: the attempt's outcome is `killed`, no memory write is
  performed by that completion, and the window ends cancelled.
- R-2 (Q2 — old attempt cannot complete the retry): the retry attempt's
  outcome is determined only by the retry's own child result and its own
  abort state; the first attempt's result cannot complete the retry, and a
  successful window attributes its durable write to the attempt that
  performed it.
- R-3 (Q3 — order conformance): cancel-first ⇒ final `cancelled` with lock
  rolled back and no respawn; completion processed with the abort flag unset
  ⇒ final `success` with the lock committed and the pressure marker cleared,
  and no later abort rewrites it; a failed attempt ⇒ exactly one retry
  reusing the held lock; a failed retry or a retry-dispatch throw ⇒ final
  `failed` with rollback and no third attempt; a killed attempt never
  respawns.
- R-4: attempts stay bounded: `attempt ≤ MaxAttempts`, `respawns ≤
  MaxAttempts − 1`.
- R-1′ (candidate requirement, probed): cancel accepted at ANY time before
  the outcome commits excludes completion.
- R-2′ (candidate requirement, probed): a cancelled window performed no
  durable writes.

R-1′/R-2′ are not claims about the current code; they are the stricter
contracts the user asked to check. The `strict-cancel-window` and `strict-cancel-write` cases probe them and is
expected to produce counterexamples; those counterexamples are findings to
adjudicate, not model defects to patch away.

## State, actions and atomicity

State: `final`, `attempt`, `phase` (idle/running/mapping/writing/settled),
`childState`, `aborted`, `abortBeforeSettle`, `readAborted`, `outcome`,
`writesPerformed`/`writeAttempt`, `respawns`, `lock`, `markerCleared`.

Actions and their real transactions:

- `StartDream` ↔ gates pass + `tryAcquireLock` (index.ts:339 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L26-L29〕, lock.ts:71-108 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L116-L156〕).
  The lock acquire is read+write+read-back-verify; the code itself documents
  a sub-millisecond residual TOCTOU accepted with stale-window reclaim
  (lock.ts:93-99 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L218-L227〕). Modeled as atomic; the residual is excluded (A-6).
- `ChildSettles` ↔ the fork's `run.result` promise settling with
  `stopReason` completed / a child-level error / an infrastructure rejection
  (memory-job.ts:122-158 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L256-L295〕). One settlement per attempt (A-3).
- `Abort` ↔ `controller.abort()` via `job.abort(reason)` or the per-agent
  disposal effect (memory-job.ts:141 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L323-L326〕, 165-171). Targets only the current
  attempt: each `startMemoryJob` call creates a fresh controller, so the
  original job handle cannot abort a retry (finding F-5 in
  implementation.md).
- `RunHandler` ↔ the `done` outcome mapping (memory-job.ts:139-158 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L298-L320〕): reads
  `controller.signal.aborted` FIRST (synchronous), then the child result,
  then awaits validation and the write-back. **The abort read and the
  write-back are separate steps — this is the modeled non-atomicity; it is
  the real structure, not an abstraction choice.**
- `WriteCommit`/`WriteThrow` ↔ `validateMemoryWrites` + `writeMemoryFiles`
  (memory-job.ts:148-154 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L329-L338〕; @dsh-cc/memory writeback.ts). `writeMemoryFiles`
  writes files in a per-file loop — non-atomic; a throw mid-loop leaves
  partial durable writes (`WriteThrow`, fault F-3).
- `HandleOutcome` ↔ the index.ts outcome dispatch (index.ts:353-397 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L38-L85〕):
  completed ⇒ `clearPressure` + keep the success stamp; killed ⇒
  `rollbackLock(priorAt)`, never respawn; failed ⇒ exactly one retry spawn
  (same prompt, same lock, fresh controller — index.ts:377 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L100-L103〕) or the retry
  dispatch throws (F-4, index.ts:391-395 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L106-L113〕); failed at the bound ⇒ rollback.
- `TerminalStutter` keeps terminal states total under CHECK_DEADLOCK TRUE.

## Properties, assumptions and faults

- S-0 / TypeOK: all variables stay in their declared finite domains.
- S-1 / AttemptBound (R-4): bounded attempts and respawns.
- S-2 / LateCompleteCannotComplete (R-1): `abortBeforeSettle ⇒ outcome ≠
  "completed"`.
- S-3 / KilledStable (R-3): `final = "cancelled" ⇒ lock = "rolled-back"`.
  No respawn after killed is structural (the killed branch of
  HandleOutcome never spawns) and pinned by
  dream-diagnostics.spec.ts:294 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L403-L406〕.
- S-4 / SuccessCommits (R-2, R-3): success ⇒ lock committed, marker
  cleared, write performed by the final attempt.
- S-5 / FinalWriteFromFinalAttempt (R-2): `writeAttempt ≤ attempt` (a
  recorded write is never attributed to a future attempt).
- S-6 / StrictNoCompleteAfterAbort (R-1′, probe): `aborted ⇒ outcome ≠
  "completed" ∧ final ≠ "success"`.
- S-7 / StrictCancelledNoWrite (R-2′, probe): `final = "cancelled" ⇒
  ¬writesPerformed`.
- L-0: liveness excluded. Nothing obliges the fork to settle, the caller to
  abort, or the scheduler to run the handler; no fairness is added merely to
  terminate a safety exploration.
- A-1: MaxAttempts is a positive natural (ASSUME); both cases set it to 2 —
  the code allows exactly one retry (index.ts:366-372 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L88-L97〕).
- A-2: the handler's abort read is one synchronous step; the write-back is a
  later async step. Justified by memory-job.ts:139-158 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L298-L320〕 (single synchronous
  read of `controller.signal.aborted`, then `await writeMemoryFiles`).
- A-3: exactly one child settlement per attempt, and the retry spawns only
  inside `job.done.then` — causally after the first attempt's outcome
  resolved (index.ts:353 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L32-L35〕, 377). A late second result from the old attempt is
  structurally impossible; this assumption is the code's promise-chain
  structure, not a generosity.
- A-4: dream admission (gates, pressure cooldown, `dreamInFlight`
  single-flight, cross-process lock contention) is environment. A
  lock-blocked start has no lifecycle to model. Note the observed subtlety:
  `dreamInFlight` resets when `runDream` returns (at spawn time, not job
  settle — index.ts:181-183 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L18-L23〕), so concurrent windows are prevented by the
  LOCK, not the flag; any concurrent second window blocks at
  `tryAcquireLock` and ends without a lifecycle.
- A-5: best-effort I/O failures of `clearPressure` and `rollbackLock`
  itself (swallowed, void) are excluded; their success is assumed.
- A-6: the lock acquire's residual TOCTOU (lock.ts:93-99 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L218-L227〕) is excluded; a
  stolen lock is outside this window's lifecycle.
- F-1: cancel may be accepted at any point relative to child settlement and
  outcome evaluation (both competing orders).
- F-2: the child may settle as completed / error stopReason / rejection.
- F-3: the write-back may throw mid-loop leaving partial durable writes.
- F-4: the retry dispatch itself may throw.

## Planned coverage and correspondence

| Requirement ID | Business outcome | Property ID | TLA operator | Case IDs and bounds | Fault-or-race trace | Assumption IDs | Planned code symbol and atomicity mechanism | Regression scenario | Exclusion and justification |
|---|---|---|---|---|---|---|---|---|---|
| R-1 | Late completion after accepted cancel cannot complete | S-2 | LateCompleteCannotComplete | convention (core), MaxAttempts=2 | Start → Abort(running) → ChildSettles(completed) → RunHandler | A-1, A-2, A-3 | done mapping aborted-first read (memory-job.ts:141 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L323-L326〕); single sync read then branch | turn-stopping.spec.ts:284-293 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L483-L495〕 (aborted before result rejects ⇒ killed); memory-job-silence.spec.ts:96-118 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L415-L440〕 (disposal abort ⇒ killed) | External effects of the fork itself excluded — the fork holds no write tools (index.ts:8-12 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L8-L15〕); host-side write-back is the only durable effect and is modeled |
| R-2 | Old attempt's result cannot complete the retry; success attributes its write to the final attempt | S-4, S-5 | SuccessCommits, FinalWriteFromFinalAttempt | convention (core), MaxAttempts=2 | Start → ChildSettles(error) → HandleOutcome(retry) → attempt-1 events are dead | A-1, A-3 | retry spawned inside job.done.then with fresh controller (index.ts:377 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L100-L103〕; memory-job.ts:117 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L250-L253〕); writeAttempt tagged at WriteCommit/WriteThrow | dream-diagnostics.spec.ts:233-258 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L353-L381〕 (fail + retry completes: same lock, two spawns) | File-content interleaving unmodeled: writesPerformed is a flag, not per-file state (sufficient for R-2′'s probe; see critical abstractions) |
| R-3 | Cancel/complete orders conform to the convention | S-3, S-4 | KilledStable, SuccessCommits | convention (core), MaxAttempts=2 | cancel-first: Start → Abort → ChildSettles → killed/rollback; complete-first: Start → ChildSettles(completed) → RunHandler → WriteCommit → success; failed: Start → ChildSettles(error) → retry → (complete / fail / throw / kill) | A-1, A-2, A-4 | index.ts:353-397 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L38-L85〕 outcome dispatch; killed ⇒ rollbackLock no respawn; failed ⇒ one retry; completed ⇒ clearPressure + success stamp | dream-diagnostics.spec.ts:260-273 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L384-L400〕 (retry fails ⇒ rollback, no third), :275-292 (retry dispatch throw ⇒ rollback), :294-309 (no retry on killed); lock.spec.ts:148 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L409-L412〕 (killed leaves reclaimable lock) | clearPressure/rollbackLock I/O failures (A-5); lock-acquire TOCTOU (A-6) |
| R-4 | Bounded attempts | S-1, S-0 | AttemptBound, TypeOK | convention (core), MaxAttempts=2 | retry at the bound → failed; counters never exceed 2 | A-1 | retry guard `attempt < MaxAttempts` maps to the code's single-retry structure (index.ts:366-372 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L88-L97〕, 377) | dream-diagnostics.spec.ts:260-273 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L384-L400〕 (exactly two spawns) | Arbitrary attempt counts excluded — the code retries at most once by construction |
| R-1′ (candidate) | Cancel accepted at ANY time before outcome commit excludes completion | S-6 | StrictNoCompleteAfterAbort | strict-cancel-window (core), strict-cancel-write (core), MaxAttempts=2 | Start → ChildSettles(completed) → RunHandler(reads aborted=FALSE) → Abort(writing) → WriteCommit ⇒ outcome completed despite aborted=TRUE | A-1, A-2 | probed against the same done mapping; the abort read and the awaited write-back are separate steps | No existing test pins abort-during-write-back (gap; see implementation.md) | This is a probe of a candidate requirement, not a current-convention claim; counterexample expected and to be adjudicated |
| R-2′ (candidate) | A cancelled window performed no durable writes | S-7 | StrictCancelledNoWrite | strict-cancel-window (core), strict-cancel-write (core), MaxAttempts=2 | Start → ChildSettles(completed) → WriteThrow(partial write) → HandleOutcome(retry) → Abort → ChildSettles → RunHandler(killed) ⇒ cancelled with writesPerformed=TRUE | A-1, F-3 | probed against writeMemoryFiles' per-file non-atomic loop | No existing test pins partial-write persistence across a killed retry (gap) | Same as R-1′: probe; the code's rollback is lock-only and best-effort by design (lock.ts:110-124 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L230-L247〕) |

## Critical abstraction challenges

1. **One-settlement-per-attempt (A-3).** Challenge: a duplicate or second
   late result from the old attempt's promise. The code's promise chain
   settles exactly once and the retry is spawned inside `done.then`, so a
   stale result cannot reach the retry's handler; if a future refactor made
   the retry spawn concurrent with the first attempt's settlement, A-3 would
   fail silently. Adverse trace to challenge it: attempt-1 ChildSettles
   after the retry spawned — impossible today only because of the causal
   `done.then` chain (index.ts:353 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L32-L35〕→377).
2. **writesPerformed as a flag, not file contents.** Challenge: two attempts
   writing different batches interleave at file granularity. The model
   cannot distinguish "partial write then full overwrite" from "mixed
   contents". For R-2/R-2′ (attribution and existence of durable effects)
   the flag suffices; a content-integrity requirement would need per-file
   state and is explicitly out of scope.
3. **Abort after outcome resolution is a no-op.** Modeled by disabling
   Abort once `outcome ≠ "none"`. Justified: the resolved `done` promise is
   immutable and `controller.abort()` on a settled run changes nothing the
   dispatch observes. Challenge trace: abort lands between WriteCommit and
   HandleOutcome — in the code this aborts nothing observable (the write
   already happened and the outcome dispatch ignores the controller).
4. **The original job handle cannot abort the retry.** Each
   `startMemoryJob` call owns a fresh controller; `job.abort()` from the
   first attempt has no channel into the retry (only agent disposal
   reaches it, via the retry's own registered effect — memory-job.ts:165-171 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L341-L350〕
   runs per call). Modeled as Abort targeting the current attempt only.
   This is an asymmetry to report, not to fix in the model.
5. **dreamInFlight resets at spawn time, not settle time** (index.ts:181-183 〔src:ws:specs/tla/background-task-lifecycle/code-anchors.md#L18-L23〕).
   The lock, not the flag, is the real mutual exclusion; the model relies on
   A-4. Adverse trace: a second turn-end during the first dream's retry
   passes `dreamInFlight`, then blocks at `tryAcquireLock` (fresh stamp) —
   ends without a lifecycle, so no interference with this window's
   semantics.

## Counterexample disposition and acceptance

Expected dispositions for the strict-cancel-window / strict-cancel-write probes:

- S-6 violation (abort during write-back ⇒ completed): USER-ADJUDICATED
  (2026-10-25) as documented behavior — cancel arriving after the handler's
  abort read is advisory; a fully committed, validated consolidation is a
  valid terminal outcome. Requiring a re-check before write-back would
  convert this window into the S-7 shape (files written, lock rolled back)
  and is rejected. Follow-up: pin the order with a regression test;
  eliminating the window entirely would require transactional staged-write
  (separate future PR, not this task).
- S-7 violation (cancelled with partial writes): USER-ADJUDICATED
  (2026-10-25) as a documented design decision — rollback is lock-only and
  best-effort by design; partial writes from a failed attempt persist and
  are healed by the next dream window (time gate re-opens). A transactional
  write-back (staged write + rename) is recorded as a candidate follow-up
  PR, not adopted now.

Both must-pass invariants of the `convention` case are expected to verify.
The aggregate check status is expected to be `counterexample` because of the
strict-cancel-window / strict-cancel-write probes; that is the honest encoding of "these races exist",
kept in-package so the traces are durable evidence. Never delete S-6/S-7 to
turn the aggregate green; adjudicate them instead.

implementation.md (outside inputDigest) holds run IDs, tool metadata, code
and test observations keyed to the checked digest.
