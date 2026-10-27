# Combined TLA+ and Lean models

Use this guide when screening selects `both`: the two backends check different
obligations over one operation, and a bridge records and tests their shared
contract. Read [modeling-guide.md](modeling-guide.md),
[lean-modeling-guide.md](lean-modeling-guide.md) and
[lean-conformance.md](lean-conformance.md) first.

## What each backend proves

- Lean: algebraic properties over the recorded domains, such as a guarded
  reservation preserving `reserved <= budget` or a rejection preserving the
  prior balance.
- TLA+: bounded operational properties, such as atomic admission and balance
  updates, no stale-balance admission by concurrent callers, and no duplicate
  release.
- The bridge: both sides use the same admission guard, numeric units, rejection
  behavior and state update, exercised by bounded shared examples.

Arithmetic proofs do not establish atomicity; TLC's bounded arithmetic examples
do not establish the general Lean theorem. Shared examples are conformance
evidence, not a composition theorem. Never report `both` as one combined proof.

## Bridge files

For selection `both`, add `specs/formal/<feature-id>/bridge.json` and
`bridge.md`. The strict bridge schema has exactly `schemaVersion` (1),
`featureId`, `tlaModel` (a `specs/tla/<id>` path), `leanModel` (a
`specs/lean/<id>` path) and `operations` (1..64 unique rows):

```json
{"schemaVersion":1,"featureId":"budget-reservation","tlaModel":"specs/tla/budget-reservation","leanModel":"specs/lean/budget-reservation","operations":[{"id":"boundary-exhaustion","requirementId":"REQ-1","tlaOperator":"Reserve","leanFunction":"Formal.reserve","propertyIds":["budget-bound"],"domain":"canonical decimal strings for budget, reserved and amount","casesFile":"specs/formal/budget-reservation/cases.json","implementationFiles":["packages/example/src/budget.ts"]}]}
```

Each row contains exactly those fields. `featureId` uses the model-id grammar and
operation IDs use the corpus case ID grammar. `propertyIds` must exist in the
selected Lean manifest, and `implementationFiles` must be a subset of that
manifest's implementation closure. Names use their backend identifier grammars;
`domain` is a nonempty explanation and `casesFile` is a regular,
repository-root-relative JSON file path.

Each cases file is an array of rows with exactly `id`, `input`, `expected` and
`tlaExpression`. `id` must equal the ID of a committed Lean corpus case; IDs use
the corpus grammar, which excludes underscores, so the join key is ID equality.
The bridge row's `propertyIds` must equal that corpus case's `covers` set, and
`input` must be canonically equal to the corpus case's `input`. `expected` is the
section-7 conformance result — exactly an `{"ok": ...}` or
`{"error": {"code": ...}}` object — and both the Lean reference and the
implementation must return it. `tlaExpression` is TLA+ source, authored and
reviewed, never shell text.

Record the exact JSON-to-TLA+ encoding in `bridge.md`. All bridge artifacts and
cases must be listed in both models' design documents with SHA-256 hashes; a
changed bridge requires updating both design inputs and rerunning both
workflows.

## Derived invariants

For each bridge row, the main dialog adds a derived TLA+ invariant named
`Bridge_<id>` with every hyphen in `id` replaced by an underscore (injective,
because the corpus grammar excludes underscores), asserting that the
corresponding operator expression equals the TLA+ encoding of `expected`, and
includes it in a declared TLC case. The invariant is checked, not assumed: the
combined auditor requires each derived invariant name to occur in the digested
cfg bytes of a case whose recorded verdict is `verified`, matched as a complete
cfg identifier token (whitespace or line boundaries), never as a substring —
`Bridge_a` must not satisfy the check when only `Bridge_a_b` is present. Human
review confirms the expression really is the specified bridge assertion.

## Producer and auditor commands

Both-mode commands require the same `--bridge` argument, a unique
repository-root-relative `specs/formal/<id>/bridge.json` path. The flag is also
accepted by preflight and auditors and is forbidden with a nonmatching model.

```sh
node "${CLAUDE_SKILL_DIR}/scripts/preflight.mjs" --project "$PROJECT" --model specs/tla/<id> --bridge specs/formal/<id>/bridge.json
node "${CLAUDE_SKILL_DIR}/scripts/check.mjs" --project "$PROJECT" --model specs/tla/<id> --bridge specs/formal/<id>/bridge.json
node "${CLAUDE_SKILL_DIR}/scripts/lean-check.mjs" --project "$PROJECT" --model specs/lean/<id> --lean-root "$LEAN_ROOT" --bridge specs/formal/<id>/bridge.json
node "${CLAUDE_SKILL_DIR}/scripts/lean-check-conformance.mjs" --project "$PROJECT" --model specs/lean/<id> --lean-root "$LEAN_ROOT" --bridge specs/formal/<id>/bridge.json
node "${CLAUDE_SKILL_DIR}/scripts/check-combined-evidence.mjs" --project "$PROJECT" --bridge specs/formal/<id>/bridge.json
```

`check-combined-evidence.mjs` is a read-only auditor. It validates the strict
schema and case files, invokes both read-only backend auditors, verifies pinned
bridge hashes from both evidence packages, and checks every bridge invariant and
corpus case is represented in successful current evidence (TLC `status:
verified`; Lean `proofVerdict: verified` and `conformanceVerdict: passed`). It
writes exactly one JSON result object and exits 0 only when combined acceptance
is valid; otherwise 2. Evidence must include the complete ordered per-case
ID/result list in a hashed comparison report; aggregate counts alone cannot
establish bridge coverage.

Version-two evidence for both backends adds exactly one field, `bridgeFiles`: an
array of `{ "path", "sha256" }` entries for `bridge.json`, `bridge.md` and every
declared `casesFile`, included in each backend's input enumeration before
hashing. Without `--bridge` both producers keep their version-one shape and
behavior. The auditor rejects mixed bridge versions or successful records
missing a bridge row. Derive `bridgeFiles` by enumerating the actual files with
regular-file and size checks; each case file is at most 1 MiB and the bridge
package at most 10 MiB. Never extract hashes from Markdown. Both mode cannot
enter combined acceptance on unrelated successful runs with stale bridge
bindings.
