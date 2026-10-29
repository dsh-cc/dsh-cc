# Implementation notes — task-grant-authorization

Feature not implemented yet: this model pins the planned semantics of the
batch-autonomous design §3.4-§3.5 (grant consumption and escalation
re-validation) and §4.3-§4.4 (deferred disagreement, adjudication authority).

## Run lineage

- R1 `20261029T021437Z-0124050a-088e-445d-a013-4f2680e7459f`: all cases errored with
  `property-evaluation-failed`. **Modeling defect**: the `UNCHANGED` lists
  were inconsistent after introducing the grant ceiling as state (a
  variable both assigned and marked unchanged, another left unassigned).
- R2 `20261029T021639Z-15788464-383a-4c10-b615-45ecc703d7cb` (superseded): boundary/indent damage from a
  bulk edit (`ELSE "empty" /\ UNCHANGED ...` parsed as a conjunct on a
  string). Fixed by re-indenting the two LET-body conjuncts.
- R3 `20261029T021853Z-63991f96-613a-4b08-a425-d63a1b05de05`: final. convention verified (8,640 / 1,220);
  every probe is red on its intended invariant:
  strict-skip-grant-check and strict-stale-registry
  (`NoUngrantedAutoApproval`), strict-replay (`OneApprovalPerCall`),
  strict-ceiling (`ModeWithinCeiling`), strict-branch (`BranchGuardHolds`),
  strict-forged-adjudication (`NoForgedAdjudication`),
  strict-deferred-flip (`DeferredNeverPromoted`).
  check-evidence: valid/fresh.

## Design clarifications the model produced

1. **Registration alone cannot authorize an approval.** `strict-stale-registry`
   is red on `NoUngrantedAutoApproval`: if the listener trusts the registry
   entry without re-reading the live grant, a revoke between decision and
   escalation still auto-approves. This is the model-level confirmation of the
   r2 fold requiring a live-grant re-check at the approval seam.
2. **The mode ceiling must be grant state, not a constant** — a grant created
   with `workspace-write` must never approve a `danger-full-access` request;
   modeling it as state made the ceiling probe meaningful.
3. **The branch guard needs the call's branch recorded** at decision time;
   checking only the grant's branch is vacuous (the model's first draft was
   vacuous here — caught by the probe verifying instead of failing).

## Unverified scope

- Liveness (eventual user answer after a forced fallback) is not modeled.
- Registry TTL, the missing-`callId` fallback and the branch-probe failure
  path (E-2/E-3) only shrink the auto-approval set; they are implementation
  tests, not model claims.
- The shell-rule composition (E-1) is deliberately out of scope: it is
  deterministic string logic covered by differential tests; a Lean model
  would need a pure reference predicate extracted from the IO-coupled matcher.
