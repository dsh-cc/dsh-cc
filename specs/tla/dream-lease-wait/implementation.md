# Implementation record: dream-lease-wait

Effective project rules at modeling time: the root AGENTS.md carries **no**
formal-design screening clause — screening is session-adopted (user request
2026-11-23 "针对这个缺陷设计完整的实现方案，经过三路评审"; the fix targets the
mutation lease, FD-T2/FD-T4 territory, and the existing
`extraction-watermark` model's `DreamTakesLease` action is the behavior being
changed). Adoption snippet: `<skill>/references/agents-snippet.md`.

## Final run

- runId: `20261124T003337Z-96cd5a52-4e5b-496c-b04d-8c996a6214c0` (r2 review
  revision: `DreamAborted` added as a specified disposal cancellation —
  distinct from the bound-exhausted timeout; `Ext2Queues` widened so the
  D5 inversion is modeled; the false termination claim removed from
  design.md. First run: `20261124T001006Z-359b4f54`.)
- toolchain: TLC 1.7.4 (bundled JAR, SHA-256 pinned), Java 25.0.2, runner
  `@dsh-cc/plugin-dsh-cc-agents` 0.9.6, darwin.
- convention (core): **verified** — all 5 invariants hold (`TypeOK`,
  `SingleOwner`, `FifoNoOvertake`, `TimeoutOnlyAtBound`, `NoLostDream`).
- Probes (expansion, expected counterexample; each breaks exactly its own
  invariant):
  - `strict-dream-balks` → `NoLostDream` violated (the production defect:
    a gated, contended dream becomes `lost` forever — the pre-fix balk).
  - `strict-fifo-break` → `FifoNoOvertake` violated (a release that skips
    the queued dream lets a newer extraction overtake).
  - `strict-timer-early` → `TimeoutOnlyAtBound` violated (the timer aborts
    before the budget is exhausted).
- `check-evidence`: valid, fresh; `verification: counterexample` is the
  expected legal form for a probe package (core verified + probes with
  counterexamples).
- Reachability diagnostics (scratch, not committed — the repo convention):
  temporary anti-invariants `dream # "granted"`, `dream # "timed-out"`
  and `dream # "aborted"` all produce violations, so `granted`,
  `timed-out` and `aborted` are reachable in the convention constants;
  the model is not vacuously verified. **No termination claim**: under
  stuttering a queued dream may remain queued forever; the runtime
  assumptions (drain hands the slot to the oldest live waiter, the timer
  fires, the teardown aborts) live in the code, not the model.

## Counterexample classification

All development errors were **modeling defects**, never design defects:

1. The module name `dream-lease-wait` contains a hyphen — SANY rejects it
   (`Was expecting "----"`); renamed to `Model` per repo convention.
2. `budget \in 0..WaitBound` lexed `0.` as a real literal (the known
   `-1..3` pitfall class); spaced to `0 .. WaitBound`.
3. Missing `EXTENDS Naturals` — `..`, `>`, `-` unresolved; added.
4. Settled states (`done`/`timed-out`/`lost` with no lane work left)
   deadlocked the checker; added the explicit `Terminal` no-op (the
   extraction-watermark `Idle` convention).

## Implementation mapping (for the executor)

| Model element | Code |
|---|---|
| `DreamTakesFree` | `lease.tryAcquire(dir)` fast path in `runDream` (unchanged) |
| `DreamQueues` + `Tick` + `DreamTimesOut` | the new `acquireDreamLease` bounded wait: `lease.acquire(dir, controller.signal)` + `setTimeout(() => controller.abort('lease-timeout'), dreamLeaseWaitMs)` |
| `DreamAborted` | the fiber-teardown cancellation: `controller.abort('dispose')` on the live wait handle + the per-attempt `cancelled` flag check (pre-acquire and post-grant) |
| `ExtReleasesHandoff` | the lease's existing `drain()` — release hands the freed slot to the oldest live waiter atomically (`mutation-lease.ts`, unchanged, pinned by `tests/mutation-lease.spec.ts`) |
| `Ext2Granted` FIFO guard | the lease's `tryAcquire`/`acquire` queue discipline (unchanged) |
| `DreamGivesUp` (probe) | the pre-fix `tryAcquire`-balk code path being deleted |
| `lease-timeout` breadcrumb | new `recordDreamDiagnostic` phase on the timeout path |

## Non-goals / out of scope

- No liveness (leads-to / WF) spec: all 20 existing repo models are
  safety-only; NO termination claim is made — under stuttering a queued
  dream may remain queued forever. From `queued` the outgoing transitions
  are the handoff, the bound-exhausted timeout and the disposal
  cancellation. The runtime scheduling assumptions (drain hands the slot
  to the oldest live waiter; the timer fires; the teardown aborts) live
  in the code. Recorded in design.md §"Why safety-only".
- The lease implementation, the disk lock, and the coordinator state
  machine are unchanged (pinned by their existing models/specs).
