-------------------------- MODULE Model --------------------------
(***************************************************************************)
(* task-grant-authorization v2: the task-scoped grant of the              *)
(* batch-autonomous design (§3.4-§3.6, §4.3-§4.4).                         *)
(*                                                                        *)
(* Review folds over v1:                                                  *)
(*  - the approval is SPLIT around the out-of-process git probe:          *)
(*    ApproveCheck (snapshot: registry, ceiling, content gate) -> the      *)
(*    await window (BranchCheckout / RevokeGrant / ExpireGrant may         *)
(*    interleave) -> ApproveConsume (RE-VALIDATE the live grant and the   *)
(*    current HEAD branch, then consume the registration atomically).    *)
(*    UseStaleAfterGit is the documented fault that skips the             *)
(*    re-validation (review fold K2).                                    *)
(*  - the branch is a live variable re-sampled at consume time, not a    *)
(*    decision-time frozen value (review fold K4).                        *)
(*  - the disagreement block is an EFFECTIVE FORCE state variable         *)
(*    (major / cleared), so accept-keeps-the-block and deferred-never-    *)
(*    promotes are non-tautological checks (review fold K3).             *)
(*  - the registry has two slots (own / stray) so cross-consume of        *)
(*    another execution's entry is representable (review fold K6).       *)
(*  - baseline semantics pinned (review fold, codex F12): with NO grant   *)
(*    active, today's blanket sandbox auto-allow is preserved; but a      *)
(*    GATED call (witness = grant) NEVER falls back to the baseline --    *)
(*    a dead grant sends it to the user.                                 *)
(*  - the contentScope gate is part of the approval check (§3.6).         *)
(***************************************************************************)
EXTENDS Naturals

CONSTANT SkipGrantCheck, UseStaleAfterGit, ConsumeOnce, IgnoreCeiling,
         IgnoreBranch, AgentCanForge, WrongDeferFlip, WrongAcceptClears,
         CrossConsume, SkipContentGate

ASSUME /\ SkipGrantCheck \in BOOLEAN
       /\ UseStaleAfterGit \in BOOLEAN
       /\ ConsumeOnce \in BOOLEAN
       /\ IgnoreCeiling \in BOOLEAN
       /\ IgnoreBranch \in BOOLEAN
       /\ AgentCanForge \in BOOLEAN
       /\ WrongDeferFlip \in BOOLEAN
       /\ WrongAcceptClears \in BOOLEAN
       /\ CrossConsume \in BOOLEAN
       /\ SkipContentGate \in BOOLEAN

(* Bounded universes. *)
Cmds       == {"c1", "c2"}     (* c1 inside the grant face, c2 outside *)
CallStates == {"idle", "decided", "escalated", "checking", "approved", "asked"}
GrantStates == {"none", "active", "revoked", "expired"}
RegStates   == {"empty", "entry", "consumed"}
AdjStates   == {"none", "unresolved", "accept", "reject"}
Modes       == {"workspace-write", "danger-full-access"}
Branches    == {"b1", "b2"}
Signers     == {"none", "human", "agent"}
Forces      == {"none", "major", "cleared"}

GrantCovers == {"c1"}
GrantBranch == "b1"

CallType ==
  [ cmd:      Cmds
  , state:    CallStates
  , witness:  {"none", "grant"}
  , approvals: 0..2
  , mode:     Modes
  , modeOk:   BOOLEAN          (* re-checked at consume *)
  , branchAt:  Branches         (* sampled at consume *)
  , contentOk: BOOLEAN
  , grantWasActive: BOOLEAN    (* grant active at consume (baseline record) *)
  , underLiveGrant: BOOLEAN
  , consumedFrom: {"none", "self", "stray"} ]

VARIABLES grant, grantCeiling, headBranch, regSelf, regStray, call, adj,
          signer, force

vars == <<grant, grantCeiling, headBranch, regSelf, regStray, call, adj,
          signer, force>>

Init ==
  /\ grant = "none"
  /\ grantCeiling = "workspace-write"
  /\ headBranch = "b1"
  /\ regSelf = "empty"
  /\ regStray = "empty"
  /\ call = [cmd |-> "c1", state |-> "idle", witness |-> "none",
             approvals |-> 0, mode |-> "workspace-write", modeOk |-> TRUE,
             branchAt |-> "b1", contentOk |-> TRUE,
             grantWasActive |-> FALSE, underLiveGrant |-> FALSE,
             consumedFrom |-> "none"]
  /\ adj = "none"
  /\ signer = "none"
  /\ force = "none"

(***************************************************************************)
(* Grant lifecycle                                                         *)
(***************************************************************************)

CreateGrant(m) ==
  /\ grant = "none"
  /\ grant' = "active"
  /\ grantCeiling' = m
  /\ UNCHANGED <<headBranch, regSelf, regStray, call, adj, signer, force>>

RevokeGrant ==
  /\ grant = "active"
  /\ grant' = "revoked"
  /\ (* Registrations die with their grant: a reborn grant must never
        consume a stale entry (model-review finding). *)
     regSelf' = "empty"
  /\ regStray' = "empty"
  /\ UNCHANGED <<grantCeiling, headBranch, call, adj, signer, force>>

ExpireGrant ==
  /\ grant = "active"
  /\ grant' = "expired"
  /\ (* Registrations die with their grant: a reborn grant must never
        consume a stale entry (model-review finding). *)
     regSelf' = "empty"
  /\ regStray' = "empty"
  /\ UNCHANGED <<grantCeiling, headBranch, call, adj, signer, force>>

(* A new session may re-grant after a revoked/expired grant. *)
ResetGrant ==
  /\ grant \in {"revoked", "expired"}
  /\ grant' = "none"
  /\ regSelf' = "empty"
  /\ regStray' = "empty"
  /\ UNCHANGED <<grantCeiling, headBranch, call, adj, signer, force>>

(***************************************************************************)
(* Call lifecycle                                                           *)
(***************************************************************************)

SelectCall(c, m, b, ok) ==
  /\ call.state \in {"idle", "approved", "asked"}
  /\ call' = [cmd |-> c, state |-> "idle", witness |-> "none",
              approvals |-> 0, mode |-> m, modeOk |-> TRUE,
              branchAt |-> b, contentOk |-> ok, grantWasActive |-> FALSE,
              underLiveGrant |-> FALSE, consumedFrom |-> "none"]
  /\ regSelf' = "empty"
  /\ regStray' = "empty"
  /\ UNCHANGED <<grant, grantCeiling, headBranch, adj, signer, force>>

Decide(c, m) ==
  /\ call.state = "idle"
  /\ call.cmd = c
  /\ call.mode = m
  /\ LET gated == (grant = "active" /\ c \in GrantCovers)
     IN
     /\ call' = [call EXCEPT !.state = "decided",
                                !.witness = IF gated THEN "grant" ELSE "none"]
     /\ regSelf' = IF gated THEN "entry" ELSE "empty"
     /\ UNCHANGED <<grant, grantCeiling, headBranch, regStray, adj, signer,
                    force>>

(* A registration belonging to a DIFFERENT execution appears in the      *)
(* registry (the slot the approval must NOT consume).                     *)
StrayArrival ==
  /\ regStray = "empty"
  /\ regStray' = "entry"
  /\ UNCHANGED <<grant, grantCeiling, headBranch, regSelf, call, adj,
                 signer, force>>

Escalate ==
  /\ call.state = "decided"
  /\ call' = [call EXCEPT !.state = "escalated"]
  /\ UNCHANGED <<grant, grantCeiling, headBranch, regSelf, regStray, adj,
                 signer, force>>

(***************************************************************************)
(* Approval, split around the out-of-process git probe.                    *)
(***************************************************************************)

(* Stage 1 -- the listener's synchronous pre-checks: registry hit (or     *)
(* preserved baseline), the mode ceiling parsed from the reason, and the  *)
(* contentScope gate. The git branch probe is out of process, so the       *)
(* branch check happens AFTER this stage.                                 *)
ApproveCheck ==
  /\ call.state = "escalated"
  /\ LET grantLive == grant = "active"
         gated     == call.witness = "grant"
         ceilingOk == IgnoreCeiling
                      \/ (call.mode = "workspace-write"
                          \/ grantCeiling = "danger-full-access")
         contentOk == SkipContentGate \/ call.contentOk
         eligible  == ( gated /\ regSelf = "entry" /\ ceilingOk /\ contentOk )
                      \/ ( ~gated /\ ~grantLive )
                      \/ ( SkipGrantCheck /\ grantLive )
     IN
     /\ eligible
     /\ call' = [call EXCEPT !.state = "checking"]
     /\ UNCHANGED <<grant, grantCeiling, headBranch, regSelf, regStray, adj,
                    signer, force>>

(* The await window: the user may switch branches (the git probe observes  *)
(* the CURRENT head, not a decision-time value).                          *)
BranchCheckout ==
  /\ headBranch' \in Branches
  /\ UNCHANGED <<grant, grantCeiling, regSelf, regStray, call, adj, signer,
                 force>>

(* Stage 2 -- after the await: re-validate the live grant and the current *)
(* head branch, then consume the registration atomically.                  *)
ApproveConsume ==
  /\ call.state = "checking"
  /\ LET grantLive == grant = "active"
         revalidate == UseStaleAfterGit \/ grantLive
         branchOk == IgnoreBranch \/ headBranch = GrantBranch
     IN
     /\ ( call.witness = "grant" => revalidate )
     /\ ( call.witness = "none" => (SkipGrantCheck \/ ~grantLive) )
     /\ branchOk
     /\ LET own == ( regSelf = "entry" )
            stray == ( regStray = "entry" )
            useStray == CrossConsume /\ stray
        IN
        /\ ( call.witness = "grant" => (own \/ useStray
                                          \/ UseStaleAfterGit) )
        /\ call' = [call EXCEPT
            !.state = "approved",
            !.approvals = call.approvals + 1,
            !.modeOk = (call.mode = "workspace-write"
                        \/ grantCeiling = "danger-full-access"),
            !.branchAt = headBranch,
            !.grantWasActive = grantLive,
            !.underLiveGrant = grantLive,
            !.consumedFrom = IF call.witness = "grant"
                              THEN (IF useStray THEN "stray" ELSE "self")
                              ELSE "none"]
        /\ regSelf' = IF (ConsumeOnce /\ call.witness = "grant" /\ own
                          /\ ~useStray) THEN "consumed" ELSE regSelf
        /\ regStray' = IF (ConsumeOnce /\ useStray) THEN "consumed" ELSE regStray
     /\ UNCHANGED <<grant, grantCeiling, headBranch, adj, signer, force>>

(* Fallback to the human for either stage. *)
AskUser ==
  /\ call.state \in {"escalated", "checking"}
  /\ call' = [call EXCEPT !.state = "asked"]
  /\ UNCHANGED <<grant, grantCeiling, headBranch, regSelf, regStray, adj,
                 signer, force>>

(* One-shot consumption fault: the entry was not deleted. *)
ReplayApproval ==
  /\ call.state = "approved"
  /\ (regSelf = "entry" \/ regStray = "entry")
  /\ ~ConsumeOnce
  /\ call' = [call EXCEPT !.approvals = call.approvals + 1]
  /\ UNCHANGED <<grant, grantCeiling, headBranch, regSelf, regStray, adj,
                 signer, force>>

(***************************************************************************)
(* F3: disagreement, adjudication, effective force                         *)
(***************************************************************************)

RecordDisagreement ==
  /\ adj = "none"
  /\ adj' = "unresolved"
  /\ force' = "major"
  /\ UNCHANGED <<grant, grantCeiling, headBranch, regSelf, regStray, call,
                 signer>>

Adjudicate(dec) ==
  /\ adj = "unresolved"
  /\ dec \in {"accept", "reject"}
  /\ adj' = dec
  /\ signer' = "human"
  /\ force' = IF dec = "reject" THEN "cleared"
              ELSE IF WrongAcceptClears THEN "cleared" ELSE "major"
  /\ UNCHANGED <<grant, grantCeiling, headBranch, regSelf, regStray, call>>

ForgeAdjudication ==
  /\ AgentCanForge
  /\ adj = "unresolved"
  /\ adj' = "reject"
  /\ signer' = "agent"
  /\ force' = "cleared"
  /\ UNCHANGED <<grant, grantCeiling, headBranch, regSelf, regStray, call>>

PromoteDeferred ==
  /\ WrongDeferFlip
  /\ adj = "unresolved"
  /\ force' = "cleared"
  /\ UNCHANGED <<grant, grantCeiling, headBranch, regSelf, regStray, call,
                 adj, signer>>

(* Reviewed eligibility: only a human-cleared dispute yields it (§4.4).   *)
EligibleNow == force = "cleared" /\ signer = "human" /\ adj = "reject"

Idle == UNCHANGED vars

Next ==
  \/ \E m \in Modes : CreateGrant(m)
  \/ RevokeGrant
  \/ ExpireGrant
  \/ ResetGrant
  \/ \E c \in Cmds, m \in Modes, b \in Branches, ok \in BOOLEAN :
       SelectCall(c, m, b, ok)
  \/ \E c \in Cmds, m \in Modes : Decide(c, m)
  \/ StrayArrival
  \/ Escalate
  \/ ApproveCheck
  \/ BranchCheckout
  \/ ApproveConsume
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
  /\ headBranch \in Branches
  /\ regSelf \in RegStates
  /\ regStray \in RegStates
  /\ call \in CallType
  /\ adj \in AdjStates
  /\ signer \in Signers
  /\ force \in Forces

(* S-1a: a gated call never falls back to the baseline -- its grant must  *)
(* be live at consume.                                                     *)
GrantPathSound ==
  (call.state = "approved" /\ call.witness = "grant") => call.underLiveGrant

(* S-1b: the preserved blanket baseline only applies with no active grant. *)
BaselineOnlyWithoutActiveGrant ==
  (call.state = "approved" /\ call.witness = "none") => ~call.grantWasActive

(* S-2: one approval per registration. *)
OneApprovalPerCall == call.approvals <= 1

(* S-3: the approved mode never exceeds the grant ceiling (checked at    *)
(* consume, after the await; grant-path approvals only -- the preserved    *)
(* baseline has no ceiling).                                               *)
ModeWithinCeiling ==
  (call.state = "approved" /\ call.witness = "grant") => call.modeOk

(* S-4: the branch guard holds on the branch observed at consume          *)
(* (grant-path approvals only). *)
BranchGuardHolds ==
  (call.state = "approved" /\ call.witness = "grant") => call.branchAt = GrantBranch

(* S-5: no adjudication is signed by anything but the human lane. *)
NoForgedAdjudication ==
  (adj \in {"accept", "reject"}) => signer = "human"

(* S-6: the effective force only clears on a human reject; unresolved and *)
(* accept keep the major force. *)
ForceSound ==
  /\ (force = "cleared" => (adj = "reject" /\ signer = "human"))
  /\ (adj = "unresolved" => force = "major")
  /\ (adj = "accept" => force = "major")

(* S-7: an approval consumes only the registration bound to its own       *)
(* execution (the stray slot belongs to someone else). *)
NoCrossConsume ==
  (call.state = "approved" /\ call.witness = "grant")
  => call.consumedFrom = "self"

(* S-8: the contentScope gate held at approval (grant-path only -- the   *)
(* baseline blanket allow has no content gate). *)
ContentGateSound ==
  (call.state = "approved" /\ call.witness = "grant") => call.contentOk

ToolchainFingerprint == <<SkipGrantCheck, UseStaleAfterGit, ConsumeOnce,
                          IgnoreCeiling, IgnoreBranch, AgentCanForge,
                          WrongDeferFlip, WrongAcceptClears, CrossConsume,
                          SkipContentGate>>

=============================================================================
