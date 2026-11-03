# Design: vwa-support-triage (SystemOne S1-07 scheduling)

Model directory: `specs/tla/vwa-support-triage`. Module `Model`,
spec `Spec`, safety-only.

## Formal design screening

- mode: **auto** (session-scoped; the project rules carry no formal-design
  screening clause at this revision — user request 2026-11-02; adoption
  snippet at `<skill>/references/agents-snippet.md`).
- decision: **enabled**
- triggerIds: FD-T1 (the triage pending set and frozen order are shared
  across concurrent review runs), FD-T2 (a triage result arriving after the
  deadline must not reorder a dispatched batch; reuse must precede triage),
  FD-T3 (resume/scope identity decides whether hints are reusable).
- backends: `["tla"]`, modelDirs: `{"tla": "specs/tla/vwa-support-triage"}`.
  The S1-02 reserve/settle protocol this rides on is covered by
  `specs/tla/decision-runtime-quota`; this model owns only the scheduling
  semantics.
- behavioral source: `docs/plans/2026-11-02-systemone-07-vwa-support-triage.md`
  — "this proposal must operate after reuse, so that an already completed
  task does not incur decision cost a second time", "completed records are
  first reused by the existing semantic key, and the remaining tasks form
  `pending` in original plan index order", "triage must not touch already
  reused records", the frozen-order stages (`planned → reuse-filtered →
  triage-pending → triage-frozen`), "a batch already dispatched is not
  reordered on late results; results past the triage deadline are billed
  only", and the reuse rule for cycle/scope identity.

## Requirements

- **REQ-1** Reuse runs before triage; an already completed task never pays
  for a decision again, and triage never touches a reused record.
- **REQ-2** The pending set is exactly the tasks left after the reuse
  filter.
- **REQ-3** The batch order freezes once; a past-deadline result is billed
  but never reorders a dispatched batch.
- **REQ-4** Hints are reusable only within the same cycle and an identical
  complete DecisionScope; a scope change re-evaluates.
- **REQ-5** Triage is an auxiliary priority only: it never rewrites rules,
  target refs or evidence, and never becomes a formal pass (covered by the
  design's enablement rules and asserted by the delivery tests, not by a
  model invariant here).

## State variables

| Variable | Meaning |
|---|---|
| `phase` | planned / reuse-filtered / triage-pending / triage-frozen |
| `pending` | tasks left after reuse |
| `frozen` | tasks whose batch order is frozen |
| `reused` | already completed tasks |
| `batch`, `hint` | per-task batch slot and priority hint |
| `scopeGen` | DecisionScope generation (cycle/session identity) |
| `lateSeen` | tasks whose result arrived after the deadline |
| `faults` | probe-injected fault witnesses |

## Coverage matrix

| Invariant | Requirement | Adverse trace challenged |
|---|---|---|
| `ReuseTriageDisjoint` | REQ-1 | `TriageReused` probe |
| `ReuseExcluded` | REQ-2 | pending drifting from the post-reuse set |
| `LateNeverReorders` | REQ-3 | `ReorderOnLate` / `AdoptLateAsOrder` probes |
| `NoCrossScopeReuse` | REQ-4 | `ReuseAcrossScope` probe |
| `NoFaults` | all | union of fault witnesses |

## Bounds and assumptions

- A fixed small task set, two batch slots, hint values 0..2, scope
  generation bounded at 2.
- The decision call itself (questions, probabilities, batch windows) is out
  of scope: triage produces hints, and the generative reviewer still owns
  the authoritative relation.
- Budget accounting, reserve/settle and the permit adapter are
  `decision-runtime-quota`'s domain (S1-02/S1-07 share that adapter).
- Out of scope: the frozen prompt text, grading, delivery and the
  "never write assist results as a formal pass" rule, which are enforced by
  the delivery tests rather than by these invariants.
