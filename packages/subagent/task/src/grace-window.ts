/**
 * R8 grace-window auto-release with the R9 two-tier delta
 * (`docs/plans/2026-10-04-ephemeral-read-only-subagents.md` §3.8/§3.9): a
 * settled continuable Task child keeps its durable catalog row forever unless
 * a bounded grace window expires — then the row is TOMBSTONED (process-local
 * marker, no drain, no parent authority). A later `subagent/start` for the
 * child cancels any pending timer and clears the tombstone.
 *
 * Membership is the dispatch-site arm-registry: the Task entry points record
 * `{childId, parentId, tier, overrideMs?}` BEFORE the creation await, so
 * coordinator/epoch-collector children (never recorded) are structurally
 * excluded. Tier is stamped inside the entry point that actually runs;
 * `overrideMs` carries the definition `autoReleaseMs` override ONLY (identity
 * check, never truthiness — `0` disables arming and the copy says so).
 *
 * Fire re-checks the registry first: a child live again (running or
 * idle-resident) skips the tombstone and re-arms. Timer hygiene: every timer
 * is `.unref()`'d; fire-callback failures are logged, never rethrown
 * (fail-open toward retention).
 *
 * @module @dsh-cc/subagent-task/grace-window
 */

import { subscribeLifecycle, type WatchBus } from './subagent-watchers.ts'

/** Foreground-delivered results arm a 30-minute continuation window (R9). */
export const FOREGROUND_AUTO_RELEASE_MS = 1_800_000

/** Background-delivered results keep the §3.8 2-hour window (R9). */
export const BACKGROUND_AUTO_RELEASE_MS = 7_200_000

/** The delivery tier, stamped inside the dispatch entry point (R9). */
export type DispatchTier = 'foreground' | 'background'

/** One arm-registry record (R9 shape). */
export interface GraceArmEntry {
  readonly childId: string
  readonly parentId: string
  tier: DispatchTier
  /** The definition `autoReleaseMs` override ONLY — never a resolved default. */
  overrideMs?: number | undefined
}

/** The process-local arm registry + pending timers. Module singletons. */
const registry = new Map<string, GraceArmEntry>()
const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; expiresAt: number }>()

/** Record the dispatch-site entry (called BEFORE the creation await). */
export function recordGraceEntry(entry: GraceArmEntry): void {
  registry.set(entry.childId, entry)
}

/** Test-only: clear the registry and every pending timer. */
export function resetGraceWindow(): void {
  for (const { timer } of pending.values()) clearTimeout(timer)
  pending.clear()
  registry.clear()
}

/** Instrumentation for tests: pending-timer count (idempotence pins). */
export function pendingGraceTimers(): number {
  return pending.size
}

/** Instrumentation for tests: whether an id is recorded. */
export function isGraceRecorded(childId: string): boolean {
  return registry.has(childId)
}

/** Instrumentation for tests: the recorded entry (or undefined). */
export function graceEntryOf(childId: string): GraceArmEntry | undefined {
  return registry.get(childId)
}

/**
 * Resume window precedence (§3.9): `pin.autoReleaseMs !== undefined` → that
 * value; else `pin.dispatchTier === 'foreground'` → 30m; else 2h — legacy
 * pins (both fields absent) read tier-indistinguishable → 2h, fail-safe
 * toward retention.
 */
export function graceWindowFromPin(pin: {
  dispatchTier?: 'foreground' | 'background' | undefined
  autoReleaseMs?: number | undefined
}): number {
  if (pin.autoReleaseMs !== undefined) return pin.autoReleaseMs
  return pin.dispatchTier === 'foreground' ? FOREGROUND_AUTO_RELEASE_MS : BACKGROUND_AUTO_RELEASE_MS
}

/**
 * Resume arming (§3.8): record the pin-derived entry and arm it (window runs
 * from resume load time). A `0` override records but never arms.
 */
export function armGraceFromPin(pin: {
  childId: string
  parentSessionId: string
  dispatchTier?: 'foreground' | 'background' | undefined
  autoReleaseMs?: number | undefined
}): void {
  const entry: GraceArmEntry = {
    childId: pin.childId,
    parentId: pin.parentSessionId,
    tier: pin.dispatchTier ?? 'background',
    ...(pin.autoReleaseMs !== undefined ? { overrideMs: pin.autoReleaseMs } : {}),
  }
  recordGraceEntry(entry)
  if (resolveGraceWindowMs(entry) !== 0) armGraceWindow(pin.childId)
}

/**
 * Window resolution (R9): the override with an IDENTITY check — `0` is the
 * disable value and must survive; a resolved default is never stored.
 */
export function resolveGraceWindowMs(entry: GraceArmEntry): number {
  return entry.overrideMs !== undefined
    ? entry.overrideMs
    : entry.tier === 'foreground'
      ? FOREGROUND_AUTO_RELEASE_MS
      : BACKGROUND_AUTO_RELEASE_MS
}

/** Cancel a pending timer, if any. @returns whether one was pending. */
export function cancelPendingGrace(childId: string): boolean {
  const p = pending.get(childId)
  if (p === undefined) return false
  clearTimeout(p.timer)
  pending.delete(childId)
  return true
}

export interface GraceWindowDeps {
  /** The live agents registry (`ctx.agents`) for the fire-time liveness recheck. */
  agents?: { get(id: string): { status?: string } | undefined } | undefined
  /** Tombstone the ready row (release-module `tombstoneReadyRow`). */
  tombstone: (childId: string) => void
  /** Clear the tombstone marker (release-module `clearTombstone`). */
  clearTombstone: (childId: string) => void
  /** Failure logger: fire-callback errors are logged, never rethrown. */
  warn?: (message: string) => void
  /** Injectable clock (tests). */
  now?: () => number
}

let depsRef: GraceWindowDeps | undefined

/**
 * Arm (or re-arm — a second arm REPLACES the pending timer; timers never
 * stack) the grace window for a recorded child. `0` override → never armed.
 * Exported for the resume-arming path (window runs from resume load time).
 */
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

/**
 * R9 promotion re-tier (Ctrl+B), cancel-and-replace: set the tier to
 * `'background'`, cancel any pending timer, and if one WAS pending re-arm
 * immediately from the new window; otherwise the later `subagent/end` arms
 * from the mutated entry. Fire/re-arm always read the CURRENT entry.
 */
export function promoteGraceTier(childId: string): void {
  const entry = registry.get(childId)
  if (entry === undefined) return
  entry.tier = 'background'
  if (cancelPendingGrace(childId)) armGraceWindow(childId)
}

/**
 * `subagent/start` for a recorded id: cancel the pending timer AND clear the
 * tombstone marker. Start-without-pending-timer is a documented no-op.
 */
function onStartGrace(childId: string): void {
  if (!registry.has(childId)) return
  cancelPendingGrace(childId)
  depsRef?.clearTombstone(childId)
}

/**
 * Mount the process-global `subagent/start` + `subagent/end` listeners.
 * Membership is registry-first; `INTERNAL_LABELS` filtering is not needed
 * here because only dispatch-recorded ids ever arm (defense-in-depth only).
 * @param bus - the cordis context (lifecycle-event bus).
 * @param deps - the fire dependencies (agents registry, tombstone ops, logger).
 * @returns an unmount callback.
 */
export function mountGraceWindow(
  bus: WatchBus<Record<string, unknown>, Record<string, unknown>>,
  deps: GraceWindowDeps,
): () => void {
  depsRef = deps
  return subscribeLifecycle(bus, {
    onStart(info: Record<string, unknown>): void {
      onStartGrace(String(info.id))
    },
    onEnd(info: Record<string, unknown>): void {
      armGraceWindow(String(info.id))
    },
  })
}

// ── Arm-time copy (R9): the absolute expiry, one formatter for both tiers ──

/** Humanize a window for copy: whole hours/minutes, else raw ms. */
function humanizeWindow(ms: number): string {
  if (ms % 3_600_000 === 0) {
    const h = ms / 3_600_000
    return `${h} hour${h === 1 ? '' : 's'}`
  }
  if (ms % 60_000 === 0) {
    const m = ms / 60_000
    return `${m} minute${m === 1 ? '' : 's'}`
  }
  return `${ms} ms`
}

/** Render the recorded expiry as `HH:MM` local time. */
function formatExpiry(expiresAt: number): string {
  const d = new Date(expiresAt)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/**
 * The arm-time copy clause for a child (R9): ` (auto-released after <window>
 * of inactivity, expires <HH:MM local>)`, or ` (auto-release disabled)` for a
 * `0` override; `''` when the child was never recorded (non-Task dispatch).
 * The expiry reads the PENDING timer's recorded timestamp when armed, else
 * `now + window` — one formatter serves defaults and overrides alike.
 */
export function graceWindowClause(childId: string, now: number = Date.now()): string {
  const entry = registry.get(childId)
  if (entry === undefined) return ''
  const windowMs = resolveGraceWindowMs(entry)
  if (windowMs === 0) return ' (auto-release disabled)'
  const expiresAt = pending.get(childId)?.expiresAt ?? now + windowMs
  return ` (auto-released after ${humanizeWindow(windowMs)} of inactivity, expires ${formatExpiry(expiresAt)})`
}
