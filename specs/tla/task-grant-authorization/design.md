# Design: task-grant-authorization v2 (task grant x escalation re-validation; disagreement authority)

Model directory: `specs/tla/task-grant-authorization`. Module `Model`, spec
`Spec`, safety-only. This is the v2 rewrite after the three-lane model review.

## Formal design screening

- mode: **auto** (session-scoped; no formal-design screening clause in the
  effective project rules at this revision).
- decision: **enabled**
- triggerIds: FD-T4 (authorization across asynchronous changes: the git
  branch probe and grant revocation interleave with the approval), FD-T2
  (duplicate/replayed escalations; one-shot consumption), FD-T1 (agent lane,
  approval lane, human lane on one shared registry/grant state).
- backends: `["tla"]`, modelDirs:
  `{"tla": "specs/tla/task-grant-authorization"}`.
- behavioral source: `docs/plans/2026-10-28-vwa-batch-autonomous-review.md`
  §3.4-§3.6 (grant consumption, escalation, contentScope) and §4.3-§4.4
  (deferred disagreement, adjudication). The feature is **not implemented
  yet**; existing code that constrains it: `approval-listener.ts:56-73`
  (today's blanket `allowed-once` — the PRESERVED baseline, NOT the planned
  seam), harness `escalation.ts:186-198` (the approval request carries
  `callId` at :191 and the reason embeds the requested mode at :192),
  `report.ts:346-360` (`adjudications.json`, string `signer`),
  `delivery-check.ts:44-53` (adjudication liveness).

## Requirements

- **REQ-1a** A gated call (registered under a live covering grant) is
  auto-approved only while that grant is still live AT CONSUME TIME (after
  the out-of-process git probe); it never falls back to the blanket
  baseline.
- **REQ-1b** The preserved blanket baseline (today's listener) only applies
  when no grant is active at consume time — including grants created during
  the await window.
- **REQ-2** One registration authorizes at most one approval; a replayed or
  duplicate escalation never approves twice.
- **REQ-3** The approved mode never exceeds the grant's ceiling (grant-path
  approvals; the baseline has no ceiling).
- **REQ-4** The branch guard holds on the branch observed at consume time
  (the git probe reads the CURRENT head, not a decision-time value).
- **REQ-5** No adjudication is ever signed by anything but the human lane.
- **REQ-6** The effective force (the disagreement block) clears only on a
  human reject; unresolved and accept keep it; a deferred promotion while
  unresolved is impossible.
- **REQ-7** An approval consumes only the registration bound to its own
  execution (a stray entry belongs to someone else).
- **REQ-8** The contentScope gate held at approval (grant-path only).
- **REQ-9** Registrations die with their grant: a reborn grant (revoke →
  re-grant) never consumes a stale entry.

## State variables

| Variable | Meaning |
|---|---|
| `grant`, `grantCeiling` | grant lifecycle (`none/active/revoked/expired`) and its mode ceiling (set at creation) |
| `headBranch` | the CURRENT HEAD branch (changeable by `BranchCheckout` — models the user switching during the await) |
| `regSelf`, `regStray` | two registry slots: the call's own entry, and a foreign execution's entry |
| `call` | the current call slice: command, state (idle/decided/escalated/checking/approved/asked), witness, approvals, requested mode, modeOk/branchAt/contentOk recorded at consume, grantWasActive/underLiveGrant, consumedFrom |
| `adj`, `signer`, `force` | the dispute state, who signed, and the EFFECTIVE FORCE (`none/major/cleared`) — the disagreement block |

The grant's capability face is abstracted to "covers `c1` only"; its branch
is fixed `b1`.

## Coverage matrix

| Requirement ID | Business outcome | Property ID | TLA operator | Case IDs and bounds | Fault-or-race trace | Assumption IDs | Planned code symbol and atomicity mechanism | Regression scenario | Exclusion and justification |
|---|---|---|---|---|---|---|---|---|---|
| REQ-1a | a gated approval happens only under a live grant at consume | S-1a `GrantPathSound` | `GrantPathSound` | convention; strict-stale-registry (expected red) | Decide(c1) → Escalate → ApproveCheck → RevokeGrant → ApproveConsume without re-validation | A-1, A-2 | the approval-listener re-reads the live grant AFTER the git probe (§3.5); the registry entry is invalidated when the grant dies | revoke between check and consume; assert the user is asked | — |
| REQ-1b | the baseline only applies with no active grant | S-1b `BaselineOnlyWithoutActiveGrant` | `BaselineOnlyWithoutActiveGrant` | convention; strict-skip-grant-check (expected red: an UNCOVERED call under an ACTIVE grant) | Decide(c2, grant active) → Escalate → blanket approve | A-3 | §3.5 fallback: while any grant is active, unregistered escalations go to the user | an uncovered command while a grant is active; assert ask | the baseline itself is today's `approval-listener.ts:60-72` (preserved) |
| REQ-2 | one approval per registration | S-2 `OneApprovalPerCall` | `OneApprovalPerCall` | convention; strict-replay (expected red) | ApproveConsume → ReplayApproval on the same entry | A-4 | registry entry deleted on use (one-shot, all terminal paths) | deliver the same escalation twice | TTL expiry is E-2 |
| REQ-3 | the ceiling holds at consume | S-3 `ModeWithinCeiling` | `ModeWithinCeiling` (grant-path only) | convention; strict-ceiling (expected red) | approve a `danger-full-access` request under a `workspace-write` grant | A-5 | mode parsed from the `escalate sandbox to <mode>:` reason (`escalation.ts:192`), checked against `grantCeiling` | request full access under a default-ceiling grant | reason forms outside the known prefix fail closed (documented) |
| REQ-4 | the branch guard holds on the observed head | S-4 `BranchGuardHolds` | `BranchGuardHolds` (grant-path only) | convention; strict-branch (expected red) | decide on b1 → checkout b2 during the await → approve at b2 | A-6 | listener spawns `git rev-parse --abbrev-ref HEAD` (out of process) and checks it at consume | switch branches after the grant; assert refused | probe failure falls back to the user (E-3) |
| REQ-5 | no forged adjudication | S-5 `NoForgedAdjudication` | `NoForgedAdjudication` | convention; strict-forged-adjudication (expected red) | the agent writes `adjudications.json` with `signer:"user"` | A-7 | `/vwa` command lane is the only writer (report.ts:346-360 today checks only the string) + §3.7 default-ask on `.dsh/vwa/**` | agent attempts to write an adjudication | the `signer` provenance hardening itself is a design note, not modeled |
| REQ-6 | force only clears on a human reject | S-6 `ForceSound` | `ForceSound` | convention; strict-deferred-flip and strict-accept-clears (both expected red) | promotion while unresolved; accept clearing the block | A-8 | delivery-check post-pass: `excludedFromForce` + the `Eligible` predicate (§4.4) | resolve with accept; assert eligible stays false | the report overlay rendering is E-4 |
| REQ-7 | only the own entry is consumed | S-7 `NoCrossConsume` | `NoCrossConsume` | convention; strict-cross-consume (expected red) | a stray registration present; the fault consumes it | A-1 | the registry is keyed by execution identity (the design's executionToken+commandHash; the model abstracts identity to slot ownership) | two gated executions; assert each consumes its own | the token/hash keying itself is an implementation obligation (A-1) |
| REQ-8 | the contentScope gate held | S-8 `ContentGateSound` | `ContentGateSound` (grant-path only) | convention; strict-skip-content-gate (expected red) | approve with non-conforming staged content | A-9 | §3.6 pre-check (`diff --cached -z --name-status`) | commit a non-.md file; assert the approval is refused | the parser is E-5 |
| REQ-9 | registrations die with their grant | structural (in the Revoke/Expire/Reset actions) | — | convention | grant dies → entry survives → a reborn grant consumes it | A-1 | registry entries are cleared on grant death (revoke/expiry) | revoke, re-grant, replay the escalation; assert ask | — |

## Assumptions

- **A-1** The harness approval request carries `callId`
  (`escalation.ts:191`) and the listener can correlate it to its
  registration. The design's STRONGER binding (execution token + command
  hash) is an implementation obligation the model abstracts as slot
  ownership; with only `callId` the correlation is the best available.
- **A-2** Registry invalidation on grant death is a single synchronous map
  mutation in the same event-loop turn as the revoke.
- **A-3** The grant is created only by the user lane (§3.3).
- **A-4** Registry consumption is a single synchronous map operation.
- **A-5** The requested mode is fully determined by the escalation reason
  text at approval time.
- **A-6** `git rev-parse --abbrev-ref HEAD` reports the granted worktree's
  current branch, spawned out of process by the listener.
- **A-7** Only the command lane writes `adjudications.json`.
- **A-8** The deferred post-pass and the eligibility predicate run in one
  synchronous delivery-check evaluation.
- **A-9** The staged-content inspection is a truthful summary (git `-z`).

## Faults modeled (one switch per probe)

| Switch | Models | Probe |
|---|---|---|
| `SkipGrantCheck` | blanket-approving an uncovered call under an active grant | strict-skip-grant-check |
| `UseStaleAfterGit` | consuming a registration without re-validating the live grant (entry + grant snapshot trusted) | strict-stale-registry |
| `ConsumeOnce = FALSE` | the entry is not deleted on use | strict-replay |
| `IgnoreCeiling` | dropping the ceiling re-validation | strict-ceiling |
| `IgnoreBranch` | dropping the branch guard | strict-branch |
| `AgentCanForge` | an agent lane minting a human-signed adjudication | strict-forged-adjudication |
| `WrongDeferFlip` | deferred mode promoting eligibility while unresolved | strict-deferred-flip |
| `WrongAcceptClears` | accept clearing the block | strict-accept-clears |
| `CrossConsume` | consuming another execution's registration | strict-cross-consume |
| `SkipContentGate` | approving non-conforming staged content | strict-skip-content-gate |

## Exclusions

- **E-1** the shell-rule composition (deterministic string logic, differential
  tests; a Lean model would need a pure reference predicate extracted from
  the IO-coupled matcher — recorded as a scoped decision).
- **E-2** registry TTL and the missing-`callId` fallback (both only shrink
  the auto-approval set; implementation tests).
- **E-3** the branch-probe failure path (falls back to the user by
  construction).
- **E-4** the report's adjudication overlay rendering (deterministic
  projection).
- **E-5** the contentScope `-z` parser.
- **E-6** liveness (eventual user answer after a forced fallback) — no
  fairness is claimed.
