import Model

namespace Formal

/- **Conservation**: across every ledger state, the retained total never
exceeds the reserved total. Combined with the per-attempt bound this is
the S1-02 accounting contract: quota cannot be double-counted, and no
settlement path frees more than was reserved. -/
theorem retainedTotal_le_reservedTotal :
    ∀ ledger : Ledger, retainedTotal ledger ≤ reservedTotal ledger := by
  intro ledger
  induction ledger with
  | nil => simp [retainedTotal, reservedTotal]
  | cons row rest ih =>
      have hrow : retained row.2 row.1 ≤ row.1 := by
        cases row.2 with
        | unsettled => simp [retained]
        | actual usage =>
            simp only [retained]
            split
            · omega
            · omega
        | unknown => simp [retained]
        | notDispatched => simp [retained]
      calc retainedTotal (row :: rest)
          = retained row.2 row.1 + retainedTotal rest := by
              simp [retainedTotal]
        _ ≤ row.1 + reservedTotal rest := Nat.add_le_add hrow ih
        _ = reservedTotal (row :: rest) := by
              simp [reservedTotal]

/- **Unknown keeps the full reservation**: an unknown outcome never frees
quota — "never assume failure is free". -/
theorem retained_unknown_is_upper_bound (reserved : Nat) :
    retained .unknown reserved = reserved := by simp [retained]

/- **Unsettled keeps the full reservation**: an in-flight attempt remains
billed at its reserve row. -/
theorem retained_unsettled_is_upper_bound (reserved : Nat) :
    retained .unsettled reserved = reserved := by simp [retained]

/- **Only not-dispatched refunds**: a durable not-dispatched entry is the
only terminal that returns the full reservation. -/
theorem retained_notDispatched_refunds (reserved : Nat) :
    retained .notDispatched reserved = 0 := by simp [retained]

/- **Actual returns the difference**: a valid actual settlement bills
exactly the usage, which is at most the reservation — the difference over
actual is returned. -/
theorem retained_actual_bills_usage (usage reserved : Nat) (h : usage ≤ reserved) :
    retained (.actual usage) reserved = usage := by
  simp only [retained]
  split
  · rfl
  · omega

/- **Monotone settlement**: settling at a valid actual usage never raises
the retained amount compared to leaving the attempt unsettled. -/
theorem settle_actual_never_raises (usage reserved : Nat) (h : usage ≤ reserved) :
    retained (.actual usage) reserved ≤ retained .unsettled reserved := by
  simp only [retained]
  split
  · omega
  · omega

/- Witness declarations for the implication-carrying properties. -/
def witnessUsage : Nat := 7
def witnessReserved : Nat := 12

theorem valid_actual_example : witnessUsage ≤ witnessReserved := by decide

end Formal
