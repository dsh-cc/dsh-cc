/**
 * Shared release operation: the single source of truth for evicting a direct
 * continuable child's resident activation via the harness
 * `drainContinuableChildren` seam (plan
 * docs/plans/2026-09-30-subagent-release-valve.md §4 D1). Consumed by the
 * model-facing `release_agent` tool and the human-facing
 * `/agents release <id>` command, so both surfaces render ONE copy set (§5)
 * and share ONE process-local marker state (F14: released rows are not
 * representable upstream — the durable catalog survives a drain and reads
 * `ready`).
 *
 * Residency derivation cross-reference: this module's registry reads derive
 * residency exactly like the sibling sites `snapshot.ts residencyOf` (live
 * `status === 'running'` → running, live-not-running → idle, absent →
 * settled/ready) and `background-start.ts assertLiveCapacity` (a slot is held
 * only while the registry reports `status === 'running'`).
 * @module @dsh-cc/command-agents/release
 */

import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** The duck-typed subagents seam release needs (host duck compat). */
export interface ReleaseSubagentsLike {
  listChildren?(parentSessionId: SessionId, signal?: AbortSignal):
    Promise<readonly { id: string; mode?: string }[]>
  drainContinuableChildren?(parent: Agent, ids: SessionId[]): Promise<void>
}

/** The duck-typed live-agents registry slice release reads. */
export interface ReleaseRegistryLike {
  get(id: string): { status?: 'idle' | 'running' | string } | undefined
}

type PreStatus = 'running' | 'idle' | 'unknown'
type CatalogNote = 'catalog' | 'registry-only' | 'catalog-unreadable'

export type ReleaseOutcome =
  | { kind: 'released'; id: string; preStatus: PreStatus; catalogNote: CatalogNote;
      cause?: string /* present iff catalogNote === 'catalog-unreadable' */ }
  | { kind: 'issued-unobservable'; id: string; catalogNote: 'catalog' }
  | { kind: 'evicted-degraded'; id: string; failure: string; catalogNote: CatalogNote;
      cause?: string /* present iff catalogNote === 'catalog-unreadable' */ }
  | { kind: 'not-resident'; id: string; releasedEarlier: boolean }
  | { kind: 'still-resident'; id: string; drainPending: boolean }

export type ReleaseFailureReason =
  | 'unknown-id' | 'not-continuable' | 'no-drain-seam'
  | 'catalog-unreadable' | 'not-direct-child' | 'stale-parent'

/** A release gate error whose `message` IS the final §5 copy. */
export class ReleaseFailure extends Error {
  constructor(readonly reason: ReleaseFailureReason, message: string) {
    super(message)
  }
}

/** How long a drain may run before the caller reports still-resident (F4). */
export const DRAIN_OBSERVE_TIMEOUT_MS = 10_000

// ---------------------------------------------------------------------------
// Process-local markers (F14) — TWO sets: `releasing` and `released`.
// markReleasing(id) adds releasing-membership AFTER the final throwIfAborted
// and BEFORE drain issuance (F12a: an armed first-epoch collect resolves
// DURING the drain, so the releasing mark must already be visible then).
// markReleased(id) moves the id releasing → released (removes releasing
// membership).
// clearReleasing(id) removes releasing membership ONLY and is refused while
// the id is released (a no-op then) — the invariant that makes a concurrent
// retry's mark clobber-proof against a stale attempt's late handlers
// (critic r5 #3). The timeout arm KEEPS the releasing mark and attaches a
// late completion continuation (step 5). Snapshot tagging rule:
// (isReleased(id) || isReleasing(id)) && registry-absent-at-snapshot-time —
// never from the marker alone.
// ---------------------------------------------------------------------------

const releasing = new Set<string>()
const released = new Set<string>()

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

export function isReleased(id: string): boolean {
  return released.has(id)
}

export function isReleasing(id: string): boolean {
  return releasing.has(id)
}

/** Test-only: clears BOTH sets. */
export function resetReleasedMarkers(): void {
  releasing.clear()
  released.clear()
}

// ---------------------------------------------------------------------------
// Copy helpers (F15 normalization).
// ---------------------------------------------------------------------------

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function catalogUnreadableCopy(id: string, cause: string): string {
  return `Cannot verify ${id} against this session's child catalog (${cause}); refusing to release blind. Retry, or restart the session if listing stays broken.`
}

function failureMessage(
  reason: ReleaseFailureReason,
  id: string,
  detail: string | undefined,
): string {
  switch (reason) {
    case 'unknown-id':
      return `No agent ${id} among this session's continuable children; use list_agents or /agents for current ids.`
    case 'not-continuable':
      return `Agent ${id} is not a continuable child (mode: ${detail ?? 'unknown'}); release only covers continuable children.`
    case 'no-drain-seam':
      return `Cannot release ${id}: this composition's subagents seam exposes no drainContinuableChildren; free capacity by letting children settle or by restarting the session.`
    case 'catalog-unreadable':
      return catalogUnreadableCopy(id, detail ?? '')
    case 'not-direct-child':
      return `Agent ${id} is not a direct child of this session (the drain seam refused with UNAUTHORIZED); release its direct parent instead — if that parent is one of this session's children. Releasing a parent evicts its whole resident subtree.`
    case 'stale-parent':
      return `This session's agent handle is stale (the drain seam refused with UNAUTHORIZED against the parent identity); retry the release, or restart the turn if it persists.`
  }
}

const NO_LIST_CHILDREN_CAUSE = 'the subagents seam exposes no listChildren'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/** The post-drain registry read, fully guarded (a throw degrades to unobservable). */
type GuardedRead =
  | { kind: 'present'; status: string | undefined }
  | { kind: 'absent' }
  | { kind: 'unobservable' }

function guardedRegistryRead(agents: ReleaseRegistryLike | undefined, id: string): GuardedRead {
  if (agents === undefined || typeof agents.get !== 'function') return { kind: 'unobservable' }
  try {
    const row = agents.get(id)
    return row === undefined ? { kind: 'absent' } : { kind: 'present', status: row.status }
  } catch {
    return { kind: 'unobservable' }
  }
}

function preStatusOf(status: string | undefined): PreStatus {
  if (status === 'running' || status === 'idle') return status
  return 'unknown'
}

/**
 * Run one release against the authoritative drain seam. Gate errors precede
 * any marking/drain; every transition is test-pinned (plan §4 D1 step list).
 */
export async function runRelease(deps: {
  parent: Agent
  id: string
  subagents: ReleaseSubagentsLike | undefined
  agents: ReleaseRegistryLike | undefined
  signal?: AbortSignal // absent → fresh never-aborted controller
}): Promise<ReleaseOutcome> {
  const { parent, id } = deps
  const subagents = deps.subagents
  const agents = deps.agents
  const signal = deps.signal ?? new AbortController().signal

  // Step 0: seam gates before any marking or drain.
  if (subagents === undefined || typeof subagents.drainContinuableChildren !== 'function') {
    throw new ReleaseFailure('no-drain-seam', failureMessage('no-drain-seam', id, undefined))
  }
  signal.throwIfAborted()

  // Step 1: catalog read (guarded).
  let catalog: 'clean-hit' | 'clean-miss' | 'unreadable'
  let catalogMode: string | undefined
  let catalogCause: string | undefined
  if (typeof subagents.listChildren !== 'function') {
    catalog = 'unreadable'
    catalogCause = NO_LIST_CHILDREN_CAUSE
  } else {
    try {
      const rows = await subagents.listChildren(SessionId(parent.id), signal)
      const row = rows.find(entry => String(entry.id) === id)
      if (row === undefined) {
        catalog = 'clean-miss'
      } else {
        catalog = 'clean-hit'
        catalogMode = row.mode
      }
    } catch (error) {
      if (signal.aborted) throw error // cancellation is never catalog failure
      catalog = 'unreadable'
      catalogCause = errorText(error)
    }
  }

  // Step 2: registry pre-read (guarded). `preStatus` is captured only on a hit.
  const preRead = guardedRegistryRead(agents, id)
  const preStatus = preRead.kind === 'present' ? preStatusOf(preRead.status) : undefined

  // Step 3: mode gate (clean catalog hit only).
  if (catalog === 'clean-hit' && catalogMode !== 'continuable') {
    throw new ReleaseFailure('not-continuable', failureMessage('not-continuable', id, catalogMode ?? 'unknown'))
  }

  // Step 4: the catalog × registry matrix.
  if (catalog === 'clean-miss' && preRead.kind !== 'present') {
    // miss × miss and miss × unobservable both refuse without a drain.
    throw new ReleaseFailure('unknown-id', failureMessage('unknown-id', id, undefined))
  }
  if (catalog === 'unreadable' && preRead.kind !== 'present') {
    // unreadable × miss and unreadable × unobservable refuse blind.
    throw new ReleaseFailure('catalog-unreadable', catalogUnreadableCopy(id, catalogCause ?? ''))
  }
  if (catalog === 'clean-hit' && preRead.kind === 'absent') {
    return { kind: 'not-resident', id, releasedEarlier: isReleased(id) }
  }

  // A drain row: catalogNote from the matrix.
  const catalogNote: CatalogNote =
    catalog === 'clean-hit' ? 'catalog'
      : catalog === 'clean-miss' ? 'registry-only'
        : 'catalog-unreadable'

  // Step 5: the honored-cancellation checkpoint comes FIRST, then the mark,
  // then issuance (critic r5 #1: an abort must never orphan a releasing mark
  // on an unissued drain).
  signal.throwIfAborted()
  markReleasing(id)
  const drain = subagents.drainContinuableChildren!(parent, [SessionId(id)])

  const withCause = (): { cause?: string } =>
    catalogNote === 'catalog-unreadable' && catalogCause !== undefined
      ? { cause: catalogCause }
      : {}

  // Race the drain against the observe timeout; the timer is cleared on BOTH
  // settle arms (grok r5 #6: a leftover rejecting timer is an unhandled
  // rejection on the happy path).
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), DRAIN_OBSERVE_TIMEOUT_MS)
  })
  const settled = await Promise.race([
    drain.then(
      () => 'resolved' as const,
      error => ({ kind: 'rejected' as const, error }),
    ),
    timedOut,
  ]).finally(() => { clearTimeout(timer) })

  if (settled === 'timeout') {
    // KEEP the releasing mark and attach a fully-total late continuation.
    void drain.then(
      () => {
        // Late resolve: absent ⇒ released (tag becomes visible); present ⇒
        // clearReleasing (refused while released); unobservable ⇒ KEEP the
        // releasing mark — a pure no-op, never a re-insert into releasing
        // after markReleased (critic r6 #4 / grok r6 #6). Never throws.
        try {
          const read = guardedRegistryRead(agents, id)
          if (read.kind === 'absent') markReleased(id)
          else if (read.kind === 'present') clearReleasing(id)
          // unobservable: keep the releasing mark (fail-open).
        } catch { /* total: swallow */ }
      },
      error => {
        try {
          const code = (error as { code?: string } | undefined)?.code
          if (code === 'ACTIVATION_TEARDOWN_FAILED') {
            // The seam's disposal order deletes the resident entry before
            // throwing (F4) — the same evidence as the sync arm.
            const read = guardedRegistryRead(agents, id)
            if (read.kind !== 'present') markReleased(id)
            else clearReleasing(id)
          } else {
            clearReleasing(id)
          }
        } catch { /* total: swallow */ }
      },
    )
    return { kind: 'still-resident', id, drainPending: true }
  }

  if (typeof settled === 'object' && settled !== null && 'kind' in settled && (settled as { kind: string }).kind === 'rejected') {
    const error = (settled as { kind: 'rejected'; error: unknown }).error
    const message = errorText(error)
    if (message.includes('not a direct child')) {
      clearReleasing(id)
      throw new ReleaseFailure('not-direct-child', failureMessage('not-direct-child', id, undefined))
    }
    if (message.includes('exact live parent')) {
      clearReleasing(id)
      throw new ReleaseFailure('stale-parent', failureMessage('stale-parent', id, undefined))
    }
    if ((error as { code?: string } | undefined)?.code === 'ACTIVATION_TEARDOWN_FAILED') {
      // F4's code-order pin: the resident entry is deleted BEFORE the throw,
      // so absent-or-unobservable after this rejection is degraded success.
      const read = guardedRegistryRead(agents, id)
      if (read.kind !== 'present') {
        markReleased(id)
        return {
          kind: 'evicted-degraded', id, failure: message, catalogNote, ...withCause(),
        }
      }
      clearReleasing(id)
      throw error
    }
    clearReleasing(id)
    throw error
  }

  const preReadWasHit = preRead.kind === 'present'
  if (!preReadWasHit) {
    // Pre-read never observed residency — possible only on the catalog-hit
    // row. Zero residency evidence means the released label is never
    // claimable (orchestrator ruling on the unnamed cell, matching the r2/r3
    // adultery guard class): post absent OR unobservable ⇒ issued (no mark,
    // no slot claim); only a still-present read is evidence something was
    // there, and then the bounded poll applies.
    let post = guardedRegistryRead(agents, id)
    for (let attempt = 1; attempt <= 10 && post.kind === 'present'; attempt++) {
      await sleep(200)
      post = guardedRegistryRead(agents, id)
    }
    clearReleasing(id)
    return post.kind === 'present'
      ? { kind: 'still-resident', id, drainPending: false }
      : { kind: 'issued-unobservable', id, catalogNote: 'catalog' }
  }
  let read = guardedRegistryRead(agents, id)
  if (read.kind === 'absent') {
    markReleased(id)
    return { kind: 'released', id, preStatus: preStatus ?? 'unknown', catalogNote, ...withCause() }
  }
  if (read.kind === 'unobservable') {
    // Observability died between pre- and post-read (grok r6 #3): the drain's
    // resolution plus the pre-read hit is the eviction evidence; the tag's
    // render degrades per §5's contradictions entry.
    markReleased(id)
    return { kind: 'released', id, preStatus: preStatus ?? 'unknown', catalogNote, ...withCause() }
  }
  for (let attempt = 1; attempt <= 10; attempt++) {
    await sleep(200)
    read = guardedRegistryRead(agents, id)
    if (read.kind !== 'present') {
      // absent: the F4 causation rule (pre-hit + resolved + post-absent ⇒
      // released). unobservable after a pre-read HIT: observability died
      // mid-flight (grok r6 #3) — the drain resolution is still eviction
      // evidence; the tag's render degrades per §5's contradictions entry.
      markReleased(id)
      return { kind: 'released', id, preStatus: preStatus ?? 'unknown', catalogNote, ...withCause() }
    }
  }
  clearReleasing(id)
  return { kind: 'still-resident', id, drainPending: false }
}

// ---------------------------------------------------------------------------
// §5 copy renderer — ONE renderer keyed by (kind, preStatus, catalogNote).
// Every string here is a full-equality-pinned contract (plan §5).
// ---------------------------------------------------------------------------

/** Provenance prepends for the eviction-claiming kinds. */
function provenancePrepend(outcome: { catalogNote: CatalogNote; cause?: string }, id: string): string {
  if (outcome.catalogNote === 'registry-only') {
    return `(Note: ${id} was absent from the readable child catalog — released via the live registry only.) `
  }
  if (outcome.catalogNote === 'catalog-unreadable') {
    return `(Note: the child catalog was unreadable (${outcome.cause}) — released via the live registry only.) `
  }
  return ''
}

/**
 * Render a release outcome as the final user-facing text. Every §5 variant
 * is a verbatim contract; the descendant clause rides on every
 * eviction-claiming string.
 */
export function renderReleaseOutcome(outcome: ReleaseOutcome): string {
  const { id } = outcome
  switch (outcome.kind) {
    case 'released': {
      const prepend = provenancePrepend(outcome, id)
      const body =
        outcome.preStatus === 'running'
          ? `Released agent ${id}: its in-flight turn was aborted and its resident activation evicted — the capacity slot it held is free. Its resident descendants (if any) were evicted with it. The persisted session survives on disk. Within this session it cannot be continued (send_message resolves but runs no turn — upstream cold-resume-after-drain gap); /agents marks it [released] for the rest of this process.`
          : outcome.preStatus === 'idle'
            ? `Released agent ${id}: its resident (idle) activation was evicted; it held no capacity slot (only running children count toward the 25-child guard). Its resident descendants (if any) were evicted with it. The persisted session survives on disk; within this session it cannot be continued (upstream cold-resume-after-drain gap); /agents marks it [released] for the rest of this process.`
            : `Released agent ${id}: its resident activation was evicted; any capacity slot it held is free (its running state could not be observed). Its resident descendants (if any) were evicted with it. The persisted session survives on disk; within this session it cannot be continued (upstream cold-resume-after-drain gap); /agents marks it [released] for the rest of this process.`
      return prepend + body
    }
    case 'issued-unobservable':
      return `Release of agent ${id} was issued against the authoritative drain seam; this composition cannot observe the registry, so residency after the drain could not be confirmed and the child is NOT marked released. Eviction, when it applies, also covers resident descendants. If it was resident, the drain evicts it by the seam's own contract; its continuation state here is unknown.`
    case 'evicted-degraded': {
      const prepend = provenancePrepend(outcome, id)
      return prepend + `Release of agent ${id} reported a teardown failure (${outcome.failure}), but the activation entry is removed before that failure surfaces per the seam's disposal order — any capacity slot is free. Its resident descendants (if any) were evicted with it. The persisted session survives on disk; within this session it cannot be continued; /agents marks it [released] for the rest of this process.`
    }
    case 'not-resident':
      return outcome.releasedEarlier
        ? `Agent ${id} was released earlier in this process and has no resident activation; nothing was evicted.`
        : `Agent ${id} has no resident activation (settled or released); nothing was evicted and no capacity slot is held by it.`
    case 'still-resident':
      return outcome.drainPending
        ? `Release of agent ${id} is in flight: its turn did not reach idle within 10s (a cancel-resistant turn). The release still completes by itself if the turn ever becomes idle — /agents then marks it [released] — but nothing locally force-evicts a cancel-resistant turn; a process restart is the only hard boundary.`
        : `Release of agent ${id} was issued, but the registry still reports it resident after the drain; check /agents detail ${id} and retry if it persists.`
  }
}
