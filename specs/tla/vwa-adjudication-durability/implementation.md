# Implementation: vwa-adjudication-durability

Model: `specs/tla/vwa-adjudication-durability` (module `Model`). Design: `design.md` here.
Behavioral source: `docs/plans/2026-11-15-vwa-autonomous-render-pipeline.md` §6.1, §6.2, §6.3, §10.2.

## Status

Core case `convention` — **verified**. Probe cases live in the sibling
`specs/tla/vwa-adjudication-durability-probes`.

## What the model pins

The delivery "force" flag is an **observation**, not stored state. The model compares what the
implementation would compute (`forceComputed`: a reject is live when its recorded cohort still equals
the current cohort) against what the design requires (`forceRequired`: the same predicate, written
independently). Equality is the property `SemanticsPinned`.

Two probes break the equality in opposite directions:

- `strict-content-digest` (pinned to record content rather than the origin-run cohort): after a fresh
  judgment joins the dispute the decision still suppresses the force, so the human is never asked
  again — the implementation is too sticky.
- `strict-random-id` (a new dispute id minted on every evaluation): a re-evaluation loses the match,
  so the force returns although nothing about the dispute changed — the implementation is too
  forgetful. This is the current `review-current.ts:66-73` behaviour.

## Run lineage

| Step | What changed | Result |
|---|---|---|
| R1 | initial draft with `force` and `faults` as variables updated by an explicit `Recompute` action | `convention` counterexample: the flag lagged the record changes, so the invariant fired between an adjudication and the next recompute |
| R2 | `force` made a derived operator, `faults` dropped, `Evaluate` added to model a re-evaluation that mints an id | `convention` counterexample — `TypeOK` failed because `mintSeq` was unbounded |
| R3 | `mintSeq` bounded (`0..MaxRuns+2`) and guarded on the incrementing actions | `convention` verified; both probes counterexample |
| R4 | decision records gained a unique `tag` so `retired` membership is not confused by value-equal records (a `Retire` followed by a new identical-valued adjudication was being treated as retired) | `convention` verified; both probes counterexample |
| R5 | probes split into the sibling model | `convention` verified |

The R1/R2/R4 failures were **modeling** defects (stale derived state, an unbounded counter, value
equality standing in for identity), not design defects; each was repaired in the spec, not by
weakening a property.

## Semantics pinned to code (implementation handoff)

| Model element | Code symbol |
|---|---|
| immutable append-only records | `writeRecord` (`review-run-store.ts:185-193`) |
| `originRunId` (new field) | cache reuse saves a copied judgment under a fresh run id (`review-runner.ts:319-321`) — the origin must be carried explicitly |
| cohort equality | `activeAdjudications` (`delivery-check.ts:67-92`), to be re-expressed over `resolveDisputes` |
| `disputeId` derivation | `dispute.ts` per §6.1 (`{inputHash, stage}`) |
| `Retire` | `--migrate` moving records and adjudications to `retired/` (§6.3) |
| `NoHalfConversion` | no decision live and retired at once |

## Unmodeled scope

Findings, severities and blocker counts (the force flag abstracts them); the cache-key composition
(`specs/tla/vwa-review-cycle`); marker persistence; crash atomicity of the migration transaction
(`specs/tla/vwa-render-commit`).
