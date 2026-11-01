# Code anchors — subagent-lifecycle

Verbatim excerpts from the current worktree (main after PR #301), read before
modeling. Each excerpt is byte-exact; the source path and line range are
given per block. These excerpts exist so that `design.md` claims can carry
workspace markers pointing at a markdown file (the evidence pipeline does
not accept direct `.ts` citations).

## A1 — the capacity cap, the single refusal literal, and the guard 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L9-L52〕

Source: `packages/subagent/task/src/live-capacity.ts:38-80`

```ts
export const MAX_LIVE_CONTINUABLE_CHILDREN = 25

export const LIVE_CAPACITY_REFUSAL = `parent has ${MAX_LIVE_CONTINUABLE_CHILDREN} live subagents; free a slot with `
  + 'release_agent on a running child (or /agents release <id> interactively), or '
  + 'let children settle — only running children hold slots, and only '
  + 'list_agents-visible children are releasable'
```

with the guard body (`:46-80`) 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L9-L52〕:

```ts
export async function assertLiveCapacity(
  seam: SubagentsLike,
  parent: Agent,
  signal: AbortSignal,
  refuse?: (live: number) => Error,
): Promise<void> {
  signal.throwIfAborted()
  if (typeof seam.listChildren !== 'function') return
  let children: { id: string; mode?: string }[]
  try {
    children = await seam.listChildren(parent.id, signal)
  } catch {
    signal.throwIfAborted()
    return
  }
  signal.throwIfAborted()
  const agents = parent.ctx?.get?.('agents') as { get?(id: string): { status?: string } | undefined } | undefined
  const isRunning = (id: string): boolean => agents?.get?.(id)?.status === 'running'
  const live = children.filter(child => isRunning(child.id)).length
  if (live >= MAX_LIVE_CONTINUABLE_CHILDREN) {
    throw refuse !== undefined ? refuse(live) : new Error(LIVE_CAPACITY_REFUSAL)
  }
}
```

Unobservable capacity (no seam, throwing listing, absent registry) degrades
open — a safety valve never blocks on its own infrastructure.

## A2 — atomic spawn admission: the guard runs under the lease 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L53-L79〕

Source: `packages/subagent/task/src/live-capacity.ts:83-97`

```ts
export async function acquireLiveCapacity(
  seam: SubagentsLike,
  parent: Agent,
  signal: AbortSignal,
  refuse?: (live: number) => Error,
): Promise<AdmissionLease> {
  const lease = await acquireAdmission(String(parent.id), signal)
  try {
    await assertLiveCapacity(seam, parent, signal, refuse)
  } catch (error) {
    lease()
    throw error
  }
  return lease
}
```

The caller holds the lease across the creation call and releases it once
creation settled (`startBackground` / `collectForeground` /
`dispatchEphemeral`), so two concurrent starts cannot both pass the guard —
the TOCTOU the model's earlier revision recorded is gone 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L53-L79〕.

## A3 — the shared per-parent admission lease 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L80-L127〕

Source: `packages/subagent/resume-pins/src/admission.ts:1-56`

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
```

with the FIFO queue and its abort handling (`:19-56`) 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L80-L127〕:

```ts
export async function acquireAdmission(parentId: string, signal: AbortSignal): Promise<AdmissionLease> {
  const { tails } = state
  signal.throwIfAborted()
  const previous = tails.get(parentId) ?? Promise.resolve()
  let release!: () => void
  const mine = new Promise<void>(resolve => { release = resolve })
  const tail = previous.then(() => mine)
  tails.set(parentId, tail)
  ...
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
  return () => { if (released) return; released = true; release(); void tail.then(cleanup) }
}
```

## A4 — continuation admission at dispatch, after approval 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L128-L159〕

Source: `packages/subagent/resume-pins/src/dispatch-admission.ts:1-26`

```ts
/** Atomic continuation admission after approval, held until delivery settles. */
import { admitContinuation, type CapacityServices } from './live-capacity.ts'

/** No per-execution tracker: every acquired lease has a lexical finally. */
export function wireDispatchAdmission(ctx: unknown): void {
  ...
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

`tools/execute` is the dispatch seam 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L128-L159〕: it runs after the pre-execute
waterfall and the approval prompt, and the lease is held until the delivery
settles — so a continuation that waited for approval is admitted against
the capacity at delivery time, not at gate time. There is no expiring
reservation and therefore no stale-admission window.

## A5 — the send_message tombstone gate (pre-execute) 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L160-L183〕

Source: `packages/subagent/resume-pins/src/plugin.ts:299-322`

```ts
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'send_message') return next()
    const target = (exec.arguments as { agent_id?: unknown } | null)?.agent_id
    if (typeof target !== 'string' || target.length === 0) return next()
    const markers = ctx.get('ccReleaseMarkers', true) as
      | { isTombstoned?: (id: string) => boolean }
      | undefined
    if (markers?.isTombstoned?.(target) === true) {
      return {
        kind: 'deny' as const,
        reason:
          `[AUTO_RELEASED] Agent ${target} was auto-released after inactivity: its settled `
          ...
```

This gate is a SEPARATE step from the dispatch-time admission (A4) 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L160-L183〕: a grace
fire landing between them admits one extra epoch for an auto-released child
— the documented accepted residual (A8).

## A6 — grace-window arm and fire 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L184-L211〕

Source: `packages/subagent/task/src/grace-window.ts:150-198` (excerpt)

```ts
export function armGraceWindow(childId: string): void {
  cancelPendingGrace(childId)
  const entry = registry.get(childId)
  if (entry === undefined) return // non-registry id: never arms (membership)
  ...
}

async function fireGraceWindow(childId: string): Promise<void> {
  ...
  const status = deps.agents?.get(childId)?.status
  if (status === 'running' || status === 'idle') {
    // Live again (a continuation raced the fire): skip + re-arm.
    armGraceWindow(childId)
    return
  }
  try {
    deps.tombstone(childId)
  } catch (error) {
    // Fail-open toward retention: skip + log, never tombstone on uncertain state.
  }
}
```

## A7 — release marker algebra 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L212-L233〕

Source: `packages/interaction/command-agents/src/release.ts:75-103`

```ts
const releasing = new Set<string>()
const released = new Set<string>()
const tombstoned = new Set<string>()

export function markReleasing(id: string): void { releasing.add(id) }

export function markReleased(id: string): void {
  releasing.delete(id)
  released.add(id)
}

export function clearReleasing(id: string): void {
  if (released.has(id)) return
  releasing.delete(id)
}
```

## A8 — the accepted residual (in-flight send after a grace fire) 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L234-L245〕

Source: `packages/interaction/command-agents/src/release.ts:111-117`

```ts
// R8 tombstone algebra: the auto-release lane. `tombstoneReadyRow` marks a
// READY (registry-absent, settled) row without any drain; `clearTombstone`
// runs on the child's `subagent/start` (and equivalently on a gate pass), so
// an in-flight send_message that lands after the fire gets its one extra
// epoch and a fresh window (the accepted residual).
```

## A9 — promotion guard and mark-before-issue 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L246-L264〕

Source: `packages/subagent/task/src/epoch-collector.ts:283-302` and
`packages/interaction/command-agents/src/release.ts:283-288`

```ts
    promote(): void {
      // Idempotent: a collect already resolved (settled) or already promoted
      // never re-releases, re-un-suppresses, or re-resolves.
      if (settled || promoted) return
      promoted = true
```

```ts
  signal.throwIfAborted()
  markReleasing(id)
  const drain = subagents.drainChildren!(parent, [SessionId(id)])
```

## A10 — session-exit drain contract (prompt copy, pinned by tool.spec.ts) 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L265-L273〕

Source: `packages/subagent/task/src/index.ts:183` (verbatim contract text
pinned by `tests/tool.spec.ts`):

> exiting the session drains every background child's in-flight turn
> (whole-forest teardown); persisted session survives; a self-settled child
> stays cold-resumable; a DRAINED child does not resume on the next 〔src:ws:specs/tla/subagent-lifecycle/code-anchors.md#L265-L273〕
> `send_message`
