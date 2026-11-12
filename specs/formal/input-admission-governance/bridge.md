# Bridge: input-admission-governance (both backends)

Selection for docs 1+7 is `["tla", "lean"]` — the full backend set, so a
bridge records and tests the shared contract (combined-models guide). Neither
backend substitutes for the other: the TLA model checks bounded operational
ordering (backlog re-offer, drop-vs-defer, commit-on-admission state advance);
the Lean model proves the arithmetic predicates.

## Shared contract

Each bridge operation is one committed Lean corpus case: its `id` is the
corpus case id, its `propertyIds` equal that case's `covers` set, and
`cases.json` carries the same `input` canonically plus the `expected`
protocol result the Lean reference and the conformance adapter both produce.
On the TLA side the same instance is asserted by the derived invariant
`Bridge_<id>` (hyphens to underscores), declared in `Model.tla` from the
shared predicates `BridgeFits` / `BridgeOversize` / `BridgeWithinWindow` and
checked by the `convention` case.

| operation (corpus case) | TLA operator | Lean function | shared rule |
|---|---|---|---|
| admit-exact-advisory-0 / admit-over-advisory-1 | `WalkFresh` | `Formal.fits` | admit iff `bytes <= budget - used` |
| oversize-above-4 / oversize-at-4 | `WalkFresh` | `Formal.oversize` | `budget < bytes` is never admittable, dropped not deferred |
| window-3-below / -equal / -above | `ProvisionalDedupeEligible` | `Formal.withinWindow` | suppress iff `now - lastAdmitted < window` (strict); equality admits |
| protected-governance-4096 | `ClassOf` | `Formal.charged` | governance-class messages are never charged |

The `Bridge_<id>` invariants are constant by construction: bounded shared
examples are **conformance evidence, not a composition theorem** — they bind
both sides to the same instance arithmetic, they do not turn the two proofs
into one.

## Model split (why probes live next door)

The combined-evidence contract requires the bridged TLA model's aggregate to
be `verified` (every case green). The fault-injection negative controls
(the r1 defect probes) are deliberately red and therefore live in
`specs/tla/input-admission-governance-probes`, sharing the same `Model.tla`
via a byte-identical copy; its aggregate is expected to be `counterexample`.
Removing either half would either destroy the negative controls or make the
bridge unattainable.

## What is NOT bridged

- The enter budget / `hardOver` rule (design A5, Lean coverage table gap).
- Observe-mode simulated state (A7).
- Accumulation across a batch (TLA-only property).

## Reporting discipline

Never report the backends as one combined proof. Per-model verdicts stand
alone: the TLA model is `verified` with the probes model red by design; the
Lean face is `verified` with conformance `passed` against the model-local
fixture (production code does not exist yet). When `@dsh-cc/input-budget`
lands, the adapter must be re-pointed at it and the fixture removed.
