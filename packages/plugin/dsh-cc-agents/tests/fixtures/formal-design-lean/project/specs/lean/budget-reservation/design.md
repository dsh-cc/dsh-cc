# Budget reservation (Lean fixture)

Bounded conformance fixture for the Lean verification contract tests. The
implementation binding `packages/example/src/budget.ts` is a fixture module, not
a production module; proof preflight records declared bindings as planned and
never requires them (design sections 5 and 9), while conformance requires them
〔src:ws:packages/plugin/dsh-cc-agents/tests/fixtures/formal-design-lean/project/packages/example/src/budget.ts〕.

Requirement REQ-1: a successful reservation preserves `reserved <= budget`
〔src:ws:packages/plugin/dsh-cc-agents/tests/fixtures/formal-design-lean/project/specs/lean/budget-reservation/checks.json〕.
Requirement REQ-2: a zero request succeeds for a valid state and returns the
current reservation
〔src:ws:packages/plugin/dsh-cc-agents/tests/fixtures/formal-design-lean/project/specs/lean/budget-reservation/checks.json〕.

## Model semantics

`Formal.reserve budget reserved amount` rejects with `invalid-state` when the
prior state is already invalid (`reserved > budget`), rejects with
`insufficient-budget` when `amount > budget - reserved`, and otherwise returns
`reserved + amount` as `Nat` so the guard is checked before any saturating
subtraction
〔src:ws:packages/plugin/dsh-cc-agents/tests/fixtures/formal-design-lean/project/specs/lean/budget-reservation/Model.lean〕.

## Coverage table

| Requirement | Property | Theorem | Assumptions | Witness | Implementation symbol | Codec | Corpus cases | Negative control | Excluded scope |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| REQ-1 | `budget-bound` | `Formal.reserve_preserves_bound` | `r <= b`, `a <= b - r` | `Formal.admissible_example` | `reserve` | canonical decimal strings, `BigInt` | `boundary-exhaustion`, `above-safe-integer`, `excess-by-one`, `invalid-prior-state` | `boundary-exhaustion` | JS numbers, floats, non-reservation code |
| REQ-2 | `zero-request` | `Formal.reserve_zero` | `r <= b` | `Formal.admissible_example` | `reserve` | canonical decimal strings, `BigInt` | `zero-request` | `zero-request` | negative requests, floats |

Theorem statements and their per-property reports are declared in
`checks.json` and proved in `Properties.lean`
〔src:ws:packages/plugin/dsh-cc-agents/tests/fixtures/formal-design-lean/project/specs/lean/budget-reservation/Properties.lean〕.

## Reference boundary

`Formal.reference` decodes `{ budget, reserved, amount }` as canonical decimal
strings matching `^(0|[1-9][0-9]*)$`, calls the same `Model.lean` function the
properties name, and returns `{"ok": <decimal string>}` or
`{"error": {"code": ...}}` with `invalid-amount`, `invalid-state`, or
`insufficient-budget`
〔src:ws:packages/plugin/dsh-cc-agents/tests/fixtures/formal-design-lean/project/specs/lean/budget-reservation/Reference.lean〕.

## Corpus provenance

Hand-written boundary corpus, algorithm "boundary-enumeration", version 1, no
seed; bounds are the `maxCases` limit of `checks.json`. Cases cover exact
exhaustion, excess by one, zero, an invalid prior state, a malformed amount, a
negative amount, a malformed shape, and values above JavaScript's safe-integer
range as canonical decimal strings (design section 15)
〔src:ws:packages/plugin/dsh-cc-agents/tests/fixtures/formal-design-lean/project/specs/lean/budget-reservation/conformance/cases.jsonl〕.
The adapter binds the implementation through Node ESM resolution relative to its
own module and prints protocol-only stdout
〔src:ws:packages/plugin/dsh-cc-agents/tests/fixtures/formal-design-lean/project/specs/lean/budget-reservation/conformance/adapter.mjs〕.

The known-bad mutant omits the `reserved > budget` admission guard, so the
`invalid-prior-state` case must be rejected by conformance
〔src:ws:packages/plugin/dsh-cc-agents/tests/fixtures/formal-design-lean/mutants/budget-omits-guard.ts〕.
