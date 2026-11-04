# Code anchors — subagent-lifecycle

Verbatim excerpts pinned to the rc.5 line. Each section carries a self-citation
so the excerpt range is checkable in this file as well.

## A1 — the spawn lane: the pool is the only capacity valve, plus the refusal copy 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L6-L75〕

`packages/subagent/task/src/live-capacity.ts:1-16`

```ts
/**
 * The §3.6 admission lease and capacity-refusal copy, shared by every spawn
 * lane (`startBackground`, `collectForeground`, the ephemeral dispatch).
 *
 * As of the rc.5 subagent runtime the harness capacity pool
 * (`maxActiveSubagents`, configured to 25 in the cc bundle) is the ONLY
 * capacity valve: it counts resident activations per root-parent tree and
 * throws ACTIVATION_LIMIT_REACHED — there is no queue and no dsh-cc-side
 * running-count refusal anymore. What remains here is the F-1 atomic
 * admission lease (serialization of check+create per parent) and the single
 * refusal literal the pool's bare error is mapped onto for a user-visible
 * remedy.
 *
 * @module
 */

```

`packages/subagent/task/src/live-capacity.ts:27-68`

```ts
export const MAX_LIVE_CONTINUABLE_CHILDREN = 25

/**
 * The single runtime refusal literal for the resident-capacity cap (D4). The
 * continuation admission in `@dsh-cc/subagent-resume-pins` carries the same
 * text, so the user-visible remedy cannot drift between the spawn lanes and
 * `send_message` continuations; a test pins byte equality.
 */
export const LIVE_CAPACITY_REFUSAL = `parent has ${MAX_LIVE_CONTINUABLE_CHILDREN} resident subagents in its activation `
  + 'tree (limit reached): the harness counts every resident activation in the tree — '
  + 'running children, idle parents waiting on child settlement, and cold-resumed '
  + 'children all hold slots; send_message follow-ups to an already-resident child do '
  + 'not. Free a slot with release_agent on a listed child (or /agents release <id> '
  + 'interactively), dispose children you no longer resume, or let running children settle'

/**
 * Map the harness pool's bare ACTIVATION_LIMIT_REACHED throw onto the D4
 * refusal literal (which names the release_agent remedy); anything else
 * returns `undefined` so the caller rethrows it unchanged.
 */
export function capacityErrorRefusal(error: unknown): Error | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  const message = String((error as { message?: unknown }).message ?? error)
  if (code === 'ACTIVATION_LIMIT_REACHED' || message.includes('ACTIVATION_LIMIT_REACHED')) {
    return new Error(LIVE_CAPACITY_REFUSAL)
  }
  return undefined
}

/**
 * F-1: atomic admission. Takes the per-parent admission lease; the caller
 * holds it across the creation call and releases it once creation settled
 * (success or failure). The capacity DECISION belongs to the harness pool —
 * `startActivation` throwing ACTIVATION_LIMIT_REACHED is the refusal (map it
 * through {@link capacityErrorRefusal} for the remedy copy).
 */
export async function acquireLiveCapacity(
  parent: Agent,
  signal: AbortSignal,
): Promise<AdmissionLease> {
  return acquireAdmission(String(parent.id), signal)
```

## A2 — continuation admission: no dsh-cc-side count, one refusal literal 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L76-L123〕

`packages/subagent/resume-pins/src/live-capacity.ts:1-16`

```ts
/**
 * Admission serialization for continuation dispatch (`send_message`).
 *
 * As of the rc.5 subagent runtime the harness capacity pool
 * (`maxActiveSubagents`, configured to 25 in the cc bundle) is the ONLY
 * capacity valve — for fresh activations AND for cold-resumed continuations
 * alike (a follow-up to an already-resident child takes no slot). The dsh-cc
 * running-count refusal that used to gate continuations is deleted; a
 * cold resume that would overshoot simply lets the harness throw
 * ACTIVATION_LIMIT_REACHED downstream.
 *
 * What remains here: the per-parent admission lease that serializes
 * continuation acceptance with spawn dispatch, and the single refusal
 * literal kept byte-identical to the spawn lane's so the remedy copy cannot
 * drift (a test pins equality).
 */
```

`packages/subagent/resume-pins/src/live-capacity.ts:45-64`

```ts
 * through message acceptance (not the child's epoch): a cold resume spends a
 * pool slot inside that window, and a running target may settle while
 * delivery waits. Child-to-parent reports keep their exemption. The capacity
 * DECISION belongs to the harness pool — no dsh-cc-side counting here
 * anymore.
 */
export async function admitContinuation(
  _services: CapacityServices,
  parent: { id?: unknown; session?: { header?: { parentSession?: unknown } } } | undefined,
  targetId: string,
  signal: AbortSignal,
): Promise<ContinuationAdmission> {
  signal.throwIfAborted()
  const reportingTo = parent?.session?.header?.parentSession
  if (parent?.id === undefined || (reportingTo !== undefined && String(reportingTo) === targetId)) {
    return { admitted: true, release: () => undefined }
  }
  const lease = await acquireAdmission(String(parent.id), signal)
  return { admitted: true, release: lease }
}
```

## A3 — the shared per-parent admission lease (check + creation in one critical section) 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L124-L185〕

`packages/subagent/resume-pins/src/admission.ts:1-55`

```ts
/**
 * Per-parent FIFO admission shared by spawn and send_message dispatch.
 * Callers hold check + creation/acceptance under one lease and release in
 * finally. Approval runs before admission; there are no counters or expiring
 * reservations. Cancellation cannot free a held lease before creation settles.
 * Duplicate module copies share the queue through a process-global symbol.
 */
export type AdmissionLease = () => void
const STATE_KEY = Symbol.for('@dsh-cc/subagent-admission/v1')
const globals = globalThis as unknown as Record<symbol, { tails: Map<string, Promise<void>> } | undefined>
const state = globals[STATE_KEY] ??= { tails: new Map<string, Promise<void>>() }

/**
 * Acquire the admission lease for one parent session. Resolves when every
 * earlier lease of the same parent has been released.
 * @throws the signal's reason if it aborts while waiting, or before the lease
 *   would be handed over (a cancelled waiter never holds the lease).
 */
export async function acquireAdmission(parentId: string, signal: AbortSignal): Promise<AdmissionLease> {
  const { tails } = state
  signal.throwIfAborted()
  const previous = tails.get(parentId) ?? Promise.resolve()
  let release!: () => void
  const mine = new Promise<void>(resolve => { release = resolve })
  const tail = previous.then(() => mine)
  tails.set(parentId, tail)
  const cleanup = (): void => {
    if (tails.get(parentId) === tail) tails.delete(parentId)
  }
  let abortWaiter: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    abortWaiter = () => reject(signal.reason ?? new Error('aborted'))
    signal.addEventListener('abort', abortWaiter, { once: true })
  })
  try {
    await Promise.race([previous, aborted])
    // The race can settle with the predecessor and the abort land before this
    // continuation runs: recheck so a cancelled waiter is never handed the lease.
    signal.throwIfAborted()
  } catch (error) {
    // Left the queue without holding the lease: pass the turn straight on.
    release()
    void tail.then(cleanup)
    throw error
  } finally {
    if (abortWaiter !== undefined) signal.removeEventListener('abort', abortWaiter)
  }
  let released = false
  return () => {
    if (released) return
    released = true
    release()
    void tail.then(cleanup)
  }
}
```

## A4 — dispatch admission at tools/execute, after approval, lease held until delivery settles 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L186-L218〕

`packages/subagent/resume-pins/src/dispatch-admission.ts:1-26`

```ts
/** Atomic continuation admission after approval, held until delivery settles. */
import { admitContinuation, type CapacityServices } from './live-capacity.ts'

/** No per-execution tracker: every acquired lease has a lexical finally. */
export function wireDispatchAdmission(ctx: unknown): void {
  const context = ctx as CapacityServices & {
    on(name: 'tools/execute', handler: (exec: {
      name: string
      arguments: unknown
      agent?: Parameters<typeof admitContinuation>[1]
      signal: AbortSignal
    }, next: () => Promise<unknown>) => Promise<unknown>): unknown
  }
  context.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'send_message') return next()
    const target = (exec.arguments as { agent_id?: unknown } | null)?.agent_id
    if (typeof target !== 'string' || target.length === 0) return next()
    const admission = await admitContinuation(context, exec.agent, target, exec.signal)
    if (!admission.admitted) throw new Error(admission.reason)
    try {
      return await next()
    } finally {
      admission.release()
    }
  })
}
```

## A5 — the resident-slot contract text the model's abstraction follows 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L219-L227〕

`packages/subagent/task/src/index.ts:184-185`

```ts
  '- Exiting your session drains every background child\'s in-flight turn (whole-forest teardown); its persisted session survives on disk — a child that settled on its own stays cold-resumable, but a DRAINED child does not resume on the next send_message (known upstream gap; cross-session resume after a drain is unverified).',
  '- A background child holds one of 25 tree-wide resident capacity slots until it is disposed or released — running children, idle parents waiting on child settlement, and cold-resumed children all count; a send_message follow-up to an already-resident child takes no new slot, while a cold resume of a settled child needs one and is refused at the cap with the same remedy. A settled child auto-releases after its inactivity grace window (foreground deliveries 30 minutes, background 2 hours; a definition\'s `autoReleaseMs` frontmatter overrides this, `0` disables) — after expiry its send_message is refused, so send_message promptly if you plan to continue it. release_agent <id> remains the interactive override for a RUNNING child: it evicts the resident activation (and resident descendants\') one-way — same-session continuation is unavailable after release; its persisted session survives; eviction is cooperative — a cancel-resistant turn keeps its slot until it settles.',
```

## A6 — grace arm/fire: membership gate, running/idle skip, fail-open tombstone 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L228-L277〕

`packages/subagent/task/src/grace-window.ts:150-192`

```ts
export function armGraceWindow(childId: string): void {
  cancelPendingGrace(childId)
  const entry = registry.get(childId)
  if (entry === undefined) return // non-registry id: never arms (membership)
  const deps = depsRef
  if (deps === undefined) return
  const windowMs = resolveGraceWindowMs(entry)
  if (windowMs === 0) return // tri-state: 0 disables, never armed
  const now = (deps.now ?? Date.now)()
  const timer = setTimeout(() => {
    void fireGraceWindow(childId).catch((error: unknown) => {
      deps.warn?.(`grace-window fire failed for ${childId}: ${(error as Error).message}`)
    })
  }, windowMs)
  timer.unref?.()
  pending.set(childId, { timer, expiresAt: now + windowMs })
}

/**
 * The fire callback: re-check the registry first — a live-again child skips
 * the tombstone and re-arms; otherwise the ready row is tombstoned.
 */
async function fireGraceWindow(childId: string): Promise<void> {
  const deps = depsRef
  if (deps === undefined) return
  const entry = registry.get(childId)
  if (entry === undefined) return
  cancelPendingGrace(childId)
  const status = deps.agents?.get(childId)?.status
  if (status === 'running' || status === 'idle') {
    // Live again (a continuation raced the fire): skip + re-arm.
    deps.warn?.(`grace-window fire for ${childId} skipped: child is live again (${status}); window re-armed`)
    armGraceWindow(childId)
    return
  }
  try {
    deps.tombstone(childId)
    deps.warn?.(`grace-window expired for ${childId}: ready row tombstoned (auto-released after inactivity)`)
  } catch (error) {
    // Fail-open toward retention: skip + log, never tombstone on uncertain state.
    deps.warn?.(`grace-window tombstone failed for ${childId}: ${(error as Error).message}`)
  }
}
```

## A7 — release markers: mark-releasing before the drain, released after it 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L278-L307〕

`packages/interaction/command-agents/src/release.ts:78-100`

```ts
const releasing = new Set<string>()
const released = new Set<string>()
// R8 tombstones: ready rows auto-released by the grace-window fire (no drain,
// no parent authority). Cleared on the child's `subagent/start` via
// `clearTombstone`. One-way only while the process lives.
const tombstoned = new Set<string>()

/** Enter the releasing state (pre-issuance; F12a). */
export function markReleasing(id: string): void {
  releasing.add(id)
}

/** Terminal success: move the id releasing → released. */
export function markReleased(id: string): void {
  releasing.delete(id)
  released.add(id)
}

/** Withdraw a releasing mark; refused (no-op) while the id is released. */
export function clearReleasing(id: string): void {
  if (released.has(id)) return
  releasing.delete(id)
}
```

## A8 — the accepted late-continuation residual (SplitContinue probe) 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L308-L322〕

`packages/interaction/command-agents/src/release.ts:110-117`

```ts
// ---------------------------------------------------------------------------
// R8 tombstone algebra: the auto-release lane. `tombstoneReadyRow` marks a
// READY (registry-absent, settled) row without any drain; `clearTombstone`
// runs on the child's `subagent/start` (and equivalently on a gate pass), so
// an in-flight send_message that lands after the fire gets its one extra
// epoch and a fresh window (the accepted residual). The `tombstoned` outcome
// rides the same ReleaseOutcome union so both surfaces can render it.
// ---------------------------------------------------------------------------
```

## A9 — promotion guard and re-tier 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L323-L344〕

`packages/subagent/task/src/epoch-collector.ts:285-299`

```ts
    promote(): void {
      // Idempotent: a collect already resolved (settled) or already promoted
      // never re-releases, re-un-suppresses, or re-resolves.
      if (settled || promoted) return
      promoted = true
      // R9: re-tier the grace window synchronously at the promotion moment.
      try {
        deps.onPromoted?.()
      } catch {
        // A hook failure must never break promotion (retention-safe).
      }
      // Release the watch: the runId-matched `subagent/end` arriving later
      // resolves nothing — the epoch is no longer awaited (§6).
      release(childId)
      // The promoted child's eventual settlement notice flows NORMALLY
```

