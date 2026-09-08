# Harness: the Collectable Continuable Handle

Status: **Cancelled for local implementation (upstream proposal only)** — per the 2026-09-10 harness read-only directive this is not implemented in the dsh-cc repo; the dsh-cc-side epoch collector (`docs/plans/2026-09-05-epoch-collector-dsh-cc.md`, shipped in PR #115) covers the first-epoch collection need by different means, and the v2.1 design below stands as the proposal for upstream adoption. Design state: Revised v2.1 (v2 folded the dual cold review: 4-state machine, abort
ack/terminal split, collectSignal lease, post-admission detach, overloads, catalog
regen; v2.1 adds the resolution-check fixes: the aborted branch resolves the epoch
from the real disposal terminal, and the lease wiring is assigned to downstream).
2026-09-10 constraint: deepseek-harness is never modified (local checkout, fork, or
upstream PR) — local implementation is cancelled; this document is the upstream
proposal only. The dsh-cc UX plan's Slices 2–3 reformulate dsh-cc-side instead.
Date: 2026-09-10
Scope: upstream `deepseek-ai/deepseek-harness`, `packages/subagent/subagent/src/{continuation.ts,types.ts,lifecycle.ts,index.ts}` and `packages/subagent/subagent/tests/`. Companion to `docs/plans/2026-09-05-continuable-background-ux.md` (Slices 2–3).

## 1. Problem

dsh-cc needs to collect a continuable child's first epoch inline (foreground
wait) with exactly-once settlement semantics, so Ctrl+B can later promote that
wait to background and Esc can abort it. Today `startContinuable` returns only
`{ childId, messageId }` (continuation.ts:111-138): no result promise, no
detach, no abort. `notifySettlement` (continuation.ts:1462-1511) is
unconditional — every settled announced child wakes its durable parent — and
`ContinuableStartSpec.signal` owns only until inbox acceptance (continuation.ts:128,
:394-405, :533-554), so a post-acceptance caller abort cannot stop the child.
A start-time flag cannot express the decision because it is made *after*
start (collected inline vs. promoted to background).

## 2. Ground truth (verified in the harness checkout at b150a551b8)

- **G1.** `startContinuable` (continuation.ts:409-476) resolves at inbox
  acceptance via `submitMaterialized` → `submitAdmitted` → `submit`
  (:1192-1209), which sets `activation.announced = true` — the flag
  `notifySettlement` keys on (:1463).
- **G2.** Settlement runs entirely inside `finishDisposal` (:1359-1442):
  quiescence → `flushFinalState` → `observer.capture(child)` (:1396) →
  `notifySettlement(activation, observer.terminal(failure))` (:1434) →
  `releaseOwnership` (:1437) → `observer.settle(failure)` (:1440). The
  manager holds the Activation in the live map until disposal settles
  (:1428), so a racing delivery waits rather than cold-resumes.
- **G3.** `ActivationTerminal` (lifecycle.ts:31-36) is exactly
  `{ stopReason, output? }`, computed by `observer.terminal(failure)` from
  `observer.capture()` (lifecycle.ts:186-207) — the child's own event suffix
  via `epochStopReason`/`finalAssistantOutput`. This is the one existing
  value carrying stopReason + output at settlement; it is what the handle's
  `epoch` must resolve with.
- **G4.** `interrupt` (:554-594) authorizes, then issues
  `agent.cancel(cause, { keepInbox: true })` and returns without awaiting —
  the pattern `abort()` must reuse post-acceptance. An absent/disposing
  target is an accepted no-op.
- **G5.** `watchSettlement` (:1295-1330) opens the disposal transaction
  inside the per-child `ChildLock` critical section; every converging path
  (`drain`, `drainDescendants`, `drainChildren`, natural settlement) funnels
  into the single memoized `dispose()` transaction (:1343-1352), so
  `finishDisposal` runs exactly once per Activation — the natural
  exactly-once settlement point.
- **G6.** `SubagentReportDelivery = 'quiet' | 'next-step'`
  (continuation.ts:100-101) is the established vocabulary pattern for
  parent-delivery policy on this seam.
- **G7.** Handles are per-Activation (per residency epoch). A cold resume
  after disposal creates a *new* Activation (:1087-1102); the collected epoch
  is the one whose Activation `startContinuable` created.

## 3. API surface

All new types live in `packages/subagent/subagent/src/continuation.ts`
(alongside `ContinuableStart`/`ContinuableStartSpec` — the internal control
surface module), re-exported from `index.ts`'s `export type` block
(:113-123) with the existing `@deepseek-ai/dsh-subagent` entry point.

```ts
/** Terminal outcome of one collected continuable epoch. */
export interface ContinuableEpochResult {
  /** Why the epoch's last turn ended; mirrors ActivationTerminal. */
  readonly stopReason: SubagentResult['stopReason']
  /** Final assistant content of the epoch, absent when it produced none. */
  readonly output?: ContentBlock[]
}

/** Exactly-once ownership handle over one continuable child's first epoch.
 *
 * This is a capability: it is handed only to the `startContinuable` caller
 * (who supplied `spec.request.parent`) and intentionally bypasses the
 * `interrupt()` authorization surface (`interrupt`'s cause/authorization
 * checks do not apply here). Flag this for security review in the PR.
 */
export interface ContinuableEpochHandle {
  /** The durable child this handle's epoch belongs to. */
  readonly childId: SessionId
  /**
   * Resolves at the epoch's terminal; never rejects (see §4.3).
   *
   * Deliberately STRONGER than `SubagentRun.result`: `result` rejects on
   * infrastructure faults, while `epoch` folds every infrastructure fault
   * into `stopReason: 'error'` so a collector can `await` unconditionally.
   * On the detached path the epoch never resolves and must never be awaited
   * after detach (see the detached-handle rule in §4.2).
   */
  readonly epoch: Promise<ContinuableEpochResult>
  /** Current collector state; lets callers observe the transitions of §4.1. */
  readonly state: 'armed' | 'consumed' | 'detached' | 'aborted'
  /**
   * Release the wait to background: the eventual settlement notice is
   * delivered normally (today's contract). Taking interactive control of the
   * child (a followup) releases the wait to background the same way.
   */
  detach(): void
  /**
   * Interrupt the child. Synchronously closes ownership, issues the cancel,
   * and returns promptly (ack, not terminal — see §4.3). The epoch resolves
   * later, from the real disposal terminal; it is never rejected.
   */
  abort(): Promise<void>
}

/** Options on startContinuable. */
export interface ContinuableStartOptions {
  /** Issue a collectable epoch handle for the child's first epoch. */
  readonly collectable?: boolean
  /**
   * When `collectable` is set: owns the collection lease for the whole
   * first-epoch wait, analogous to how `spec.signal` owns until acceptance.
   * Aborting it drives an ARMED collector through exactly the same
   * synchronous abort path as `handle.abort()` (§4.3) — see §5 for why
   * this lease is required, not optional.
   */
  readonly collectSignal?: AbortSignal
}
```

Signature (manager + `SubagentRuntime.startContinuable` passthrough,
index.ts:212-214):

```ts
async startContinuable(
  spec: ContinuableStartSpec,
  options?: ContinuableStartOptions,
): Promise<ContinuableStart>
```

`ContinuableStart` gains one optional field:

```ts
export interface ContinuableStart {
  readonly childId: SessionId
  readonly messageId: MessageId
  /** Present iff options.collectable; the first epoch's ownership handle. */
  readonly handle?: ContinuableEpochHandle
}
```

A new exported type-only name is preferred over a separate return type so
every existing caller and `Omit`-style consumer of `ContinuableStart`
compiles unchanged (backward compatibility, §7).

The return type is **overloaded** so the type surface states the truth:

```ts
async startContinuable(
  spec: ContinuableStartSpec,
  options?: ContinuableStartOptions,
): Promise<ContinuableStart>
// overload when options.collectable === true:
async startContinuable(
  spec: ContinuableStartSpec,
  options: ContinuableStartOptions & { collectable: true },
): Promise<ContinuableStart & { handle: ContinuableEpochHandle }>
```

`{ collectable: true }` returns a type where `handle` is REQUIRED; omitted
or `collectable: false` keeps today's return shape exactly.

## 4. Internal design

### 4.1 Ownership state machine

One collector record, a mutable field on the `Activation` the start created
(freeing with the Activation — no manager-level registry, no GC problem):

```ts
/** Linearized exactly-once ownership of one collected epoch. */
interface EpochCollector {
  /** 'armed' until settlement (consumed), detach, or abort wins. */
  state: 'armed' | 'consumed' | 'detached' | 'aborted'
  /** Terminal states: 'consumed' | 'aborted'. */
  /** Resolved exactly once, at the epoch's terminal (or at real disposal
   *  after abort — see §4.3). */
  readonly epoch: PromiseWithResolvers<ContinuableEpochResult>
}
// Activation gains: collector?: EpochCollector
```

State transitions (all synchronous, so JS single-threaded execution *is* the
linearization; there is no await between the check and the flip):

| current | event | next | effect |
|---|---|---|---|
| armed | settlement (`finishDisposal` reaches notify) | consumed | `epoch.resolve(terminal)` with the real `ActivationTerminal`; **no** parent notice |
| armed | `handle.detach()` | detached | none now; notice at settlement; **epoch stays pending forever** |
| armed | `handle.abort()` or `collectSignal` abort (§4.3, §5) | aborted | issue `agent.cancel`; return promptly; **no** notice ever; epoch resolves later from the real disposal terminal |
| consumed/detached/aborted | anything | — | no-op (idempotent) |

`startContinuable` allocates the collector and installs it on the Activation
synchronously inside the same `ChildLock` critical section that submits the
initial prompt, before returning. Installation is *after*
`submitAdmitted` succeeded, so a start rejection never leaves a collector
(the rollback in `submitMaterialized` :1014-1019 disposes an Activation with
`announced === false` and no collector — no notice, no epoch).

### 4.2 Settlement consult — the one change to `notifySettlement`

At the top of `notifySettlement` (continuation.ts:1462), before the
`announced` check:

```ts
private notifySettlement(activation: Activation, terminal: ActivationTerminal): void {
  const collector = activation.collector
  if (collector !== undefined) {
    if (collector.state === 'armed') {
      // Exactly-once consume: resolve the epoch, deliver no notice.
      collector.state = 'consumed'
      collector.epoch.resolve(terminal)  // the real ActivationTerminal ({stopReason, output?})
      return                              // no notice
    }
    if (collector.state === 'detached') {
      // fall through to today's delivery verbatim; the epoch is NOT
      // resolved on this path — it stays pending forever (see rule below).
    } else {
      // aborted: abort() won ownership earlier; per §4.3 the epoch STILL
      // resolves, from the real disposal terminal arriving here — the
      // terminal is delivered to the promise, the notice never is.
      collector.epoch.resolve(terminal)
      return                              // aborted: no notice ever
    }
  }
  if (!activation.announced) return
  ... // unchanged body
}
```

**Detached-handle rule (documented, load-bearing):** a detached handle's
epoch never resolves and must never be awaited after detach; it never
rejects, and it is GC'd with the session. Awaiting after detach is a caller
bug. This is safe by construction because the downstream promotion (Ctrl+B)
detaches and never awaits — it hands the child back to background delivery
and stops touching the promise.

Details:

- The `ActivationTerminal` passed at :1434 is already computed
  (`observer.terminal(failure)`, G3) *before* ownership release, while the
  child's log is still readable — the handle needs no new data path, no
  second observer, no listener on `subagent/end`.
- Detached handles fall through to the existing delivery logic verbatim:
  wake/steer for a live open parent, inject under closing teardown, log and
  drop if the parent is gone. The parent-notice contract for `detach` is
  exactly today's unconditional contract.
- The lifecycle edge (`observer.settle`, :1440) is untouched: it always
  fires, exactly as today, for every terminal regardless of collector state.
  The collector only governs the *parent message*, not observability.

### 4.3 `epoch` semantics (never rejects) and `abort()` semantics

`epoch` is deliberately STRONGER than `SubagentRun.result`
(types.ts:270-276): `result` rejects on infrastructure faults, whereas
`epoch` never rejects — a child-level failure resolves with
`stopReason: 'error'`; a teardown failure resolves with `stopReason:
'error'` (that is what `observer.terminal(failure)` already yields,
lifecycle.ts:191-193). Every infrastructure fault folds into `'error'`, so
a collector can `await` unconditionally.

**`abort()` — acknowledgment vs. terminal split.** `abort()` does two
things and then returns PROMPTLY (its returned promise resolves once
cancellation is *initiated*, not at quiescence):

1. Synchronously wins ownership: `collector.state = 'aborted'`.
2. Issues the interrupt-pattern cancel (G4):
   `activation.handle.agent.cancel({ kind: 'parent' }, { keepInbox: true })`
   with the existing postchecks `this.activations.get(childId) ===
   activation && activation.disposal === undefined` (absent/disposing
   target is an accepted no-op).

`epoch` does NOT resolve eagerly at `abort()`. It resolves later, from the
REAL disposal terminal: the cancel-then-dispose path runs `finishDisposal`,
whose `observer.terminal(failure)` yields `'aborted'` via the existing
`epochStopReason` mapping (G3) — or `'error'` if the teardown itself
failed. The real disposal sees a closed collector and sends no notice.

**Epoch-never-hangs guard:** any synchronous-throw escape from the disposal
path (e.g. `wake`/`cancel` throwing before `notifySettlement` is reached)
MUST resolve the epoch with `{ stopReason: 'error' }`. Wrap in disposal's
rejection arm: the catch around `finishDisposal`'s tail checks for an
unresolved collector epoch and resolves it there, so no caller can ever
observe a hung epoch.

Downstream note: dsh-cc races its own abort intent so Esc returns promptly;
the `epoch` promise it abandoned resolves later, unobserved, and never
rejects — nothing in the downstream cleanup depends on it.

Terminal mapping at each end state (all resolved through the same
`ActivationTerminal` computation):

| how the epoch ended | `stopReason` handed to epoch / notice | notice delivered? |
|---|---|---|
| completed | `completed` + output | iff detached |
| error / refusal | `error` / `refusal` (+output when present) | iff detached |
| max-tokens | `max-tokens` + output | iff detached |
| abort via handle | `aborted` (real terminal at disposal; `'error'` if teardown failed) | never |
| abort via parent `interrupt()` / parent cancel | `aborted` (from `epochStopReason`, G3) | iff detached (armed → consume wins) |
| parent teardown mid-collect | no drain branch: teardown of the parent aborts the tool call's signals, which fires the collectSignal lease rule (§5) — the child aborts via the same §4.3 path | never (aborted collector) |
| start rolled back pre-acceptance | no collector exists | no (unchanged `announced` rule) |

### 4.4 `detach()` and followups

- `detach()` on an armed collector flips state and returns. Detach after
  settlement/abort is a no-op (the state field is terminal).
- **Implicit detach on followup (design decision), post-admission only:**
  any later `followup()` ADMITTED to the same child while a collector is
  armed force-detaches it — but the check is applied only AFTER admission
  succeeds (post-`admitWaking` success), so a failed follow-up cannot
  detach the collector. Taking interactive control of the child releases
  the wait to background: the parent has taken over, so background-notice
  semantics are the correct default for the eventual settlement; leaving
  the collector armed would let an interactive parent silently swallow its
  own settlement notice.
- **Ordering invariant:** installation happens after the initial submit
  inside the start critical section (§4.1); the implicit-detach check lives
  ONLY in the followup admission arm — it is NOT in `submit()` (:1192)
  generally; `reportFrom` is exempt (it never extends the child's epoch).
  The readonly `handle.state` (§3) makes the transition observable.

## 5. The collectSignal lease (required-semantics investigation)

Required: deliver iff ownership ended detached — but what when the handle is
still *armed* at settlement (e.g. the parent tore down mid-collect, or the
downstream collector crashed without detaching)? The base rule stands:

> **Armed at settlement ⇒ consume wins.** The epoch promise resolves with
> the terminal; the settlement notice is suppressed.

Rationale: (1) there is no observable "consume" event — **consume =
settlement while armed**; (2) it never double-signals
(one channel per settlement: promise XOR notice); (3) it cannot wedge
`waiting` ancestry — `releaseOwnership` (:1437) runs unconditionally and is
what unblocks ancestors, notice delivery never was; (4) the `subagent/end`
lifecycle edge still fires, so telemetry sees the settlement either way.
The residual risk of the base rule — a dropped collector silently swallowing
the settlement notice or wedging teardown — is closed by the **lease**
(amendment 3): `collectSignal` owns the collection lease for the whole
first-epoch wait. When it aborts, an ARMED collector transitions exactly as
`abort()` does (§4.3's synchronous abort path). The owner going away is
itself an ownership resolution, so no drain-path special-casing is needed —
one mechanism covers teardown-mid-collect. There are no drain branches. The
lease only acts on an ARMED collector: after an implicit followup-detach
(§4.4) the state field is terminal and the lease abort is a no-op — teardown
of that child then relies on the detached path's inject-under-closing-
teardown record (§4.2 Details), exactly as for any detached child. Wiring
`collectSignal` (to the collecting tool call's cancellation) is dsh-cc's
responsibility in Slice 3 of docs/plans/2026-09-05-continuable-background-ux.md;
the harness defines the lease, the caller wires it.

This also closes the scheduler-drain interleaving: a tool call awaiting
`epoch` is an in-flight dispatch the scheduler awaits during parent cancel
(tool-calls.ts:215-241), so abort propagation must be synchronous and
lease-driven, never dependent on downstream catching the cancel first.

## 6. Race analysis

- **consume-vs-detach, same tick.** Settlement runs to the
  `notifySettlement` call synchronously inside `finishDisposal`'s await
  chain; `detach()` is a synchronous flip. Whichever executes first wins:
  armed wins → `consumed`, no notice; detached wins → notice delivered, and
  the epoch stays pending forever (§4.2's detached-handle rule). A detach
  scheduled after the settlement microtask observes a terminal state and is
  a no-op. No interleaving exists where both a notice is sent and the epoch
  resolves with it, because both branches read and flip the same field
  without an await between check and use.
- **abort pre-acceptance.** Impossible through the handle: the handle is
  returned only after acceptance. Pre-acceptance cancellation remains
  `spec.signal`'s job (unchanged, G5 of the UX plan); a start rejection
  yields no ids and no collector (§4.1).
- **abort vs settlement.** If disposal already began (`activation.disposal !==
  undefined`), `abort()` skips the cancel (the G4 no-op rule) but still
  wins ownership (`state = 'aborted'`); the in-flight settlement later sees
  a closed collector and delivers nothing, and the epoch resolves from the
  real disposal terminal. If abort wins first, the watcher's later disposal
  is notice-free.
- **collectSignal abort.** Fires the same synchronous §4.3 abort path —
  ownership wins, cancel issued, prompt return — with no round trip
  through the handle. This is what makes a dropped collector safe (§5).
- **abort vs a *later* epoch.** The collector lives on the first
  Activation object; `abort` re-checks `this.activations.get(childId) ===
  activation` before cancelling, so it can never cancel a cold-resumed
  successor Activation (an absent target is a no-op, matching `interrupt`).
- **repeated detach / repeated abort / detach-then-abort.** All no-ops on a
  closed state field; exactly-once is structural (single mutable field, no
  await inside the transition), not counter-based.
- **N collectors, one parent.** Each `startContinuable` creates its own child
  and its own collector; no shared state. Each `abort()` issues at most one
  cancel (idempotence via state + disposal check). Parent cancel reaches
  these handles through the real tool scheduler: a tool call awaiting
  `epoch` is an in-flight dispatch the scheduler awaits during parent cancel
  (tool-calls.ts:215-241), and parent-cancel teardown aborts the tool call's
  signals, which fires the `collectSignal` lease (§5) — every child is
  aborted exactly once via one mechanism; there is no drain branch.
- **GC/disposal of unclaimed handles.** The collector is a field of the
  Activation; the Activation is removed from the live map at disposal
  settlement (:1428). A detached epoch never resolves and is GC'd with the
  session (§4.2's detached-handle rule); a resolved promise is GC-eligible
  normally. No timer, no WeakRef, no registry — nothing to leak.
- **startContinuable rejection with `collectable: true`.** No handle is
  constructed (it is built only on the success path); the caller's `await`
  rejects with the existing typed error and the rollback path is unchanged.

## 7. Backward compatibility

- Omitting `options` (every existing caller) → no collector is installed →
  `notifySettlement` skips the new branch entirely and `ContinuableStart`
  has no `handle` field: **byte-for-byte current behavior**, including the
  unconditional notice and `announced` rule.
- The signature widening `startContinuable(spec)` → `startContinuable(spec,
  options?)` is source- and type-compatible (optional trailing parameter).
- Lifecycle events (`subagent/start`/`subagent/end`) and their payloads are
  unchanged; the collector governs only the `subagent-settled` parent
  message. This matches the seam's separation between the report/notice
  message channel and the observer edge (lifecycle.ts module docs).
- No persistence format change: the collector is process-local, never
  durable. A process restart mid-collect simply loses the handle (the child
  settles and — with no collector on the cold-resumed Activation — delivers
  today's normal notice). The durable record remains the child's Session.

## 8. Required-semantics tensions found (flagged)

1. **"Consume = epoch awaited to resolution" is unobservable.** A promise
   cannot tell whether anyone awaits it. Smallest reconciling adjustment:
   define consume as *armed-at-settlement* (§5). The "first of
   consume/detach/abort wins, linearized at resolution time" contract is
   preserved — resolution is one of the three racing events — but "consume"
   fires at settlement, not at the first `.then`. If upstream insists on
   true await-detection, the fallback is a two-phase protocol
   (`epoch.then` marking interest + a grace tick), which I recommend
   against: it reintroduces exactly the timing-dependent double-signal the
   handle exists to remove.
2. **`notifySettlement`'s unconditionality is a documented invariant**
   (continuation.ts:1444-1458: "does not consider whether the child
   reported, because the cases that most need it … never got to choose").
   The collectable option deliberately narrows it. The smallest reconciling
   adjustment keeps the invariant's spirit: the suppression applies only
   when the parent (or its tool layer) demonstrably holds the result channel
   (armed/aborted collector), and the `'quiet'`-style vocabulary
   (`SubagentReportDelivery`, G6) is the precedent that delivery policy is a
   per-operation concern, not a manager-wide one. Doc comment on
   `notifySettlement` must be updated in the same PR.
3. **Esc-abort "without awaiting settlement" vs. exactly-once epoch
   resolution.** A strictly once-resolving epoch that only settles at
   disposal would force the aborting collector to either hang or race.
   Adjustment (v2, adjudicated): `abort()` is an *acknowledgment*, not the
   terminal — it wins ownership and issues the cancel, returning promptly,
   while the epoch resolves later from the real disposal terminal (§4.3).
   Eager resolution at `abort()` was rejected in review: it would discard
   the real terminal and fork the resolution path.
4. **Followup-during-collect (new hazard this API creates).** Without the
   implicit detach of §4.4, a parent that follows up its own collected child
   would silently suppress its settlement notice — an invariant violation
   the required semantics did not anticipate. The implicit detach (applied
   only AFTER followup admission succeeds) is the smallest fix and must be
   called out for downstream review.

## 9. Test plan

New file `packages/subagent/subagent/tests/continuation-collectable.spec.ts`
(mirrors the existing `continuation.spec.ts` harness: fake provider with
`prepareContinuable`, scripted child turns). Case list, mirroring §6:

1. `collectable: true` returns a handle; `epoch` resolves with
   `{ stopReason: 'completed', output }` equal to the `subagent/end` payload;
   **no** `subagent-settled` message reaches the parent.
2. Same start without the option: notice delivered (regression guard for §7).
3. `detach()` before settlement: notice delivered with today's wake/steer
   shape (idle parent → followup; busy parent → steer); the epoch stays
   pending forever per §4.2's detached-handle rule (never awaited after
   detach — promotion detaches and never awaits).
4. `detach()` after settlement: no-op, no second notice.
5. `abort()` while child running: returns promptly (not awaiting child
   quiescence); the epoch does NOT resolve at abort time — it resolves
   `aborted` from the real disposal terminal (or `error` on teardown
   failure); child quiesces; no notice; Activation disposed; `subagent/end`
   still fires with `aborted`.
6. `abort()` after natural settlement: no-op (no cancel, no notice).
7. `abort()` while parent teardown already opened disposal: no cancel issued,
   epoch resolves from the real terminal, no notice, no wedge (parent leaves
   `waiting`).
8. consume-vs-detach race, BOTH orders (same-tick): armed wins → `consumed`,
   epoch resolves, no notice; detached wins → notice delivered, epoch stays
   pending forever (and is never rejected).
9. error / max-tokens / refusal terminals each resolve `epoch` with the
   matching `stopReason` (+ output when the child produced one) and suppress
   the notice; teardown failure resolves `error`.
10. followup ADMISSION FAILURE while armed → collector NOT detached
    (state stays `armed`); successful followup → detached post-admission
    (`handle.state === 'detached'`) → later settlement delivers the notice.
11. start rejection with `collectable: true`: no handle, existing typed
    error, rollback unchanged; `spec.signal` abort pre-acceptance unchanged.
12. N parallel collected children under one parent, cancelled via the REAL
    tool scheduler (parent cancel path, tool-calls.ts:215-241): every child
    aborted exactly once (via the collectSignal lease), all epochs resolve,
    parent drains, no wedge.
13. repeated `detach()`; detach-after-settlement: both no-ops, no second
    notice; a detached epoch never resolves and never rejects.
14. `collectSignal` abort while armed: same synchronous abort path as
    `handle.abort()` — ownership wins, cancel issued, epoch resolves from
    the real disposal terminal, no notice.
15. abort-vs-settlement race, both orders: each exactly-one-signal, no
    double delivery, no hung epoch.
16. synchronous throw in the disposal tail (before `notifySettlement`):
    epoch resolves `{ stopReason: 'error' }` — never hangs.
17. cold resume after a collected epoch: new Activation has no collector;
    later settlement delivers today's normal notice.
18. patch-carrying check: the regenerated Cordis `api-catalog.ts` diff is
    committed together with the patch (see §10).

Coverage: the repo gate demands per-file 100% on `packages/*/*/src`
(CLAUDE.md); the two v8-ignore-worthy arms are the disposal-cutoff race in
`abort` (mirrors the existing `followup` cutoff ignore at :515-518) — prefer
covering it via case 7's path if schedulable.

## 10. Branch, review, and release

- **Branch:** `feat/collectable-continuable-handle` on the fork
  `dsh-cc/deepseek-harness`, based on `b150a551b8` (0.1.1-rc.2 release
  merge — the checkout's detached HEAD; rebase onto `upstream/main` before
  opening the PR if upstream has moved). PR target: `deepseek-ai/deepseek-harness`
  `main`. Follow the repo's commit convention (`feat(subagent): …`, as in
  `72b204afa1 feat(images): …`); one PR, source + tests + `notifySettlement`
  doc-comment update in the same change (doc gates run in CI,
  `pnpm run doc-sync`).
- **Patch-carrying regeneration (v2):** the Cordis API catalog
  (`packages/extensions/tool-cordis/src/api-catalog.ts:1781-1785` and
  `:3145-3150`) embeds the method signature and the exact
  `ContinuableStart` declaration — it MUST be REGENERATED and the diff
  CARRIED with every rebase of the fork-carried patch. Check
  `knip.json`'s unused-export rules for the new type exports
  (`ContinuableEpochResult`, `ContinuableEpochHandle`, and the overload
  surface) and run the repo's doc-sync checks before opening the PR.
  CONTRIBUTING.md:9 confirms external PRs are not accepted; the
  fork-carried patch is the distribution path, and the change stays
  additive: one module + re-exports + an optional trailing option.
- **Contribution caveat:** CONTRIBUTING.md states the project does not
  currently accept external PRs. The fork-PR may need to land through a
  maintainer or as a patch carried by dsh-cc until accepted; the design keeps
  the change additive so carrying it as a downstream patch is viable.
- **Versioning:** additive public API on `@deepseek-ai/dsh-subagent`.
  Bump `packages/subagent/subagent/package.json` `0.1.1-rc.2` → `0.2.0` (or
  `0.1.1-rc.3` if it rides the current prerelease train). The repo is
  pre-first-stable-release with a "foundation over blast radius" stance, so
  no deprecation shim is needed. **The downstream pin should wait for the
  first tag carrying this API** — nominally `0.2.0` — and gate on
  `typeof start.handle === 'object' || start.handle !== undefined` (feature
  detection) rather than hard-pinning, so the dsh-cc worktree stays runnable
  against both.

## Review provenance

Dual cold review (deep-reasoner + Codex), both verdicts **REVISE**; the
revision above folds the adjudicated outcome:

- **Converged:** the state-machine blocker — the v1 3-state union collapsed
  `consumed` into a `detached` terminal marker, corrupting the notify path —
  fixed as the 4-state machine (§4.1, §4.2).
- **Converged:** implicit detach's placement in `submit()` was wrong
  (pre-admission detach could strand a collector on a failed follow-up);
  moved post-admission with observable `handle.state` (§4.4).
- **Adjudicated divergences:**
  - eager-abort resolution rejected in favor of the ack/terminal split
    (Codex position adopted, §4.3);
  - armed-at-settlement consume retained but lease-bound via
    `collectSignal` (combined position, §3 + §5);
  - implicit detach retained post-admission (deep-reasoner's placement fix
    + state observability, §4.4);
  - teardown-drain is covered by the `collectSignal` lease + the
    parent-cancel integration test (case 12) rather than drain-path
    special-casing — one mechanism, no drain branches (§5, §4.3).
