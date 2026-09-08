# dsh-cc Epoch Collector: inline first-epoch collection without harness changes

Status: **Implemented** — shipped in PR #115 (merged 2026-09-05). Approved (feasibility spike: FEASIBLE-WITH-CAVEATS; harness read-only constraint, user directive 2026-09-10).
Date: 2026-09-05
Scope: `packages/subagent/task` (new `epoch-collector.ts`), `packages/hooks` (suppression listener), `packages/ui/tui` (Ctrl+B), `packages/bundle/cc-shell` (registry publication), `docs/claude-code-capabilities.yaml`

## 1. Problem

Ctrl+B promotion of a foreground wait and the foreground-wait semantics of
`docs/plans/2026-09-05-continuable-background-ux.md` (§3.4) require the parent's
tool call to **collect the child's first epoch inline**: await its terminal,
return the result to the model, and — only if the user promotes — release the
wait to background so the eventual settlement wakes the parent instead.

The original plan assumed an upstream harness API (the collectable continuable
handle, `docs/plans/2026-09-05-harness-collectable-handle.md`). That upstream PR
is cancelled: **hard constraint — deepseek-harness is never modified** (local
checkout, fork, or upstream PR; user directive 2026-09-10). A feasibility spike
established that dsh-cc can collect the first epoch inline using only in-process
surfaces the harness already exposes, with zero harness changes. This document
is the normative design for that collector and replaces the harness side of
Slice 2.

## 2. Verified mechanisms

All mechanisms below were confirmed by the spike against in-process surfaces.
Anchors are cited against the harness/repo trees **as read on a shifted tree**;
re-verify exact lines at implementation.

- **M1. Cordis event bus, `subagent/start` / `subagent/end`.** Plugins subscribe
  via `ctx.on(...)` — pattern at
  `packages/ui/tui/src/harness/driver-catalog.ts:239-295` (verified against
  harness tree; re-verify exact lines at implementation).
- **M2. `subagent/end` payload fidelity.** The harness `SubagentRunEndInfo`
  (harness:packages/core .../types.ts:56-71) carries
  `{ runId, provider, id (= childId), local, stopReason, lastAssistantMessage? }`;
  `stopReason` covers `completed` / `max-tokens` / `aborted` / `error` /
  `refusal`, and `lastAssistantMessage` is the epoch's closing output. The event
  fires **after** the child's final flush, so it is timely. No session-log
  reading is needed (the original plan's session-log collector is dropped).
- **M3. Preallocated child id.** `startContinuable` returns
  `{ childId, messageId }`; the child id can be preallocated dsh-cc-side —
  pattern `capture.preallocateChildId`,
  `packages/subagent/task/src/tool.ts:353-368` (re-verify exact lines at
  implementation).
- **M4. Settlement notice is steerable dsh-cc-side.** The harness's
  `notifySettlement` steers a `subagent-settled` user message into a busy
  parent's inbox; it is claimed at the next agent pre-step (after the tool
  returns). dsh-cc owns a pre-step waterfall
  (`packages/hooks/.../strip-instructions.ts:29` and `:70-78` pattern; re-verify
  exact lines at implementation) that can DROP pending messages
  (`inbox.remove`).
- **M5. Abort.** `ctx.subagents.interrupt(childId, { kind: 'ancestor', agent:
  exec.agent })` — admission is synchronous; an absent/settled target is an
  accepted no-op (re-verify at implementation; the harness `interrupt` shape is
  documented in the companion handle doc, §2 G4).

## 3. Collector design

New module `packages/subagent/task/src/epoch-collector.ts` behind a small
internal interface (§7). One collect loop:

```
reserve  : subscribe the shared subagent/end watcher and register the
           childId in the watch map BEFORE calling startContinuable
start    : preallocate childId (M3); startContinuable(spec); on throw,
           release the reservation and tombstone (same as startBackground)
attach   : the shared subagent/start listener with id === childId captures
           the runId; the end listener matches by runId
race     : Promise.race([ exec.signal abort, promotion intent, epoch end ])
resolve  : epoch end wins      -> map stopReason/lastAssistantMessage onto
                                 the existing foreground outcome mapping
           abort wins          -> interrupt exactly once (§4), resolve the
                                 tool call promptly with synthetic 'aborted'
           promotion wins      -> release to background (§6), tool call
                                 resolves async_launched
```

Rules (verbatim from the spike; load-bearing):

- **Watch bookkeeping.** ONE shared `ctx.on('subagent/end')` listener + a
  `Map<childId, { runId?, resolve, ... }>` singleton. Subscribe (reserve)
  BEFORE `startContinuable`; capture `runId` from the first `subagent/start`
  with `id === childId`; match `subagent/end` by `runId` (survives cold-resume
  epochs); release on terminal; dispose the listener when the map empties.
- **Deadlock rule (spike Q3).** The collector must NEVER await the parent's
  inbound message — only bus events.
- **Abort (M5).** `ctx.subagents.interrupt(childId, { kind: 'ancestor', agent:
  exec.agent })`; admission synchronous; absent/settled target = accepted
  no-op. `exec.signal` abort → interrupt exactly once → tool resolves PROMPTLY
  with synthetic stopReason `'aborted'` (prompt Esc UX; no awaiting child
  quiescence) → the watcher stays armed ONLY to drive suppression bookkeeping
  until the child's real `subagent/end` arrives.
- **Duplicate-notice suppression.** See §5.
- **Parallel collects.** All collectors of a process share the one listener and
  the one map; per-child state is keyed by childId.

## 4. Abort semantics

On `exec.signal` abort (busy Esc / Ctrl+C / parent teardown of the tool call):

1. Interrupt the child **exactly once** via
   `ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: exec.agent })`.
2. Resolve the tool call **promptly** with a synthetic `stopReason: 'aborted'`
   — never awaiting child quiescence or the child's real terminal.
3. Keep the watcher entry armed, but only to drive suppression bookkeeping:
   the child's real `subagent/end` arrives later; on it, mark the child
   collected-for-suppression and release the watch entry.

Why: the scheduler drains started dispatches during parent cancel, so the tool
must return promptly or the whole parent turn wedges (F10 of the UX plan). The
synthetic resolution is what gives the model its prompt back for the Esc UX;
the real terminal arrives only as the suppressed notice's mirror event.

## 5. Duplicate-notice suppression

A collected epoch's settlement also arrives as a `subagent-settled` user
message steered into the busy parent's inbox (M4). Suppression is a pre-step
waterfall listener (the `strip-instructions.ts:29, 70-78` pattern): it filters
`decision.messages` for `source.kind === 'subagent-settled'` whose
`senderSessionId` is in a **pop-once "collected" set**, and drops them via
`inbox.remove`. Entries are popped (never re-consulted), so a later epoch of
the same child delivers normally.

**Parity deviation (documented):** for inline-collected epochs the settlement
account lives only in the tool result, not the parent session log. Under the
upstream handle it would have been structural; here the parent log simply has
no record of a settlement that was consumed inline. Declared in the PR body.

## 6. Promotion & registry publication

- **Registry for the TUI.** Publish a root-realm service
  (pattern: `packages/bundle/cc-shell/src/ccPlugins.ts:121-133`; re-verify exact
  lines at implementation), e.g. `ccCollectorRegistry`:
  `Map<parentSessionId + toolCallToken, { childId, promote(), abort() }>`.
- **Promotion (Ctrl+B).** The TUI busy-branch queries the registry (F9 of the
  UX plan); `promote()` performs: registry release(childId) + remove the child
  from the suppression set + resolve the tool call with
  `{ status: 'async_launched', agentId, backgroundedByUser: true }`. The
  eventual settle wake flows normally (desired: unsuppressed — the child was
  removed from the suppression set).
- Abort routes through the collector's abort semantics (§4).

## 7. Swap seam

Put collection behind a small internal interface, e.g.
`EpochCollector { collect(spec, exec): Promise<EpochOutcome>; abort();
promote(); }`, implemented today by the bus-based collector (§3). When upstream
later adopts the handle API (`docs/plans/2026-09-05-harness-collectable-handle.md`,
the companion design doc), the implementation is replaced **in one file** — the
task tool and TUI surfaces are untouched. Capability degradation: if the seam's
environment lacks `interrupt` (M5), degrade to non-collectable foreground
behavior and declare it in the capability matrix (covered by the test plan,
case 7).

## 8. Race register

- **Subscribe-before-start.** Reserve in the watch map before
  `startContinuable`, so an immediate settle cannot fall between start and
  subscription.
- **runId matching vs cold resume.** End events are matched by runId captured
  from the child's first `subagent/start`, not by childId alone — a
  cold-resumed later epoch has a new runId and never satisfies a stale watcher.
- **End-after-flush ordering.** `subagent/end` fires after the child's final
  flush (M2), so `lastAssistantMessage` is complete when observed.
- **Missed-terminal.** Only on process crash: the in-memory watcher is lost
  with the process; a restarted session has no collecting waits (same residual
  risk the UX plan accepted in §6.5). No durable bookkeeping is attempted.
- **Suppression leak at parent teardown.** A stale pop-once entry is harmless:
  the set dies with the parent process, and post-teardown drops of settled
  notices are inert.

## 9. TDD test plan

Exact cases (vitest, fake bus + fake subagents service):

1. **runId matching ignoring later epochs.** A collector for child C resolves
   on the end event matching C's first-epoch runId; a later epoch's
   `subagent/end` (cold-resumed runId) is ignored.
2. **Subscribe-before-start immediate-settle.** The child settles between
   startContinuable and the first poll; the reservation placed before start
   still catches the end event and resolves the collect.
3. **exec.signal abort.** Interrupt issued exactly once with
   `{ kind: 'ancestor', agent: exec.agent }`; the tool call resolves promptly
   with synthetic `stopReason: 'aborted'` (not awaiting the child); the real
   `subagent/end` arriving later still performs suppression bookkeeping and
   releases the watch entry.
4. **Suppression filtering.** The pre-step waterfall drops the collected
   child's `subagent-settled` message (pop-once) and passes through notices
   for promoted children and for later epochs of the same child.
5. **Promotion.** `promote()` resolves the tool call with
   `{ status: 'async_launched', agentId, backgroundedByUser: true }`, removes
   the child from the suppression set and the registry; the later
   `subagent/end` resolves nothing (watcher already released).
6. **Parallel collectors.** N concurrent collects share ONE
   `subagent/end` listener and one map; on the last release the listener is
   disposed; no cross-talk between childIds.
7. **Capability degradation.** When the seam's environment lacks `interrupt`,
   collection degrades to non-collectable foreground behavior and the
   degradation is observable (no hang, no silent success).

## 10. Parity deviations & risks

- **Parent-log account absence (§5).** For inline-collected epochs the parent
  session log carries no settlement record; the account lives only in the tool
  result. Declared deviation.
- **Synthetic aborted (§4).** On abort the tool result reports a synthetic
  `stopReason: 'aborted'` rather than the child's real terminal. The real
  terminal is observable only via lifecycle events. Declared deviation.
- **No harness version dependency.** The design depends on no new harness
  surface, version pin, or capability gate — the mechanisms (M1–M5) exist
  today. This removes the version-gating risk the handle-based plan carried.
- **Residual risks:** process crash mid-collect loses the watcher (§8);
  anchors were verified on a shifted tree and must be re-verified at
  implementation (§2).
