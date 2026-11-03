import Lean
import Model

namespace Formal

/- The reference mirror used by conformance. The production pure function
to bind is the per-rule worst-wins merge in
`packages/interaction/vwa-argument/src/audit-align.ts`
(`mergeChunkTargets`'s VERDICT_SEVERITY comparison); conformance for this
model may run against the existing production code once the S1-08 split
work wires its adapter, since the merge itself already exists there. -/

def decodeVerdict : Lean.Json → Option Verdict
  | .str "not-run" => some .notRun
  | .str "pass" => some .pass
  | .str "needs-review" => some .needsReview
  | .str "fail" => some .fail
  | _ => none

def encodeVerdict : Verdict → String
  | .notRun => "not-run"
  | .pass => "pass"
  | .needsReview => "needs-review"
  | .fail => "fail"

def decodeVerdicts : Lean.Json → Option (List Verdict)
  | .arr rows =>
    rows.foldl (fun acc row =>
      match acc, decodeVerdict row with
      | some acc, some v => some (v :: acc)
      | none, _ => none
      | _, none => none) (some [])
  | _ => none

/-- Pure JSON boundary: a list of per-chunk verdict strings in, the merged
worst verdict out. -/
def reference (input : Lean.Json) : Except String Lean.Json :=
  match input.getObj? with
  | .error _ => .error "invalid-verdicts"
  | .ok fields =>
    match fields.get? "verdicts" with
    | none => .error "invalid-verdicts"
    | some rows =>
      match decodeVerdicts rows with
      | none => .error "invalid-verdicts"
      | some verdicts =>
        .ok (.mkObj [("worst", .str (encodeVerdict (mergeVerdicts verdicts)))])

end Formal
