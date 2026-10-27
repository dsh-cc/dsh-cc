# budget-reservation — Lean worked example

Committed worked example from the formal-design skill contract (design section
15). `Nat` state and request values; canonical decimal strings at the JSON
boundary so Lean and the JavaScript `BigInt` implementation agree 〔src:ws:specs/lean/budget-reservation-code-anchors.md#L163-L192〕.

The example binds a real committed fixture implementation at
`packages/plugin/dsh-cc-agents/tests/fixtures/formal-design-lean/project/packages/example/src/budget.ts`
(erasable TypeScript only, imported directly by Node `^22.19 || >=24`) 〔src:ws:specs/lean/budget-reservation-code-anchors.md#L163-L192〕. The
adapter resolves it by Node ESM resolution relative to its own module location
〔src:ws:specs/lean/budget-reservation-code-anchors.md#L111-L149〕. It is the same
module the real-tool conformance tests copy into their temporary fixture
projects, so there is exactly one copy of the algorithm.

## Requirements

- **REQ-1** A successful reservation keeps the returned reservation within the
  budget.
- **REQ-2** A successful reservation adds exactly the requested amount to the
  prior reservation.
- **REQ-3** A rejected reservation preserves the caller's prior state under the
  documented API contract.
- **REQ-4** A zero request succeeds for a valid state and returns the same
  reservation.

## Model semantics

`Formal.reserve budget reserved amount` rejects with `invalid-state` when the
prior state is already invalid (`reserved > budget`), rejects with
`insufficient-budget` when `amount > budget - reserved`, and otherwise returns
`reserved + amount` as `Nat`; the guard is checked before any `Nat` subtraction,
and every property states `reserved <= budget` explicitly to avoid
saturating-subtraction mistakes
〔src:ws:specs/lean/budget-reservation-code-anchors.md#L9-L29〕. `Formal.reserveState` is the
documented API contract as a state step: it keeps `reserved` unchanged on every
error and adopts the new amount on success.

## Coverage table

| Requirement | Property | Theorem | Assumptions | Witness | Implementation symbol | Codec | Corpus cases | Negative control | Excluded scope |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| REQ-1 | `budget-bound` | `Formal.reserve_preserves_bound` | `r <= b`, `a <= b - r` | `Formal.admissible_example` | `reserve` | canonical decimal strings, `BigInt` | `boundary-exhaustion`, `above-safe-integer`, 180 `enum-*`, 26 successful `seeded-*` | `excess-by-one` | JS numbers, floats, non-reservation code |
| REQ-2 | `adds-amount` | `Formal.reserve_adds_amount` | `Formal.reserve b r a = .ok v` | `Formal.admissible_example` | `reserve` | canonical decimal strings, `BigInt` | `boundary-exhaustion`, `above-safe-integer`, 180 `enum-*`, 26 successful `seeded-*` | `excess-by-one` | JS numbers, floats, non-reservation code |
| REQ-3 | `rejection-preserves-state` | `Formal.reserve_rejection_preserves_state` | `Formal.reserve b r a = .error code` | `Formal.rejection_example` | `reserveState` (over `reserve`) | canonical decimal strings, `BigInt` | `invalid-prior-state`, `excess-by-one`, `malformed-amount`, `negative-amount`, `malformed-shape`, 14 rejected `seeded-*` | `invalid-prior-state` | thrown exceptions, transport failures |
| REQ-4 | `zero-request` | `Formal.reserve_zero` | `r <= b` | `Formal.admissible_example` | `reserve` | canonical decimal strings, `BigInt` | `zero-request`, 15 successful `enum-*` with `amount = 0` | `zero-request` | negative requests, floats |

Theorem statements and their per-property reports are declared in `checks.json`
and proved in `Properties.lean`
〔src:ws:specs/lean/budget-reservation-code-anchors.md#L30-L68〕.

## Reference boundary

`Formal.reference` decodes `{ budget, reserved, amount }` as canonical decimal
strings matching `^(0|[1-9][0-9]*)$`, calls the same `Model.lean` function the
properties name, and returns `{"ok": <decimal string>}` or
`{"error": {"code": ...}}` with `invalid-amount`, `invalid-state`, or
`insufficient-budget`
〔src:ws:specs/lean/budget-reservation-code-anchors.md#L69-L110〕. The production
implementation converts strings to `BigInt` under the same grammar and never
silently coerces JSON numbers.

## Corpus provenance

Corpus generation is an explicit authoring step (design section 7). Algorithm
`boundary-enumeration+mulberry32`, version 1, seed `20261026`, bounds: the named
boundary cases required by design section 15, the exhaustive small finite domain
`budget 0..4 × reserved 0..5 × amount 0..5` (180 cases), and 40 seeded larger
values above `2^53 - 1` as canonical decimal strings. Total 228 cases, capped by
`maxCases = 10000` in `checks.json`. Every declared property is covered by at
least one case; `covers` annotations classify each case by outcome
〔src:ws:specs/lean/budget-reservation-code-anchors.md#L150-L162〕.

The known-bad mutant (omits the `reserved > budget` admission guard) is **not**
committed with this model: it stays in the test fixture tree
(`tests/fixtures/formal-design-lean/mutants/budget-omits-guard.ts`) and is
demonstrated by the real-tool conformance suite, which fails it on the
`invalid-prior-state` case. That mutant cannot establish complete fault
detection; it only shows one relevant wrong implementation is rejected.

## Assurance boundary

Lean checked the listed propositions under the recorded definitions,
assumptions, and allowed axioms. The implementation matched the reference on the
recorded corpus. This does not prove arbitrary TypeScript code equivalent to the model 〔src:ws:specs/lean/budget-reservation-code-anchors.md#L163-L192〕.

Excluded scope: JavaScript numbers, floats, public API transport, persistence 〔src:ws:specs/lean/budget-reservation-code-anchors.md#L163-L192〕,
concurrent reservations, and any budget code outside the bound fixture module.
