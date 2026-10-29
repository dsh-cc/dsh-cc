# Design: vwa-batch-run v2 (batch page loop: init idempotency + checkpoint contract)

Model directory: `specs/tla/vwa-batch-run`. Module `Model`, spec `Spec`,
safety-only. This is the v2 rewrite after the three-lane model review; the
folds are listed in implementation.md.

## Formal design screening

- mode: **auto** (session-scoped; the project rules carry no formal-design
  screening clause at this revision — session request "model the batch
  design" 2026-10-29, manual adoption snippet at
  `<skill>/references/agents-snippet.md`).
- decision: **enabled**
- triggerIds: FD-T1 (two drivers share one page record and the state writer
  lock), FD-T2 (retried checkpoints, replayed init requestIds), FD-T3 (crash
  recovery decides project/report/commit/push identity — dedup and
  persistence order), FD-T4 (the state writer lock and the reserved
  projectId are cross-process ownership).
- backends: `["tla"]`, modelDirs: `{"tla": "specs/tla/vwa-batch-run"}`.
- behavioral source: `docs/plans/2026-10-28-vwa-batch-autonomous-review.md`
  §2.3-§2.4 (init) and §8.2-§8.3 (manifest/state/checkpoints). The feature is
  **not implemented yet**; existing code that constrains it:
  `store.ts:200-220` (init + HEAD guard — see issue #312 for its lockless
  create race), `commands.ts:148-155`, `lock.ts:40-96` (see issue #311 for
  the dead-holder TOCTOU).

## Requirements

- **REQ-1** A project exists only behind one well-formed payload-matching
  reservation; a torn reservation write never yields a project; the torn
  fault is reachable ONLY in the original write window (a retry that re-reads
  an on-disk reservation never rewrites it — v2 fold); the documented
  recovery for a torn file is abandoning it and starting a fresh requestId.
- **REQ-2** The graph is bound before the review runs.
- **REQ-3** The evaluation is frozen before the report is written; the report
  is durable before the single commit that carries the fix and the report.
- **REQ-4** Commit precedes push precedes PR precedes CI confirmation.
- **REQ-5** The commit's content is sampled at commit time; pushing
  non-conforming content is impossible (the content gate); a DETECTED
  violation fails the page and pushing it afterwards is forbidden.
- **REQ-6** `state.json` is only a cache: it never claims a checkpoint the
  evidence does not support, and a stale cache never causes a repeated or
  skipped side effect (the protocol fault, not just the shape).
- **REQ-7** A page is skipped only after `SkipAfter` consecutive failures of
  the SAME checkpoint (a checkpoint success resets that counter); a skipped
  or failed page never reaches CI.
- **REQ-8** Only one live driver holds the state writer lock; a torn lock is
  never auto-reclaimed.
- **REQ-9** The no-commit/no-PR terminal: a page with nothing to deliver ends
  done without CI and never delivers afterwards.
- **REQ-10** No stuck live state exists (CHECK_DEADLOCK is meaningful: the
  self-loop is enabled only when every driver is dead).

## State variables

| Variable | Meaning | Durability |
|---|---|---|
| `ev` | durable evidence: reservation state/payload, project, bound, reviewed, frozen, rep, com, content, push, pr, nopr, ci, failure counter, page status | survives crashes |
| `cl` | `state.json` cache claims | lost on crash |
| `alive`, `lock`, `inLock`, `pend` | driver liveness, the state-writer lock, and the in-flight action (with `phase`: original write vs retry adoption) | pend/alive lost on crash |

Atomicity mapping: `ReserveFile` = one `openSync('wx')` + single
`writeSync`+`fsync` (the torn window is `CrashTornReservation`, phase
"write" only); `CreateProject` = `ProjectStore.init` (issue #312: the real
init is lockless today — the design requires taking the project write lock;
the model pins the INTENDED transaction); checkpoint actions are one durable
effect each; `WriteClaim` is a separate cache write — the non-atomicity of
effect-then-cache is the crash window the resume path closes.

## Coverage matrix

| Requirement ID | Business outcome | Property ID | TLA operator | Case IDs and bounds | Fault-or-race trace | Assumption IDs | Planned code symbol and atomicity mechanism | Regression scenario | Exclusion and justification |
|---|---|---|---|---|---|---|---|---|---|
| REQ-1 | duplicate projects impossible in every crash window | S-1 `InitSound` | `InitSound` | convention; strict-adopt-torn (expected red) | ReserveFile → CrashTornReservation → retry must not create; ReserveFile → Crash → RetryPrepare adopts the reserved id | A-1, A-2 | `argument.init` reserve record then `ProjectStore.init` under the project write lock (issue #312) | crash between reservation and init; replay same requestId | the payload-hash conflict branch is abstracted to the `resFor` guard |
| REQ-2 | no review of an unbound graph | S-2 `BoundBeforeReview` | `BoundBeforeReview` | convention | Review attempted right after project creation | A-3 | checkpoint 2 (`bind-artifact`) before any review | assert review requires a bound artifact | — |
| REQ-3 | freeze → report → single commit | S-3 `FrozenBeforeReport`, S-4 `ReportBeforeCommit` | same | convention; strict-commit-before-report (expected red) | Commit with `rep = FALSE` under the fault switch | A-3 | §8.3 checkpoints 4-6 | assert the report file is inside the commit | git's own object model is a durable boolean here |
| REQ-4 | commit → push → PR → CI | S-5 `DeliveryOrder` | `DeliveryOrder` | convention; strict-push-stale-cache (expected red) | Push without commit via the stale cache | A-4 | §8.3 checkpoints 6-9 | assert `head_sha == pushedSha` | the remote is abstracted to durable booleans |
| REQ-5 | content gate and violation stop | S-6 `ContentGateSound` | `ContentGateSound` | convention; strict-skip-content-gate (expected red) | a violating commit (`content = "other"`) is pushed | A-5 | §3.6 pre-check (`diff --cached -z --name-status`) + post-commit `diff-tree` detection | commit a non-.md file; assert no push and page failed | the -z parser itself is E-2 |
| REQ-6 | cache never authorizes an effect | S-7 `ClaimNeverAhead` + the protocol fault | `ClaimNeverAhead`; `PushFromStaleCache` (fault) | convention; strict-cache-first (shape, expected red); strict-push-stale-cache (protocol, expected red) | WriteClaim ahead, crash before the effect, then a driver acting on the claim | A-6 | resume recomputes each boolean from disk evidence (§8.3) | crash after commit before cache write; resume; no second commit | reconciliation of git history is abstracted to "recompute from `ev`" |
| REQ-7 | same-checkpoint skip rule | S-8 `SkipNeedsFailures`, S-11 `TerminalStable` | same | convention (SkipAfter=2) | fail(review) → succeed → fail(freeze) → skip must be refused | A-7 | per-checkpoint `stageFailures[n]` reset on that checkpoint's success (§8.3) | two consecutive failures at one checkpoint skip; interleaved do not | the `ciTimeouts` counter is E-3 |
| REQ-8 | single writer; torn lock terminal | S-9 `StateWriteExclusive` | `StateWriteExclusive` | convention | two drivers race for the lock; crash in the create window | A-8 | `state.lock` via the `lock.ts` primitive (issue #311 documents its real TOCTOU) | kill a driver holding the lock | dead-holder reclaim is E-4 |
| REQ-9 | no-PR terminal delivers nothing | S-10 `NoPrSound` | `NoPrSound` | convention | MarkNoPr then a delivery attempt | A-3 | §8.3 checkpoint 8 note | a nothing-to-deliver page ends done without CI | — |
| REQ-10 | no stuck live state | structural (deadlock check) | `Idle` restricted to all-dead | convention | torn reservation → `AbandonReservation`; every live state has a successor | A-1 | the STORE_IO_FAILED delete-to-recover path (§2.4) | drive a torn reservation; assert the driver recovers | — |

## Assumptions

- **A-1** `openSync(path,'wx')` is exclusive-create (Node fs contract); a
  single small `writeSync`+`fsync` either lands or leaves the "torn" prefix.
- **A-2** A retry reads the reservation file and never rewrites it (design
  §2.4; the v1 fault that let a retry-adopted reservation be torn was a
  modeling artifact, folded).
- **A-3** Each checkpoint's durable effect is atomic on completion
  (temp+rename publication; git commit/push durability).
- **A-4** `git push` success implies the commit is on the remote.
- **A-5** The content pre-check and the post-commit `diff-tree` inspection
  are truthful summaries of the committed tree (git `-z` output).
- **A-6** `state.json` is written only by the lock holder and carries no
  authority beyond the evidence.
- **A-7** A checkpoint failure is observed before the next checkpoint starts.
- **A-8** The OS pid check used by `lock.ts` is truthful; its dead-holder
  TOCTOU is issue #311, not modeled (E-4).

## Faults modeled (one switch per probe)

| Switch | Models | Probe |
|---|---|---|
| `CommitBeforeReport` | committing without the durable report | strict-commit-before-report |
| `CacheFirst` | an optimistic cache write ahead of evidence | strict-cache-first (shape) / strict-push-stale-cache (protocol) |
| `AdoptTorn` | adopting a truncated reservation | strict-adopt-torn |
| `SkipContentGate` | pushing a violating commit | strict-skip-content-gate |

## Exclusions

- **E-1** the `FrozenEvaluation` read-back hash is a single-file integrity
  check (unit tests).
- **E-2** the `-z --name-status` parser (deterministic string logic).
- **E-3** the `ciTimeouts` counter (same shape as `sf`; tested directly).
- **E-4** the dead-holder reclaim TOCTOU is a KNOWN product defect tracked as
  issue #311; the reclaim is modeled atomically so the model's other
  properties are not blocked by it (when #311 is fixed the abstraction
  becomes exact).
- **E-5** `manifest.json` immutability (no runtime mutator).
- **E-6** per-page cost accounting (observability only).
- **E-7** the lockless `ProjectStore.init` create race is a KNOWN product
  defect tracked as issue #312; the model pins the INTENDED transaction (init
  under the project write lock) and the design doc requires it.
