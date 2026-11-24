# Design: dream-lease-wait (the dream lane's bounded FIFO wait for the mutation lease)

Model directory: `specs/tla/dream-lease-wait`. Module `Model`,
spec `Spec`, safety-only.

## The defect this model pins

2026-11-23 live debugging established the starvation empirically: in
`shadow`/`active` extraction mode the coordinator's `extract()` holds the
per-plugin mutation lease from before the fork starts until `job.done`
(minutes per round), while `runDream()` reaches `lease.tryAcquire()` only
after four awaited fs reads and then **balks** when the slot is owned or any
waiter is queued. Both lanes dispatch from the same `agent/turn-stopping`
event; the coordinator's `queueMicrotask` dispatch wins the free slot before
dream's I/O-burdened path arrives, so dream structurally never owns the slot
while extraction is active: **0 dream dispatches across 2.5 hours of
shadow-mode attempts, dispatch within 20 seconds of switching extraction to
`off`** (the legacy lane takes no lease). The failure is silent — a debug
log and an early return, no breadcrumb — which is why the MEMORY.md index
grew to its 25 KB cap without ever being consolidated.

## The fix being modeled

Dream's local-lease acquisition becomes a bounded FIFO wait:

1. Fast path unchanged: `tryAcquire` first; an uncontended slot (extraction
   `off` or idle) is taken at once, exactly as today.
2. Contended path: dream queues via `lease.acquire(dir, signal)` — the
   lease's existing FIFO queue — on a fresh `AbortController` aborted by
   (a) a bounded timer (`dreamLeaseWaitMs`, default 10 min, `0` restores
   the old balk behavior), and (b) plugin fiber disposal.
3. The lease's release drains to the **oldest live waiter atomically**;
   a queued dream therefore receives the slot **before any extraction
   attempt that queued after it**. That FIFO handoff — not polling, not
   extraction yield — is the mechanism that kills the starvation.
4. A timeout leaves a durable breadcrumb (`lease-timeout`) so future
   starvation is diagnosable; the pressure marker stays armed, so the next
   cooldown window retries.

The DISK lock (`.consolidation-lock`) rationale from the S1-04 design is
untouched: dream still takes the disk lock only while already holding the
local lease, never queues behind a foreign process.

## Formal design screening

- mode: **auto** (session-scoped; the project rules carry no formal-design
  screening clause at this revision — user request 2026-11-23 "完整的实现方案",
  adoption snippet at `<skill>/references/agents-snippet.md`).
- decision: **enabled**
- triggerIds: FD-T2 (a new bounded timeout races the grant and decides
  whether the round is lost), FD-T4 (the mutation lease is single-owner
  resource ownership shared by extraction and dream; the existing
  `extraction-watermark` model pins the extraction side, and its
  `DreamTakesLease` action is the behavior this fix changes — "existing
  modeled behavior changes also trigger").
- backends: `["tla"]`, modelDirs: `{"tla": "specs/tla/dream-lease-wait"}`.
- behavioral source: the fix plan (this PR) plus
  `packages/memory/memory-consolidation/src/mutation-lease.ts` (the real
  FIFO drain in `drain()`: release hands the freed slot to the oldest live
  waiter, a cancelled waiter is skipped and removed) and
  `src/extraction-coordinator.ts:269` (extraction's queued acquire).

## Why safety-only (no leads-to / WF)

All 20 existing TLA+ models in this repo are safety-only
(`Spec == Init /\ [][Next]_vars`); introducing the first liveness spec is a
convention change this fix does not need. The wait-termination guarantee is
captured **structurally**: from `dream = "queued"` the only outgoing
transitions are the FIFO handoff (`granted`) and the bound-exhausted
timeout (`timed-out`); there is no `lost` transition out of `queued`. The
pre-fix defect is modeled by the `DreamBalks` probe — the `lost` state
becomes reachable exactly the way production lost rounds — and the
convention run proves `granted` is reachable (non-vacuity diagnostic
below), so the fixed protocol cannot degenerate into the balk shape
without breaking `NoLostDream`.

## Requirements

- **REQ-1 (single owner)** The lease has at most one owner; `dream`
  holds it exactly for the span `queued → granted → done`, and the
  terminal outcome always releases it.
- **REQ-2 (FIFO rescue)** While dream is queued, the running extraction's
  release hands the slot to dream before any extraction attempt that
  queued after dream (the `ext2` actor).
- **REQ-3 (bounded wait)** Dream leaves the queue only via the handoff or
  the timeout, and the timeout fires only when the wait budget is
  exhausted (the abort-before-bound race is a probe, not a behavior).
- **REQ-4 (defect dead)** Under the fixed protocol a gated dream with the
  slot contended can only become `queued` — the pre-fix `lost` state is
  unreachable.

## State variables

| Variable | Meaning |
|---|---|
| `leaseOwner` | `none` / `extraction` / `dream` |
| `dream` | `idle` / `gated` / `queued` / `granted` / `done` / `timed-out` / `lost` |
| `budget` | dream's remaining wait budget while queued (`0..WaitBound`) |
| `ext2` | a newer extraction attempt: `none` / `queued` / `granted` / `released` |

`Init` opens mid-extraction (`leaseOwner = "extraction"`) because that is
the defect scenario; the uncontended path is still exercised through
`ExtReleases` + `DreamTakesFree`.

## Coverage matrix

| Invariant | Requirement | Adverse trace challenged |
|---|---|---|
| `TypeOK` | — | — |
| `SingleOwner` | REQ-1 | a `done`/`timed-out` dream still recorded as owner |
| `FifoNoOvertake` | REQ-2 | a newer extraction granted while dream still queued (the `FifoBreak` probe removes both the atomic handoff and the FIFO guard — the exact non-FIFO drain shape) |
| `TimeoutOnlyAtBound` | REQ-3 | the timer aborting before the budget is exhausted (`TimerFiresEarly` probe) |
| `NoLostDream` | REQ-4 | the pre-fix balk (`DreamBalks` probe: gated + contended → `lost` forever) |

Non-vacuity: the convention run's `faults`-free `granted` reachability is
asserted by inspection of the state graph (`dream = "granted"` and
`dream = "timed-out"` are both reachable in the convention constants;
TLC's coverage output confirms the handoff and timeout actions fire).

## Fault switches

| Switch | Emulates |
|---|---|
| `DreamBalks` | the pre-fix code: a gated dream gives up when the slot is contended |
| `FifoBreak` | a release that skips the queued dream (a non-FIFO drain), letting a newer extraction overtake |
| `TimerFiresEarly` | a timeout that fires before the wait budget is exhausted |

## Out of scope

- The lease implementation itself (`drain()`, waiter cancellation,
  idempotent release): unchanged, pinned by
  `tests/mutation-lease.spec.ts`.
- The disk lock protocol: unchanged, pinned by
  `specs/tla/memory-write-lifecycle`.
- The extraction coordinator's own state machine: unchanged, pinned by
  `specs/tla/extraction-watermark`.
