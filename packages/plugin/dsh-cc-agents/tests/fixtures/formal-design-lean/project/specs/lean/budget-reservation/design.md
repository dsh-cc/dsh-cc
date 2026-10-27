# Budget reservation (Lean fixture)

Bounded conformance fixture for the Lean verification contract tests. The
implementation binding `packages/example/src/budget.ts` is declared and does not
exist in this fixture project: proof preflight records it as planned and never
requires it (design sections 5 and 9).

Requirement REQ-1: a successful reservation preserves `reserved <= budget`.
Requirement REQ-2: a zero request succeeds for a valid state and returns the
current reservation.
