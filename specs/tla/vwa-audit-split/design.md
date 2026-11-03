# Design: vwa-audit-split (SystemOne S1-08)

Model directory: `specs/tla/vwa-audit-split`. Module `Model`, spec `Spec`,
safety-only.

## Formal design screening

- mode: **auto** (session-scoped; the project rules carry no formal-design
  screening clause at this revision — user request 2026-11-02; adoption
  snippet at `<skill>/references/agents-snippet.md`).
- decision: **enabled**
- triggerIds: FD-T2 (a later aggregate pass or a bisected chunk meets an
  earlier verdict; a body task's retries and a late result), FD-T3 (a
  partial save and its recovery decide whether the body re-runs — dedup and
  persistence order across the public pair), FD-T4 (the S1-02 budget permit
  is shared with S1-07 across run/cycle/project budgets).
- backends: `["tla"]`, modelDirs: `{"tla": "specs/tla/vwa-audit-split"}`.
- behavioral source: `docs/plans/2026-11-02-systemone-08-vwa-audit-split.md`
  — the split rationale (S1 only orders candidates; dropping low-probability
  candidates is rejected; AlignEntry is never built from S1), the "Once"
  paragraph for the full-text task, the mergeAlignChunks worst-verdict rule,
  the "fragments may not be aggregated" exclusion, and the recovery test
  rows.

## Requirements

- **REQ-1** The retained legacy aggregation keeps the worst verdict
  (`mergeChunkTargets` in audit-align.ts, used when split=off): a later pass
  never overwrites an earlier `fail`; split-v1 performs no cross-chunk merge.
- **REQ-2** Exactly one logical full-text body task per `(runId, auditKey)`;
  alignment chunks never start their own.
- **REQ-3** Fragments are never aggregated into a completed full-text audit.
- **REQ-4** No extracted candidate is dropped for a low S1 probability: S1
  only orders, the complete set reaches the generative model.
- **REQ-5** Every dispatched attempt is reserved through the shared permit
  first (S1-02 / S1-07 adapter).
- **REQ-6** Delivery requires both halves of the public pair durable and
  validated; a body PART that completed but whose durable save failed re-runs
  on restart; a durable body part whose final pair commit was interrupted is
  only re-assembled and committed.

## State variables

| Variable | Meaning |
|---|---|
| `items`, `batchOf` | extracted items and their alignment batch |
| `merged` | per-item merged verdict (worst-wins lattice) |
| `bodyState`, `bodyCount` | the single full-text task's state and count |
| `runs`, `res` | dispatch and reservation counters |
| `partial` | durable partial saves: align / body |
| `admitted`, `dropped` | delivery admission and dropped candidates |
| `faults` | probe-injected fault witnesses |

## Coverage matrix

| Invariant | Requirement | Adverse trace challenged |
|---|---|---|
| `WorstSticky` / `NoFaults` | REQ-1 | `OverwriteWithLater` probe |
| `OneBodyTask` | REQ-2 | `BodyPerChunk` probe |
| `NoFragmentAdoption` | REQ-3 | `AdoptFragments` probe |
| `NoCandidateDropped` | REQ-4 | `DropLowProb` probe |
| `ReservedBeforeDispatch` | REQ-5 | `NoReserve` probe |
| `DeliveryNeedsPair` | REQ-6 | delivery before both halves are durable |

## Bounds and assumptions

- Three extracted items, two batches; verdict lattice
  `not-run < pass < needs-review < fail`.
- The generative reviewer's content is not modeled: alignment passes return
  verdicts abstractions; S1 candidate ordering collapses into "every
  candidate still gets aligned".
- Repair-on-invalid and per-wire-attempt billing collapse into the
  reservation counter.
- Out of scope: the prompt/response schemas, AUDIT-01..05 rule bodies, the
  cost model's arithmetic, and the shortlist ranking thresholds.
