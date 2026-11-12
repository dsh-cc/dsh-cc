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

R5 (observe mode, narrowed): in observe mode the real admitted batch stays
empty and every real state component is left untouched. **Not modeled:** doc
7's simulated-batch bookkeeping inside observe mode (the model has no
simulated state) — see A7.

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
| mC | retry-attendant | advisory | 2 | k2 |
| mU | unknown | passthrough (probe: advisory) | 2 | — |

Budgets: advisory 3 (`mA`+`mC` cannot both fit, so the advisory defer arm is
reachable), memory 3 (`mM` alone fills it), enter 8, window 3, TTL 2, advisor
cap 1, retry-attendant cap 8 (so `mC` is never cap-blocked and the cap path
stays attributable to `mA`).

## Invariants

- `ProtectedUntouchable`: no governance/task message is ever dropped or
  deferred. Business consequence of violation: behavioral constraints and user
  input silently disappear.
- `UnknownUntouchable`: the unknown-kind message (true class passthrough) is
  never dropped or deferred — the classification-inversion guard.
- `DedupeCommitted` / `CapCommitted`: the plugin's state equals the
  oracle state that advances only at true admissions. Violation = the r1
  self-suppression class (check-time state advance poisons later admissions).
- `AdvisoryBudgetHeld` / `MemoryBudgetHeld`: the admitted advisory (memory)
  bytes of the last gate ≤ its class budget, unless `hardOver`. Both classes
  are checked; the memory side exists because the backlog's admitted bytes and
  the fresh batch share one budget.
- `DispositionPartition`: a queue entry is never both admitted and dropped.
- `AdmittedAtMostOnce`: no entry id is ever admitted more than once
  (`admCount[eid] <= 1`), which the earlier queue-membership form could not
  detect.
- `AdmittedEverCommitted`: the plugin's never-admitted flag equals the
  oracle's (the r1 sentinel bug).
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
- A5: the enter budget (`EB`) is a **flag-only** abstraction: the model
  records `hardOver` but never re-trims on it. Doc 1's enter-budget pass and
  its `hardOver` semantics are therefore proven by neither backend (recorded
  in the Lean coverage table as an explicit cross-backend gap).
- A6: fresh-batch trimming walks the batch newest-first so that budget
  exhaustion defers the OLDEST messages (doc 1 "FIFO-oldest trim"); the
  admitted order re-emitted into the batch is arrival order.
- A7: observe-mode simulated state (doc 7's simulate-then-report bookkeeping)
  is out of scope; only real-pipeline isolation is checked.
- A8: dedupe suppression drops a message while cap overflow defers it (doc 7
  routes cap overflow to the governor's trim), so the two arms are modeled
  separately.
- A9: a never-admitted key is admitted unconditionally; once admitted, the
  window rule `gap >= W` admits (strict comparison at the boundary).
- Bounds: batch ≤ 2, queue ≤ 4, gateSeq ≤ 4, 7 messages, advisory budget 3
  (so two 2-byte advisories cannot both fit and the defer arm is live).
