/**
 * Shared release operation: the single source of truth for evicting a direct
 * continuable child's resident activation via the root-realm
 * `ccContinuableDisposals` receipt registry (design §3.4.4 — harness rc.5
 * removed `drainChildren`; a release now disposes the retained activation
 * receipt of the NAMED child only, so its own delegates survive and must be
 * released individually by their creating session). Consumed by the
 * model-facing `release_agent` tool and the human-facing
 * `/agents release <id>` command, so both surfaces render ONE copy set (§5)
 * and share ONE process-local marker state (F14: released rows are not
 * representable upstream — the durable catalog survives an eviction and reads
 * `ready`).
 *
 * Residency derivation cross-reference: this module's registry reads derive
 * residency exactly like the sibling sites `snapshot.ts residencyOf` (live
 * `status === 'running'` → running, live-not-running → idle, absent →
 * settled/ready). The capacity pool itself counts RESIDENT activations
 * tree-wide (rc.5) — this derivation only feeds user-facing status.
 * @module @dsh-cc/command-agents/release
 */

import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'

/**
 * One `listDescendants` row as release reads it (harness
 * `SubagentDescendantListEntry`): `depth === 1` is direct-child evidence;
 * `kind: 'child'` rows carry the catalog `mode`; `kind: 'diagnostic'` rows
 * mark a corrupt/unreadable/unsupported branch. `depth` is always present on
 * real rows; duck-typed fakes may omit it (treated as direct).
 */
export interface ReleaseDescendantRowLike {
  readonly id: SessionId | string
  readonly depth?: number
  readonly kind?: string
  readonly mode?: string
  readonly reason?: string
}

/** The duck-typed subagents seam release needs (host duck compat). */
export interface ReleaseSubagentsLike {
  listDescendants?(rootSessionId: SessionId, signal?: AbortSignal):
    Promise<readonly ReleaseDescendantRowLike[]>
}

/**
 * The outcome of one receipt-dispose attempt (mirrors
 * `ContinuableDisposalAttempt` from `@dsh-cc/subagent-task`, duck-typed here
 * so this package keeps its one-directional dependency).
 */
export type ReleaseDisposalAttempt =
  | { readonly held: true; readonly disposed: Promise<void> }
  | { readonly held: false; readonly cause: 'no-receipt' | 'foreign' }

/** The duck-typed `ccContinuableDisposals` service slice release admits on. */
export interface ReleaseDisposalsLike {
  tryDispose(parentId: SessionId, childId: SessionId): Promise<ReleaseDisposalAttempt>
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
  | { kind: 'tombstoned'; id: string }
  | { kind: 'still-resident'; id: string; drainPending: boolean;
      refusal?: 'foreign' | 'no-receipt' /* present on the receipt-refusal arms */ }

export type ReleaseFailureReason =
  | 'unknown-id' | 'not-continuable' | 'no-disposals'
  | 'catalog-unreadable' | 'not-direct-child'

/** A release gate error whose `message` IS the final §5 copy. */
export class ReleaseFailure extends Error {
  constructor(readonly reason: ReleaseFailureReason, message: string) {
    super(message)
  }
}

/** How long a disposal may run before the caller reports still-resident (F4). */
export const DRAIN_OBSERVE_TIMEOUT_MS = 10_000

// ---------------------------------------------------------------------------
// Process-local markers (F14) — TWO sets: `releasing` and `released`.
// markReleasing(id) adds releasing-membership AFTER the final throwIfAborted
// and BEFORE disposal issuance (F12a: an armed first-epoch collect resolves
// DURING the disposal, so the releasing mark must already be visible then).
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
// R8 tombstones: ready rows auto-released by the grace-window fire (no
// disposal, no parent authority). Cleared on the child's `subagent/start`
// via `clearTombstone`. One-way only while the process lives.
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

export function isReleased(id: string): boolean {
  return released.has(id)
}

export function isReleasing(id: string): boolean {
  return releasing.has(id)
}

// ---------------------------------------------------------------------------
// R8 tombstone algebra: the auto-release lane. `tombstoneReadyRow` marks a
// READY (registry-absent, settled) row without any disposal; `clearTombstone`
// runs on the child's `subagent/start` (and equivalently on a gate pass), so
// an in-flight send_message that lands after the fire gets its one extra
// epoch and a fresh window (the accepted residual). The `tombstoned` outcome
// rides the same ReleaseOutcome union so both surfaces can render it.
// ---------------------------------------------------------------------------

/**
 * Tombstone a READY row (grace-window fire). Unlike {@link markReleased} this
 * needs no disposal and no releasing transition — the child is already
 * registry-absent. Returns the outcome kind for the fire log.
 */
export function tombstoneReadyRow(id: string): { kind: 'tombstoned'; id: string } {
  tombstoned.add(id)
  return { kind: 'tombstoned', id }
}

/** Clear the tombstone marker (on the child's `subagent/start`). */
export function clearTombstone(id: string): void {
  tombstoned.delete(id)
}

/** Whether the id is currently tombstoned (auto-released after inactivity). */
export function isTombstoned(id: string): boolean {
  return tombstoned.has(id)
}

/** Test-only: clears BOTH sets and the tombstone set. */
export function resetReleasedMarkers(): void {
  releasing.clear()
  released.clear()
  tombstoned.clear()
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
    case 'no-disposals':
      return `Cannot release ${id}: the ccContinuableDisposals service is not available in this composition.`
    case 'catalog-unreadable':
      return catalogUnreadableCopy(id, detail ?? '')
    case 'not-direct-child':
      return `Agent ${id} is not a direct child of this session; only its creating session (its direct parent) can release it.`
  }
}

const NO_LIST_DESCENDANTS_CAUSE = 'the subagents seam exposes no listDescendants'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/** The post-disposal registry read, fully guarded (a throw degrades to unobservable). */
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
 * Run one release against the receipt registry, with lineage evidence from
 * the descendant catalog (a `depth === 1` row is direct-child evidence; a
 * deeper hit is refused as `not-direct-child` BEFORE any dispose attempt).
 * Gate errors precede any marking/disposal; every transition is test-pinned
 * (design §3.4.4 step list).
 */
export async function runRelease(deps: {
  parent: Agent
  id: string
  subagents: ReleaseSubagentsLike | undefined
  agents: ReleaseRegistryLike | undefined
  disposals?: ReleaseDisposalsLike | undefined
  signal?: AbortSignal // absent → fresh never-aborted controller
}): Promise<ReleaseOutcome> {
  const { parent, id } = deps
  const subagents = deps.subagents
  const agents = deps.agents
  const disposals = deps.disposals
  const signal = deps.signal ?? new AbortController().signal

  // Step 0: admit on the receipt registry (duck-typed, like `agents`).
  if (disposals === undefined || typeof disposals.tryDispose !== 'function') {
    throw new ReleaseFailure('no-disposals', failureMessage('no-disposals', id, undefined))
  }
  signal.throwIfAborted()

  // Step 1: descendant-catalog read (guarded — the rc.5 service call throws
  // `SubagentError` when sessionQuery/projections are absent, so the old
  // seam-absence degrade extends to cover service throws).
  let catalog: 'clean-hit' | 'clean-miss' | 'unreadable'
  let catalogMode: string | undefined
  let catalogCause: string | undefined
  if (subagents === undefined || typeof subagents.listDescendants !== 'function') {
    catalog = 'unreadable'
    catalogCause = NO_LIST_DESCENDANTS_CAUSE
  } else {
    let rows: readonly ReleaseDescendantRowLike[] | undefined
    let cause: string | undefined
    try {
      rows = await subagents.listDescendants(SessionId(parent.id), signal)
    } catch (error) {
      if (signal.aborted) throw error // cancellation is never catalog failure
      cause = errorText(error)
    }
    if (rows === undefined) {
      catalog = 'unreadable'
      catalogCause = cause
    } else {
      const row = rows.find(entry => String(entry.id) === id)
      if (row === undefined) {
        catalog = 'clean-miss'
      } else if ((row.depth ?? 1) > 1) {
        // A deeper-tree hit: the id belongs to a session this parent did not
        // create — refused BEFORE any dispose attempt (lineage evidence, not
        // drain-error text parsing).
        throw new ReleaseFailure('not-direct-child', failureMessage('not-direct-child', id, undefined))
      } else if (row.kind === 'diagnostic') {
        catalog = 'unreadable'
        catalogCause = `the descendant listing returned a "${row.reason ?? 'unavailable'}" diagnostic for ${id}`
      } else {
        catalog = 'clean-hit'
        catalogMode = row.mode
      }
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
    // miss × miss and miss × unobservable both refuse without a disposal.
    throw new ReleaseFailure('unknown-id', failureMessage('unknown-id', id, undefined))
  }
  if (catalog === 'unreadable' && preRead.kind !== 'present') {
    // unreadable × miss and unreadable × unobservable refuse blind.
    throw new ReleaseFailure('catalog-unreadable', catalogUnreadableCopy(id, catalogCause ?? ''))
  }
  if (catalog === 'clean-hit' && preRead.kind === 'absent') {
    // R8: a tombstoned (auto-released) child is registry-absent too — manual
    // release on it stays the not-resident no-op with releasedEarlier: true
    // (T18b parity; the tombstone is the auto lane of the same retirement).
    return { kind: 'not-resident', id, releasedEarlier: isReleased(id) || isTombstoned(id) }
  }

  // A disposal row: catalogNote from the matrix.
  const catalogNote: CatalogNote =
    catalog === 'clean-hit' ? 'catalog'
      : catalog === 'clean-miss' ? 'registry-only'
        : 'catalog-unreadable'

  // Step 5: the honored-cancellation checkpoint comes FIRST, then the mark,
  // then issuance (critic r5 #1: an abort must never orphan a releasing mark
  // on an unissued disposal).
  signal.throwIfAborted()
  markReleasing(id)
  let attempt: ReleaseDisposalAttempt
  try {
    attempt = await disposals.tryDispose(SessionId(parent.id), SessionId(id))
  } catch (error) {
    clearReleasing(id)
    throw error
  }
  if (!attempt.held) {
    // Receipt refusals (never throws): the child was never tracked by this
    // process (or was restored by send_message after settling), or its
    // receipt belongs to a different creating parent.
    clearReleasing(id)
    return { kind: 'still-resident', id, drainPending: false, refusal: attempt.cause }
  }
  const drain = attempt.disposed

  const withCause = (): { cause?: string } =>
    catalogNote === 'catalog-unreadable' && catalogCause !== undefined
      ? { cause: catalogCause }
      : {}

  // Race the disposal against the observe timeout; the timer is cleared on
  // BOTH settle arms (grok r5 #6: a leftover rejecting timer is an unhandled
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
    if ((error as { code?: string } | undefined)?.code === 'ACTIVATION_TEARDOWN_FAILED') {
      // F4's code-order pin: the resident entry is deleted BEFORE the throw,
      // so absent-or-unobservable after this rejection is degraded success.
      // The service rejects `disposed` with the ORIGINAL teardown error —
      // this arm stays live exactly as under the drain seam.
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
    // Observability died between pre- and post-read (grok r6 #3): the
    // disposal's resolution plus the pre-read hit is the eviction evidence;
    // the tag's render degrades per §5's contradictions entry.
    markReleased(id)
    return { kind: 'released', id, preStatus: preStatus ?? 'unknown', catalogNote, ...withCause() }
  }
  for (let attempt = 1; attempt <= 10; attempt++) {
    await sleep(200)
    read = guardedRegistryRead(agents, id)
    if (read.kind !== 'present') {
      // absent: the F4 causation rule (pre-hit + resolved + post-absent ⇒
      // released). unobservable after a pre-read HIT: observability died
      // mid-flight (grok r6 #3) — the disposal resolution is still eviction
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
 * is a verbatim contract. §3.4.4 consequence: a release evicts the NAMED
 * child only — its resident delegates are unaffected and must be released
 * individually by their creating session (upstream `dispose()` does not
 * cascade).
 */
export function renderReleaseOutcome(outcome: ReleaseOutcome): string {
  const { id } = outcome
  switch (outcome.kind) {
    case 'released': {
      const prepend = provenancePrepend(outcome, id)
      const body =
        outcome.preStatus === 'running'
          ? `Released agent ${id}: its in-flight turn was aborted and its resident activation evicted — the capacity slot it held is free. Its resident delegates (if any) are unaffected and must be released individually. The persisted session survives on disk. Within this session it cannot be continued (send_message resolves but runs no turn — upstream cold-resume-after-drain gap); /agents marks it [released] for the rest of this process.`
          : outcome.preStatus === 'idle'
            ? `Released agent ${id}: its resident (idle) activation was evicted — the capacity slot it held is free. Its resident delegates (if any) are unaffected and must be released individually. The persisted session survives on disk; within this session it cannot be continued (upstream cold-resume-after-drain gap); /agents marks it [released] for the rest of this process.`
            : `Released agent ${id}: its resident activation was evicted; any capacity slot it held is free (its running state could not be observed). Its resident delegates (if any) are unaffected and must be released individually. The persisted session survives on disk; within this session it cannot be continued (upstream cold-resume-after-drain gap); /agents marks it [released] for the rest of this process.`
      return prepend + body
    }
    case 'issued-unobservable':
      return `Release of agent ${id} was issued against the authoritative drain seam; this composition cannot observe the registry, so residency after the drain could not be confirmed and the child is NOT marked released. Eviction, when it applies, covers the named child only — its resident delegates are unaffected. If it was resident, the drain evicts it by the seam's own contract; its continuation state here is unknown.`
    case 'evicted-degraded': {
      const prepend = provenancePrepend(outcome, id)
      return prepend + `Release of agent ${id} reported a teardown failure (${outcome.failure}), but the activation entry is removed before that failure surfaces per the seam's disposal order — any capacity slot is free. Its resident delegates (if any) are unaffected and must be released individually. The persisted session survives on disk; within this session it cannot be continued; /agents marks it [released] for the rest of this process.`
    }
    case 'not-resident':
      return outcome.releasedEarlier
        ? `Agent ${id} was released earlier in this process and has no resident activation; nothing was evicted.`
        : `Agent ${id} has no resident activation (settled or released); nothing was evicted and no capacity slot is held by it.`
    case 'tombstoned':
      return `Agent ${id} was auto-released after inactivity (its settled grace window expired); the catalog row is tombstoned for the rest of this process. Nothing was drained — the child was already settled.`
    case 'still-resident':
      if (outcome.refusal === 'foreign') {
        return `Cannot release ${id}: a release receipt for it exists, but it belongs to a different parent session.`
      }
      if (outcome.refusal === 'no-receipt') {
        return `Cannot release ${id}: this session holds no release receipt for it — it was either never spawned by this process, or it settled and was re-woken by send_message (the harness restores a new activation that no API can release by id; let it settle again or restart the session).`
      }
      return outcome.drainPending
        ? `Release of agent ${id} is in flight: its turn did not reach idle within 10s (a cancel-resistant turn). The release still completes by itself if the turn ever becomes idle — /agents then marks it [released] — but nothing locally force-evicts a cancel-resistant turn; a process restart is the only hard boundary.`
        : `Release of agent ${id} was issued, but the registry still reports it resident after the drain; check /agents detail ${id} and retry if it persists.`
  }
}
