# Implementation record: audit-merge-lattice (Lean face)

Effective project rules at modeling time: the root AGENTS.md carries **no**
formal-design screening clause — screening is session-adopted (user request
2026-11-02; full-program scope confirmed via ask_user_question). Adoption
snippet: `<skill>/references/agents-snippet.md`. No formal review dispatched.

## Final proof run

- runId: `09a2c546-6d82-4092-9a1c-a15547f2d35f`
- toolchain: leanprover/lean4 v4.35.0 (darwin-arm64, archive SHA-256
  c0c6f34f...63177c2, provisioned at the system temp directory), runner
  `@dsh-cc/plugin-dsh-cc-agents` 0.9.3-rc.4.
- All seven properties **verified**: never-improves, fail-absorbing,
  bottom-identity, idempotent, associative, commutative,
  merge-is-max (the merged severity is exactly the maximum severity over
  the chunk list).
- `lean-check-evidence --stage proof`: valid and fresh. Conformance is
  **not-run** by design (proof stage): the S1-08 split design has not yet
  wired its adapter to the existing `mergeChunkTargets` production code;
  `acceptanceReady` is accordingly false (proof-only result, never
  implementation acceptance).

## Modeling notes

- The proofs enumerate the finite 4-element verdict lattice (fail >
  needs-review > pass > not-run), so `cases a <;> cases b <;> simp` is
  complete; the only structural lemma is `severity_worst` (merged
  severity = max), which also carries REQ-4.
- The merge-is-max property is stated with `foldr`, matching
  `mergeVerdicts`'s head-recursive structure; a `foldl` statement defeats
  the induction (no standard foldl-accumulator bridge lemma).
- The first-chunk tie rule in production (`>` comparison, keep previous)
  concerns which chunk's payload entry is kept, not the merged verdict
  value — severities are injective, so a tie is value equality and the
  value-level merge is a commutative semilattice.

## Not verified (explicitly out of scope)

- Implementation conformance: no adapter is created and no corpus exists,
  because S1-08 is not implemented (the production module
  `audit-merge.ts` does not exist yet). The conformance stage stays
  `not-run` and implementation acceptance stays pending; per the workflow a
  proof-only result is never implementation acceptance.
- The payload-level tie rule (which chunk's entry object survives) and
  the findings concatenation.
- The split/recovery/bisection interleaving — that is the M6 TLA+ face.
