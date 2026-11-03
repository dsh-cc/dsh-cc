-------------------------- MODULE Model --------------------------
(***************************************************************************)
(* auto-approval-pipeline: the auto-mode authorization pipeline for one tool *)
(* call.                                                                     *)
(*                                                                         *)
(* Stage order (pre-execute.ts:335-372, decide.ts:130-234, auto-stage.ts): *)
(*   1 risk classification      HIGH -> deny, short-circuits everything     *)
(*   2 rule waterfall           deny -> bypassPermissions -> ask ->         *)
(*                              allow -> passthrough, with the auto-mode    *)
(*                              allow-rule suspension filter applied to     *)
(*                              allow rules only (auto-rule-filter.ts:86)   *)
(*   3 task grant               an opaque deterministic allow               *)
(*   4 LLM classifier           only auto AND passthrough AND LOW|MEDIUM    *)
(*                              AND not read-only; every failure asks       *)
(*   5 post-waterfall           session allow covers an ask; a leftover     *)
(*                              passthrough reaches the human prompt        *)
(*   6 human approval           the engine's own approval seam              *)
(*                                                                         *)
(* The only asynchronous window is the classifier: the clock (mode change,  *)
(* settings change, breaker trip, session grant) can move while the verdict *)
(* is in flight, so the verdict may be applied against a different mode     *)
(* than the one it was computed under.                                      *)
(*                                                                         *)
(* Each fault switch turns one intended guard off, so each probe case shows *)
(* exactly one reachable wrong authorization.                              *)
(***************************************************************************)
EXTENDS Naturals

CONSTANT HonorSuspendedRule, ArbitrateRuleAsk, ApplyStaleMode,
         SilentAllowFailure, GrantFirst, NoBackstopTrip, IgnoreGrantCeiling,
         StageArmed, MaxDenies

ASSUME /\ HonorSuspendedRule \in BOOLEAN
       /\ ArbitrateRuleAsk \in BOOLEAN
       /\ ApplyStaleMode \in BOOLEAN
       /\ SilentAllowFailure \in BOOLEAN
       /\ GrantFirst \in BOOLEAN
       /\ NoBackstopTrip \in BOOLEAN
       /\ IgnoreGrantCeiling \in BOOLEAN
       /\ StageArmed \in BOOLEAN
       /\ MaxDenies \in 1..3

Modes  == {"auto", "default", "plan", "bypass"}
Risks  == {"low", "medium", "high", "readonly"}
Shapes == {"pluginPath", "short", "interp", "pkgRunner", "whole", "subagent"}
Phases == {"idle", "new", "deciding", "asked", "staged", "eligible",
           "classifying", "awaitHuman", "done"}
RuleVerdicts == {"none", "pass", "ask", "allow", "deny"}
ClsOutcomes  == {"none", "allow", "ask", "deny", "timeout", "malformed",
                 "unarmed", "breaker"}
Verdicts     == {"none", "allow", "ask", "deny"}
Sources      == {"none", "risk", "rule", "bypass", "grant", "llm", "session",
                 "human"}
Breakers     == {"closed", "open"}

(* The suspension predicate of auto-rule-filter.ts:86-104: every shell allow *)
(* whose fixed head is a short bare word, an interpreter, a package runner   *)
(* (npm run / npx / pnpm exec / ...) or a whole-tool rule, and every         *)
(* subagent allow, is suspended. The cd/ls SAFE_SHORT_HEADS exemption is not *)
(* modeled, so "short" over-suspends (conservative). classifyAllShell widens *)
(* it to every shell allow, including an absolute-path head that otherwise   *)
(* survives. A suspended allow is not dropped from the set: it silently      *)
(* stops matching, which is what makes it a passthrough.                     *)
Suspended(s, cas) ==
  \/ s \in {"short", "interp", "pkgRunner", "whole", "subagent"}
  \/ (cas /\ s \in {"interp", "pkgRunner", "whole", "pluginPath"})

CallType ==
  [ phase:        Phases
  , risk:         Risks
  , shape:        Shapes
  , denyRule:     BOOLEAN
  , askRule:      BOOLEAN
  , bypassImmune: BOOLEAN
  , ruleVerdict:  RuleVerdicts
  , ruleSuspended: BOOLEAN
  , denySeen:     BOOLEAN
  , ruleMode:     Modes
  , clsUsed:      BOOLEAN
  , classifyMode: Modes
  , appliedMode:  Modes
  , cls:          ClsOutcomes
  , verdict:      Verdicts
  , by:           Sources
  , executed:     BOOLEAN ]

CallIdle ==
  [ phase |-> "idle", risk |-> "low", shape |-> "pluginPath", denyRule |-> FALSE,
    askRule |-> FALSE, bypassImmune |-> FALSE, ruleVerdict |-> "none",
    ruleSuspended |-> FALSE, denySeen |-> FALSE, ruleMode |-> "auto",
    clsUsed |-> FALSE, classifyMode |-> "auto",
    appliedMode |-> "auto", cls |-> "none", verdict |-> "none",
    by |-> "none", executed |-> FALSE ]

MakeCall(rk, sh, dr, ar, bi) ==
  [ phase |-> "new", risk |-> rk, shape |-> sh, denyRule |-> dr, askRule |-> ar,
    bypassImmune |-> bi, ruleVerdict |-> "none", ruleSuspended |-> FALSE,
    denySeen |-> FALSE, ruleMode |-> "auto", clsUsed |-> FALSE,
    classifyMode |-> "auto", appliedMode |-> "auto",
    cls |-> "none", verdict |-> "none", by |-> "none", executed |-> FALSE ]

VARIABLES mode, cas, sessionAllow, grant, denyStreak, breaker, tripped, call

vars == <<mode, cas, sessionAllow, grant, denyStreak, breaker, tripped, call>>

Executed == call.phase = "done" /\ call.executed

Init ==
  /\ mode = "auto"
  /\ cas = FALSE
  /\ sessionAllow = FALSE
  /\ grant = FALSE
  /\ denyStreak = 0
  /\ breaker = "closed"
  /\ tripped = FALSE
  /\ call = CallIdle

(* --------------------------------------------------------------- environment *)

(* The user or a project file changes settings. Any of these may land inside  *)
(* the classifier's await.                                                   *)
(* A deliberate re-entry into auto clears the trip: the backstop is a        *)
(* session-scoped downgrade, not a permanent ban.                          *)
ModeChange ==
  /\ \E m \in Modes :
       /\ m # mode
       /\ mode' = m
       /\ tripped' = IF m = "auto" THEN FALSE ELSE tripped
       /\ UNCHANGED <<cas, sessionAllow, grant, denyStreak, breaker, call>>

ToggleCas ==
  /\ cas' = ~cas
  /\ UNCHANGED <<mode, sessionAllow, grant, denyStreak, breaker, tripped, call>>

SessionAllowAdd ==
  /\ ~sessionAllow
  /\ sessionAllow' = TRUE
  /\ UNCHANGED <<mode, cas, grant, denyStreak, breaker, tripped, call>>

GrantSet ==
  /\ grant' = ~grant
  /\ UNCHANGED <<mode, cas, sessionAllow, denyStreak, breaker, tripped, call>>

BreakerTrip ==
  /\ breaker = "closed"
  /\ breaker' = "open"
  /\ UNCHANGED <<mode, cas, sessionAllow, grant, denyStreak, tripped, call>>

BreakerReset ==
  /\ breaker = "open"
  /\ breaker' = "closed"
  /\ UNCHANGED <<mode, cas, sessionAllow, grant, denyStreak, tripped, call>>

(* ------------------------------------------------------------------- stages *)

NewCall ==
  /\ call.phase \in {"idle", "done"}
  /\ \E rk \in Risks, sh \in Shapes, dr \in BOOLEAN, ar \in BOOLEAN,
       bi \in BOOLEAN :
       /\ ~(dr /\ ar)
       /\ call' = MakeCall(rk, sh, dr, ar, bi)
       /\ UNCHANGED <<mode, cas, sessionAllow, grant, denyStreak, breaker, tripped>>

(* Stage 1: a HIGH risk classification denies and nothing later runs.        *)
RiskHighDeny ==
  /\ call.phase = "new"
  /\ call.risk = "high"
  /\ call' = [call EXCEPT !.phase = "done", !.verdict = "deny",
                              !.by = "risk", !.denySeen = TRUE]
  /\ UNCHANGED <<mode, cas, sessionAllow, grant, denyStreak, breaker, tripped>>

BeginRules ==
  /\ call.phase = "new"
  /\ call.risk # "high"
  /\ call' = [call EXCEPT !.phase = "deciding"]
  /\ UNCHANGED <<mode, cas, sessionAllow, grant, denyStreak, breaker, tripped>>

(* bypassPermissions allow: applied after a deny rule and not against a       *)
(* bypass-immune rule.                                                      *)
BypassAllow ==
  /\ call.phase = "deciding"
  /\ mode = "bypass"
  /\ ~call.bypassImmune
  /\ call' = [call EXCEPT !.phase = "done", !.verdict = "allow",
                              !.by = "bypass", !.executed = TRUE]
  /\ UNCHANGED <<mode, cas, sessionAllow, grant, denyStreak, breaker, tripped>>

(* The rule waterfall is a single deterministic decision over the call's     *)
(* rule facts and the live suspension filter: deny, then ask, then a         *)
(* non-suspended allow, then passthrough.                                    *)
(* A bypass-immune rule denies in EVERY mode, including bypassPermissions.   *)
(* The real enforcement is the monotonic layer after pre-execute (decide.ts  *)
(* passes an EMPTY bypassImmune set to the waterfall), so the model applies  *)
(* its effect at the rule stage for every mode (E-1).                      *)
EvaluateRules ==
  /\ call.phase = "deciding"
  /\ (mode # "bypass" \/ call.bypassImmune)
  /\ IF call.bypassImmune
       THEN /\ call' = [call EXCEPT !.phase = "done", !.verdict = "deny",
                                    !.by = "rule", !.ruleVerdict = "deny",
                                    !.denySeen = TRUE, !.ruleMode = mode]
       ELSE IF call.denyRule
       THEN /\ call' = [call EXCEPT !.phase = "done", !.verdict = "deny",
                                    !.by = "rule", !.ruleVerdict = "deny",
                                    !.denySeen = TRUE, !.ruleMode = mode]
       ELSE IF call.askRule /\ mode = "plan" /\ call.risk # "readonly"
         (* evaluate.ts plan wrap: a leftover ask on a mutating call in plan   *)
         (* mode is a deny.                                                   *)
         THEN /\ call' = [call EXCEPT !.phase = "done", !.verdict = "deny",
                                      !.by = "rule", !.ruleVerdict = "deny",
                                      !.denySeen = TRUE, !.ruleMode = mode]
       ELSE IF call.askRule
         THEN /\ call' = [call EXCEPT
                  !.phase = IF ArbitrateRuleAsk THEN "eligible" ELSE "asked",
                  !.ruleVerdict = "ask", !.ruleMode = mode]
         ELSE IF ~Suspended(call.shape, cas) \/ HonorSuspendedRule
           THEN /\ call' = [call EXCEPT !.phase = "done", !.verdict = "allow",
                                        !.by = "rule", !.ruleVerdict = "allow",
                                        !.ruleSuspended = Suspended(call.shape, cas),
                                        !.executed = TRUE, !.ruleMode = mode]
           ELSE IF mode = "plan" /\ call.risk # "readonly"
             (* the same wrap over a leftover passthrough.                      *)
             THEN /\ call' = [call EXCEPT !.phase = "done", !.verdict = "deny",
                                          !.by = "rule", !.ruleVerdict = "deny",
                                          !.denySeen = TRUE, !.ruleMode = mode]
             ELSE /\ call' = [call EXCEPT !.phase = "staged",
                                          !.ruleVerdict = "pass", !.ruleMode = mode]
  /\ UNCHANGED <<mode, cas, sessionAllow, grant, denyStreak, breaker, tripped>>

(* GrantFirst models consulting the grant before the waterfall: a grant then *)
(* survives a matching deny rule.                                           *)
GrantFirstAllow ==
  /\ GrantFirst
  /\ grant
  /\ call.phase = "deciding"
  /\ call' = [call EXCEPT !.phase = "done", !.verdict = "allow",
                              !.by = "grant", !.executed = TRUE,
                              !.denySeen = call.denyRule]
  /\ UNCHANGED <<mode, cas, sessionAllow, grant, denyStreak, breaker, tripped>>

(* Stage 3: a matched grant is a deterministic allow; it never lifts a deny, *)
(* a non-LOW risk or plan mode, which is why it is reachable only after an  *)
(* ask or a passthrough.                                                    *)
GrantAllow ==
  /\ grant
  /\ call.phase \in {"asked", "staged"}
  (* task-grant-service.ts:191: never over a non-LOW risk and never in plan. *)
  /\ \/ IgnoreGrantCeiling
     \/ (call.risk = "low" /\ mode # "plan")
  /\ call' = [call EXCEPT !.phase = "done", !.verdict = "allow",
                              !.by = "grant", !.executed = TRUE,
                              !.appliedMode = mode]
  /\ UNCHANGED <<mode, cas, sessionAllow, grant, denyStreak, breaker, tripped>>

(* Stage 5: a session allow covers a rule ask outside plan mode.             *)
SessionAllowOnAsk ==
  /\ call.phase = "asked"
  /\ sessionAllow
  /\ mode # "plan"
  /\ call' = [call EXCEPT !.phase = "done", !.verdict = "allow",
                              !.by = "session", !.executed = TRUE]
  /\ UNCHANGED <<mode, cas, sessionAllow, grant, denyStreak, breaker, tripped>>

(* mapPostWaterfall: a MEDIUM passthrough is covered by a session allow.     *)
SessionAllowMedium ==
  /\ call.phase \in {"asked", "staged"}
  /\ call.risk = "medium"
  /\ sessionAllow
  /\ mode # "plan"
  /\ call' = [call EXCEPT !.phase = "done", !.verdict = "allow",
                              !.by = "session", !.executed = TRUE]
  /\ UNCHANGED <<mode, cas, sessionAllow, grant, denyStreak, breaker, tripped>>

ToEligible ==
  /\ call.phase = "staged"
  /\ call' = [call EXCEPT !.phase = "eligible"]
  /\ UNCHANGED <<mode, cas, sessionAllow, grant, denyStreak, breaker, tripped>>

(* Stage 4 entry: the classifier arbitrates only the auto/passthrough/       *)
(* LOW-or-MEDIUM/not-read-only slice. ArbitrateRuleAsk widens it to a rule   *)
(* ask as well, which is the fault the S-3 probe targets.                    *)
StartClassify ==
  /\ call.phase = "eligible"
  /\ mode = "auto"
  /\ call.risk \in {"low", "medium"}
  /\ ~call.clsUsed
  /\ StageArmed
  /\ breaker = "closed"
  /\ \/ call.ruleVerdict = "pass"
     \/ (/\ ArbitrateRuleAsk
         /\ call.ruleVerdict = "ask")
  /\ call' = [call EXCEPT !.phase = "classifying", !.classifyMode = mode,
                              !.cls = "none"]
  /\ UNCHANGED <<mode, cas, sessionAllow, grant, denyStreak, breaker, tripped>>

(* Stage-eligible but unavailable: fail to the human prompt, never a silent  *)
(* allow.                                                                   *)
StageUnavailable ==
  /\ call.phase = "eligible"
  /\ mode = "auto"
  /\ call.risk \in {"low", "medium"}
  /\ breaker = "open"
  /\ call' = [call EXCEPT !.phase = "awaitHuman", !.cls = "breaker",
                              !.verdict = "ask", !.by = "llm"]
  /\ UNCHANGED <<mode, cas, sessionAllow, grant, denyStreak, breaker, tripped>>

(* The stage is composed but unarmed: an eligible call still fails to the     *)
(* human prompt (auto-stage.ts:344-345).                                    *)
StageUnarmed ==
  /\ call.phase = "eligible"
  /\ mode = "auto"
  /\ call.risk \in {"low", "medium"}
  /\ ~StageArmed
  /\ ~call.clsUsed
  /\ call' = [call EXCEPT !.phase = "awaitHuman", !.cls = "unarmed",
                              !.verdict = "ask", !.by = "llm", !.clsUsed = TRUE]
  /\ UNCHANGED <<mode, cas, sessionAllow, grant, denyStreak, breaker, tripped>>

ToHuman ==
  /\ call.phase = "eligible"
  /\ \/ mode # "auto"
     \/ call.risk = "readonly"
     \/ call.risk = "high"
  /\ call' = [call EXCEPT !.phase = "awaitHuman"]
  /\ UNCHANGED <<mode, cas, sessionAllow, grant, denyStreak, breaker, tripped>>

(* The verdict arrives. A verdict computed under a mode that has since       *)
(* changed is discarded and the call is re-staged; ApplyStaleMode applies it *)
(* anyway.                                                                  *)
SettleStale ==
  /\ ~ApplyStaleMode
  /\ call.phase = "classifying"
  /\ mode # call.classifyMode
  (* a discarded verdict falls through to the post-waterfall human prompt; the *)
  (* stage is one-shot, so the call is never re-classified                  *)
  /\ call' = [call EXCEPT !.phase = "awaitHuman", !.cls = "none",
                              !.verdict = "ask", !.by = "llm", !.clsUsed = TRUE]
  /\ UNCHANGED <<mode, cas, sessionAllow, grant, denyStreak, breaker, tripped>>

SettleApply ==
  /\ call.phase = "classifying"
  /\ \/ ApplyStaleMode
     \/ mode = call.classifyMode
  /\ \E o \in ClsOutcomes :
       /\ o # "none"
       /\ call' =
            IF o = "allow"
              THEN [call EXCEPT !.phase = "done", !.cls = o,
                                 !.verdict = "allow", !.by = "llm",
                                 !.executed = TRUE, !.appliedMode = mode]
            ELSE IF o = "deny"
              THEN [call EXCEPT !.phase = "done", !.cls = o,
                                 !.verdict = "deny", !.by = "llm",
                                 !.appliedMode = mode]
            ELSE IF SilentAllowFailure /\ o # "ask"
              THEN [call EXCEPT !.phase = "done", !.cls = o,
                                 !.verdict = "allow", !.by = "llm",
                                 !.executed = TRUE, !.appliedMode = mode]
              ELSE [call EXCEPT !.phase = "awaitHuman", !.cls = o,
                                 !.verdict = "ask", !.by = "llm",
                                 !.appliedMode = mode]
  /\ IF call'.verdict = "deny" /\ call'.phase = "done"
       THEN /\ denyStreak' = IF denyStreak >= MaxDenies
                                THEN MaxDenies
                                ELSE denyStreak + 1
            /\ tripped' = (denyStreak + 1 >= MaxDenies)
            /\ IF tripped' /\ ~NoBackstopTrip THEN mode' = "default" ELSE mode' = mode
       ELSE /\ denyStreak' = denyStreak
            /\ tripped' = tripped
            /\ mode' = mode
  /\ UNCHANGED <<cas, sessionAllow, grant, breaker>>

(* Stage 6: the engine's own approval seam.                                 *)
HumanDecide ==
  /\ call.phase \in {"asked", "awaitHuman"}
  /\ \E ok \in BOOLEAN :
       /\ call' = IF ok
            THEN [call EXCEPT !.phase = "done", !.verdict = "allow",
                               !.by = "human", !.executed = TRUE]
            ELSE [call EXCEPT !.phase = "done", !.verdict = "deny",
                               !.by = "human"]
       /\ UNCHANGED <<mode, cas, sessionAllow, grant, denyStreak, breaker, tripped>>

(* ------------------------------------------------------------- safety *)

TypeOK ==
  /\ mode \in Modes
  /\ cas \in BOOLEAN
  /\ sessionAllow \in BOOLEAN
  /\ grant \in BOOLEAN
  /\ denyStreak \in 0..MaxDenies
  /\ breaker \in Breakers
  /\ tripped \in BOOLEAN
  /\ call \in CallType

(* S-1: a call that reached a deny anywhere in the pipeline never executes.  *)
(* Deny dominance is what makes the short-circuits meaningful.               *)
NoExecAfterDeny == Executed => ~call.denySeen

(* S-2: an LLM-authorized execution came from an actual allow verdict; every *)
(* classifier failure (timeout, malformed, breaker, unarmed) yields a prompt. *)
FailToPrompt == Executed /\ call.by = "llm" => call.cls = "allow"

(* S-3: a rule-derived ask is never arbitrated by the model; executing it    *)
(* requires a session grant or a human.                                     *)
RuleAskNeedsHuman ==
  Executed /\ call.ruleVerdict = "ask" => call.by \in {"session", "human", "grant"}

(* S-4: a verdict is applied only against the mode it was computed under.    *)
StaleVerdictOnly ==
  Executed /\ call.by = "llm" => call.classifyMode = call.appliedMode

(* S-5: a suspended allow rule never authorizes.                            *)
SuspendedInert ==
  Executed /\ call.by = "rule" => ~call.ruleSuspended

(* S-6: the deny backstop leaves auto mode before the next call executes.    *)
BackstopHolds == tripped => mode # "auto"

(* S-7: a grant never executes a non-LOW risk or a plan-mode call.          *)
GrantCeiling ==
  Executed /\ call.by = "grant" => (call.risk = "low" /\ call.appliedMode # "plan")

(* S-8: plan mode never executes a mutating call.                           *)
PlanWrapSound ==
  Executed /\ call.ruleMode = "plan" =>
    (call.risk = "readonly" \/ call.ruleVerdict = "allow")

(* --------------------------------------------------------------- spec *)

Idle ==
  /\ call.phase = "done"
  /\ UNCHANGED vars

Next ==
  \/ Idle
  \/ ModeChange \/ ToggleCas \/ SessionAllowAdd \/ GrantSet
  \/ BreakerTrip \/ BreakerReset
  \/ NewCall \/ RiskHighDeny \/ BeginRules \/ BypassAllow \/ EvaluateRules
  \/ GrantFirstAllow \/ GrantAllow \/ SessionAllowOnAsk \/ SessionAllowMedium
  \/ ToEligible \/ StartClassify \/ StageUnavailable \/ StageUnarmed
  \/ ToHuman \/ SettleStale \/ SettleApply \/ HumanDecide

Spec == Init /\ [][Next]_vars

=============================================================================
