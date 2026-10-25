# acp-prompt-lifecycle — formal design

TLA+ model of the ACP session **prompt lifecycle** in
`packages/acp/cc-acp/src/session.ts` (the `AcpSession` module: single
in-flight admission slot, cancellation precedence, turn correlation, late
`turn/end` isolation, memoized close), with the stop-reason vocabulary of
`packages/acp/cc-acp/src/codec.ts` (`turnEndToStopReason`).

## Formal design screening (current)

- mode: **auto**, decision: **enabled**
- trigger ids: FD-T1 (independent actors — the ACP client, the agent loop,
  in-process foreign producers and teardown all mutate shared prompt-slot
  state), FD-T2 (cancellation vs late turn ends / late failures), FD-T3
  (close/crash-style teardown affecting prompt settlement and slot
  ownership).
- rationale: the prompt lifecycle is the only part of the ACP design whose
  correctness depends on event ordering; content mapping, MCP mounting,
  model control and preset composition are deterministic single-threaded
  computation or composition concerns and do not trigger.
- model directory: `specs/tla/acp-prompt-lifecycle`.
- user directive: task instruction 「使用 formal-design，对当前
  acp 相关设计进行建模", with the standing contract: read the actual code
  and tests first, do not modify production code, ask on ambiguity, and
  report scope/assumptions/counterexamples/unverified parts.

## Requirements (business contract, restated from code and tests)

- **R-1 Single in-flight slot.** At most one ACP prompt owns the session's
  prompt slot. A second `session/prompt` while one is in flight is rejected
  `invalidParams` ("a prompt is already in flight") and must not disturb
  the first prompt's state 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L44-L75〕.
- **R-2 Cancellation precedence.** Once `session/cancel` (or a JSON-RPC
  request abort, or `close()`) is accepted for the in-flight prompt
  (`cancelRequested = true`), the prompt settles `stopReason = "cancelled"`
  no matter what output-delivery error, out-of-turn agent error or turn end
  arrives afterwards 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L245-L283〕.
- **R-3 Turn correlation / late-end isolation.** `turn/end` writes the
  in-flight prompt's `endReason` only when it belongs to that prompt's own
  claimed turn; a late end from a cancelled turn or a foreign/autonomous
  turn cannot settle or corrupt the next prompt
  〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L156-L186〕.
- **R-4 Cancel during admission never queues.** A cancel accepted while
  the prompt is still in admission (before `agent.followup`) prevents the
  message from ever being queued — no `user/message`, no `turn/start`
  〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L77-L117〕
  〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L344-L375〕.
- **R-5 Admission failure frees the slot.** Invalid content, an agent
  disposed outside the bridge, or a synchronous `followup` throw reject
  the prompt and leave the slot free for the next prompt (a failed prompt
  never wedges the slot)
  〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L119-L143〕
  〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L510-L525〕.
- **R-6 Out-of-turn failure attribution.** An agent interval failure is
  attributed to the in-flight prompt only when the message is already
  queued and the failure is outside the prompt's own turn; in-turn
  failures arrive as a durable `turn/end` with kind `error`; failures
  during admission are never attributed
  〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L187-L207〕
  〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L391-L400〕.
- **R-7 Stop-reason mapping.** `completed → end_turn`,
  `max-tokens → max_tokens`, `aborted → end_turn` ("cancelled" is reserved 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L285-L310〕
  for explicit client cancellation and disposal), 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L285-L310〕 `interrupted →
  cancelled`; a turn end of kind `error` rejects the prompt
  〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L285-L310〕.
- **R-8 Unclaimed quiescence settles cancelled.** A prompt whose message
  was removed before its turn claimed it settles `cancelled` (no end reason
  ever arrives) 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L494-L508〕.
- **R-9 Close memoization and gating.** `close()` runs once; prompts
  after close starts are rejected (`session is closing`); close cancels
  any in-flight prompt first
  〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L209-L243〕.

## Model actions ↔ code mapping

| TLA action | Code (symbol, mechanism) |
|---|---|
| `PromptStart` | `AcpSession.prompt` head: `assertActive` + `inflight !== undefined` guard, fresh `InflightPrompt` (session.ts:282-302 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L44-L75〕) |
| `PromptBusy` | the `throw invalidParams('a prompt is already in flight…')` branch (session.ts:283 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L44-L75〕) |
| `PromptWhileClosing` | `assertActive` closing rejection (session.ts:504-506 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L228-L243〕) |
| `AdmitSuccess` | `admitAcpPrompt` resolving + `throwIfAborted` guard + `messageQueued = true` + `agent.followup` in one synchronous block (session.ts:314-338 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L77-L117〕) |
| `AdmitFailCancelled` | cancel-during-admission path: `admissionController.abort` → admission failure with `cancelRequested`, settled by `settleAfterQuiescence` as `cancelled` (session.ts:345-348 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L119-L143〕, 508-515 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L461-L478〕) |
| `AdmitFailReject` | admission failure branch: slot freed synchronously, prompt rejected (session.ts:349-357 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L119-L143〕) |
| `ClaimTurn` | `onInboxClaimed`: `inflight.messageId === message.id ⇒ inflight.turn = turn` (session.ts:430-435 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L187-L207〕) |
| `AutonomousTurnStart` | foreign/in-process producers driving the same agent (edges.spec.ts:106-121 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L567-L576〕, turns.spec.ts:211-236 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L554-L563〕) |
| `TurnEndEvent` | `onSessionEvent` finally-block: `turn/end` with `inflight.turn === event.data.turn` (session.ts:416-421 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L187-L207〕) |
| `AgentErrorEvent` | `onAgentError` guards: `messageQueued` + `inflight.turn !== turn` (session.ts:442-450 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L187-L207〕) |
| `OutputErrorEvent` | `assistant/message` delivery failure recorded on the matching turn via `outputTail` catch (session.ts:381-393 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L156-L185〕) |
| `Cancel` | `cancelPrompt` from `session/cancel`, JSON-RPC request abort, or `close()` (session.ts:303-306 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L77-L117〕, 367-372 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L391-L400〕, 508-515 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L461-L478〕) |
| `Close` | `close()` memoization + `cancelPrompt` (session.ts:462-468 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L209-L226〕) |
| `Settle` | `settleAfterQuiescence` body: one-shot (`settlementStarted`), await admission/quiescence/output tail, clear slot, precedence chain (session.ts:517-557 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L245-L281〕) |

Atomicity: the model treats as atomic exactly the code blocks that are
synchronous in the single-threaded runtime — the guard→queue→followup
block (session.ts:321-338 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L77-L117〕), the settle precedence chain
(session.ts:527-548 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L245-L281〕), and `cancelPrompt`'s flag writes. Asynchronous
boundaries (`admitAcpPrompt` awaits, `whenIdle`/`outputTail` awaits,
event delivery) are the interleaving points the checker explores.

## Coverage matrix

| Requirement ID | Business outcome | Property ID | TLA operator | Case IDs and bounds | Fault-or-race trace | Assumption IDs | Planned code symbol and atomicity mechanism | Regression scenario | Exclusion and justification |
|---|---|---|---|---|---|---|---|---|---|
| R-1 | Second prompt rejected, first undisturbed; slot owns exactly one prompt | S-1 `SlotConsistency` (+ `TypeOK`) | Invariant 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L44-L75〕 | convention (MaxTurns=3) | PromptBusy while admitting/queued/running | A-1 | `inflight` slot + synchronous guard at session.ts:283 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L44-L75〕 | turns.spec.ts:266-275 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L329-L342〕 | none |
| R-2 | Cancel accepted ⇒ settle `cancelled` regardless of late errors/ends | S-2 `CancelWinsSettlement` | Invariant 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L245-L283〕 | convention | Cancel then late TurnEndEvent/OutputErrorEvent/AgentErrorEvent before Settle | A-3 | `cancelRequested` flag + settle precedence chain (session.ts:529-531 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L245-L281〕) | turns.spec.ts:277-304 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L329-L342〕, 448-459 | none |
| R-3 | Only the prompt's own turn end writes its endReason; late/foreign ends ignored | S-3 `LateEndIsolation` | Invariant 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L156-L185〕 | convention | Prompt1 cancel → its turn end arrives after prompt2 claimed turn2/3 | A-2 | `inflight.turn === event.data.turn` guard (session.ts:418 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L187-L207〕) | turns.spec.ts:501-514 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L461-L478〕, 211-236 | none |
| R-4 | Cancel during admission never queues the message | S-4 `CancelInAdmissionNeverQueues` | Invariant | convention | Cancel while phase=admitting, admission then resolves | A-1 | `throwIfAborted` guard in the synchronous admission block (session.ts:321 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L77-L117〕) | turns.spec.ts:306-332 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L344-L374〕, 421-436 | none |
| R-5 | Admission failure frees the slot; next prompt is not "already in flight" | S-1 (slot freed: `phase=free ⇒ msgQueued=FALSE` via `SlotConsistency` + `TypeOK`) | Invariant 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L119-L143〕 | convention | AdmitFailReject then PromptStart accepted | A-1 | synchronous `this.inflight = undefined` (session.ts:350 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L119-L143〕) | turns.spec.ts:253-264 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L510-L525〕, 398-419 | none |
| R-6 | Out-of-turn failure attributed; in-turn failure arrives via turn/end; admission failures not attributed | S-5 `StopReasonMapping` (rejected ⇒ agentErr/outputErr/error-end/admit-fail; end_turn/max_tokens exclude them) | Invariant 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L187-L207〕 | convention | AgentErrorEvent with t ≠ turn during queued/running; same during admitting (must be ignored) | A-3 | `onAgentError` guards (session.ts:443-447 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L187-L207〕) | turns.spec.ts:365-396 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L391-L400〕, 532-540 | none |
| R-7 | Settled stop reason follows the codec mapping and precedence chain | S-5 `StopReasonMapping` | Invariant 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L245-L283〕 | convention | TurnEndEvent(reason) × Cancel × OutputError × AgentError in both orders | A-3 | precedence chain (session.ts:529-548 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L245-L281〕) + `turnEndToStopReason` (codec.ts:18-38) | turns.spec.ts:45-51, 461-471 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L445-L459〕, 516-530 | none |
| R-8 | Unclaimed message at quiescence settles cancelled | S-5 (`cancelled ⇐ snapEndReason ∈ {none, interrupted}`) | Invariant 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L494-L508〕 | convention | Settle from phase=queued with endReason=none | A-2 | `end === undefined ⇒ resolve('cancelled')` (session.ts:541-543 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L245-L281〕) | turns.spec.ts:554-563 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L494-L508〕 | none |
| R-9 | Close once; prompts during closing rejected; close cancels inflight | S-1 + `TypeOK` (closing latch; `PromptWhileClosing`) | Invariant 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L209-L226〕 | convention | Close during admitting/queued/running, then PromptStart rejected | A-1 | `closing` memo + `assertActive` (session.ts:462-468 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L209-L226〕, 504-506 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L461-L478〕) | dispose.spec.ts (package suite) | E-2 (drain/flush/dispose ordering below) |
| R-2′ (probe) | Strict claim: cancel at any time prevents queueing | S-6 `StrictCancelNeverQueues` | Invariant 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L428-L443〕 | strict-cancel-no-queue (MaxTurns=3) | AdmitSuccess then Cancel | A-1 | — (expected REFUTED) | turns.spec.ts:448-459 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L428-L443〕, 501-514 ("partialnext") | probe: counterexample is documented behavior (cancel after queue keeps partial output); awaiting user adjudication |
| R-7′ (probe) | Strict claim: an aborted turn settles cancelled | S-7 `StrictAbortedMeansCancelled` | Invariant 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L445-L459〕 | strict-aborted-cancelled (MaxTurns=3) | TurnEndEvent(hookabort) without Cancel, then Settle | A-3 | — (expected REFUTED) | turns.spec.ts:461-471 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L445-L459〕 | probe: counterexample is documented codec behavior (aborted→end_turn; cancelled reserved for client cancel); awaiting user adjudication |

## Assumptions (with justification)

- **A-1 Single-threaded interleaving model.** The bridge runs on one JS
  loop; asynchronous boundaries (awaits in `prompt`, `whenIdle`,
  `outputTail`, event dispatch) are the only interleaving points.
  Synchronous blocks are atomic. Justified by the runtime model of the
  vendored code and by the tests' microtask-level race construction
  (e.g. turns.spec.ts:421-436 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L414-L426〕).
- **A-2 Turn allocation is a monotone counter shared by prompt turns and
  autonomous/foreign turns.** `onInboxClaimed` correlates by messageId; 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L187-L207〕
  turns started by other producers exist on the same session
  (edges.spec.ts:106-121 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L567-L576〕). The model abstracts messageId correlation to 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L187-L207〕
  "the next allocated turn" — justified because the correlation guard is
  an exact id equality check (session.ts:431 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L187-L207〕) and no reordering of turn
  ids is possible within one agent.
- **A-3 Output/agent failures are observable before settlement reads them.**
  Settlement awaits the ordered `outputTail` and `whenIdle`
  (session.ts:520-524 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L245-L281〕), so any delivery failure of the prompt's own turn
  is committed to `inflight.outputError` before the precedence chain runs;
  likewise out-of-turn interval failures precede quiescence. The model
  therefore lets `OutputErrorEvent`/`AgentErrorEvent` fire any time before
  `Settle` clears the slot.
- **A-4 One session.** The prompt slot, output tail and close latch are
  per-`AcpSession`; sessions do not share state (multi-session.spec.ts
  exercises independence). The model covers one session.

## Faults and adverse traces explicitly modeled

- F-1 cancel during admission (both before and after the abort guard is
  modeled by the `AdmitSuccess` guard `~cancelReq`).
- F-2 cancel in the admission-to-followup handoff gap
  (turns.spec.ts:421-436 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L414-L426〕).
- F-3 late `turn/end` from a cancelled turn arriving after the next
  prompt claimed its own turn (turns.spec.ts:501-514 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L461-L478〕).
- F-4 out-of-turn agent failure during admission (must NOT be
  attributed, turns.spec.ts:365-396 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L391-L400〕) vs during queued/running (must be).
- F-5 output delivery failure of the matching turn before settlement
  (turns.spec.ts:133-151 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L542-L552〕).
- F-6 synchronous `followup` throw / agent disposed outside the bridge
  (turns.spec.ts:253-264 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L510-L525〕, 398-419 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L402-L412〕).
- F-7 message removed before claim (turns.spec.ts:554-563 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L494-L508〕).
- F-8 close during any inflight phase (R-9).

## Bounds

`MaxTurns = 3` — enough for prompt1's turn, an autonomous turn, and
prompt2's turn (the F-3 trace), plus a retry-free second prompt. All
other state is finite by construction (flags, small sets, one slot).

## Exclusions

- **E-1 Update-stream content and ordering** (assistant/tool/usage update
  conversion, `outputTail` serialization order). Deterministic
  single-owner queue; no ordering decision affects the modeled stop
  reason beyond the outputErr flag 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L527-L540〕 (test turns.spec.ts:107-131 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L527-L540〕 pins the
  drain-before-settle contract, which A-3 assumes).
- **E-2 Close teardown ordering** (drain → continuable subagent drain →
  persistence flush → dispose, session.ts:469-499 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L209-L226〕). Sequential
  single-owner code with aggregated failure reporting; no interleaving
  decision remains after the cancel the model does capture.
- **E-3 Model control / pendingSelections pinning, 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L187-L207〕 MCP mounting, preset
  composition, content admission internals.** Deterministic computation
  or composition seams without cross-actor ordering (per screening
  decision).
- **E-4 Idle cancel of autonomous work** (session.ts:371 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L145-L154〕). Affects only
  agent-side work; no bridge state changes (turns.spec.ts:492-499 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L461-L478〕 pins
  that it does not affect the following prompt, which the model's state
  reset guarantees structurally).

## Counterexample dispositions

- `StrictCancelNeverQueues` (case strict-cancel-no-queue): expected
  counterexample — cancel accepted AFTER admission keeps the queued
  message; the turn still runs to an aborted end and its partial output
  is delivered (documented behavior, turns.spec.ts:448-459 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L428-L443〕,
  501-514 "partialnext") 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L461-L478〕. Reported for user adjudication; no model or
  code change made to pass.
- `StrictAbortedMeansCancelled` (case strict-aborted-cancelled): expected
  counterexample — a hook/owner abort maps to `end_turn` because
  `cancelled` is reserved for explicit client cancellation (codec.ts
  comment, turns.spec.ts:461-471 〔src:ws:specs/tla/acp-prompt-lifecycle/code-anchors.md#L445-L459〕). Reported for user adjudication.

## Regression commands

```sh
pnpm --filter @dsh-cc/acp test            # vitest suite incl. turns.spec.ts
node packages/plugin/dsh-cc-agents/skills/formal-design/scripts/check.mjs \
  --project . --model specs/tla/acp-prompt-lifecycle
```
