# Design: auto-approval-pipeline (auto-mode authorization for one tool call)

Model directory: `specs/tla/auto-approval-pipeline`. Module `Model`, spec
`Spec`, safety-only. First model of the authorization pipeline; no production
change. The TaskGrant surface is out of scope here — it is already modeled by
`specs/tla/task-grant-authorization`, and this model treats a grant hit as an
opaque allow event.

## Formal design screening

- mode: **auto** (session-scoped; the project rules carry no formal-design
  screening clause at this revision — session request "model the auto-mode
  approval pipeline" 2026-11-03, manual adoption snippet at
  `<skill>/references/agents-snippet.md`).
- decision: **enabled**
- triggerIds: FD-T1 (the pipeline, the settings writer and the human approver
  act on one shared decision), FD-T4 (authorization and the session/grant state
  change asynchronously while a classifier verdict is in flight).
- backends: `["tla"]`, modelDirs: `{"tla": "specs/tla/auto-approval-pipeline"}`.
- behavioural source: current code —
  `packages/interaction/permission-rules/src/pre-execute.ts:335-372`,
  `decide.ts:130-234`, `evaluate.ts:85-154`, `auto-rule-filter.ts:86-160`,
  `auto-stage.ts:343-476`, `classifier-breaker.ts:140-150`,
  `llm-classifier.ts:301-331,425-439`, `approval-listener.ts:98-144`,
  `session-allowlist.ts:68-123`, `task-grant-service.ts:191-237`.

## Requirements

- **REQ-1 (deny dominance)** A call that met a deny anywhere — HIGH risk, a
  deny rule, a bypass-immune rule — never executes, whatever runs later.
- **REQ-2 (fail to prompt)** Every classifier failure (timeout, malformed,
  error, breaker open, unarmed, stale verdict) yields a prompt or a discard,
  never a silent allow.
- **REQ-3 (arbitration scope)** The model arbitrates only the auto ∧
  passthrough ∧ LOW-or-MEDIUM ∧ not-read-only slice; a rule-derived ask is
  resolved by a session grant or a human, never by the classifier.
- **REQ-4 (stale verdict)** A verdict is applied only against the mode it was
  computed under (`auto-stage.ts:402-416`).
- **REQ-5 (suspension inert)** A suspended allow rule never authorizes
  (`auto-rule-filter.ts:86-104`).
- **REQ-6 (backstop)** After the consecutive-deny backstop trips, the session
  is no longer in auto when the next call executes (`auto-stage.ts:447-469`).
- **REQ-7 (grant ceiling)** A grant never lifts a deny, a non-LOW risk or plan
  mode (`task-grant-service.ts:191`). The deny half is structural — a grant is
  reachable only after an ask or a passthrough — and the risk/mode half is a
  guard on the grant action itself.
- **REQ-8 (plan is read-only)** In plan mode the waterfall denies a mutating
  leftover ask or passthrough (`evaluate.ts:77-81`, `:227-231`).
- **REQ-9 (bypass immunity)** A bypass-immune deny holds in every mode,
  including bypassPermissions. The real enforcement is the monotonic guard
  layer after pre-execute; the model applies its effect at the rule stage
  (E-1).

## State variables

| Variable | Meaning |
|---|---|
| `mode` | session permission mode (auto/default/plan/bypass) |
| `cas` | `permissions.autoMode.classifyAllShell` |
| `sessionAllow` | a session-scoped allow exists that covers this call class |
| `grant` | a live task grant covers this call (opaque, imported) |
| `breaker` | classifier route breaker (closed/open) |
| `denyStreak`, `tripped` | consecutive deny verdicts and the backstop trip |
| `call` | the in-flight call record: risk, rule facts, rule verdict, classify mode/outcome, verdict, source, executed |

Atomicity mapping: the rule waterfall is one deterministic evaluation over the
call's rule facts and the live suspension filter; the classifier stage is the
only asynchronous window, so every environment action (mode change, settings
change, session grant, breaker trip) is interleavable inside it.

## Coverage matrix

| Requirement ID | Business outcome | Property ID | TLA operator | Case IDs and bounds | Fault-or-race trace | Assumption IDs | Planned code symbol and atomicity mechanism | Regression scenario | Exclusion and justification |
|---|---|---|---|---|---|---|---|---|---|
| REQ-1 | no execution after any deny | S-1 `NoExecAfterDeny` | `NoExecAfterDeny` | convention; strict-grant-first (expected red) | grant consulted before the waterfall over a matching deny rule | A-1 | `decide.ts:133-140` HIGH short-circuit, `evaluate.ts:85-154` deny-first ordering | a deny rule plus a live grant | — |
| REQ-2 | no silent allow on classifier failure | S-2 `FailToPrompt` | `FailToPrompt` | convention; strict-silent-allow-failure (expected red) | timeout verdict applied as allow | A-2 | `auto-stage.ts:357-393`, `llm-classifier.ts:425-439` | classifier timeout/malformed/breaker | — |
| REQ-3 | the model never arbitrates a rule ask | S-3 `RuleAskNeedsHuman` | `RuleAskNeedsHuman` | convention; strict-arbitrate-rule-ask (expected red) | classifier allow applied to a rule-derived ask | A-3 | `auto-stage.ts:349-352` eligibility guard | rule asks stay deterministic | — |
| REQ-4 | a stale verdict is discarded | S-4 `StaleVerdictOnly` | `StaleVerdictOnly` | convention; strict-apply-stale-mode (expected red) | mode changes during the await, verdict applied anyway | A-4 | `auto-stage.ts:402-416` re-fold and `stale-mode` audit | flip mode mid-classification | — |
| REQ-5 | suspended rules stay inert | S-5 `SuspendedInert` | `SuspendedInert` | convention; strict-honor-suspended (expected red) | a `node …`/whole-tool/subagent allow authorizes under auto | A-5 | `auto-rule-filter.ts:86-104` predicate, applied at `decide.ts:152-157` | an "always allow" derived rule that is suspended | — |
| REQ-6 | the backstop leaves auto | S-6 `BackstopHolds` | `BackstopHolds` | convention; strict-no-backstop-trip (expected red) | trip recorded, mode unchanged | A-6 | `auto-stage.ts:447-469` + `pauseAuto` | three consecutive deny verdicts | — |
| REQ-7 | a grant never executes a non-LOW or plan-mode call | S-7 `GrantCeiling` | `GrantCeiling` | convention; strict-ignore-grant-ceiling (expected red) | the grant guard dropped: a MEDIUM call executes by grant | A-1 | `task-grant-service.ts:191` eligibility gate (risk = LOW, mode != plan) | grant plus a MEDIUM call | the deny half is structural; escalation semantics live in `task-grant-authorization` |
| REQ-8 | plan mode executes nothing mutating | S-8 `PlanWrapSound` | `PlanWrapSound` | convention | a mutating passthrough reaching the human prompt in plan mode | A-1 | `evaluate.ts:77-81` plan wrap inside the waterfall | plan mode plus a mutating ask | the plan overlay itself is E-6 |
| REQ-9 | bypassPermissions never overrides a bypass-immune deny | S-1 (`denySeen` under bypass) | `BypassImmuneDeny` | convention | a bypass-immune call under bypassPermissions | A-7 | monotonic guard layer after `pre-execute` (`decide.ts:150-157` passes an empty set) | bypassPermissions plus a critical deny | the guard layer's mounting point is outside this package (E-1) |

## Assumptions

- **A-1** The rule waterfall is synchronous and re-evaluated per call from the
  live rule set; nothing between the risk classification and the waterfall can
  change its inputs (`decide.ts:130-171`).
- **A-2** Classifier outcomes are one of allow/ask/deny/timeout/malformed/
  unarmed, and the mapping from failure to ask is total (`llm-classifier.ts`).
- **A-3** The eligibility predicate is evaluated once at stage entry
  (`auto-stage.ts:343-352`).
- **A-4** The mode fold is readable at any point and cheap
  (`mode.ts:110-116`).
- **A-5** The suspension predicate is a pure function of the rule shape and
  `classifyAllShell` (`auto-rule-filter.ts:86-104`).
- **A-6** The deny counters are per session and append-only
  (`classifier-audit.ts:107-139`).

## Faults modeled (one switch per probe)

| Switch | Models | Probe |
|---|---|---|
| `GrantFirst` | consulting the grant before the waterfall | strict-grant-first |
| `SilentAllowFailure` | a classifier failure rendered as allow | strict-silent-allow-failure |
| `ArbitrateRuleAsk` | the classifier arbitrating a rule-derived ask | strict-arbitrate-rule-ask |
| `ApplyStaleMode` | applying a verdict computed under a stale mode | strict-apply-stale-mode |
| `HonorSuspendedRule` | a suspended allow rule still authorizing | strict-honor-suspended |
| `NoBackstopTrip` | recording the trip without leaving auto | strict-no-backstop-trip |
| `IgnoreGrantCeiling` | dropping the grant's risk/mode guard | strict-ignore-grant-ceiling |

## Bounds

One call at a time, `MaxDenies=2`, `StageArmed` in every case (the unarmed path
is exercised by `StageUnarmed`, not by a probe). A second concurrent call adds nothing here:
the two only share the classifier cache and the route breaker, and the breaker
is modeled as state (E-3).

## Exclusions

- **E-1** the bypass-immune monotonic guard layer: it is mounted after
  `tools/pre-execute` (`decide.ts:150-157` passes an empty set to the
  waterfall), so its decision is applied by the model at the rule stage
  (`BypassImmuneDeny`) rather than reproduced. The sandbox-escalation approval
  listener and the permission-request hook (`approval-listener.ts:98-144`)
  resolve an `approval/request` payload, not a tool-call verdict.
- **E-2** rule parsing and shell segment splitting (`parser.ts:18-41`,
  `splitShellCommand`): pure deterministic string logic, covered by
  `auto-rule-filter.spec.ts` and the parser tests.
- **E-3** the classifier verdict LRU and the breaker's half-open probe
  lifecycle (`classifier-breaker.ts:140-150`): the breaker is modeled as a
  state; probe admission is deterministic and covered by
  `classifier-breaker.spec.ts`.
- **E-4** the grader/System One lane (`gauge-stage.ts`): the same shape, one
  lane.
- **E-5** the post-execute verification (PI probe, grant post-hoc commit
  verification): not part of authorization.
- **E-6** the plan-mode overlay computation (`foldPlanMode`): modeled as the
  mode value; the deny wrap it produces is REQ-8 and is modeled.
- **E-7** the backstop's second trip rule (20 total deny verdicts,
  `classifier-audit.ts:107-108`) and its session-log seeding: only the
  consecutive rule is modeled, with `MaxDenies` standing for the configured
  threshold.
- **E-8** the `cd`/`ls` SAFE_SHORT_HEADS exemption (`auto-rule-filter.ts:69-83`):
  the `short` shape is suspended unconditionally, which over-suspends in the
  conservative direction. Relatedly, the model applies the suspension filter in
  every non-bypass mode while the code applies it only in auto
  (`decide.ts:150-152`); outside auto the model is therefore stricter than the
  code.
- **E-9** the D13 secondPass (an ask that may be reconfirmed as allow,
  `llm-classifier.ts:437-443`, default OFF): one more monotone-allow step that
  would need its own switch.
- **L-1** liveness (every call eventually settles) is excluded: the model has
  no fairness assumptions and the classifier await is unbounded by design.

## Code and test mapping

| Property | Code mechanism | Test pinning it |
|---|---|---|
| S-1 | deny-first ordering | `decide-verbose.spec.ts`, `task-grant-listener.spec.ts` |
| S-2 | failure → ask | `llm-classifier.spec.ts` (timeout/malformed), `auto-stage.spec.ts` (D11) |
| S-3 | eligibility guard | `auto-stage.spec.ts` (I1-I3/I5) |
| S-4 | stale-mode discard | `auto-stage.spec.ts` (A8) |
| S-5 | suspension predicate | `auto-rule-filter.spec.ts` |
| S-6 | backstop trip | `auto-stage.spec.ts` (S4/D5) |

## Open questions (not decided by this model)

1. Should the rule set be re-read after the classifier await, the way the mode
   is? Today only the mode is re-validated, so a deny rule added mid-flight
   does not apply to the in-flight call (documented, not modeled as a fault).
2. Is the cross-session verdict cache (keyed on input and slot digests, not on
   the session) intended?
3. Is the route breaker's process-global blast radius (session A's failures
   open the route for session B) intended?

Counterexample dispositions are recorded in `implementation.md`.
