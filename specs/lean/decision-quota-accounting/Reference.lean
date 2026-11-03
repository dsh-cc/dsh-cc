import Lean
import Model

namespace Formal

/- The reference mirror used by conformance once the S1-02 ledger exists
in production (`packages/observability/decision-usage/src/quota.ts`).
Proof-stage only for now: conformance stays not-run until the feature is
implemented. The projected functions are `retained`, `retainedTotal` and
`reservedTotal` in Model.lean. -/

/-- Canonical decimal grammar `^(0|[1-9][0-9]*)$` (same JSON boundary
convention as the worked example). -/
def canonicalNat? (value : Lean.Json) : Option Nat :=
  match value with
  | .str text =>
    if text.isEmpty then none
    else if !text.toList.all (fun char => char.isDigit) then none
    else if text.startsWith "0" && text.length != 1 then none
    else text.toNat?
  | _ => none

def decodeTerm (value : Lean.Json) : Option Term :=
  match value with
  | .str "unsettled" => some .unsettled
  | .str "unknown" => some .unknown
  | .str "not-dispatched" => some .notDispatched
  | .obj fields =>
    match fields.get? "actual" with
    | some usage =>
      match canonicalNat? usage with
      | some number => some (.actual number)
      | none => none
    | none => none
  | _ => none

def decodeRow (value : Lean.Json) : Option (Nat × Term) :=
  match value with
  | .obj fields =>
    match fields.get? "reserved", fields.get? "term" with
    | some reservedJson, some termJson =>
      match canonicalNat? reservedJson, decodeTerm termJson with
      | some reserved, some term => some (reserved, term)
      | _, _ => none
    | _, _ => none
  | _ => none

def decodeLedger (value : Lean.Json) : Option Ledger :=
  match value with
  | .arr rows =>
    rows.foldl (fun acc row =>
      match acc, decodeRow row with
      | some ledger, some decoded => some (decoded :: ledger)
      | none, _ => none
      | _, none => none) (some [])
  | _ => none

/-- Pure JSON boundary of the reference model: a ledger in, the retained
and reserved totals out (canonical decimal strings at the boundary, like
the worked example, so Lean and a future JavaScript implementation agree). -/
def reference (input : Lean.Json) : Except String Lean.Json :=
  match input.getObj? with
  | .error _ => .error "invalid-ledger"
  | .ok fields =>
    match fields.get? "ledger" with
    | none => .error "invalid-ledger"
    | some ledgerJson =>
      match decodeLedger ledgerJson with
      | none => .error "invalid-ledger"
      | some ledger =>
        let out : Lean.Json := .mkObj [
          ("retainedTotal", .str (toString (retainedTotal ledger))),
          ("reservedTotal", .str (toString (reservedTotal ledger)))]
        .ok out

end Formal
