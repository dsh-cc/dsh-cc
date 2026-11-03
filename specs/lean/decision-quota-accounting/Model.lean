namespace Formal

/- The terminal settlement of one decision attempt, exactly as the S1-02
ledger records it: an attempt settles at actual usage (only the difference
over actual is returned), keeps its full reservation when the outcome is
unknown (never assume failure is free), is refunded only by a durable
not-dispatched entry, and holds its full reservation while unsettled. -/
inductive Term where
  | unsettled
  | actual (usage : Nat)
  | unknown
  | notDispatched

/-- The retained-amount projection of one attempt. `reserved` is the
attempt's reserve row (one attempt slot, per-request input and
per-request output upper bounds). A valid settlement satisfies
`usage ≤ reserved`; an overrun is an accounting error handled by the
surrounding protocol (freeze), not by this projection. -/
def retained : Term → Nat → Nat
  | .unsettled, reserved => reserved
  | .actual usage, reserved => if usage ≤ reserved then usage else reserved
  | .unknown, reserved => reserved
  | .notDispatched, _ => 0

/-- A ledger is the list of (reserved, terminal) rows of one session's
quota scope. -/
abbrev Ledger := List (Nat × Term)

/-- The session's retained total: the sum of per-attempt projections. -/
def retainedTotal (ledger : Ledger) : Nat :=
  (ledger.map fun row => retained row.2 row.1).sum

/-- The session's reserved total: the sum of the reserve rows. -/
def reservedTotal (ledger : Ledger) : Nat :=
  (ledger.map Prod.fst).sum

end Formal
