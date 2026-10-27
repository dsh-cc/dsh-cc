namespace Formal

/-- Reject when the prior state is already invalid, otherwise reserve. -/
def reserve (budget reserved amount : Nat) : Except String Nat :=
  if reserved > budget then .error "invalid-state"
  else if amount > budget - reserved then .error "insufficient-budget"
  else .ok (reserved + amount)

end Formal
