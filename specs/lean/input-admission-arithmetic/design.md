# Design: input-admission-arithmetic (Lean face for docs 1+7)

- Program: context-engineering input governance
  (docs/plans/2026-11-12-per-step-input-budget-governor.md,
  docs/plans/2026-11-12-injection-dedupe-notice-governance.md)
- Model: `specs/lean/input-admission-arithmetic`
- Companion TLA model: `specs/tla/input-admission-governance` (ordering and
  cross-step state). Neither substitutes for the other.

## Formal design screening

Session-adopted (no formal-design screening clause in the project rules at
this revision; adoption snippet at `<skill>/references/agents-snippet.md`).
Lean triggers: **FD-L1** — class eligibility composition with a stated
invariant whose violation changes effective behavior (protected classes must
never be trimmed); **FD-L2** — budget/byte arithmetic with stated
conservation/bound/ordering requirements (class budgets, oversize drop rule,
dedupe window boundary).
Not "mere determinism": each property below names the business consequence of
violation.

## Requirements and properties

REQ-1. Protected classes (governance/task/passthrough) are never charged
against a trimmable budget.
  - Violation: a behavioral constraint or real user input becomes a trim
    candidate, i.e. it can silently disappear from the step's input.
  - Property `protected-never-charged`: `budgeted cls = false →
    charged cls bytes = 0`.

REQ-2. Admission respects the class budget.
  - Violation: the class budget stops bounding the prompt size.
  - Property `admission-preserves-bound`: `used ≤ budget ∧ fits budget used
    bytes → used + bytes ≤ budget`.

REQ-3. An oversize message is dropped at trim time, never enqueued
(`drop-oversize`).
  - Violation: a message that can never fit occupies the defer backlog
    forever, and the ledger reports a deferral that could never succeed.
  - Property `oversize-never-fits`: `oversize budget bytes → ¬ fits budget
    used bytes` (for any `used`).

REQ-4. The dedupe window is the strict comparison `delta < window`.
  - Violation: an off-by-one either suppresses a legitimately re-asserted
    notice or re-admits a duplicate one step early.
  - Properties `window-boundary-admits` (`delta = window` admits) and
    `window-below-suppresses` (`delta < window` suppresses).

## Coverage table

| REQ | property | theorem | assumptions | witness | implementation symbol | codec | corpus cases | negative control | excluded scope |
|---|---|---|---|---|---|---|---|---|---|
| REQ-1 | protected-never-charged | `Formal.protected_never_charged` | class registry closed (5 classes) | `Formal.protected_example` | planned: class map in `@dsh-cc/input-budget` `registry.ts` | n/a (proof-only) | `protected-governance`, `protected-passthrough` | mutant returns `bytes` for protected classes | charge semantics for future classes |
| REQ-2 | admission-preserves-bound | `Formal.admission_preserves_bound` | `used ≤ budget` precondition | `Formal.admissible_example` | planned: trim loop in `govern.ts` | n/a | `admit-fits`, `admit-exact-fit` | mutant uses `<` instead of `≤` | multi-message accumulation (TLA model) |
| REQ-3 | oversize-never-fits | `Formal.oversize_never_fits` | class budget > 0 | `Formal.oversize_witness` | planned: `drop-oversize` branch | n/a | `oversize-advisory`, `oversize-boundary` | mutant keeps oversize in the backlog | backlog TTL interaction (TLA model) |
| REQ-4 | window-boundary-admits | `Formal.window_boundary_admits` | `0 < window` | `Formal.window_witness` | planned: dedupe check in `dedupe.ts` | n/a | `window-equal`, `window-above` | mutant uses `≤ window` | multi-key interleaving (TLA model) |
| REQ-4 | window-below-suppresses | `Formal.window_below_suppresses` | `delta < window` | `Formal.oversize_witness` (shared non-emptiness witness) | planned: dedupe check | n/a | `window-below` | as above | — |

## Corpus

**Conformance is `not-run` by design (proof-only).** Docs 1 and 7 are not
implemented yet, so there is no production symbol to bind and no adapter to
run: fabricating a model-local fixture that merely restates the Lean
functions would manufacture conformance evidence for code that does not
exist. This matches the precedent set by
`specs/lean/decision-quota-accounting` (proof-only, conformance `not-run`,
implementation acceptance pending). When `@dsh-cc/input-budget` lands,
conformance must be added by binding its real trim/dedupe functions through a
`conformance/adapter.mjs` plus a committed corpus.

Planned corpus coverage (recorded here so the future author does not have to
re-derive it): boundary cases for `used = budget`, `bytes = 0`,
`bytes = budget - used`, `bytes = budget - used + 1`, `window = 1`,
`delta = window - 1`, `delta = window`, plus one known-bad implementation for
each of the four mutants named in the coverage table.

## Bounds and assumptions

- A1: classes are a closed five-element set; future classes must be assigned
  a budgeted/unbudgeted status explicitly (a change here requires re-proof).
- A2: byte counts are `Nat`; saturation of `Nat` subtraction is handled by
  the `used ≤ budget` preconditions, which the caller must guarantee.
- A3: the model covers per-message arithmetic, not accumulation across a
  batch — accumulation and the backlog walk are the TLA model's property.
- A4: `charged` returns 0 for protected classes; the real implementation must
  express the same thing (skip, not charge-and-ignore) — a test must pin it.

## Property verdict basis

Allowed axioms are the pinned set (`propext`, `Classical.choice`,
`Quot.sound`). The permitted conclusion after a green run is:
"Lean checked the listed propositions under the recorded definitions,
assumptions, and allowed axioms. The implementation matched the reference on
the recorded corpus." — with the last sentence explicitly **not** claimable
here, because no implementation or corpus exists yet.
