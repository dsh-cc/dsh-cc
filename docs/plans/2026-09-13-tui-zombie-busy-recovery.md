# TUI Zombie-Busy Recovery + Recall Late-Inject Guard

Date: 2026-09-13. Status: plan, critic-approved (cold review: GO with 4
amendments, all adopted inline). Trigger: incident session
`tui-0fc1fcae-2572-44a9-adfa-9ab40f8a7889`.

## 1. Background and constraints

A live dsh-cc TUI session froze: the backend session kept working (transcript
shows both turns ending `turn/end {kind: completed}`, and later events kept
being appended, including a final flush at +5s), but the TUI never painted the
results and ignored all further input. Forensic evidence: every later Enter
produced a "queued chip" — an artifact produced ONLY by the `s.busy === true`
branch of `submit()` (`packages/ui/tui/src/harness/driver-queue.ts:252-260`).
Since the `turn/end` fold in `packages/ui/tui/src/transcript.ts:398-426` cannot
throw (`return setBusy(state, false)` is unconditional), a permanently latched
`busy` proves the driver's `session/event` observer
(`packages/ui/tui/src/harness/driver-agent.ts:63-122`, `attachSessionEvents`)
stopped advancing state mid-turn. Chips are drained only by `flushQueue`
anchored on the next durable `turn/end` (driver-queue.ts:135-159) — an event
the dead pipeline can no longer see. The wedge is self-sustaining. This is the
"zombie busy anchor" family the driver-queue comments already name
(driver-queue.ts:106-134) in a new variant: previously fixed variants assumed
the wake happened but the flush was skipped; this time the event intake
itself dies.

The exact throwing callback is unrecoverable post-hoc: the harness session
publisher contains per-listener errors with warn-only logging
(deepseek-harness `packages/core/session/src/index.ts`,
`invokeContainedSessionObservers`), and the warn went to the alt-screen
terminal. The fix must therefore kill the failure CLASS, not one trigger.

Adjacent proven bug from the same transcript tail: the memory-recall selector
(`packages/memory/memory/src/recall.ts`) is fire-and-forget from
`agent/pre-step` (`onPreStep`: `void this.maybeRecall(...).catch(() => {})`)
and calls `agent.inject(...)` (recall.ts, end of `maybeRecall`) whenever the
selector settles. In the incident it settled 29s AFTER turn/end. Harness
`inject()` is a durable next-step inbox splice with wakeup=false
(`@deepseek-ai/dsh-agent` loop, `send(msg, 'next-step', false)`), restricted to
top-level agents; at idle the injected memory body strands in the inbox and
would silently contaminate whichever turn comes next (the transcript fold
hides `kind: 'memory'`, so the user never sees it). The recall also marks
selected topics as shown BEFORE injecting; a dropped or stranded inject must
not leak that suppression.

**Hard constraints.** The sibling `deepseek-harness` checkout is read-only —
everything below is dsh-cc-side. `packages/ui/pi-tui` is a vendored upstream
renderer and must never be modified; all paint-path protection therefore lives
in `@dsh-cc/tui`'s own subscribers, not in pi-tui's `doRender`.

Verified facts this plan relies on:

- `createDriver`'s `emit` (driver.ts:77-80) assigns state first, then notifies
  listeners in a bare for-loop with no try/catch.
- The single root subscription (components/root.ts:~295) runs
  window-title → history reseed → `transcript.setRows` → queue/todo/notice
  lines → working line → `renderOverlayChildren` → autocomplete →
  `tui.requestRender()`; a throw anywhere skips the rest and propagates into
  the emitter's caller.
- The observer's post-emit bookkeeping — `clearTurn` + `flushQueue` on
  `turn/end` (driver-agent.ts:115-121) — runs after the fold emit in the same
  callback body; a throw from the emit skips it.
- `busy=false` on turn completion lives ONLY inside the skipped fold
  (transcript.ts:404); `clearTurn` drops the turn anchor but never touches
  `busy` (store/session.ts:97).
- Harness `Agent.status` returns `'idle'` for both idle and maintenance
  phases; `followup` during maintenance is latched by the harness
  (`wakeRequested`) and delivered at convergence — normal behavior, so it is a
  safe reconcile precondition.
- `driver.ts:252` and `driver-sessions.ts:316` already reconcile busy from
  `rt.current.agent.status === 'running'` at (re)bind time — ground-truth
  reads are an established pattern.
- Queued entries can be plugin slash commands; `dispatchQueued`
  (driver-queue.ts:57-100) exists to reclassify them (`followup` vs harness
  dispatch). Raw `agent.followup` on a queued `/` line would leak the command
  to the model as prose.
- recall.ts marks topics shown inside the selection loop
  (`entry.shown.add(topic.path)`) before `agent.inject`.

## 2. Workstreams

One PR, three commits (W1..W3), TDD per workstream.

### W1 — Emit isolation and observer resilience (packages/ui/tui)

Changes:

- `driver.ts` `emit`: wrap EACH listener invocation in try/catch; a throwing
  listener never vetoes the others nor the caller's continuation. Faults are
  recorded in a capped in-memory list on the driver (last 5 `{at, message}`),
  AND `console.error`'d per fault (guaranteed channel — the TUI owns stdout,
  stderr still lands in terminal/logs), AND surfaced via `showNotice` on the
  FIRST fault only (best-effort: if the throwing site precedes the notice
  row's render, it simply won't paint; reentry via showNotice → emit is safe
  because listeners are now isolated — pin this in W1-A).
- `components/root.ts` subscription: wrap the paint block
  (`transcript.setRows` … `renderOverlayChildren` …) in try/finally so
  `tui.requestRender()` ALWAYS runs — a renderer exception paints the
  last-good frame instead of freezing.
- `driver-agent.ts` `attachSessionEvents`: wrap the ENTIRE observer callback
  body (fold emit, permission-mode follow-up, classifier notice, compaction
  anchor, working-line anchoring, step-clock reset, `turn/end` bookkeeping) in
  one try/catch. On catch: surface a visible notice with the event seq/type
  (`⚠ Skipped malformed session event <seq> (<type>)`), AND when
  `eventType === 'turn/end'` additionally `rt.emit(setBusy(rt.state(), false))`
  — turnaround completeness cannot depend on the fold that just failed. (This
  is a required amendment: as originally specced, a guarded fold-only emit
  would leave busy latched exactly on the incident's proven trigger.)
- Skip policy: a skipped event leaves at worst a stale or missing seq-tagged
  row; rows are seq-tagged (transcript.ts:155-164) and surface `replace`
  drops by seq range, so skipping cannot mis-target later folds. A skipped
  `surfaceOp replace` boundary can leave superseded content visible —
  cosmetic, self-heals on next compaction. Accepted.

Tests (TDD):

- W1-A: subscribe one throwing listener + one recording listener → emit →
  recorder still invoked, state advanced; fault recorded; `console.error`
  called; first-fault notice surfaced exactly once (no per-fault flood during
  boot replay); emitting from inside the fault handler (showNotice reentry)
  does not recurse-throw.
- W1-B: drive `attachSessionEvents` with a fold/presenter-throwing synthetic
  event, then a good event — good fold lands, notice present. THEN the
  incident pin: an event stream of [turn/start, poisoned `turn/end`] → after
  the callback, `busy === false`, `turn` anchor cleared, `flushQueue` invoked
  (queued chip dispatched).

### W2 — Zombie-busy reconciliation in submit (driver-queue.ts)

At the busy gate, reconcile against ground truth: when `s.busy` is true but
`rt.current.agent.status !== 'running'`:

1. `rt.emit(...)` clearing busy, the turn anchor, and the widget queue state
   (`setBusy(false)` + `clearTurn` + `clearQueue` in one emit).
2. Re-dispatch already-queued chips FIFO — SYNCHRONOUSLY, through
   `dispatchQueued(rt, text, 'followup')` per entry (NOT raw `agent.followup`:
   queued plugin slash commands must reclassify; NOT via `flushQueue`: its
   `whenIdle` microtask deferral would let the new draft's synchronous
   followup land before the chips — order inversion). Honor dispatchQueued's
   existing return-value discipline: an all-dropped flush must not anchor a
   zombie busy spinner.
3. Fall through to the existing idle-send path for the new draft (optimistic
   busy + turn anchor preserved unchanged).

When `agent.status === 'running'`, the chip path is preserved byte-for-byte.
`steerQueued` (Ctrl+S) gets the same reconcile precondition (steering a zombie
turn would self-recover dispatch but leave busy latched). `flushQueue` needs
no guard — it is gated on `turn/end`, which a live pipeline always sees. Add
`.catch` → notice on the deferred flush chain (`whenIdle().then(flush, flush)`
— a throwing `flush` is otherwise an unhandled rejection).

TDD tests:

- W2-A: state busy+turn-anchor with one queued chip; fake agent
  `status: 'idle'`; `submit('next')` → chips re-dispatched then draft —
  dispatch order [chipText, 'next']; `state.queued` empty; busy optimistically
  re-anchored; no new chip row. Second case: chip is a plugin slash command →
  assert it routes through dispatchQueued's command path, never as prompt
  prose.
- W2-B: busy + `status: 'running'` → chip behavior unchanged (regression
  pin).
- W2-C: Ctrl+S steer under zombie busy reconciles before steering.

### W3 — Recall late-inject idle guard (packages/memory/memory)

In `maybeRecall`, immediately AFTER the selector resolves and BEFORE the
shown-marking/injection loop: `if (agent.status === 'idle') return` (the
existing `signal.throwIfAborted()` stays). Late recall is by definition stale
enrichment for a turn that no longer exists; dropping beats inbox stranding.
Placement before `entry.shown.add(...)` is load-bearing (required amendment):
guarding at the inject line would permanently suppress the selected topics for
the process lifetime — the next turn's `fresh` filter excludes shown topics.
This placement also fixes the preexisting identical leak on the abort path.
No enter-batch-append alternative: there is no live step to append to when
idle; the next turn's pre-step recalls fresh. `entry.inFlight` already resets
in `finally`; `lastQuery` needs no change (next turn's query differs). Log at
most once per process via the existing warn-once pattern (separate flag from
the malformed-selection one).

TDD tests:

- W3-A: selector resolves after the fake agent's status flips to `'idle'` →
  `inject` not called; `entry.shown` NOT polluted (a subsequent different-query
  recall surfaces the same topics); warn-once fires once across two late
  deliveries.
- W3-B: selector resolves while `status === 'running'` → inject called
  (regression pin).

## 3. Acceptance (DoD)

- All new tests fail pre-implementation and pass post-implementation.
- From repo ROOT: `node_modules/.bin/vitest run packages/ui/tui
  packages/memory/memory` green; `node_modules/.bin/tsc -b
  tsconfig.packages.json` clean.
- No new package dependencies (check-spec-deps untouched); `pi-tui` and the
  harness checkout untouched (`git diff -- packages/ui/pi-tui` must be empty).
- File-size gate: watch `scripts/check-file-size.baseline.json`; prefer small
  helper extraction over ratcheting.
- Capability manifest untouched: no change to preset composition, hook
  bridging, command mounting, settings/permissions surface, or plugin loader.
- PR body declares the observable behavior changes: the TUI recovers from
  render-path and fold-path exceptions instead of freezing (loud notice +
  fault log); queued chips self-dispatch when ground truth says the agent is
  idle; memory-recall results that arrive after turn end are dropped instead
  of stranding in the next turn's context.
- Declared accepted residual: interrupt-after-reconcile can lose drained
  chips (inbox cleared by cancel after the UI queue cleared) — same hazard
  class as the preexisting flushQueue path; noted, not fixed here.
- Declared unverifiable: the incident's exact original throwing callback
  (post-hoc unrecoverable); W1 is verified to sever every KNOWN wedge path,
  including the proven trigger.
