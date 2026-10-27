# Lean modeling and proof guide

Read [modeling-guide.md](modeling-guide.md) first for the shared screening,
coverage and change rules. This guide adds the Lean-specific parts. Read
[lean-conformance.md](lean-conformance.md) before writing an adapter and
[combined-models.md](combined-models.md) when both backends apply.

## When Lean is selected

Lean proves named algebraic properties over explicit, possibly unbounded
domains. It does not prove the repository's TypeScript implementation correct;
implementation evidence comes from the conformance corpus. Select Lean for
these triggers, added to FD-T1 through FD-T4:

- FD-L1: permission, policy, eligibility or configuration composition with a
  stated invariant whose violation changes authorization or effective behavior.
- FD-L2: budget, quota, allocation, accounting or ranking arithmetic with a
  stated conservation, bound, monotonicity or ordering requirement.
- FD-L3: a deterministic transformation or algorithm with a requested general
  correctness property, or a previously verified Lean contract that changes.
- FD-L4: an explicit user request for Lean verification.

Mere determinism does not trigger Lean. A trigger record must name the business
property and the consequence of violating it. Record `backends` (ordered subset
of `["tla", "lean"]`) and `modelDirs` (exactly the selected backend keys) next
to the existing Formal design fields. Keep `modelDir` for TLA-only records; new
TLA-only records also write it, other selections omit it. Passing one backend
never substitutes for a missing or failing obligation in the other.

| Behavior under review | Selection | Required work |
| --- | --- | --- |
| Event ordering, cancellation, retries, ownership, recovery | `tla` | Existing bounded TLC workflow |
| High-impact deterministic rules or algorithms | `lean` | Proof workflow, then implementation conformance |
| Both kinds of behavior | `both` | Both workflows plus shared operation contracts |
| Formatting, layout, ordinary low-risk glue | `none` | Normal project workflow |

These are engineering selection rules, not language expressiveness limits.

## Model files and input boundary

A model lives at `specs/lean/<model-id>/` with exactly `design.md`,
`checks.json`, `Model.lean`, `Properties.lean`, `Reference.lean`,
`conformance/adapter.mjs`, `conformance/cases.jsonl`, `implementation.md` and
the generated current evidence/pointers. `Model.lean` may import bundled Lean
libraries only. `Properties.lean` and `Reference.lean` import `Model`.
`Reference.lean` must call the same `Model.lean` functions named in the
properties; it may not reimplement the algorithm. The shipped `Inspector.lean`
and `Driver.lean` are trusted runner inputs and are never replaced by project
files. Do not add extra Lean modules, a Lake configuration, local `.olean`
files or dependency packages.

Keep the model boundary honest: `Model.lean` must not import `Reference` or
branch on JSON merely to match corpus cases. Separate observed legacy behavior
from intended behavior and raise ambiguous business semantics before proving
them.

## Property statements

`checks.json` is a strict schema separate from the TLC manifest:

```json
{"schemaVersion":1,"backend":"lean","modelId":"budget-reservation","properties":[{"id":"budget-bound","requirementId":"REQ-1","declaration":"Formal.reserve_preserves_bound","statement":"forall b r a : Nat, r <= b -> a <= b - r -> r + a <= b","witnessDeclaration":"Formal.admissible_example"}],"conformance":{"adapter":"conformance/adapter.mjs","corpus":"conformance/cases.jsonl","implementationFiles":["packages/example/src/budget.ts"],"executionFiles":["package.json","pnpm-lock.yaml","tsconfig.base.json"],"command":["node","conformance/adapter.mjs"],"comparison":"canonical-json"},"limits":{"proofTimeoutMs":120000,"conformanceTimeoutMs":120000,"maxHeartbeats":2000000,"maxRecDepth":2048,"maxCases":10000}}
```

- `statement` is a Lean proposition expression, elaborated as a closed term of
  type `Prop` in the `Properties` environment. Every identifier outside the Lean
  prelude must be fully qualified; it must not be a command, declaration or
  source fragment. The inspector requires definitional equality between the
  elaborated statement and the declared theorem's type.
- `witnessDeclaration` is required whenever the statement matrix contains a
  top-level implication arrow (`->` or `→`), including behind a leading
  `forall`/`∀` telescope; a null witness on such a form is `config-invalid` at
  preflight. The witness must be a theorem proving an explicit nonempty instance
  of the precondition domain. The machine only checks existence, theorem kind
  and stored proof; a reviewer inspects quantification, branches and assumptions.
  Conditionality hidden behind a definition, and whether a witness actually
  addresses the preconditions, remain review findings. Do not certify that a
  witness mechanically eliminates all vacuity.
- Declarations are dot-separated ASCII Lean identifiers, each segment matching
  `[A-Za-z_][A-Za-z0-9_]*`; quoted names are unsupported. Property IDs use the
  existing ID grammar; requirement IDs match `REQ-[1-9][0-9]*`.
- Prefer one property per business requirement. A passing weaker theorem is not
  evidence for the requirement it does not state.

Never delete a property, strengthen an assumption or widen a domain merely to
make a proof pass. Failed proof search is pending work. Allowed axioms are fixed
at `propext`, `Classical.choice` and `Quot.sound`; direct or indirect `sorry`,
`admit`, custom axioms and computation axioms outside that list are rejected.
The initial claim assumes honest elaboration and the pinned trusted toolchain,
not resistance to adversarial Lean code.

## Coverage table

Record these rows in `design.md`: requirement ID, property ID, theorem,
assumptions, witness, implementation symbol, codec, corpus cases, negative
control and excluded scope. Mark planned implementation symbols explicitly as
planned; proof checks do not require the implementation or conformance inputs
to exist yet. A complete table is necessary, not sufficient.

## Corpus authoring

Corpus generation is an explicit authoring step, never hidden check behavior.
Commit the generated corpus bytes and its provenance (algorithm, version, seed,
bounds) in `design.md`. The corpus is UTF-8 JSON Lines without blank lines; each
line has exactly `id`, `input` and `covers`, where `covers` is a nonempty unique
list of declared property IDs. Every declared property needs at least one case;
that syntactic condition is not a coverage sufficiency claim.

Require boundary cases, invalid inputs, relevant branch combinations and a
known-bad implementation mutant. Enumerate all cases where a small finite domain
makes that practical. For larger domains, state the sampling limits explicitly
in review. Use canonical decimal strings for numbers outside the safe-integer
range and let the reviewed codec decide missing versus null, error behavior,
overflow, rounding and collection ordering.

A mutation test must show that at least one relevant wrong implementation is
rejected. It cannot establish complete fault detection. A reference wrapper that
throws, exits nonzero, prints precomputed results or contains a second copy of
the algorithm fails review.

## Proof checks and review

Run the proof checks before the implementation exists; conformance stays
`not-run` and implementation acceptance stays pending. Use the commands and
exit semantics in [lean-conformance.md](lean-conformance.md) and the skill
entry. A proof-stage audit exit 0 means valid and fresh evidence, not a verified
verdict: read `proofVerdict` itself. Then submit the full same-run proof package
to the existing review lanes, including exact inputs, Lean statements, inspector
results, both streams for every phase, tool identities, corpus, planned source
bindings and outstanding conformance.

`acceptanceReady` requires valid and fresh proof and conformance evidence, proof
`verified`, conformance `passed` and matching run, digest and tool identities.
Human approval and coverage sufficiency remain separate; a runner never converts
this boolean into project review approval.
