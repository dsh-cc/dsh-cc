# Design: vwa-adjudication-durability

Model of VWA adjudication durability over immutable review records (design doc §6.1, §6.2, §6.3,
§10.2).

Behavioral source: `docs/plans/2026-11-15-vwa-autonomous-render-pipeline.md`.

## Formal design screening

- mode: auto
- decision: enabled
- triggerIds: FD-T2 (append-only, late-arriving review records change whether a human decision
  still applies), FD-T1 (the human adjudication actor and the review actor act independently on
  shared state), FD-T4 in the weak sense that a human decision is a form of ownership over a
  disputed verdict.
- backends: `["tla"]`
- modelDirs: `["specs/tla/vwa-adjudication-durability"]`
- rationale for excluding Lean: no arithmetic bound or conservation (the cohort is a set, not a
  counter), and no permission composition. No obligation is downgraded; none exists.
- userDirective: session request "如果有必要，使用formal-design建模或修改存量模型".

## Requirement ↔ property ↔ model ↔ code mapping

| Req | Business outcome | Property | TLA operator | Case | Trace | Assumption | Code symbol | Exclusion |
|---|---|---|---|---|---|---|---|---|
| R-1 | a rejected disagreement stays resolved despite unrelated reviews | DurabilityReject | `DurabilityReject` | convention | reject h1, then append a judgment on h2 | A-1 | `activeAdjudications` over the origin-run cohort (`delivery-check.ts:67-92`) | the stage dimension is a constant here; the real key is `{inputHash, stage}` |
| R-2 | a genuinely new judgment on the same dispute re-asks the human | ExpiryOnFreshJudgment | `ExpiryOnFreshJudgment` | convention; probe `strict-content-digest` | reject, then a fresh judgment joins h1 | A-2 | cohort equality against `originRunIds` (design §6.2) | a dependency change that makes old records stale is out of scope |
| R-3 | cache reuse never expires a human decision | ExpiryOnFreshJudgment | `ReuseJudgment` action | convention | reject, then a cached copy lands under a new run id | A-3 | `originRunId` on records (design §6.2) | the actual cache-key match is covered by the existing review-cycle model |
| R-4 | the dispute id is stable across evaluations | IdStable | `IdStable` | convention; probe `strict-random-id` | re-evaluate the same dispute | A-4 | `resolveDisputes` deriving `disputeId` from `{inputHash, stage}` (design §6.1) | hash collisions are handled at runtime by a duplicate assertion, not modeled |
| R-5 | migration never leaves half-converted decisions | NoHalfConversion | `NoHalfConversion` | convention | migrate with decisions present | A-5 | `--migrate` moving decisions to `retired/` (design §6.3) | the retirement write itself is not modeled as a crash point |

## Assumptions

- **A-1** Records are append-only and immutable once written (`review-run-store.ts:185-193`).
- **A-2** A fresh judgment has its own run id as its origin; a reused judgment inherits the origin
  of the judgment it copies (`review-runner.ts:319-321`).
- **A-3** Cache reuse produces a new `runId` with the copied record's provenance, which is exactly
  why `runId`-keyed liveness would be wrong.
- **A-4** `inputHash` is the review task cache key (`review-runner.ts:404`), so equal `inputHash`
  and stage identify the same dispute.
- **A-5** Migration is a single transaction; a crash during it is not modeled (the store's
  transaction atomicity is modeled by `vwa-render-commit`).

## Bounds and abstractions

`MaxRuns = 3`, two dispute identities, two verdicts, two decision kinds. Not modeled: the actual
findings, severities and blocker counts (the force flag is their abstraction), the review cache
key composition, and marker persistence.

## Probes

Probe cases live in `specs/tla/vwa-adjudication-durability-probes`: `strict-content-digest` and
`strict-random-id`, one per defect mode the r1/r2 reviews identified. The core `convention` case
must be `verified`.

## Exclusions

- Delivery-blocker arithmetic (how many majors remain) — covered by the design's eligibility list,
  not by a state machine.
- The review pipeline's own budget/admission semantics — `specs/tla/vwa-review-cycle`.
