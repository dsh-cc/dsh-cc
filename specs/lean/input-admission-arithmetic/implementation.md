# Implementation record: input-admission-arithmetic

## Status

**Proof-only.** Proof verdict `verified` (runId
`7fe3e862-70ee-4edb-9928-c81f42377426`); conformance `not-run` by design —
docs 1+7 are not implemented, so there is no production symbol to bind.
Implementation acceptance is **pending** and must not be claimed.

## Proof results

| property | theorem | verdict |
|---|---|---|
| protected-never-charged | `Formal.protected_never_charged` | verified |
| admission-preserves-bound | `Formal.admission_preserves_bound` | verified |
| oversize-never-fits | `Formal.oversize_never_fits` | verified |
| window-boundary-admits | `Formal.window_boundary_admits` | verified |
| window-below-suppresses | `Formal.window_below_suppresses` | verified |

Evidence: `lean-check-evidence --stage proof` → integrity valid, fresh true,
proofVerdict verified, inputDigest `aad7ac6bfc47e6fe8912af7f95859fdc5db31a49ebc9cef8538582693be34dcf`.

Toolchain: `leanprover/lean4:v4.35.0` darwin-arm64, contentDigest
`a679a8da92410e33f4e32369da43d2f4552ac1fc8fb434aec9c4ee942d482624`.
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

## Pending work (blocks implementation acceptance, not the proof)

1. When `@dsh-cc/input-budget` lands: add `conformance/adapter.mjs` +
   `conformance/cases.jsonl` binding its real trim/dedupe functions, then run
   `lean-check-conformance` and `lean-check-evidence --stage acceptance`.
2. Corpus cases to author are enumerated in design.md §Corpus, including the
   four known-bad mutants (one per property family).
3. A test must pin A4 (the real implementation skips protected classes rather
   than charging-then-ignoring them).
