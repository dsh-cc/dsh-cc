namespace Formal

/-- Reject when the prior state is already invalid, otherwise reserve. -/
def reserve (budget reserved amount : Nat) : Except String Nat :=
  if reserved > budget then .error "invalid-state"
  else if amount > budget - reserved then .error "insufficient-budget"
  else .ok (reserved + amount)

/-- Documented API contract as a state step: on success the caller's
reservation becomes the new amount; on rejection it stays exactly as it was. -/
def reserveState (budget reserved amount : Nat) : Nat × Except String Nat :=
  match reserve budget reserved amount with
  | .ok value => (value, .ok value)
  | .error code => (reserved, .error code)

end Formal
