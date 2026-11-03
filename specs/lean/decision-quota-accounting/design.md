# Design: decision-quota-accounting (SystemOne S1-02, Lean face)

Model directory: `specs/lean/decision-quota-accounting`. The Lean face of
the M1 TLA+ model `specs/tla/decision-runtime-quota` (screened together).

## Formal design screening

- mode: **auto** (session-adopted; the project rules carry no formal-design
  screening clause at this revision — user request 2026-11-02, full-program
  scope confirmed via ask_user_question; adoption snippet at
  `<skill>/references/agents-snippet.md`).
- decision: **enabled**
- triggerIds: FD-L2 (budget/quota accounting with a stated conservation
  requirement: reserved ≥ settled + in-flight, missing usage retained as an
  unknown upper bound).
- backends: `["tla", "lean"]` for S1-02 as a whole; this model is the lean
  face, modelDirs: `{"tla": "specs/tla/decision-runtime-quota", "lean":
  "specs/lean/decision-quota-accounting"}`.
- behavioral source: `docs/plans/2026-11-02-systemone-02-decision-runtime-metering.md`
  §Execution state machine steps 6-7 (settle actual/unknown), §Durable
  quota and concurrency (recovery rules) and §Failure table. The feature
  is not implemented; the pure functions live only in this model until
  `packages/observability/decision-usage` exists.

## Business properties (plain English)

- **REQ-1 Conservation** — for any ledger, the retained total never exceeds
  the reserved total: no settlement path frees more than was reserved, and
  no path double-counts an attempt.
- **REQ-2 Unknown is an upper bound** — an unknown outcome (timeout,
  unknown network state) and an unsettled in-flight attempt both retain
  the full reservation ("never assume failure is free").
- **REQ-3 Only not-dispatched refunds** — a durable not-dispatched terminal
  is the only one returning the full reservation.
- **REQ-4 Actual bills exactly the usage** — a valid actual settlement
  (usage ≤ reserved) bills exactly the usage, so the difference over
  actual is returned, and settling never raises the retained amount
  compared to staying unsettled.

Boundary behavior: a usage above the reservation is an accounting error
handled by the surrounding protocol (record actual values plus
`accounting-overrun`, freeze the session) — the projection itself clamps
to the reservation so REQ-1 stays a theorem without the error path.

## Conformance

Not applicable yet (proof stage): S1-02 is not implemented, so there is no
production module to bind the adapter to. When `quota.ts` exists, the
adapter binds `retained`/`retainedTotal`/`reservedTotal` from this model
to the production projection over the JSONL ledger rows and the corpus
below pins the boundary cases. corpus provenance: none yet — to be
recorded when the conformance stage runs.
