-------------------------- MODULE Model --------------------------
(***************************************************************************)
(* task-grant-authorization: the task-scoped grant of the batch-autonomous *)
(* design (docs/plans/2026-10-28-vwa-batch-autonomous-review.md §3 and     *)
(* §4.4). Modeled together because both are authorization across async     *)
(* changes:                                                               *)
(*   F2 grant lifecycle (user-created, revoked, expired) x decide-time     *)
(*      registration x escalation approval, which must re-validate the     *)
(*      live grant, the mode ceiling and the branch guard (§3.4-§3.5);     *)
(*   F3 the disagreement adjudication lane: only a human adjudication may  *)
(*      lift the block, deferred mode never promotes eligibility (§4.3-    *)
(*      §4.4).                                                            *)
(* Fault switches model the documented failure modes the invariants must   *)
(* catch; each probe case enables exactly one of them.                     *)
(***************************************************************************)
EXTENDS Naturals

CONSTANT SkipGrantCheck, UseRegistryOnly, ConsumeOnce, IgnoreCeiling,
         IgnoreBranch, AgentCanForge, WrongDeferFlip

ASSUME /\ SkipGrantCheck \in BOOLEAN
       /\ UseRegistryOnly \in BOOLEAN
       /\ ConsumeOnce \in BOOLEAN
       /\ IgnoreCeiling \in BOOLEAN
       /\ IgnoreBranch \in BOOLEAN
       /\ AgentCanForge \in BOOLEAN
       /\ WrongDeferFlip \in BOOLEAN

(* Bounded universes. *)
Cmds       == {"c1", "c2"}          (* c1 is inside the grant face, c2 is not *)
CallStates == {"idle", "decided", "escalated", "approved", "asked"}
GrantStates == {"none", "active", "revoked", "expired"}
RegStates   == {"empty", "entry", "consumed"}
AdjStates   == {"none", "unresolved", "accept", "reject"}
Modes       == {"workspace-write", "danger-full-access"}
Branches    == {"b1", "b2"}
Signers     == {"none", "human", "agent"}

(* The grant's capability face is abstracted to "covers c1 only"; its       *)
(* ceiling is a per-case constant and its branch is fixed to b1.           *)
GrantCovers == {"c1"}
GrantBranch == "b1"

CallType ==
  [ cmd:      Cmds
  , state:    CallStates
  , witness:  {"none", "grant"}
  , underLiveGrant: BOOLEAN
  , approvals: 0..2
  , mode:     Modes
  , branch:   Branches ]

VARIABLES grant, grantCeiling, reg, call, adj, signer, promoted

vars == <<grant, grantCeiling, reg, call, adj, signer, promoted>>

Init ==
  /\ grant = "none"
  /\ grantCeiling = "workspace-write"
  /\ reg = "empty"
  /\ call = [cmd |-> "c1", state |-> "idle", witness |-> "none",
             underLiveGrant |-> FALSE, approvals |-> 0,
             mode |-> "workspace-write", branch |-> "b1"]
  /\ adj = "none"
  /\ signer = "none"
  /\ promoted = FALSE

(***************************************************************************)
(* Grant lifecycle (user lane / goal completion / manual revoke)           *)
(***************************************************************************)

CreateGrant(m) ==
  /\ grant = "none"
  /\ grant' = "active"
  /\ grantCeiling' = m
  /\ UNCHANGED <<reg, call, adj, signer, promoted>>

RevokeGrant ==
  /\ grant = "active"
  /\ grant' = "revoked"
  /\ UNCHANGED <<grantCeiling, reg, call, adj, signer, promoted>>

ExpireGrant ==
  /\ grant = "active"
  /\ grant' = "expired"
  /\ UNCHANGED <<grantCeiling, reg, call, adj, signer, promoted>>

(* Start a call: reset the per-call slice (terminal calls are re-drivable). *)
SelectCall(c, m, b) ==
  /\ call.state \in {"idle", "approved", "asked"}
  /\ call' = [cmd |-> c, state |-> "idle", witness |-> "none",
              underLiveGrant |-> FALSE, approvals |-> 0, mode |-> m,
              branch |-> b]
  /\ reg' = "empty"
  /\ UNCHANGED <<grant, grantCeiling, adj, signer, promoted>>

(***************************************************************************)
(* Decision point (§3.4): a gated call is allowed deterministically and    *)
(* registered for its escalation; an ungranted call falls through to the   *)
(* existing pipeline (no registration).                                   *)
(***************************************************************************)

Decide(c, m) ==
  /\ call.state = "idle"
  /\ call.cmd = c
  /\ call.mode = m
  /\ LET gated == (grant = "active" /\ c \in GrantCovers)
     IN
     /\ call' = [call EXCEPT !.state = "decided",
                               !.witness = IF gated THEN "grant" ELSE "none",
                               !.underLiveGrant = gated]
     /\ reg' = IF gated /\ call.mode = m THEN "entry" ELSE "empty"
     /\ UNCHANGED <<grant, grantCeiling, adj, signer, promoted>>

(* Escalation request arrives for the decided call (§3.5).                 *)
Escalate ==
  /\ call.state = "decided"
  /\ call' = [call EXCEPT !.state = "escalated"]
  /\ UNCHANGED <<grant, grantCeiling, reg, adj, signer, promoted>>

(***************************************************************************)
(* Approval. The correct path re-validates: registry entry present, grant  *)
(* still active, requested mode within the ceiling, branch guard passes.   *)
(* SkippedGrantCheck models today's blanket auto-allow; UseRegistryOnly    *)
(* models trusting a stale registration; the ceiling/branch switches model *)
(* dropping the respective re-validation.                                  *)
(***************************************************************************)

ApproveAuto ==
  /\ call.state = "escalated"
  /\ LET registered == reg = "entry"
         grantLive  == grant = "active"
         modeOk     == IgnoreCeiling
                       \/ (call.mode = "workspace-write"
                           \/ grantCeiling = "danger-full-access")
         branchOk   == IgnoreBranch \/ (call.branch = GrantBranch)
         eligible   == ( (registered /\ grantLive /\ modeOk /\ branchOk)
                         \/ SkipGrantCheck
                         \/ (UseRegistryOnly /\ registered) )
     IN
     /\ eligible
     /\ call' = [call EXCEPT
         !.state = "approved",
         !.approvals = call.approvals + 1,
         !.witness = IF registered /\ (grantLive \/ UseRegistryOnly)
                     THEN "grant" ELSE "none",
         !.underLiveGrant = grantLive]
     /\ reg' = IF ConsumeOnce THEN "consumed" ELSE reg
     /\ UNCHANGED <<grant, grantCeiling, adj, signer, promoted>>

(* Fallback: the escalation goes to the human (§3.5 "fall back to user").  *)
AskUser ==
  /\ call.state = "escalated"
  /\ call' = [call EXCEPT !.state = "asked"]
  /\ UNCHANGED <<grant, grantCeiling, reg, adj, signer, promoted>>

(* Replay: a second approval from the same registration is only reachable  *)
(* when the entry was not consumed (ConsumeOnce=FALSE) -- the one-shot     *)
(* property's fault model.                                                 *)
ReplayApproval ==
  /\ call.state = "approved"
  /\ reg = "entry"
  /\ ~ConsumeOnce
  /\ call' = [call EXCEPT !.approvals = call.approvals + 1]
  /\ UNCHANGED <<grant, grantCeiling, reg, adj, signer, promoted>>

(***************************************************************************)
(* F3: the disagreement adjudication lane.                                 *)
(***************************************************************************)

RecordDisagreement ==
  /\ adj = "none"
  /\ adj' = "unresolved"
  /\ UNCHANGED <<grant, grantCeiling, reg, call, signer, promoted>>

Adjudicate(dec) ==
  /\ adj = "unresolved"
  /\ dec \in {"accept", "reject"}
  /\ adj' = dec
  /\ signer' = "human"
  /\ UNCHANGED <<grant, grantCeiling, reg, call, promoted>>

(* Fault: the agent lane forges a human-signed adjudication (§4.1 defect).  *)
ForgeAdjudication ==
  /\ AgentCanForge
  /\ adj = "unresolved"
  /\ adj' = "reject"
  /\ signer' = "agent"
  /\ UNCHANGED <<grant, grantCeiling, reg, call, promoted>>

(* Fault: deferred mode wrongly promotes eligibility while the dispute is *)
(* still unresolved.                                                      *)
PromoteDeferred ==
  /\ WrongDeferFlip
  /\ adj = "unresolved"
  /\ promoted' = TRUE
  /\ UNCHANGED <<grant, grantCeiling, reg, call, adj, signer>>

(* The reviewed-eligibility predicate of §4.4: only a human `reject` of the *)
(* dispute clears the block; `accept` keeps the finding's force.          *)
Eligible == (adj = "reject" /\ signer = "human")

Idle == UNCHANGED vars

Next ==
  \/ \E m \in Modes : CreateGrant(m)
  \/ RevokeGrant
  \/ ExpireGrant
  \/ \E c \in Cmds, m \in Modes, b \in Branches : SelectCall(c, m, b)
  \/ \E c \in Cmds, m \in Modes : Decide(c, m)
  \/ Escalate
  \/ ApproveAuto
  \/ AskUser
  \/ ReplayApproval
  \/ RecordDisagreement
  \/ \E d \in {"accept", "reject"} : Adjudicate(d)
  \/ ForgeAdjudication
  \/ PromoteDeferred
  \/ Idle

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Safety properties                                                        *)
(***************************************************************************)

TypeOK ==
  /\ grant \in GrantStates
  /\ grantCeiling \in Modes
  /\ reg \in RegStates
  /\ call \in CallType
  /\ adj \in AdjStates
  /\ signer \in Signers
  /\ promoted \in BOOLEAN

(* S-1: every auto-approval happened under a live grant covering the call. *)
NoUngrantedAutoApproval ==
  call.state = "approved" => (call.witness = "grant" /\ call.underLiveGrant)

(* S-2: one approval per registration entry (one-shot consumption).        *)
OneApprovalPerCall == call.approvals <= 1

(* S-3: the approved mode never exceeds the grant's ceiling.               *)
ModeWithinCeiling ==
  call.state = "approved" =>
    (call.mode = "workspace-write" \/ grantCeiling = "danger-full-access")

(* S-4: the branch guard held at approval time.                            *)
BranchGuardHolds ==
  call.state = "approved" => call.branch = GrantBranch

(* S-5: no adjudication is ever signed by anything but the human lane.     *)
NoForgedAdjudication ==
  (adj \in {"accept", "reject"}) => signer = "human"

(* S-6: an unresolved dispute never yields reviewed eligibility, and the   *)
(* promotion flag can only be set after a human reject.                    *)
DeferredNeverPromoted ==
  promoted => (adj = "reject" /\ signer = "human")

(* S-7: reviewed eligibility implies a human-cleared dispute (§4.4).       *)
EligibilitySound == Eligible => signer = "human"

ToolchainFingerprint == <<SkipGrantCheck, UseRegistryOnly, ConsumeOnce,
                          IgnoreCeiling, IgnoreBranch, AgentCanForge,
                          WrongDeferFlip>>

=============================================================================
