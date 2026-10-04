/**
 * §3.4 TTL reaper (R4) for ephemeral (one-shot) Task dispatches: one timer per
 * dispatch, armed ONLY at the Task ephemeral branch and keyed by that run's
 * per-run `AbortController` — never by a child id (FIFO `subagent/start`
 * correlation under a shared `parentId` can bind the sibling). On expiry the
 * controller is aborted (the request signal is
 * `AbortSignal.any([exec.signal, ttlController.signal])`, so a parallel
 * sibling run on the same turn signal is untouched), a best-effort
 * `interrupt(childId, { kind: 'ancestor', agent })` runs ONLY when exactly one
 * candidate run was observed unambiguously, then a bounded 10s wait watches
 * the ledger for the paired `subagent/end`; if the end never arrives the row
 * is marked with a reaper stop reason.
 *
 * The one-shot ledger is the KILL LOG, never the candidate set: this module
 * never sweeps ledger rows process-wide (a `memory-recall` labeled row past
 * TTL must be left alone) and never reuses `runRelease` /
 * `drainContinuableChildren` (the mode gate rejects one-shot ids).
 *
 * @module @dsh-cc/subagent-task/ephemeral-reaper
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { OneShotLedgerRow } from './one-shot-ledger.ts'

/** Default ephemeral TTL: 15 minutes (documented product choice, §3.4). */
export const EPHEMERAL_TTL_MS_DEFAULT = 900_000

/**
 * Bounded wait for `subagent/end` after a TTL kill (§3.4), same observe-timeout
 * pattern as `DRAIN_OBSERVE_TIMEOUT_MS` in release-agent.
 */
export const EPHEMERAL_KILL_OBSERVE_TIMEOUT_MS = 10_000

/**
 * Stop reason recorded on the ledger row when a TTL-killed run produced no
 * `subagent/end` within {@link EPHEMERAL_KILL_OBSERVE_TIMEOUT_MS} (the
 * documented zombie residual — upstream cancel-gap, §3.4).
 */
export const EPHEMERAL_TTL_TIMEOUT_STOP_REASON = 'ephemeral-ttl-timeout'

/**
 * The ledger surface the reaper reads/writes: row snapshots for the kill-log
 * correlation plus the timed-out stop-reason mark. The reaper NEVER mutates
 * rows outside `markTimedOut`, and never uses rows as a sweep candidate set.
 */
export interface EphemeralReaperLedger {
  rows(): readonly OneShotLedgerRow[]
  markTimedOut(runId: string, stopReason: string): void
}

/** Duck-typed interrupt surface (same shape the epoch collector uses). */
export interface EphemeralInterruptLike {
  interrupt?(childId: string, authority: { kind: 'ancestor'; agent: Agent }): void
}

export interface EphemeralTtlDeps {
  /** The definition's `ephemeralTtlMs`, or the default when undefined. */
  ttlMs: number
  /** The per-run controller created at dispatch — the kill identity. */
  controller: AbortController
  /** The live parent agent — the interrupt authority handle. */
  agent: Agent
  /** The parent's session id; child rows resolve `parentId` against it. */
  parentSessionId: string
  /** The dispatch label (the Task `description`), matched exactly. */
  label?: string
  /** The ledger (kill log) for runId correlation and stop-reason marking. */
  ledger?: EphemeralReaperLedger | undefined
  /** Duck-typed interrupt seam; absent → abort-only degradation. */
  interrupt?: EphemeralInterruptLike
  /** Failure logger: fire-callback errors are logged, never rethrown. */
  warn?: (message: string) => void
  /** Injectable clock (tests). */
  now?: () => number
}

/**
 * Arm the TTL reaper for ONE ephemeral dispatch.
 * @returns a disposer that clears the timer (call after `settle()` returns).
 */
export function armEphemeralTtl(deps: EphemeralTtlDeps): { dispose(): void } {
  const now = deps.now ?? Date.now
  const armedAt = now()
  let fired = false
  const timer = setTimeout(() => {
    fired = true
    // Fire-callback failures are logged, never rethrown (timer hygiene): an
    // async body turns synchronous throws into rejections, so catch the
    // promise, not the call.
    void onExpiry().catch((error: unknown) => {
      deps.warn?.(`ephemeral TTL reaper fire failed: ${(error as Error).message}`)
    })
  }, deps.ttlMs)
  timer.unref?.()

  const onExpiry = async (): Promise<void> => {
    // 1. Kill identity: abort ONLY this run's controller (never the turn
    //    signal — Task is concurrency-safe; siblings share exec.signal).
    deps.controller.abort()
    // runId correlation via the ledger (the kill log): only rows started by
    // THIS dispatch (armed at `armedAt`), with this parent and label. More or
    // fewer than exactly one → no unambiguous child id → abort-only.
    const row = deps.ledger === undefined ? undefined : singleCandidate(armedAt)
    if (row === undefined) return
    // 2. Best-effort interrupt with the {kind:'ancestor', agent} authority.
    //    An absent/settled target is an accepted no-op; an admission throw
    //    must never break the bounded wait below.
    try {
      deps.interrupt?.interrupt?.(row.id, { kind: 'ancestor', agent: deps.agent })
    } catch (error) {
      deps.warn?.(`ephemeral TTL interrupt failed: ${(error as Error).message}`)
    }
    // 3. Bounded wait for the paired `subagent/end` (the ledger records it).
    const deadline = now() + EPHEMERAL_KILL_OBSERVE_TIMEOUT_MS
    while (rowEnded(deps.ledger, row.runId) === undefined && now() < deadline) {
      await sleep(Math.min(50, Math.max(0, deadline - now())))
    }
    // 4. Zombie residual: mark the row so the kill is observable.
    if (rowEnded(deps.ledger, row.runId) === undefined) {
      deps.ledger?.markTimedOut(row.runId, EPHEMERAL_TTL_TIMEOUT_STOP_REASON)
    }
  }

  /**
   * Unambiguous child-id observation: exactly one ledger row started after
   * this arm, still unsettled, with this parent and label. Never FIFO — two
   * parallel ephemeral dispatches with the same shape yield ZERO candidates
   * and the reaper degrades to abort-only (the plan's binding rule).
   */
  const singleCandidate = (since: number): OneShotLedgerRow | undefined => {
    const rows = deps.ledger?.rows() ?? []
    const candidates = rows.filter(row =>
      row.startedAt >= since
      && row.endedAt === undefined
      && row.parentId === deps.parentSessionId
      && row.label === deps.label)
    return candidates.length === 1 ? candidates[0] : undefined
  }

  const rowEnded = (ledger: EphemeralReaperLedger | undefined, runId: string): number | undefined =>
    ledger?.rows().find(row => row.runId === runId)?.endedAt

  const sleep = (ms: number): Promise<void> =>
    new Promise(resolve => {
      const t = setTimeout(resolve, ms)
      t.unref?.()
    })

  return {
    dispose(): void {
      if (!fired) clearTimeout(timer)
    },
  }
}

/**
 * Foreground failure copy: a TTL kill of a foreground-waited child surfaces
 * through `settle()` (non-`completed` stop reason) with this exact remedy
 * text (§3.4).
 */
export const EPHEMERAL_TTL_KILL_COPY = 'ephemeral child hit its TTL; re-spawn it'
