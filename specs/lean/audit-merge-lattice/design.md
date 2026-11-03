# Design: audit-merge-lattice (SystemOne S1-08, Lean face)

Model directory: `specs/lean/audit-merge-lattice`.

## Formal design screening

- mode: **auto** (session-adopted; the project rules carry no formal-design
  screening clause at this revision — user request 2026-11-02, full-program
  scope confirmed via ask_user_question; adoption snippet at
  `<skill>/references/agents-snippet.md`).
- decision: **enabled**
- triggerIds: FD-L3 (a deterministic merge transformation — the per-rule
  worst-verdict merge of the VWA audit alignment — with a requested general
  correctness property: chunk regrouping and completion order must never
  change a rule's merged verdict, and a fail must never be erasable).
- backends: this is the lean face of the S1-08 work; the split/recovery
  interleaving face is the M6 TLA+ model. modelDirs: `{"lean":
  "specs/lean/audit-merge-lattice"}` (the tla face is recorded in its own
  screening section).
- behavioral source: `docs/plans/2026-11-02-systemone-08-vwa-audit-split.md`
  ("targets merged PER (targetId, ruleId) keeping the WORST verdict … ties
  keep the first chunk's entry") and the existing production merge
  `packages/interaction/vwa-argument/src/audit-align.ts`
  (`mergeChunkTargets` with `VERDICT_SEVERITY` — the pure function this
  model mirrors; the legacy worst-wins logic is kept by the design).

## Business properties (plain English)

- **REQ-1 Never improves** — merging two verdicts never weakens either
  operand's severity: a `pass` or `not-run` arriving in a later chunk can
  never erase an earlier chunk's `fail` for the same rule (fail absorbing).
- **REQ-2 Bottom identity** — `not-run` is the neutral element: merging a
  rule nobody ran leaves the other verdict in place.
- **REQ-3 Regrouping invariance** — the merge is idempotent, associative
  and (at verdict-value level, since severities are injective) commutative,
  so the merged verdict of a (targetId, ruleId) pair is independent of how
  the chunks are batched, bisected or reordered. The first-chunk tie rule
  concerns which chunk's payload entry is kept, not the merged verdict
  value.
- **REQ-4 The merge is the maximum** — the merged verdict's severity is
  exactly the maximum severity over the whole chunk list: no chunk's
  severity is lost and no severity above the inputs can appear.

## Conformance

Not applicable yet (proof stage). The production pure function exists
(`mergeChunkTargets`'s comparison), but the S1-08 split design does not
yet wire its adapter; when it does, the adapter binds
`packages/interaction/vwa-argument/src/audit-align.ts` and the corpus pins
the verdict quadruple pairs and lists. corpus provenance: none yet — to be
recorded when the conformance stage runs.
