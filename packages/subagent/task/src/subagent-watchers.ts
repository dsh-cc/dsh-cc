/**
 * Shared ref-counted fan-out for `subagent/start` + `subagent/end` watchers.
 *
 * Exists because two consumers (`epoch-collector.ts` and
 * `one-shot-ledger.ts`) each mirrored the other's wiring: a module singleton
 * listener pair, its dispose-on-empty bookkeeping, and a hand-rolled
 * "is it attached" flag. This module owns that once: subscribers register a
 * handler pair against a bus and share one underlying `on` attach while any
 * subscriber remains.
 *
 * NO first-wins at dispatch: every subscriber's handler runs for every
 * event. Event-to-subscriber matching (e.g. runId matching, watch-map
 * lookup) is each subscriber's own job inside its handler — this core never
 * filters.
 *
 * Concurrency guarantees:
 * - dispatch iterates an `Array.from` snapshot of the subscriber set, so a
 *   subscriber that synchronously releases (even itself) during its own
 *   handler cannot corrupt iteration or skip a later subscriber's delivery;
 * - release is guarded by `detached`/`released` flags — a double release is
 *   a no-op, and the underlying `on` pair is disposed exactly once when the
 *   set empties;
 * - the WeakMap entry is DELETED on full detach, so a later subscribe
 *   re-attaches a fresh pair (a stale entry is never reused).
 *
 * @module @dsh-cc/subagent-task/subagent-watchers
 */

/** Duck-typed event bus (cordis `ctx.on`) the lifecycle events arrive on. */
export interface WatchBus<S, E> {
  on(name: 'subagent/start', handler: (p: S) => void): (() => void) | void
  on(name: 'subagent/end', handler: (p: E) => void): (() => void) | void
}

/** The subscriber's handler pair. */
export interface WatchHandlers<S, E> {
  onStart(p: S): void
  onEnd(p: E): void
}

interface BusEntry {
  offStart: () => void
  offEnd: () => void
  detached: boolean
  subscribers: Set<WatchHandlers<unknown, unknown>>
}

const entries = new WeakMap<object, BusEntry>()

/**
 * Subscribe a handler pair to the bus's lifecycle events. The first
 * subscriber on a bus attaches the real listener pair; each returned
 * release function is idempotent, and the pair detaches exactly once when
 * the last subscriber releases. @returns the release function.
 */
export function subscribeLifecycle<S, E>(
  bus: WatchBus<S, E>,
  handlers: WatchHandlers<S, E>,
): () => void {
  let entry = entries.get(bus)
  if (entry === undefined) {
    const subscribers = new Set<WatchHandlers<unknown, unknown>>()
    // Attach BEFORE any dispatch can see this entry (no dispatch here, but
    // the ordering keeps an off in the entry from ever racing an attach).
    const offStart = bus.on('subagent/start', p => {
      for (const h of Array.from(subscribers)) (h as WatchHandlers<S, unknown>).onStart(p)
    })
    const offEnd = bus.on('subagent/end', p => {
      for (const h of Array.from(subscribers)) (h as WatchHandlers<unknown, E>).onEnd(p)
    })
    entry = {
      offStart: () => offStart?.(),
      offEnd: () => offEnd?.(),
      detached: false,
      subscribers,
    }
    entries.set(bus, entry)
  }
  const subscriber = handlers as WatchHandlers<unknown, unknown>
  entry.subscribers.add(subscriber)
  let released = false
  return () => {
    if (released || entry!.detached) return
    released = true
    entry!.subscribers.delete(subscriber)
    if (entry!.subscribers.size === 0) {
      entry!.detached = true
      entries.delete(bus)
      entry!.offStart()
      entry!.offEnd()
    }
  }
}
