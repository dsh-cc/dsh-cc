namespace Formal

/-- Message classes of the per-step input gate (doc 1's registry). -/
inductive Class where
  | governance
  | task
  | memory
  | advisory
  | passthrough
  deriving DecidableEq, Repr

/-- Trim policy per class: only `memory` and `advisory` are budgeted. -/
def budgeted : Class -> Bool
  | .memory => true
  | .advisory => true
  | _ => false

/-- Bytes charged against a class budget: zero for never-trimmed
classes. This is the arithmetic face of "protected classes are never
charged against a trimmable budget". -/
def charged (cls : Class) (bytes : Nat) : Nat :=
  if budgeted cls then bytes else 0

/-- One budget line: the amount still available after `used`. -/
def available (budget used : Nat) : Nat := budget - used

/-- Admit-within-budget decision for one message. -/
def fits (budget used bytes : Nat) : Bool :=
  decide (bytes <= available budget used)

/-- Oversize rule: a message that alone exceeds its class budget is
dropped at trim time, never enqueued (doc 1's `drop-oversize`). -/
def oversize (budget bytes : Nat) : Bool :=
  decide (budget < bytes)

/-- Dedupe window: suppress when the gap from the last committed
admission is strictly below the window (doc 7's `delta < window`). -/
def withinWindow (now lastAdmitted window : Nat) : Bool :=
  decide (now - lastAdmitted < window)

end Formal
