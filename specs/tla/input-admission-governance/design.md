# Design: input-admission-governance (docs 1+7 governor + dedupe/caps)

- Program: context-engineering input governance
  (docs/plans/2026-11-12-per-step-input-budget-governor.md and
  docs/plans/2026-11-12-injection-dedupe-notice-governance.md)
- Model: `specs/tla/input-admission-governance`
- Status: modeling in progress

## Formal design screening

Session-adopted (no formal-design screening clause in the project rules at
this revision; adoption snippet at `<skill>/references/agents-snippet.md`).
Enabled: FD-T2 (defer backlog re-offers are late messages affecting admission
outcomes) plus FD-L1/L2 (eligibility composition and budget arithmetic —
the Lean face `specs/lean/input-admission-arithmetic` covers the pure rules;
this TLA model covers the cross-step state machine). Backends: both; neither
substitutes for the other.

## Requirements modeled

R1 (classes): every message maps to exactly one class — governance
(`turn-rules`), task (`user`), memory, advisory, passthrough. **Unknown kinds
are passthrough** (never trimmed, never deferred) — the r1 inversion fix.

R2 (dedupe/caps, commit-on-admission): eligibility is checked against
committed state plus in-batch provisional admissions; **state advances only
for messages that make it into the final admitted batch**; provisional
reservations of trimmed messages are discarded; suppression distances are
measured from committed admissions only.

R3 (budgets): admitted advisory bytes ≤ advisory budget; admitted memory
bytes ≤ memory budget; a single message whose own bytes exceed its class
budget is dropped (`drop-oversize`) at trim time, never enqueued; when
protected+passthrough bytes alone exceed the enter budget the gate admits
everything and flags `hardOver`.

R4 (defer): budget-trimmed advisory/memory messages enqueue FIFO; entries
age by gate invocations (`gateSeq`); entries older than the TTL are dropped;
the backlog is re-offered FIFO **before** the fresh batch is processed, each
entry judged against its own class budget.

R5 (observe mode): the real batch and the real dedupe/cap state are never
touched; only simulated admissions advance a separate simulated state.

R6 (glue exclusion): `cc-shell-glue` is observe-only in v1 and therefore
excluded from the enforced pipeline entirely (not in the message universe).

## State variables

| variable | meaning |
|---|---|
| `gateSeq` | monotonic gate invocation counter |
| `batch` | pending producer arrivals (sequence, order = arrival) |
| `queue` | deferred entries `[eid, msg, enqueuedAt]` FIFO |
| `dedupeState` | per-key last **committed** admission gateSeq |
| `capCount` | per-kind committed admission count |
| `truthAdmSeq` / `truthCapCount` | oracle copies updated only at true admissions (invariant ground truth) |
| `admEids` / `droppedEids` | entry ids ever admitted / dropped |
| `lastAdmittedBatch` | the batch the last gate actually admitted (enforce) |
| `lastAdvisoryBytes` / `lastHardOver` | the last gate's advisory bytes and hardOver flag |

## Message universe (fixed)

| id | kind | class | bytes | dedupe key |
|---|---|---|---|---|
| mG | turn-rules | governance | 2 | — |
| mT | user | task | 2 | — |
| mM | memory | memory | 3 | — |
| mA | advisor | advisory | 2 | k1 |
| mB | advisor (oversize) | advisory | 6 | k1 |
| mU | unknown | passthrough (probe: advisory) | 2 | — |

Budgets: advisory 4 (two `mA` fit; `mB` alone is oversize), memory 3, enter 8,
window 3, TTL 2, advisor cap 1.

## Invariants

- `ProtectedUntouchable`: no governance/task message is ever dropped or
  deferred. Business consequence of violation: behavioral constraints and user
  input silently disappear.
- `UnknownUntouchable`: the unknown-kind message (true class passthrough) is
  never dropped or deferred — the classification-inversion guard.
- `DedupeCommitted` / `CapCommitted`: the plugin's state equals the
  oracle state that advances only at true admissions. Violation = the r1
  self-suppression class (check-time state advance poisons later admissions).
- `AdvisoryBudgetHeld`: the admitted advisory bytes of the last gate ≤
  advisory budget, unless `hardOver`.
- `DeferredExactlyOnce`: a queue entry is never admitted twice and never
  re-queued after admission (`admEids ∩ queue = {}`).
- `ObserveClean`: in observe mode the real admitted batch is empty and the
  real state is unchanged.

## Fault switches (probe cases)

- `CommitAtCheck` — state advances at check time (the r1 BLOCKER).
- `UnknownAsAdvisory` — unknown kinds classified advisory (the r1 inversion).
- `ObserveMutates` — observe mode writes the real pipeline outcome.

## Bounds and assumptions

- A1: producers may deliver any message any number of times except while the
  same instance is pending in the batch (instance uniqueness by position).
- A2: the batch is processed atomically by one gate invocation; producer
  arrivals between gates are modeled by nondeterministic `Produce`.
- A3: `cc-shell-glue` (observe-only in v1) and lifecycle kinds are out of the
  universe by construction.
- A4: budgets are symbolic small numbers; class semantics, not scale, carry
  the properties.
- Bounds: batch ≤ 3, queue ≤ 3, gateSeq ≤ 6, 6 messages.
