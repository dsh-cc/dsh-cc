# acp-prompt-lifecycle — implementation record

Records run identities, observed code/test anchors, findings and workflow
state. Outside the input digest by design; routine observations go here, not
into design.md.

## First-use notice (screening)

Effective project rules in this session: the worktree root AGENTS.md is a
7-line self-forwarding stub (references CLAUDE.md, which symlinks back);
the full three-lane review protocol is not loadable from the effective
rules. Screening adoption: not confirmed; review rules: effectively
missing from the stub. Per the skill contract, missing review rules permit
modeling and checking but no claim of workflow approval or an invented
reviewer roster. The catalog also does not register a `formal-design` skill
this session; the repo-materialized copy at
`packages/plugin/dsh-cc-agents/skills/formal-design/` (delivered by PR
#285) is the runner actually invoked. The user's task requested
preflight/check/check-evidence and a report only — no formal review
dispatch was requested or performed.

## Scope selection

"当前 acp 相关设计" spans several candidates; the ACP session prompt
lifecycle (packages/acp/cc-acp/src/session.ts + codec.ts) is the only
candidate with protocol/state-machine behavior (single in-flight slot,
cancel/late-message ordering, teardown) per the FD-T1..T4 screening
triggers. Content mapping, MCP mounting, model control and preset
composition are deterministic computation/composition concerns that do
not trigger (recorded in design.md). This scoping is the main dialog's
screening decision, reported to the user for confirmation rather than
silently assumed.

## Runs

| Run | Command result | Notes |
|---|---|---|
| 20261025T093929Z-cb4ed610… | check: counterexample (invariant) | CancelWinsSettlement violated 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L245-L283〕 — my TLA+ authoring defect: PromptStart did not reset the settlement snapshot variables, so a prior prompt's snapCancel leaked into the next prompt. Fixed; run superseded. |
| 20261025T102355Z-3a73160a-ec57-4fb8-ba13-9e4b8ef455d2 | check: counterexample (probe invariants only); check-evidence: valid/fresh, verification=counterexample | convention verified (54960 generated / 5737 distinct / 0 queue); strict-cancel-no-queue and strict-aborted-cancelled counterexamples (expected probes) |

Current final run 20261025T102355Z-3a73160a-ec57-4fb8-ba13-9e4b8ef455d2,
input digest 544ea79865ab4bbb5a4ab060cce78a608a696f11c3f252711a3c2c81b1233675.
This run re-ran after adding citation markers to design.md (the vwa-evidence
gate requires them; code-anchors.md also gained toolchain/runner pin excerpts).
Citation metadata only — the model, checks.json and case semantics are
unchanged, and every case verdict is identical across runs. Superseded run
with identical verdicts, retained as reference: 20261025T094000Z-27552c5a…
(digest 1742ccac…).
Toolchain: bundled tla2tools.jar v1.7.4 (sha256 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L590-L598〕
936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88), Java
25.0.2 (PATH), runner @dsh-cc/plugin-dsh-cc-agents〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L600-L605〕 0.9.2-rc.1 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L600-L605〕
(repo-materialized skill directory), runner digest
06e192d42b33a964ba2fc870ea0a555988b1d649da2a32710595a3273c04d1e2.

Case results (final run):

- convention: verified (54960 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L245-L283〕 generated / 5737 distinct / 0 queue).
- strict-cancel-no-queue: counterexample on StrictCancelNeverQueues — 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L428-L443〕
  trace PromptStart → AdmitSuccess → Cancel (message already queued) 〔src:ws:specs/tla/acp-prompt-lifecycle/design.md#L74-L93〕.
- strict-aborted-cancelled: counterexample on StrictAbortedMeansCancelled — 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L445-L459〕
  trace PromptStart → AdmitSuccess → ClaimTurn → TurnEndEvent(hookabort) 〔src:ws:specs/tla/acp-prompt-lifecycle/design.md#L74-L93〕
  with no session/cancel.

## Observed code anchors (read this session, worktree @ 6ec11022)

- Single-slot guard and InflightPrompt record: 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L11-L42〕 session.ts:64-78, 114-121,
  277-306 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L11-L42〕
  〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L44-L75〕.
- Admission guard→queue→followup synchronous block: 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L77-L117〕 session.ts:307-343
  〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L77-L117〕.
- Cancel-before-admission-failure precedence + slot free on failure:
  session.ts:345-365
  〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L119-L143〕.
- Matching-turn end correlation and output error recording:
  session.ts:379-423
  〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L156-L185〕.
- onInboxClaimed / onAgentError guards: 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L187-L207〕 session.ts:430-450
  〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L187-L207〕.
- close() memoization + cancelPrompt + assertActive: 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L209-L243〕 session.ts:462-515 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L209-L243〕
  〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L209-L243〕
  〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L228-L243〕.
- settleAfterQuiescence precedence chain: 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L245-L283〕 session.ts:517-557
  〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L245-L283〕.
- turnEndToStopReason mapping 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L285-L310〕 (aborted→end_turn, interrupted→cancelled):
  codec.ts:18-38
  〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L285-L310〕.

## Observed regression tests pinning the modeled contract

- turns.spec.ts:266-275 single in-flight prompt
  〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L329-L342〕.
- turns.spec.ts:306-332 cancel during admission never queues
  〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L344-L374〕;
  :421-436 admission-to-followup gap
  〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L414-L426〕.
- turns.spec.ts:334-363 admission cancel does not cancel unrelated work;
  :365-396 unrelated failure during admission not attributed
  〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L376-L399〕.
- turns.spec.ts:501-514 late end cannot settle the next prompt
  〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L461-L478〕.
- turns.spec.ts:448-459 cancel records aborted outcome; :461-471 hook
  cancel settles end_turn
  〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L428-L459〕.
- turns.spec.ts:253-264 slot freed on synchronous followup failure;
  :398-419 agent retired during storage
  〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L510-L525〕
  〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L402-L412〕.
- turns.spec.ts:532-540 failed turn rejects; :554-563 removed-before-
  claim settles cancelled
  〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L480-L508〕.
- turns.spec.ts:107-131 settle waits for output drain; :133-151 output
  delivery failure rejects
  〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L527-L552〕.
- turns.spec.ts:211-236 / edges.spec.ts:106-121 autonomous and foreign
  turns on the same session
  〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L554-L576〕.

## Findings

- No defect in the modeled production contract: the convention case
  (all six contract invariants) verified over every interleaving within
  the bounds.
- Probe 1 (StrictCancelNeverQueues, expected refuted): 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L428-L443〕 cancel accepted
  after admission keeps the queued message; the turn runs to an aborted
  end and its partial output is delivered (documented behavior,
  turns.spec.ts:448-459 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L428-L443〕, :501-514 "partialnext"). 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L461-L478〕 Reported for user
  adjudication — treat as documented behavior or a stricter cancel
  contract change.
- Probe 2 (StrictAbortedMeansCancelled, expected refuted): 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L445-L459〕 a hook/owner
  abort settles end_turn because codec.ts reserves "cancelled" for 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L285-L310〕
  explicit client cancellation (documented in codec.ts:24-28 and pinned
  by turns.spec.ts:461-471). Reported for user adjudication.
- No production code was modified in this task.
