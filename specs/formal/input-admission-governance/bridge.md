# Bridge: input-admission-governance (both backends)

Selection for docs 1+7 is `both`: the TLA model checks bounded operational
ordering (backlog re-offer, drop-vs-defer, commit-on-admission state advance),
the Lean model checks the arithmetic predicates those operators use. Neither
establishes the other.

## Shared contract

| operation | TLA operator | Lean function | shared rule |
|---|---|---|---|
| advisory-budget-admission | `Gate` (per-message class check) | `Formal.fits` | admit iff `bytes <= budget - used` |
| oversize-drop | `WalkFresh` / `WalkBacklog` oversize arm | `Formal.oversize` | `budget < bytes` is never admittable, and is dropped rather than deferred |
| dedupe-window-boundary | `DedupeEligible` | `Formal.withinWindow` | suppress iff `now - lastAdmitted < window` (strict); equality admits |

`cases.json` records the same seven instances on both sides. These are
model-to-model conformance examples: **no implementation is bound**
(`implementationFiles` is empty in every bridge row) because docs 1+7 are not
implemented yet, and the Lean manifest therefore has no conformance block.

## What is NOT bridged

- The enter budget / `hardOver` rule (design A5, Lean coverage table gap).
- Observe-mode simulated state (A7).
- Accumulation across a batch (TLA-only property).

## Evidence state: combined acceptance is PENDING

`check-combined-evidence` requires all three packages to carry version-2 bridge
evidence and the Lean conformance verdict to be `passed`. Both docs 1+7 are
unimplemented, the Lean manifest is proof-only, and conformance is therefore
`not-run` — so **no combined-evidence package can be produced today** (the
checker rejects it with `lean-not-accepted` / `missing-file`). What exists is
the bridge contract plus two independent per-backend evidence packages.

This is the honest state, not a defect to paper over: the bridge records which
operations share a contract, and the conformance leg activates when
`@dsh-cc/input-budget` lands. Until then, the per-backend verdicts stand alone
and no "both backends verified" claim may be made.

## Reporting discipline

The two backends are never reported as one combined proof. Per-model verdicts
stand alone: TLA convention `verified` with probe cases red on their designed
invariants; Lean proof `verified` with conformance `not-run`.
