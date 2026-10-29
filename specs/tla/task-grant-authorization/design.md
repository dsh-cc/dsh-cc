# Design: task-grant-authorization (task grant x escalation re-validation; disagreement authority)

Model directory: `specs/tla/task-grant-authorization`. Module `Model`, spec
`Spec`, safety-only (no fairness; no liveness claim).

## Formal design screening

- mode: **auto** (session-scoped)
- decision: **enabled**
- triggerIds: FD-T4 (authorization across asynchronous changes: a decide-time
  registration authorizes an approval that happens later, and the grant may be
  revoked or expire in between), FD-T2 (retried/duplicate escalation requests;
  one-shot consumption), FD-T1 (agent lane, approval lane and human lane act on
  one shared grant/registry/adjudication state).
- backends: `["tla"]`. The budget arithmetic of the same design is modeled by
  the `vwa-review-cycle` extension; the permission *composition* predicate
  itself is deterministic and is covered by exhaustive differential tests, not
  a Lean proof (recorded as a scope decision below).
- modelDirs: `{"tla": "specs/tla/task-grant-authorization"}`
- rationale: the design's security master invariant ("the agent can never
  authorize itself, and can never forge human adjudication") is exactly a
  claim about which actor may move which state, under revocation races.
- rule source: **session request** ("按1-3开工", 2026-10-29). The effective
  project rules carry no formal-design screening clause at this revision, so
  this is session-scoped adoption, not a project default
  (manual adoption: `<skill>/references/agents-snippet.md`).
- behavioral source: `docs/plans/2026-10-28-vwa-batch-autonomous-review.md`
  §3.4-§3.5 (grant consumption, escalation registry, branch guard, mode
  ceiling) and §4.3-§4.4 (deferred disagreement, adjudication semantics).
  Existing code that constrains it: `approval-listener.ts:47-73` (auto
  `allowed-once` for sandbox escalations), `escalation.ts:186-198` in the
  harness (reason carries the requested mode and a `callId`),
  `delivery-check.ts:44-53` (adjudication liveness), `report.ts:346-360`
  (`adjudications.json`, string `signer`), `runtime-code.ts:165-172` (fixed
  approval payload — no `kind` field).

## Requirements

- **REQ-1** An auto-approval happens only for a call that was gated by an
  active task grant covering it, while that grant is still live at approval
  time.
- **REQ-2** One registration authorizes at most one approval (one-shot
  consumption); a duplicate or replayed escalation never approves twice.
- **REQ-3** The approved escalation never exceeds the grant's mode ceiling.
- **REQ-4** The approval respects the branch guard (HEAD branch at approval
  equals the grant's branch).
- **REQ-5** No adjudication record can exist without the human lane
  (`signer` is never minted by the agent).
- **REQ-6** An unresolved dispute never yields reviewed eligibility; `accept`
  keeps the finding's force (`Eligible` only for a human `reject`).

## State variables

| Variable | Meaning |
|---|---|
| `grant` | grant lifecycle: `none / active / revoked / expired` (user lane creates; goal completion or manual revoke expires) |
| `reg` | escalation registry: `empty / entry / consumed` for the current call |
| `call` | current call slice: command, state, whether it was gated (`witness`), whether the grant was live at approval, approvals count, requested mode, call branch |
| `adj`, `signer` | disagreement state and who signed the adjudication |
| `promoted` | the (fault-only) eligibility promotion flag |
| `clock` | a bounded tick counter so approval and replay are distinguishable in traces |

The grant's capability face is abstracted to "covers `c1` only"; its ceiling
is **grant state** set when the grant is created (`workspace-write` or
`danger-full-access`) — modeling it as a per-case constant made every
ceiling probe vacuous, which the probe run caught; its branch is fixed `b1`.

## Coverage matrix

| Requirement ID | Business outcome | Property ID | TLA operator | Case IDs and bounds | Fault-or-race trace | Assumption IDs | Planned code symbol and atomicity mechanism | Regression scenario | Exclusion and justification |
|---|---|---|---|---|---|---|---|---|---|
| REQ-1 | no auto-approval outside a live covering grant | S-1 `NoUngrantedAutoApproval` | `NoUngrantedAutoApproval` | convention (2 commands, 2 branches, 2 modes); strict-skip-grant-check (blanket auto-allow, expected red); strict-stale-registry (approval after revoke on a stale registration, expected red) | Decide → RevokeGrant → Escalate → ApproveAuto | A-1, A-2 | task-grant match in `tools/pre-execute` before `autoStage.maybeEscalate`; approval-listener re-checks the live grant (`approval-listener.ts:56-73`) | revoke the grant between decision and escalation; assert the user is asked instead | the shell-evaluation composition (rules x segments x token boundary) is E-1 |
| REQ-2 | one approval per registration | S-2 `OneApprovalPerCall` | `OneApprovalPerCall` | convention; strict-replay (ConsumeOnce=FALSE, expected red) | ApproveAuto → ReplayApproval on the same entry | A-3 | registry entry deleted on use (`§3.5` one-shot consumption, all terminal paths) | deliver the same escalation twice; assert one approval | registry TTL expiry is E-2 |
| REQ-3 | the mode ceiling is never exceeded | S-3 `ModeWithinCeiling` | `ModeWithinCeiling` | convention; strict-ceiling (IgnoreCeiling=TRUE, expected red) | approve a `danger-full-access` request under a `workspace-write` grant | A-4 | modeCeiling parsed from the `escalate sandbox to <mode>:` reason (`escalation.ts:192`) | request full access under a default-ceiling grant | reason forms outside the known prefix are fail-closed to the user (documented, not a switch) |
| REQ-4 | branch guard holds at approval | S-4 `BranchGuardHolds` | `BranchGuardHolds` | convention; strict-branch (IgnoreBranch=TRUE, expected red) | escalate from branch `b2` under a `b1` grant | A-5 | listener spawns `git rev-parse --abbrev-ref HEAD` (out of process) | switch branches after the grant; assert the approval is refused | the pid/branch probe's own failure mode is E-3 |
| REQ-5 | no forged human adjudication | S-5 `NoForgedAdjudication` | `NoForgedAdjudication` | convention; strict-forged-adjudication (AgentCanForge=TRUE, expected red) | the agent writes `adjudications.json` with `signer:"user"` | A-6 | adjudication only through the `/vwa` command lane (`report.ts:346-360` today only checks the string) plus the §3.7 default-ask rule on `.dsh/vwa/**` | agent attempts to write an adjudication record | hardening the `signer` provenance itself is an open design item (§3.7 note), not modeled here |
| REQ-6 | deferred never promotes; accept keeps the block | S-6 `DeferredNeverPromoted`, S-7 `EligibilitySound` | `DeferredNeverPromoted`, `EligibilitySound` | convention; strict-deferred-flip (WrongDeferFlip=TRUE, expected red) | deferred mode promotes eligibility while the dispute is unresolved | A-7 | delivery-check post-pass (`excludedFromForce`) + `Eligible` predicate (§4.4) | resolve a dispute with `accept`; assert `eligible` stays false | the report overlay's rendering is E-4 |

## Assumptions

- **A-1** The approval payload carries the execution identity needed to find
  the registration (`callId` is present for `approveEscalation` —
  `escalation.ts:189`). If it is absent the implementation falls back to the
  user; the model does not claim authorization in that case (see E-2).
- **A-2** The grant is created only by the user lane (§3.3) — the model gives
  `CreateGrant` no agent-side enabling action; the design's dropped
  agent-ask path is why.
- **A-3** Registry mutation (entry creation/consumption) is a single
  in-memory map operation under one event-loop turn; there is no await between
  the check and the delete.
- **A-4** The requested mode is fully determined by the escalation reason text
  at approval time (verified shape at `escalation.ts:192`).
- **A-5** `git rev-parse --abbrev-ref HEAD` reports the branch of the granted
  worktree root, executed out of process by the listener.
- **A-6** Only the command lane writes `adjudications.json` (single writer).
- **A-7** The deferred-mode post-pass and the eligibility predicate run in one
  synchronous delivery-check evaluation.

## Faults modeled (one switch each)

| Switch | Models | Expected probe |
|---|---|---|
| `SkipGrantCheck` | today's blanket auto-allow for sandbox escalations | strict-skip-grant-check (red on S-1) |
| `UseRegistryOnly` | trusting a registration without re-checking the live grant | strict-stale-registry (red on S-1) |
| `ConsumeOnce = FALSE` | forgetting to delete the registry entry | strict-replay (red on S-2) |
| `IgnoreCeiling` | dropping the mode ceiling re-validation | strict-ceiling (red on S-3) |
| `IgnoreBranch` | dropping the branch guard | strict-branch (red on S-4) |
| `AgentCanForge` | an agent lane able to mint a human-signed adjudication | strict-forged-adjudication (red on S-5) |
| `WrongDeferFlip` | deferred mode promoting eligibility early | strict-deferred-flip (red on S-6) |

## Exclusions

- **E-1** the shell-rule composition (bare-prefix matching with token
  boundaries, per-segment admissibility, `git -c` rejection, structured push
  argv matching) is deterministic string logic; it is covered by exhaustive
  differential tests against the existing evaluator, and a Lean proof would
  require extracting a pure reference predicate from an IO-coupled matcher.
  Recorded as a scoped decision: **not modeled** here.
- **E-2** registry TTL and the missing-`callId` fallback: both only *reduce*
  the set of auto-approvals (fall back to the user), so they cannot violate
  S-1..S-4; the implementation test asserts the fallback.
- **E-3** the branch-probe failure mode (git error) falls back to the user by
  construction; no property depends on it.
- **E-4** the report's adjudication overlay rendering (as-of re-render) is a
  deterministic projection; the authority claim (S-5) is what matters and is
  modeled.
- **E-5** contentScope (`tracked-md-only`) staging inspection is a git-output
  parser; it is post-hoc for `commit -a` by design (see the batch-run model's
  "known residual") and cannot be modeled as an ordering claim.
