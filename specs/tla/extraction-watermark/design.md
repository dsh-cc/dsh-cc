# Design: extraction-watermark (SystemOne S1-04 coordinator)

Model directory: `specs/tla/extraction-watermark`. Module `Model`,
spec `Spec`, safety-only.

## Formal design screening

- mode: **auto** (session-scoped; the project rules carry no formal-design
  screening clause at this revision — user request 2026-11-02, full-program
  scope confirmed via ask_user_question; adoption snippet at
  `<skill>/references/agents-snippet.md`).
- decision: **enabled**
- triggerIds: FD-T1 (the coordinator mutates per-session state — phase,
  watermark, pendingHead, lease — shared by turn-stopping triggers, dream
  and owner takeover), FD-T2 (a skip verdict settles late against a moving
  evidence head; a failed window must not be retried by a phantom timer),
  FD-T3 (a partial host write must never commit the watermark; restart
  re-reads at watermark -1), FD-T4 (the mutation lease is single-owner
  resource ownership across extraction and dream).
- backends: `["tla"]`, modelDirs: `{"tla": "specs/tla/extraction-watermark"}`.
- behavioral source: `docs/plans/2026-11-02-systemone-04-memory-extraction-gate.md`
  — the coordinator section (phases, watermark commit, cooldown, drain,
  takeover) and the mutation-lease section. Not implemented; existing code
  that constrains it: `memory-consolidation/src/memory-job.ts` (job.done is
  the real completion boundary), `writeback.ts` (file-by-file writes — a
  partial write must not commit).

## Requirements

- **REQ-1** The watermark advances only on `job.done=completed`, to
  `Math.max(previous, capturedHead)` — never past the captured head, so
  newer input that arrived during extraction is not covered.
- **REQ-2** `failed` keeps the previous watermark, releases the lease and
  enters cooldown; the cooldown is retried only by a later stop whose head
  passed `retryAt` — no automatic retry timer.
- **REQ-3** `killed` (from dispose) keeps the watermark, releases the lease
  and disposes the state.
- **REQ-4** A skip verdict commits only after full re-validation: the
  evidence head, window hash, indexHash, scope and generation must be
  unchanged; otherwise the verdict is discarded and the new head waits for
  the next stop.
- **REQ-5** During gating/waiting-lease/extracting a new stop only
  overwrites `pendingHead`; the active captured window is never rewritten.
- **REQ-6** After a settle, pending work is drained once via a microtask,
  never in a while-loop retrying the same failed window.
- **REQ-7** The mutation lease has at most one owner per dir; extraction
  holds it until `job.done`; the finally always releases it.
- **REQ-8** Owner takeover: the old owner's job must have settled; the new
  Agent instance starts at watermark -1 (repeat extraction preferred over
  permanent missed memory).

## State variables

| Variable | Meaning |
|---|---|
| `phase` | idle / gating / waiting-lease / extracting / cooldown / disposed |
| `wm` | `reviewedThrough` watermark (-1 initial) |
| `pendingHead`, `capturedHead` | newest seen evidence head and the captured window head |
| `retryAt` | cooldown retry gate |
| `gen` | owner generation (takeover increments) |
| `leaseOwner` | none / extraction / dream |
| `jobDone` | none / running / completed / failed / killed |
| `faults` | ghost witness set for the four probe families |

## Coverage matrix

| Invariant | Requirement | Adverse trace challenged |
|---|---|---|
| `WmWithinCaptured` | REQ-1 | commit past the captured head |
| `PendingNeverLost` | REQ-5/6 | pending dropped while work is live |
| `NoLeaseAfterTerminal`, `RunningSound` | REQ-3/7 | lease leaked past a terminal job |
| `NoFaults` | REQ-1/2/4/7 | all four probe witnesses: `start-commit` (AdvanceOnStart — the watermark moving when the job starts), `skip-stale` (SkipNoReval — a skip committed after the evidence head moved), `timer-retry` (CooldownAutoRetry — a phantom timer retrying the same failed window), `double-owner` (LeaseDoubleOwner — a second lease owner) |
| `TypeOK` | — | — |

Non-vacuity check: an explicit reachability diagnostic confirmed the
`extracting` phase is reachable in the convention constants (an earlier
draft accidentally made the lease-acquisition actions self-contradictory by
listing `faults` in both the primed assignment and UNCHANGED, which TLC
silently disables — the convention run verified vacuously until the
contradiction was removed).

## Bounds and assumptions

- Evidence heads 0..3, retryAt a single step, up to 3 owner generations.
- A `Stop(h)` models both a new turn and a mode-switch stop; dream appears
  only as a competing lease taker (`DreamTakesLease`/`DreamReleases`).
- The gate's probability judgement (skip vs extract) is abstracted to a
  nondeterministic choice between `GateSkip` and `GateNeedLease`.
- The host write itself (file-by-file partial write) is out of scope — its
  constraint on the watermark is exactly REQ-1 (only completed commits).
- Out of scope: window reconstruction and maxStateBytes, the LRU eviction
  of idle states, shadow-vs-active mode differences, S1-02 metering.
