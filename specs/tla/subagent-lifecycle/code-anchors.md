# Code anchors — subagent-lifecycle

Verbatim excerpts from the current worktree (head d5f7e385), read before
modeling. Each excerpt is byte-exact; the source path and line range are
given per block. These excerpts exist so that `design.md` claims can carry
workspace markers pointing at a markdown file (the evidence pipeline does
not accept direct `.ts` citations).

## A1 — capacity cap constant and its scope

Source: `packages/subagent/task/src/background-start.ts:29-40`

```ts
export const MAX_LIVE_CONTINUABLE_CHILDREN = 25
```

with the surrounding doc comment: "this cap counts a different thing —
cross-epoch live children (`listChildren` rows with a live running
activation ...) — so the refusal can name the user-visible remedy
(release_agent / `/agents release`). A safety valve, not a scheduling
policy."

## A2 — live-capacity guard (the TOCTOU window)

Source: `packages/subagent/task/src/background-start.ts:210-241`

```ts
export async function assertLiveCapacity(
  seam: SubagentsLike,
  parent: Agent,
  signal: AbortSignal,
  refuse?: (live: number) => Error,
): Promise<void> {
  if (typeof seam.listChildren !== 'function') return
  let children: { id: string; mode?: string }[]
  try {
    children = await seam.listChildren(parent.id, signal)
  } catch {
    return
  }
  const agents = parent.ctx?.get?.('agents') as { get?(id: string): { status?: string } | undefined } | undefined
  const live = children.filter(child => agents?.get?.(child.id)?.status === 'running').length
  if (live >= MAX_LIVE_CONTINUABLE_CHILDREN) {
    throw refuse !== undefined
      ? refuse(live)
      : new Error(
      `parent has ${MAX_LIVE_CONTINUABLE_CHILDREN} live subagents; free a slot with `
      + 'release_agent on a running child (or /agents release <id> interactively), or '
      + 'let children settle — only running children hold slots, and only '
      + 'list_agents-visible children are releasable',
    )
  }
}
```

`await seam.listChildren(...)` inside the guard and the later `startContinuable`
await are two separate yielding points with no lock between them — the
admission is check-then-act across awaits.

## A3 — grace-window arm and fire (membership gate, re-arm, tombstone)

Source: `packages/subagent/task/src/grace-window.ts:145-200` (excerpt)

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
    deps.warn?.(`grace-window fire for ${childId} skipped: child is live again (${status}); window re-armed`)
    armGraceWindow(childId)
    return
  }
  try {
    deps.tombstone(childId)
    deps.warn?.(`grace-window expired for ${childId}: ready row tombstoned (auto-released after inactivity)`)
  } catch (error) {
    // Fail-open toward retention: skip + log, never tombstone on uncertain state.
    ...
  }
}
```

## A4 — release marker algebra (releasing/released/tombstoned sets)

Source: `packages/interaction/command-agents/src/release.ts:75-103`

```ts
const releasing = new Set<string>()
const released = new Set<string>()
// R8 tombstones: ready rows auto-released by the grace-window fire (no drain,
// no parent authority). Cleared on the child's `subagent/start` via
// `clearTombstone`. One-way only while the process lives.
const tombstoned = new Set<string>()

export function markReleasing(id: string): void {
  releasing.add(id)
}

export function markReleased(id: string): void {
  releasing.delete(id)
  released.add(id)
}

export function clearReleasing(id: string): void {
  if (released.has(id)) return
  releasing.delete(id)
}
```

## A5 — the accepted residual: in-flight send_message after a grace fire

Source: `packages/interaction/command-agents/src/release.ts:105-117`

```ts
// R8 tombstone algebra: the auto-release lane. `tombstoneReadyRow` marks a
// READY (registry-absent, settled) row without any drain; `clearTombstone`
// runs on the child's `subagent/start` (and equivalently on a gate pass), so
// an in-flight send_message that lands after the fire gets its one extra
// epoch and a fresh window (the accepted residual).
```

## A6 — mark-before-issue and the refused clear (clobber-proofing)

Source: `packages/interaction/command-agents/src/release.ts:283-288`

```ts
  signal.throwIfAborted()
  markReleasing(id)
  const drain = subagents.drainContinuableChildren!(parent, [SessionId(id)])
```

and `release.ts:315-317`:

```ts
        // clearReleasing (refused while released); unobservable ⇒ KEEP the
        // ...
        // after markReleased (critic r6 #4 / grok r6 #6). Never throws.
```

## A7 — promotion guard (settle-wins)

Source: `packages/subagent/task/src/epoch-collector.ts:283-302`

```ts
    childId,
    promote(): void {
      // Idempotent: a collect already resolved (settled) or already promoted
      // never re-releases, re-un-suppresses, or re-resolves.
      if (settled || promoted) return
      promoted = true
      ...
```

with `finish()` flipping `settled = true` only after the pending start
completes (`epoch-collector.ts:328-332`):

```ts
  const finish = (): void => {
    settled = true
    if (registrationKey !== undefined) unregisterCollector(registrationKey)
    signal.removeEventListener('abort', onAbort)
  }
```

## A8 — send_message deny gate reads the tombstone marker before admission

Source: `packages/subagent/resume-pins/src/plugin.ts:303-320`

```ts
    const markers = ctx.get('ccReleaseMarkers', true) as
      | { isTombstoned?: (id: string) => boolean }
      | undefined
    if (markers?.isTombstoned?.(target) === true) {
      return {
        kind: 'deny' as const,
        reason:
          `[AUTO_RELEASED] Agent ${target} was auto-released after inactivity: its settled `
          + 'grace window expired and the continuation offer lapsed. Its persisted session '
          + 'survives on disk, but same-session continuation is closed — spawn a fresh '
          + 'subagent with subagent_fork to continue the work.',
      }
    }
```

## A9 — session-exit drain contract (prompt copy, pinned by tool.spec.ts:1448)

Source: `packages/subagent/task/src/index.ts:183` (verbatim contract text
pinned by `tests/tool.spec.ts:1448-1455`):

> exiting the session drains every background child's in-flight turn
> (whole-forest teardown); persisted session survives; a self-settled child
> stays cold-resumable; a DRAINED child does not resume on the next
> `send_message`

## A10 — release_agent one-way eviction contract (prompt copy)

Source: `packages/subagent/task/src/release-agent.ts:47-61` and
`release-agent.ts:84`:

```ts
    // Double-release converges to releasing/not-resident; safe to run in parallel.
    isConcurrencySafe: () => true,
```

with the tool description contract (pinned by `tests/release-agent.spec.ts`
T5/T6/T15): release aborts the running turn, evicts the resident activation
and all resident descendants', frees the slot only for a running child, is a
no-op on settled children, and `[released]` tags the agent for the rest of
the process.
