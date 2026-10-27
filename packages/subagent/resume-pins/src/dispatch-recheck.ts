/**
 * The dispatch-time capacity recheck for `send_message` continuations.
 *
 * A continuation's slot reservation carries a safety TTL (a lost release must
 * never starve a parent). An expired reservation stops counting, but the tool
 * call it belongs to is still pending — after the approval prompt its body
 * would create a resident activation nobody counted. This module wires the
 * `tools/execute` listener that re-runs the atomic admission right before the
 * tool body dispatches: a refusal surfaces as the same `LIVE_CAPACITY_REFUSAL`
 * the spawn lanes throw, a re-admit re-arms a fresh reservation, and a target
 * that became live meanwhile needs no new slot at all (a same-epoch steer).
 *
 * @module
 */
import { SessionId } from '@deepseek-ai/dsh-session'
import { admitContinuation, type CapacityServices } from './live-capacity.ts'
import type { SlotReservation } from './admission.ts'

/** A reserved slot with its target child, tracked per execution token. */
export interface ReservationEntry {
  readonly reservation: SlotReservation
  readonly target: string
}

/**
 * The per-execution reservation tracker owned by the plugin. Keys are the RAW
 * tool execution tokens (branded Symbols compared by identity, never
 * `String()` — every runtime token is `Symbol('dsh.tool.execution')`, so
 * stringifying them would collapse all executions onto one key and let one
 * call overwrite or release another's reservation).
 */
export interface ReservationTracker {
  /** Outstanding reservations. */
  readonly reservations: Map<unknown, ReservationEntry>
  /** Record one admission's reservation under its execution token. */
  readonly set: (token: unknown, entry: ReservationEntry) => void
  /** Idempotent release + map cleanup for one token. */
  readonly release: (token: unknown) => void
}

export function createReservationTracker(): ReservationTracker {
  const reservations = new Map<unknown, ReservationEntry>()
  return {
    reservations,
    set: (token, entry) => { if (token !== undefined) reservations.set(token, entry) },
    release: token => {
      if (token === undefined) return
      const held = reservations.get(token)
      if (held === undefined) return
      reservations.delete(token)
      held.reservation.release()
    },
  }
}

/**
 * Register the `tools/execute` recheck listener on `ctx`.
 * @param getServices - casts the plugin ctx to the capacity services view.
 */
export function wireDispatchRecheck(
  ctx: unknown,
  tracker: ReservationTracker,
  getServices: () => CapacityServices,
): void {
  const context = ctx as {
    on: (name: 'tools/execute', handler: (exec: never, next: () => Promise<unknown>) => unknown) => () => void
    agents?: { get?: (id: unknown) => unknown }
  }
  context.on('tools/execute', async (exec, next) => {
    const call = exec as {
      name?: string
      token?: unknown
      signal?: AbortSignal
      agent?: { id?: unknown }
    }
    if (call.name !== 'send_message') return next()
    const held = call.token !== undefined ? tracker.reservations.get(call.token) : undefined
    if (held === undefined || !held.reservation.expired) return next()
    // The target became live meanwhile: a steer, not a new slot.
    const targetLive = context.agents?.get?.(SessionId(held.target)) !== undefined
    if (targetLive) {
      tracker.release(call.token)
      return next()
    }
    const signal = call.signal ?? new AbortController().signal
    const admission = await admitContinuation(getServices(), call.agent, held.target, signal)
    if (!admission.admitted) {
      tracker.release(call.token)
      throw new Error(admission.reason)
    }
    tracker.set(call.token, { reservation: admission.reservation, target: held.target })
    return next()
  })
}
