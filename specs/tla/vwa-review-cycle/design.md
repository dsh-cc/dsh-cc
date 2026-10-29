# Design: vwa-review-cycle (vwa-argument 评审管线 TLA+ 模型) 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L33〕

Status: Modeling (2026-10-27, worktree formal-design-verification) 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L56-L75〕

Model directory: `specs/tla/vwa-review-cycle`. Module `Model`, spec `Spec`, 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L84-L163〕
safety-only (no fairness; see L-1 exclusion) 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕.

## Formal design screening

- mode: **auto**
- decision: **enabled**
- triggerIds: FD-T1 (multiple concurrent review runs / runner vs 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L34-L45〕.
  host share the cycle ledger, lock and run records), FD-T2 (retry pool 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L214-L264〕
  charge/earn/refund, REVISION_CONFLICT stale-snapshot retry), FD-T3 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L214-L264〕
  (process crash recovery: dead-holder lock reclaim, read-time restart
  coercion, durable reserved rows of crashed runs), FD-T4 (budget lock and 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕
  cycle ledger are cross-process resource ownership).
- rationale: the review pipeline is the remaining dsh-cc module where all
  four triggers fire (per the 2026-10-27 scan; the five existing models 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L56-L75〕
  cover subagent admission, moa routing, the context-crusher pipeline, the
  ACP prompt slot and the memory dream job) 〔src:ws:specs/tla/vwa-review-cycle/design.md#L8-L26〕.
- modelDir: `specs/tla/vwa-review-cycle` 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L84-L163〕
- userDirective: none recorded beyond the session request "使用 formal-design 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕
  对 dsh-cc 的功能模块进行建模及验证" and the scope selection 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕
  "vwa-argument 评审管线" (ask_user_question, 2026-10-27) 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕.

## Requirement ↔ property ↔ model ↔ code mapping

Statuses (`types.ts:189`): `queued | running | completed | incomplete | 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L295-L306〕
cancelled | budget-exhausted`; per-record status 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕
(`types.ts:298,339`): `completed | error | cancelled | budget-exhausted` 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L295-L306〕.

| Requirement ID | Business outcome | Property ID | TLA operator | Case IDs and bounds | Fault-or-race trace | Assumption IDs | Planned code symbol and atomicity mechanism | Regression scenario | Exclusion and justification | 〔src:ws:specs/tla/vwa-review-cycle/design.md#L27-L63〕
|---|---|---|---|---|---|---|---|---|---|
| R-1 budget-lock mutual exclusion 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L7-L83〕 | concurrent runs serialize admission and spend reservation | — (structural; see E-3) | `LockCreate`/`AdmissionBody` | convention (2 procs, 2 runs, MaxCalls=1) | P1 holds the budget lock while P2 prepares admission | A-2 | `withBudgetLock` (review-cycle.ts:72-77) wraps a fully synchronous body — no await while held, so acquire+body+release is one interleaving-free section | two concurrent admissions on the same project | project store lock (`store.ts:393-429`) uses the identical primitive; see E-3 |
| R-2 cycle budget never overspent 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L84-L163〕 | the cycle's durable ledger cannot exceed the cycle budget | S-2 `CycleBudgetSound` | `CycleBudgetSound` | convention | crash after a durable reserved row; retry reserve on top | A-1, A-3 | `reserveCycleCall` (review-cycle.ts:258-274): spend read + `reserve()` callback (durable usage row append) inside the same budget lock | kill a run mid-batch, continue the cycle, assert no over-admission | token dimensions (input/output) are abstracted away; only the calls dimension is modeled |
| R-3 retry pool accounting 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L214-L264〕 | a run never earns more retries than its allowance; refunded retries restore the pool | S-3 `RetryPoolSound` | `RetryPoolSound` | convention (RetryAllowance=1) | two tasks race for the last unit; abort during backoff after charging | A-4 | pool check+debit same tick (review-call.ts:201-209), refund on abort/count-fail/budget-refusal (review-call.ts:104-109,111,124,145), earn at retry reservation (review-call.ts:149) | concurrent batch tasks exhausting the pool | pool is in-process state, lost on crash (documented; invariant restricted to live owners) |
| R-4 one run per requestId 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L84-L163〕 | same requestId never re-calls the model; different payload is a conflict | S-4 `OneRunPerRequest` | `OneRunPerRequest` | convention (2 requests, 2 payloads) | replay after completion; conflicting payload replay | A-5 | `reserveCycleRequest` prior-wins identity (review-cycle.ts:189-190) + `review-request.ts:7-37` IDEMPOTENCY_CONFLICT | replay a completed requestId; replay with a mutated payload | partial-batch replay semantics (records returned) are not modeled |
| R-5 restart rule 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L7-L83〕 | a persisted queued/running run with a dead owner is never observed as live | S-5 `DeadOwnerLoadIncomplete` | `DeadOwnerLoadIncomplete` | convention | crash mid-run then a fresh process loads the run | A-6 | `loadRequest` read-time coercion (review-run-store.ts:124-157); nothing written back, continuation requires a new requestId | kill the process mid-run, re-open the project, assert the run reads incomplete | PID reuse misclassifying a dead owner as alive is out of scope (documented code behavior, see E-6) |
| R-6 continuation reuse soundness 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L265-L285〕 | a reused target's record existed, was completed, was not a disagreement copy, and reuse happens only in continue mode | S-6 `ContinuationSound`, S-7 `DefaultModeNoReuse` | `ContinuationSound`, `DefaultModeNoReuse` | convention | continue run resumes after a crashed partial run; disagreement copy on the same target | A-7, A-8 | `reusableRecord` (review-continue.ts:190-207) + `applyReuse` zero-token copy (review-runner.ts:323-336, continue mode only) | crash a run at 50%, continue, assert reused targets match cache keys | non-continue same-requestId reuse is unreachable (same requestId never re-runs, §10.6); audit reuse is E-4 |
| R-7 admission refusals 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L7-L83〕 | stale budget snapshot (REVISION_CONFLICT), all-reusable continue (NOTHING_TO_CONTINUE) and torn-lock LOCK_BUSY are fail-stop, never silently mis-admitted | structural: refusal branches create no run and change no mapping (S-4 remains) | `AdmissionBody`/`AdmissionBusy` branches | convention | graph commit between readHead and reservation; torn lock crash then admission | A-2, A-9 | revision check inside the lock (review-cycle.ts:204-212), `continueHasWork` (review-continue.ts:159-179), torn-lock LOCK_BUSY (lock.ts:72-91) | commit a graph revision concurrently with admission | refusal codes are not state: the model asserts only that a refusal never admits a run; refusal texts are out of scope |
| R-8 no ghost dispatch 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L276-L285〕 | a process only dispatches on a run it owns while that run is running | S-8 `NoGhostDispatch` | `NoGhostDispatch` | convention | crash clears in-flight state | A-6 | `pend` process-local state cleared on crash; runner rebuild gated by re-reservation (review-runner.ts:86-101) | — | — |
| R-9 (probe) torn lock is permanent 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L7-L83〕 | documents that a torn lock file blocks admission until manual removal | probe `LockNeverTorn` (expected counterexample) | `LockNeverTorn` | strict-torn-lock (trace: Prepare→LockCreate→CrashTorn) | crash between `openSync('wx')` and `writeSync` (lock.ts:58-62) | — | unreclaimable by design: only a dead-holder pid reclaims (lock.ts:79-84) | — | documented behavior, not a defect fix request |
| R-10 (probe) reserved-spend overcounts 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L84-L163〕 | documents that a crash between the durable reserved row and the settled attempt still charges the cycle | probe `ReservedSettledAccounting` (expected counterexample) | `ReservedSettledAccounting` | strict-reserved-spend (trace: Prepare→LockCreate→AdmissionBody→StartRun→ReserveCall→Crash) | crash after `reserve()` append, before the attempt settles | — | durable row append inside the lock precedes dispatch (review-call.ts:129-147 then :172-183); `dispatched` in the model counts settled attempts (ok / retryable failure / abort), an in-flight call carried by a live process is not an overcount | — | conservative accounting by design (review-cycle.ts:247-256) |

Model bounds (all three cases): 2 processes, 2 runs, 2 targets, 2 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L34-L45〕
requestIds, 2 payloads, RetryAllowance=1, MaxHeadRev=1; the convention 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L286-L293〕
core case uses MaxCalls=1 (budget exhaustion and the retry-refusal path 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L214-L264〕
remain reachable), the probes use MaxCalls=2. State-space abstractions 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕
recorded for review: admission-refusal outcomes are not state (no
variable; the safety claim is only that a refusal never admits a run);
load observations are recorded only for dead-owner loads (the restart
coercion branch — the only branch with a safety claim); a fresh
admission always carries payload h1 and a different payload is only 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕
preparable when replaying an existing requestId (the only purpose of 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L286-L293〕
the second payload is the IDEMPOTENCY_CONFLICT replay) 〔src:ws:specs/tla/vwa-review-cycle/design.md#L47-L63〕.

Liveness: **L-1 (excluded)** — no fairness is added; the model is a bounded 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L56-L75〕
safety exploration of admission/reservation/recovery ordering. Adding
fairness merely to force termination is forbidden by the modeling guide.
Lock-wait liveness (a live holder eventually releases) is guaranteed by the
synchronous lock discipline (R-1) and is not separately modeled 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L56-L75〕.

## Real atomicity mechanisms (per critical write)

- Budget lock critical section: acquire → read cycle spend → synchronous
  `reserve()` (durable usage row append + local counters) → release, with 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕
  no await inside (review-cycle.ts:71-77 comment, :262-273). Modeled as one 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L84-L163〕
  interleaving-free region split into `LockCreate`/`AdmissionBody` / 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕
  `ReserveCall`/`RetryReserve` action pairs only where a crash window 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕
  exists (create-write window; reserve→dispatch gap).
- Single-file persistence: temp + fsync + rename (`writeAtomic`, 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L164-L213〕
  review-run-store.ts:238-249; cycle sidecar with per-pid tmp, 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L7-L83〕
  review-cycle.ts:153-172). Modeled as atomic writes 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L84-L163〕.
- Usage ledger: append + fsync per row (review-run-store.ts:226-236) 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L7-L83〕.
  Append-only; modeled as monotonically growing `reserved` counters 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L56-L75〕.
- Lock reclaim: unlink of a dead holder's file followed by re-create
  (lock.ts:79-84); PID liveness via `process.kill(pid, 0)` (lock.ts:31-38) 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L7-L83〕.

## Assumptions

- A-1: target identity abstracts the record cache key 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L265-L285〕
  (`collectCachedRecords`/cache-key equality, review-continue.ts:36-48): same target id ⇒ same 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L265-L285〕
  cache key. Justification: cache-key derivation (content digests of
  unchanged inputs) is deterministic computation; the ordering risk is
  which records exist, not how keys are computed.
- A-2: the budget-lock body is synchronous (no await while held) — verified 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕
  in code (review-cycle.ts:71-77); the model therefore exposes a crash 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L84-L163〕
  window only in the lock create/write pair, matching lock.ts:58-62 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L7-L83〕.
- A-3: the calls dimension of the budget is representative; the 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕
  input/output token dimensions use the same check structure
  (review-cycle.ts:265-274) and add no ordering behavior 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L84-L163〕.
- A-4: the shared retry pool is only mutated by the owning process 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L214-L264〕
  (in-memory field, review-call.ts:63-67); cross-process interference is 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L214-L264〕
  impossible because one run has one owning process.
- A-5: requestId uniqueness is caller-supplied (UUID v4); collisions of 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L286-L293〕
  distinct intents are assumed absent, only replay vs conflict is modeled.
- A-6: `pidAlive` answers are trusted; PID reuse (lock.ts:31-38 has no 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L7-L83〕
  age check) can make a dead holder look alive — availability-only,
  excluded (E-6) 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕.
- A-7: completed per-task records persist immediately and are 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕
  hash-verified on read (review-run-store.ts:171-196); corrupted records 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L7-L83〕
  are filtered, which the model abstracts as "records never silently 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L56-L75〕
  change once written" 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕.
- A-8: a disagreement copy (review-run-store.ts:347-358, `disagreementFinding`) is modeled as a 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L7-L83〕
  completed record flagged non-reusable; its `needs-review` verdict 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕
  aggregation is out of scope.
- A-9: the per-run retry pool is shared by the owning process's concurrent 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L214-L264〕
  tasks; cross-task interleaving of check+debit is same-tick synchronous
  (review-call.ts:201-209), so the model's atomic charge is faithful and 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L214-L264〕
  A-4 covers process ownership 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕.

## Faults / adverse orders modeled

- F-1 crash of the admission process inside the lock create window 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕
  (torn lock, `CrashTorn`) 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕.
- F-2 crash of a run owner at any in-flight point (reserved rows and 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L34-L45〕
  records survive; `Crash`) 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕.
- F-3 graph commit between budget snapshot and reservation 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕
  (`CommitHead` + `Prepare` snapshot, REVISION_CONFLICT branch) 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕.
- F-4 retryable model failure consuming the last pool unit while a peer 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L214-L264〕
  task also needs one (`DispatchRetryFail`) 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕.
- F-5 abort during retry backoff after the unit was charged 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L214-L264〕
  (`RetryAbandon` refund path) 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕.
- F-6 continue admission when every target is already reusable 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕
  (NOTHING_TO_CONTINUE) and the opposite (partial reuse) 〔src:ws:specs/tla/vwa-review-cycle/design.md#L113-L133〕.

Adverse trace challenging the reuse abstraction (per modeling guide):
crashed run R1 completes target t1 as a *disagreement* copy only; a 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L265-L285〕
continue run R2 must not reuse t1 from R1. The model marks such records 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L34-L45〕
via `dis` and `ReusableFrom` excludes them; `ContinuationSound` asserts 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕
the copy under R2 traces back to a non-disagreement completed record 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L265-L285〕.

## Planned code/test mapping and regression scenarios

Regression assertions (all against the existing package,
`packages/interaction/vwa-argument`): 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕

1. Crash-after-reserve overcount: seed a run with a durable reserved row 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L34-L45〕
   and a dead owner; `cycleUsage` must include the row 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L133-L163〕
   (review-cycle.ts:235-245). Existing coverage: none found for the 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L84-L163〕
   dead-owner path (gap; see implementation.md).
2. Restart coercion: persist `status: "running"` with a dead pid; assert 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L34-L45〕
   `loadRequest` returns `incomplete` (review-run-store.ts:146-157) 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L7-L83〕.
3. Idempotent replay: two admissions with the same requestId and payload 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L286-L293〕
   return the same run; different payload ⇒ IDEMPOTENCY_CONFLICT 〔src:ws:specs/tla/vwa-review-cycle/design.md#L134-L152〕
   (review-request.ts:7-37) 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L286-L293〕.
4. Torn lock: write a non-JSON `write.lock`; assert admission fails 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕
   LOCK_BUSY (lock.ts:72-91) 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L7-L83〕.
5. Retry refund: charge then abort during backoff; assert the pool unit is 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L214-L264〕
   restored (review-call.ts:104-109,238-246) 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L214-L264〕.

## Exclusions

- E-1 project store transaction internals (snapshot→revision→operation→ 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕
  HEAD ordering, store.ts:464-495): a single synchronous critical section 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L7-L83〕
  under the same lock primitive as R-1; ordering risk is the lock itself, 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕
  which is modeled. Changing store.ts to async writes re-opens this.
- E-2 audit stage and cross-batch worst-verdict merge (audit-align.ts): 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕
  deterministic in-run computation after all semantic stages; the merge
  lattice is pure algebra (candidate for a separate Lean-style proof, not
  a state machine).
- E-3 project store lock vs budget lock are two directories using the same 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕
  `acquireLock` primitive; modeled once via the budget lock 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕.
- E-4 audit reuse (`applyReusedAudit`) re-persists extract+align in 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L276-L285〕
  continue mode; same guard family as R-6, no new ordering behavior 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕.
- E-5 outcome.json → request.json two-file terminal write 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕
  (review-runner.ts:108-122): loadRequest only reads request.json, and a 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L164-L213〕
  crash between the writes leaves `running` on disk, which the read-time 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L34-L45〕
  rule (R-5) coerces to incomplete; outcome.json is hash-verified on read 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕.
  No observable interleaving changes an admission decision.
- E-6 PID reuse and lock age: availability-only (conservative 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕
  misdirection: a live-looking dead holder blocks reclaim), documented in
  code; no safety claim depends on it.
- E-7 writeAtomic fixed `.tmp` path (review-run-store.ts:240): all 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L7-L83〕
  request-record writers for one run are in the owning process and
  writeAtomic is fully synchronous, so within-process interleaving is 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L164-L213〕
  impossible; a second live writer process for the same runId does not 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L34-L45〕
  exist (the runner re-stamps ownership on entry,
  review-runner.ts:101) 〔src:ws:specs/tla/vwa-review-cycle/code-anchors.md#L276-L285〕.

## Counterexample dispositions (final run)

- convention: **verified** — no violation of the eight checked invariants.
- strict-torn-lock: one counterexample (Prepare → LockCreate → CrashTorn; 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕
  the lock becomes `torn` and stays unreclaimable) — documented behavior, 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕
  no code change requested.
- strict-reserved-spend: one counterexample (Prepare → LockCreate → 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L20-L45〕
  AdmissionBody → StartRun → ReserveCall → Crash; the durable reserved row 〔src:ws:specs/tla/vwa-review-cycle/implementation.md#L34-L45〕
  outlives the killed attempt) — documented conservative accounting, no
  code change requested.
- No convention-case counterexample arose, so no design defect / modeling
  defect / requirement ambiguity classification was required this round.

## Extension: project-cumulative budget (design §5.1, 2026-10-28)

Screening re-run for the batch-autonomous design
(`docs/plans/2026-10-28-vwa-batch-autonomous-review.md` §5.1). The extension
changes modeled behavior (a second ledger dimension read at admission and at
every reservation), so FD-T4 (cross-cycle resource ownership) and FD-T2
(estimate-vs-actual reservation, retry reservations) re-fire. Backend stays
`tla`: the new mechanism is ledger concurrency, not arithmetic alone.

Constants added by this extension: `ProjectBudget` (calls allowed across all
cycles of one project), `AdmissionEstimate` (the plan estimate
`estimatedWithRetries` charged only at fresh admission), `EnforcePerCall`
(the documented fault switch: `FALSE` disables the per-call project
projection, reproducing the pre-design behavior).

| Requirement ID | Business outcome | Property ID | TLA operator | Case IDs and bounds | Fault-or-race trace | Assumption IDs | Planned code symbol and atomicity mechanism | Regression scenario | Exclusion and justification |
|---|---|---|---|---|---|---|---|---|---|
| R-11 project budget never overspent | the project ledger (all cycles, including reserved rows of crashed runs) stays within `projectBudget.maxCalls` | S-9 `ProjectBudgetSound` | `ProjectBudgetSound` | convention (ProjectBudget=1: the admission guard actually refuses a second fresh cycle — a looser bound left the guard unreached and the property vacuous); project-per-call (MaxCalls=2, ProjectBudget=1, RetryAllowance=0: the per-call projection blocks the second reservation while the cycle budget would allow it); strict-admission-only (expected red) | admit run r1 just under the ceiling, then let r1 spend its whole cycle allowance; crash between a reserved row and its dispatch | A-10 | `projectUsage` over every `review-runs/*/request` via `loadRequest` + `estimatedWithRetries` at `reserveCycleRequest`, and the per-call projection inside `reserveCycleCall` — both under the same `withBudgetLock` section (review-cycle.ts:72-77) | two cycles in one project each admitted, then run to exhaustion; assert no over-admission and ledger ≤ cap | token dimensions (input/output) abstracted away; only the calls dimension is modeled |
| R-12 admission estimate is not a reservation | an admitted run cannot be bounded by its admission estimate alone; the per-call projection is the enforcement point | probe `strict-admission-only` (expected counterexample) | `ProjectBudgetSound` with `EnforcePerCall=FALSE` | strict-admission-only (ProjectBudget=2, MaxCalls=2, EnforcePerCall=FALSE) | admission passes at estimate 1, the run then reserves two calls | A-9 | same as R-11 (the disabled switch is the fault model, never a shipped configuration) | n/a — the probe documents why the in-lock per-call check exists (codex r2 finding 11) | the fault switch is constant-bound per case, so it adds no state space |

Excluded from this extension: the streamed `usage.jsonl` reconciliation
detail (`loadRequest` reconciles to `max(request.calls, usage rows)` including `kind:'reserved'` rows — review-run-store.ts:124-157; the model uses the durable `reserved`
counter exactly as R-2 does) and the wall-clock dimension (report-only).

### Extension assumptions and known defects (2026-10-29 model review fold)

- **A-10**: `projectUsage` is a complete durable read — every admitted run's
  ledger is reconciled via `loadRequest` (max of the request's calls and its
  persisted usage rows, including `kind:'reserved'` rows of crashed runs,
  review-run-store.ts:124-157), never a raw request-field sum. The model's
  `reserved` counter is exactly that durable row count.
- **A-11**: retry earnings remain bounded under the project ceiling: a retry
  reservation consumes the same per-call projection as a fresh call (both go
  through `reserveCycleCall`); the `project-retry-earn` case exercises a
  successful retry reservation under the project guard.
- **E-8 (known product defect, tracked)**: dead-holder lock reclamation is
  modeled as one atomic step; the real `acquireLock` reclaim has a TOCTOU
  race where two acquirers can both end up holding the lock
  (lock.ts:74-84). Tracked as issue #311 — deliberately not fixed in this
  PR (docs+models only). The atomic abstraction is retained so the model's
  other properties are not blocked by the known defect; when #311 is fixed,
  this abstraction stays valid (the fix restores the modeled atomicity).
- New case `project-retry-earn` (MaxCalls=2, RetryAllowance=1,
  ProjectBudget=2, MaxHeadRev=1): covers a successful retry reservation and
  concurrent retry consumers under the project ceiling (review finding:
  green bounds had never exercised retry earnings).
- **K1 fix note**: the replay/IDEMPOTENCY_CONFLICT arm of `AdmissionBody`
  previously conjuncted `UNCHANGED vars` inside an action that had already
  assigned primed variables, making the arm dead code — R-4's replay
  semantics were never executed. Fixed; the convention state count grew
  from 31,256,810 to 31,313,450, confirming the arm is now reachable.
