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

/** The per-execution reservation tracker owned by the plugin (`plugin.ts`). */
export interface ReservationTracker {
  /** Outstanding reservations keyed by the tool execution token. */
  readonly reservations: Map<string, { reservation: SlotReservation, target: string }>
  /** Idempotent release + map cleanup for one token. */
  readonly release: (token: unknown) => void
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
    const key = call.token !== undefined ? String(call.token) : undefined
    const held = key !== undefined ? tracker.reservations.get(key) : undefined
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
    tracker.reservations.set(String(call.token), { reservation: admission.reservation, target: held.target })
    return next()
  })
}
