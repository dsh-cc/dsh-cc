# Implementation record: input-admission-arithmetic

## Status

**Acceptance-ready via a model-local fixture, not production code.** Proof
verdict `verified` (6 properties) and conformance `passed` (55/55 cases) against
`packages/plugin/dsh-cc-agents/tests/fixtures/formal-design-lean/input-governance/admission-arithmetic.ts`.

The fixture mirrors `Model.lean`; it is not an independent oracle, so the honest
claim is "the Lean propositions hold, and the committed corpus pins the
arithmetic semantics a future implementation must match" — **not** "the
implementation was validated", because no implementation exists. When
`@dsh-cc/input-budget` lands, the adapter must be re-pointed at it and the
fixture removed.

CI note: a proof-only manifest is rejected by this repo's `formal-design-lean`
job (`the manifest declares no conformance contract`), so the earlier
"conformance not-run by design" classification was not a shippable state.

## Proof results

| property | theorem | verdict |
|---|---|---|
| protected-never-charged | `Formal.protected_never_charged` | verified |
| admission-preserves-bound | `Formal.admission_preserves_bound` | verified |
| oversize-never-fits | `Formal.oversize_never_fits` | verified |
| window-boundary-admits | `Formal.window_boundary_admits` | verified |
| window-below-suppresses | `Formal.window_below_suppresses` | verified |

Evidence (machine receipts from the recorded run, kept verbatim):

```
lean-check-evidence --stage proof
  integrity: valid, fresh: true, proofVerdict: verified
  inputDigest: aad7ac6bfc47e6fe8912af7f95859fdc5db31a49ebc9cef8538582
  toolchain: leanprover/lean4:v4.35.0 darwin-arm64
  contentDigest: a679a8da92410e33f4e32369da43d2f4552ac1fc8fb434aec9c4ee942d482624
```
Note: the local elan install at `~/.elan/toolchains/leanprover--lean4---v4.35.0`
is byte-identical to that digest, but the runner requires the
`lean-provision` receipt, so the provisioned root `~/formal-design-lean` is
what the evidence records.

## Authoring history (config-level, no evidence value)

- First `lean-check` attempt: `oversize-never-fits` and
  `window-below-suppresses` are top-level implications and require a
  `witnessDeclaration` — added `Formal.oversize_witness` (shared
  non-emptiness witness for the oversize domain).
- First `lean-preflight` attempt blocked on a missing `design.md` / `checks.json`
  (the runner validates inputs before elaborating).

## Pending work

1. When `@dsh-cc/input-budget` lands: re-point `conformance/adapter.mjs` at its
   real trim/dedupe functions and delete the fixture.
2. Wire the four known-bad mutants (one per property family) into the corpus;
   they are declared in design.md §Corpus but not yet executed.
3. A test must pin A4 (the real implementation skips protected classes rather
   than charging-then-ignoring them).

## Implementation acceptance (2026-11-14, stacked PR over #409) 〔src:ws:docs/plans/2026-11-12-per-step-input-budget-governor.md#L11-L19〕

The `@dsh-cc/input-budget` package landed (`packages/context/input-budget`).
The conformance adapter is RE-POINTED at the real implementation and the
model-local fixture is deleted:

- `conformance/adapter.mjs` now imports `charged` / `fits` / `oversize` from
  `packages/context/input-budget/src/core.ts` (Node type-stripping; the core's
  own `@dsh-cc/input-ledger` bare import resolves to that package's built
  `lib/`, so the formal-design-lean CI job gained a
  `tsc -b packages/context/input-budget --force` step after install).
- `checks.json` `conformance.implementationFiles` re-pointed to
  `packages/context/input-budget/src/{core,classes}.ts` and
  `packages/observability/input-ledger/src/rows.ts`.
- `withinWindow` stays adapter-local with an explicit doc-7-ownership comment:
  the admission-window predicate belongs to the injection-dedupe package (doc 7),
  which has not landed; it is not part of the budget arithmetic this model
  binds. Pending-work item 1 is therefore closed except for that predicate.
- A4 (protected classes are skipped, not charged-then-ignored) is pinned by
  `packages/context/input-budget/tests/core-invariants.spec.ts`
  ("charges no budget to protected classes") — pending-work item 3 closed.

Post-re-point local evidence chain (this tree, with the `checks.json` re-point folded into the digest): lean-check verified 〔src:ws:specs/lean/input-admission-arithmetic/design.md#L51-L61〕
(6/6 properties, inputDigest d86197e5be7f…, bridge run) 〔src:ws:specs/lean/input-admission-arithmetic/design.md#L51-L51〕; `lean-check-conformance`
re-executed against the real core: 55/55 matched 〔src:ws:specs/lean/input-admission-arithmetic/design.md#L61-L61〕;
`lean-check-evidence --stage acceptance --bridge` valid, `acceptanceReady: true`;
`check-combined-evidence` valid, `acceptanceReady: true`.
