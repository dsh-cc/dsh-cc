/**
 * The coordinator's per-session state store (design
 * docs/plans/2026-11-02-systemone-04-memory-extraction-gate.md §"State machine
 * and commit rules").
 *
 * `ExtractionState` is the design's own state shape, verbatim; {@link SessionEntry}
 * is the bookkeeping it cannot carry (the owning Agent, the in-flight job, the
 * held mutation lease and the bounded takeover wait). Both live here so the
 * coordinator file stays about the state machine, and the LRU selection is a
 * pure function so the cap policy is testable without a host.
 *
 * @module @dsh-cc/memory-consolidation/extraction-state
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MemoryJobControl } from './memory-job.ts'

/**
 * The design's per-session state. `reviewedThrough` starts at -1 so a seq-0
 * correction is never missed.
 */
export interface ExtractionState {
  reviewedThrough: number
  phase: 'idle' | 'gating' | 'waiting-lease' | 'extracting' | 'cooldown' | 'disposed'
  generation: number
  active?: { generation: number; through: number; controller: AbortController }
  pendingHead?: number
  retryAt: number
  skipOrdinal: number
  lastUsedAt: number
}

/** One session's entry: the design state plus the bookkeeping it cannot carry. */
export interface SessionEntry {
  readonly key: string
  readonly memoryDir: string
  readonly sessionId: string
  readonly agent: Agent
  state: ExtractionState
  job: MemoryJobControl | undefined
  /** The release handle of the mutation lease this entry currently owns. */
  lease: (() => void) | undefined
  /** Bounded wait for the previous owner's job.done, observed before new work. */
  gateWait: Promise<void> | undefined
}

/** The phases a session state can be evicted from: no gate and no job in flight. */
const EVICTABLE_PHASES: ReadonlySet<ExtractionState['phase']> = new Set(['idle', 'cooldown'])

/** Compose the state key: canonical dir plus session header id, never raw cwd. */
export function stateKey(memoryDir: string, sessionId: string): string {
  return `${memoryDir}\u0000${sessionId}`
}

/** Widen one live phase read (an earlier assignment would narrow the property). */
export function phaseOf(state: ExtractionState): ExtractionState['phase'] {
  return state.phase
}

/**
 * Byte-order scope-key comparison, the LRU tie-break the design pins.
 * @param a - one state key.
 * @param b - the other state key.
 * @returns the sort order.
 */
export function compareScopeKey(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/**
 * Build one fresh state (watermark -1: an unknown review history re-extracts in
 * preference to a permanently missed memory).
 * @param now - the current clock value.
 * @returns the state.
 */
export function createState(now: number): ExtractionState {
  return {
    reviewedThrough: -1,
    phase: 'idle',
    generation: 0,
    retryAt: 0,
    skipOrdinal: 0,
    lastUsedAt: now,
  }
}

/**
 * Build one session entry bound to its owning Agent.
 * @param memoryDir - the canonical writable memory directory.
 * @param sessionId - the session header id.
 * @param agent - the Agent that owns the state.
 * @param now - the current clock value.
 * @returns the entry.
 */
export function createEntry(memoryDir: string, sessionId: string, agent: Agent, now: number): SessionEntry {
  return {
    key: stateKey(memoryDir, sessionId),
    memoryDir,
    sessionId,
    agent,
    state: createState(now),
    job: undefined,
    lease: undefined,
    gateWait: undefined,
  }
}

/**
 * Select the states to evict so the store fits `cap`.
 *
 * Only states with no in-flight work (idle or cooling down) are candidates: the
 * design bounds active states by the host's Agent lifecycle instead, and a new
 * session's extraction must never be skipped because the cache is full. The
 * oldest `lastUsedAt` goes first, ties broken by scope-key byte order, so the
 * choice is deterministic.
 * @param entries - every current entry.
 * @param cap - the configured `session-state-cap`.
 * @param keep - the entry the caller is settling right now (never evicted).
 * @returns the entries to delete, in eviction order.
 */
export function selectEvictions(
  entries: Iterable<SessionEntry>,
  cap: number,
  keep?: SessionEntry,
): SessionEntry[] {
  const all = [...entries]
  let excess = all.length - cap
  if (excess <= 0) return []
  const candidates = all.filter((entry) => entry !== keep && EVICTABLE_PHASES.has(entry.state.phase))
  candidates.sort((a, b) => a.state.lastUsedAt - b.state.lastUsedAt || compareScopeKey(a.key, b.key))
  const evicted: SessionEntry[] = []
  for (const entry of candidates) {
    if (excess <= 0) break
    evicted.push(entry)
    excess -= 1
  }
  return evicted
}

/**
 * Commit a reviewed window: the watermark only ever moves forward, and every
 * pending entry at or below the new watermark is cleared.
 * @param state - the session state.
 * @param through - the captured evidence head this review covered.
 * @param now - the current clock value.
 */
export function commitReviewed(state: ExtractionState, through: number, now: number): void {
  state.reviewedThrough = Math.max(state.reviewedThrough, through)
  if (state.pendingHead !== undefined && state.pendingHead <= state.reviewedThrough) delete state.pendingHead
  state.phase = 'idle'
  state.lastUsedAt = now
}

/**
 * Enter the failure cooldown. Only a LATER stop may retry: no timer is installed.
 * @param state - the session state.
 * @param retryAt - the epoch at which a later stop may retry.
 * @param now - the current clock value.
 */
export function enterCooldown(state: ExtractionState, retryAt: number, now: number): void {
  state.phase = 'cooldown'
  state.retryAt = retryAt
  state.lastUsedAt = now
}

/**
 * Drop a verdict because the mode flipped to `off`: no watermark move, no
 * fallback, and no pending drain (the legacy branch owns the next stop).
 * @param state - the session state.
 * @param now - the current clock value.
 */
export function discardForOffMode(state: ExtractionState, now: number): void {
  state.phase = 'idle'
  delete state.active
  delete state.pendingHead
  state.lastUsedAt = now
}

/**
 * Cancel one entry's generation and job, and hand back the settle promise the
 * caller may wait on. Idempotent: a second call has nothing left to abort.
 * @param entry - the entry to cancel.
 * @param reason - the abort reason (diagnostic only).
 * @returns a promise that resolves once the job settled (immediately when idle).
 */
export function cancelEntry(entry: SessionEntry, reason: string): Promise<void> {
  const state = entry.state
  state.phase = 'disposed'
  state.generation += 1
  const active = state.active
  if (active !== undefined) active.controller.abort(reason)
  delete state.active
  const job = entry.job
  entry.job = undefined
  if (job === undefined) return Promise.resolve()
  try {
    job.abort(reason)
  } catch { /* an abort must never throw into a teardown path */ }
  return job.done.then(() => undefined, () => undefined)
}

/** Abort reason for an owner takeover: the old generation's commit is dropped. */
export const TAKEOVER_REASON = 'memory extraction session taken over by a new agent instance'

/** Abort reason for Agent/plugin disposal. */
export const DISPOSE_REASON = 'memory extraction disposed'

/** The pinned inputs of one generation (design: set before any await). */
export interface Frame {
  readonly generation: number
  readonly from: number
  readonly through: number
  readonly controller: AbortController
}

/**
 * Race one settle promise against a fixed grace window; never rejects.
 * @param settle - the promise that resolves when the foreign job settled.
 * @param graceMs - the fixed bound (the design's 10-second grace).
 * @returns a promise that resolves on whichever happens first.
 */
export function boundedWait(settle: Promise<void>, graceMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const grace = new Promise<void>((resolveGrace) => { timer = setTimeout(resolveGrace, graceMs) })
  const clear = (): void => { if (timer !== undefined) clearTimeout(timer) }
  return Promise.race([settle, grace]).then(clear, clear)
}
