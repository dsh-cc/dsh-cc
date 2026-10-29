# Design: vwa-batch-run (batch page loop: init idempotency + checkpoint contract)

Model directory: `specs/tla/vwa-batch-run`. Module `Model`, spec `Spec`,
safety-only (no fairness; no liveness property is claimed).

## Formal design screening

- mode: **auto** (session-scoped)
- decision: **enabled**
- triggerIds: FD-T1 (two drivers share one page record and the state writer
  lock), FD-T2 (retried checkpoint after a retryable failure; the same init
  requestId replayed), FD-T3 (crash recovery decides whether a project, a
  report, a commit or a push may be (re)created — dedup and persistence
  order), FD-T4 (the state writer lock and the reserved projectId are
  cross-process ownership).
- backends: `["tla"]` — every claim is about event order, ownership or
  recovery, not about arithmetic.
- modelDirs: `{"tla": "specs/tla/vwa-batch-run"}`
- rationale: the batch design's own §12 test plan cannot cover crash windows
  or two-driver interleavings; these are exactly the F1/F6 claims.
- rule source: **session request** ("按1-3开工", 2026-10-29). No formal-design
  screening clause exists in the effective project rules (AGENTS.md /
  CLAUDE.md) at this revision, so screening is adopted for this session only
  and is **not** a project-wide default; the manual adoption snippet lives at
  `<skill>/references/agents-snippet.md`.
- behavioral source: `docs/plans/2026-10-28-vwa-batch-autonomous-review.md`
  §2.3-§2.4 (init) and §8.2-§8.3 (manifest/state/checkpoints). The feature is
  **not implemented yet**; the model pins the planned semantics and the
  planned atomicity mechanisms. Code anchors that already exist and constrain
  it: `store.ts:200-220` (init + HEAD guard), `commands.ts:148-155` (pointer
  atomic write), `lock.ts:40-96` (exclusive create, dead-holder reclaim, torn
  file not reclaimable).

## Requirements

- **REQ-1 (F1)** A project exists only behind a well-formed, payload-matching
  reservation for the same `requestId`; a torn reservation write never yields
  a project, and a retry after the reservation reuses the same reserved id.
- **REQ-2** The evaluation is frozen before the report is written.
- **REQ-3** The report is durable before the single commit that carries the
  fix and the report.
- **REQ-4** Commit precedes push; push precedes CI confirmation.
- **REQ-5** `state.json` is only a cache: it never claims a checkpoint the
  durable evidence does not support, and a resume recomputes it from evidence.
- **REQ-6** A page is skipped only after `maxPageAttempts` (default 2)
  consecutive failures of the same checkpoint, and a skipped page never
  reaches CI confirmation.
- **REQ-7** Only one live driver holds the state writer lock at a time; a
  torn lock is never auto-reclaimed.

## State variables and atomicity

| Variable | Meaning | Durability |
|---|---|---|
| `ev` | durable evidence: reservation state/payload, project existence, review/freeze/report/commit/push/CI booleans, failure counter, page status | survives crashes |
| `cl` | `state.json` cache claims for report/commit/push/CI/status | lost on crash |
| `alive` | which driver process is live | — |
| `lock`, `inLock` | state writer lock ("none" / "torn" / holder) and its body | survives as a file |
| `pend` | the driver's in-flight action (prepare-reservation, write) | lost on crash |

Atomicity mapping: `ReserveFile` is one `openSync('wx')` + single
`writeSync`+`fsync` (the torn window is `CrashTornReservation`);
`CreateProject` is `ProjectStore.init` whose HEAD-exists guard makes a second
create on the same directory fail closed; `TakeLock`/`ReleaseLock` are
`openSync('wx')`/`unlinkSync`; each checkpoint action is one durable effect
followed by a separate cache write — the *non-atomicity* of
effect-then-cache is the crash window the recovery path closes.

## Coverage matrix

| Requirement ID | Business outcome | Property ID | TLA operator | Case IDs and bounds | Fault-or-race trace | Assumption IDs | Planned code symbol and atomicity mechanism | Regression scenario | Exclusion and justification |
|---|---|---|---|---|---|---|---|---|---|
| REQ-1 | duplicate project creation impossible in every crash window | S-1 `InitSound` | `InitSound` | convention (2 drivers, 2 payloads, SkipAfter=2: the retry-adoption path is exercised); strict-adopt-torn (expected red: the fault lets a truncated reservation be adopted) | ReserveFile → CrashTornReservation (truncated file) → retry via RetryPrepare must not create a project; and ReserveFile → Crash → RetryPrepare adopts the reserved id and creates it once | A-1, A-2 | `argument.init` reserve record then `ProjectStore.init` (`store.ts:200-206` HEAD guard) | crash between reservation and init; replay the same requestId; assert one project and the same id | the payload-hash conflict branch (`IDEMPOTENCY_CONFLICT`) is abstracted to the `resFor` mismatch guard |
| REQ-2 | no report written without a frozen evaluation | S-2 `FrozenBeforeReport` | `FrozenBeforeReport` | convention | FreezeEvaluation omitted, WriteReport attempted | A-3 | `argument.report` write:false freezes `FrozenEvaluation` (`report.ts:211-228`) before as-of rendering | freeze-then-fix-then-render ordering test | the evaluation file hash read-back is E-1 |
| REQ-3 | the commit never carries an unwritten report | S-3 `ReportBeforeCommit` | `ReportBeforeCommit` | convention; strict-commit-before-report (expected red) | Commit with `rep = FALSE` under the fault switch | A-3 | single commit built after `reportWritten` (§8.3 checkpoints 5-6) | assert report file present in the commit | the git object model itself is not modeled (commit is a durable boolean) |
| REQ-4 | delivery order is commit → push → CI | S-4 `DeliveryOrder` | `DeliveryOrder` | convention | Push attempted before commit; CI confirmed before push | A-4 | checkpoint order §8.3 (7-9) | assert `head_sha == pushedSha` check cannot pass before push | the remote's own state is abstracted to the durable booleans |
| REQ-5 | a stale cache never causes a repeated or skipped side effect | S-6 `ClaimNeverAhead` | `ClaimNeverAhead` | convention; strict-cache-first (expected red) | WriteClaim optimistically, then crash before the effect lands (`CacheFirst`) | A-5 | resume recomputes each boolean from disk evidence (§8.3 resume step 3) | crash after commit, before the cache write; resume; assert no second commit | reconciliation of git history vs `state.json` is abstracted to "recompute from `ev`" |
| REQ-6 | bounded retries, then skip and continue | S-7 `SkipNeedsFailures`, S-9 `TerminalStable` | `SkipNeedsFailures`, `TerminalStable` | convention (SkipAfter=2) | FailCheckpoint ×1 then SkipPage attempted (must be refused); CI timeout vs failure distinction not modeled | A-6 | per-checkpoint `stageFailures[n]` with success reset (§8.3) | two consecutive failures at one checkpoint skip the page | CI timeout counter (`ciTimeouts`, max 3) is E-2 |
| REQ-7 | one writer at a time; torn lock is terminal for the run | S-8 `StateWriteExclusive` | `StateWriteExclusive` | convention | two drivers race for the lock; crash in the create window leaves `"torn"` | A-7 | `state.lock` via the `lock.ts` primitive | kill a driver holding the lock; assert the second driver cannot write | lock reclaim by a confirmed-dead holder is inherited from the `vwa-review-cycle` model (E-3) |

## Assumptions

- **A-1** `openSync(path,'wx')` is exclusive-create on the target filesystem
  (Node fs contract; same primitive already modeled in `vwa-review-cycle`).
- **A-2** A single small `writeSync`+`fsync` either lands or leaves a prefix;
  the model treats the prefix case as `res = "torn"` and forbids any project
  behind it. Obligation on the implementation: parse failure must be reported
  as `STORE_IO_FAILED`, never adopted.
- **A-3** The report file write and the git commit are each durable on
  completion (filesystem/git durability; the model does not model partial
  report files — the implementation publishes with temp+rename).
- **A-4** `git push` success implies the commit object is on the remote (git
  protocol guarantee for a non-force push of an existing commit).
- **A-5** `state.json` is written only by the lock holder and carries no
  authority beyond `ev` (design §8.3 "state.json is a cache").
- **A-6** A checkpoint failure is observed before the next checkpoint starts
  (sequential driver loop).
- **A-7** The OS pid check used by `lock.ts` is truthful for live/dead
  processes (same assumption as `vwa-review-cycle` A-2; PID reuse excluded
  there).

## Faults modeled

- **F-1** crash inside the reservation write (torn reservation).
- **F-2** crash between reservation and project creation.
- **F-3** crash after a durable checkpoint before the cache write (stale
  cache), followed by a resume.
- **F-4** crash inside the state-lock create window (torn lock).
- **F-5** a retryable checkpoint failure followed by a retry (counter
  behaviour, skip after the limit).
- **F-6** two drivers acting concurrently (lock contention).

## Exclusions

- **E-1** the `FrozenEvaluation` read-back hash check (`report.ts:426-436`)
  is not modeled: it is a single-file integrity check with no ordering claim;
  covered by unit tests instead.
- **E-2** the `ciTimeouts` counter (max 3, does not consume
  `maxPageAttempts`) is not modeled — it is a second counter of the same
  shape as `sf`; adding it multiplies the state space without changing any
  safety claim. Implementation must test it directly.
- **E-3** dead-holder lock reclaim is inherited from the `vwa-review-cycle`
  model (`LockCreate` reclaims only a confirmed-dead holder); this model only
  tracks "none"/"torn"/holder and asserts exclusivity.
- **E-4** the per-page cost accounting (`costs`) is observability, not a
  property.
- **E-5** `manifest.json` immutability is a documentation convention enforced
  by the skill; no runtime action mutates it, so there is nothing to model.
- **E-6** `FrozenBeforeReport` and `DeliveryOrder` are enforced by action guards
  (structural, no runtime re-check exists), so no fault switch can invert them;
  they remain as regression tripwires for the implementation order.

## Known residual (documented, not excluded)

The design's `git commit -a` content-scope check is a **post-hoc** check: a
commit that stages at commit time cannot be inspected before it lands
(design §3.6). This model therefore does not claim "no non-md commit"; the
claim is only that the batch stops the page on detection. Implementation must
surface the commit id and revoke the grant.
