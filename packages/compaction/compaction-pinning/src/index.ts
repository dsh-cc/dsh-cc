/**
 * Compaction governed-message pinning (design
 * docs/plans/2026-11-12-compaction-governed-pinning.md).
 *
 * Behavioral-governance messages (turn-rules reminders, post-edit-verify
 * recovery hints) travel as ordinary `user/message` events. Summarization
 * compaction replaces a whole `[startSeq, endSeq]` region with one checkpoint,
 * so those instructions survive only as whatever the summary kept. This plugin
 * captures them VERBATIM in a bounded per-session ring before they can be
 * shadowed, schedules their restoration when a compaction reports them among
 * its `shadowedSeqs`, and drains that schedule back into the session after the
 * checkpoint commits.
 *
 * Three seams, one settings read:
 *
 * - capture — a `{ global: true }` `session/event` observer (`./ring.ts`,
 *   {@link registerCapture});
 * - detect — a second `{ global: true }` `session/event` observer that arms /
 *   settles schedules from `compaction/summary` and `compaction/end`
 *   (`./detect.ts`, {@link registerDetect});
 * - restore — an `agent/pre-step` listener registered `{ prepend: true }` and
 *   delegate-first (`./restore.ts`, {@link registerRestore}).
 *
 * Nothing is appended from inside the firehose — mutation there throws
 * `reenter` (harness core/session/src/index.ts `publicationEntry`) — so the two
 * observers are purely observational and every append happens in the drain.
 *
 * Capture read shape (design §Current behavior, the r1 BLOCKER fix):
 * `'user/message'` events carry the `UserMessage` object ITSELF as `data`
 * (harness core/session/src/types.ts), so the listener reads
 * `event.data.source` / `event.data.content` — never `event.data.message.*`.
 *
 * Plain plugin (not a Service, non-isolate): `apply(ctx)` registers the settings
 * namespace for /config UX and mounts the three seams. Every fault is
 * contained — a throw across the firehose or waterfall boundary is never
 * allowed (§Failure semantics).
 *
 * @module @dsh-cc/compaction-pinning
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { registerDetect } from './detect.ts'
import { bumpPinningHealth } from './health.ts'
import { registerRestore } from './restore.ts'
import { createPinRing, type PinRing } from './ring.ts'
import { createScheduleStore, type ScheduleStore } from './schedule.ts'
import {
  DEFAULT_COMPACTION_PINNING_SETTINGS,
  registerSettings,
  type CompactionPinningSettings,
} from './settings.ts'

export {
  SETTINGS_NAMESPACE,
  SettingsSchema,
  DEFAULT_COMPACTION_PINNING_SETTINGS,
  DEFAULT_ENABLED,
  DEFAULT_PINNED_SOURCE_KINDS,
  DEFAULT_MAX_PINNED,
  DEFAULT_MAX_PINNED_BYTES,
  MIN_PINNED,
  MAX_PINNED,
  MIN_PINNED_BYTES,
  MAX_PINNED_BYTES,
  MAX_SOURCE_KIND_CHARS,
  registerSettings,
  readUserSettings,
  type CompactionPinningSettings,
} from './settings.ts'
export {
  createPinRing,
  estimateMessageBytes,
  type PinRing,
  type PinRingEntry,
  type PinRingOptions,
} from './ring.ts'
export {
  createScheduleStore,
  raiseTurn,
  RULE_B_TURNS,
  SCHEDULE_GC_TURNS,
  type RestoreItem,
  type RestoreSchedule,
  type ScheduleStore,
} from './schedule.ts'
export { registerDetect } from './detect.ts'
export { registerRestore } from './restore.ts'
export {
  getPinningHealth,
  bumpPinningHealth,
  resetPinningHealth,
  type PinningHealth,
  type PinningHealthKey,
} from './health.ts'

/** Cordis plugin id. */
export const name = 'compaction-pinning'

/**
 * One session's pinning state. The ring is the capture half's payload; the
 * restore half adds its own per-session bookkeeping on the SAME object —
 * pending restore schedules keyed by `compactionId`, the rule-(b) turn clock,
 * and the provisional summary whose checkpoint commit is still unwitnessed
 * (`./detect.ts`). The state object is the single per-session seam, so no
 * second registry is ever needed.
 */
export interface PinningState {
  /** Bounded FIFO ring of verbatim captured governance messages. */
  readonly ring: PinRing
  /** Pending restore schedules, keyed by `compactionId` (§Detect). */
  readonly schedules: ScheduleStore
  /**
   * Highest turn observed for this session — the rule-(b) clock (§Detect).
   * Fed by `turn/start` events and by the drain's `agent/pre-step` payload
   * turn. A state created mid-turn starts at 0 and is corrected by the next
   * `turn/start`; that only ever shortens the rule-(b) wait for a schedule
   * armed in the same turn the state was born, and rule (b) independently
   * requires a witnessed checkpoint commit, so no phantom restore can follow.
   */
  turn: number
  /**
   * The most recent summary's provisional commit witness: cleared by the next
   * replacement `user/message`, which either proves the commit (rule (b)) or
   * arrives without citing it.
   */
  lastSummary: { readonly compactionId: string; readonly summarySeq: number } | undefined
}

/** The session-id-keyed state registry both halves read. */
export interface PinningStateRegistry {
  /**
   * The state for one session, created on first use with the CURRENT
   * hot-read caps.
   * @param sessionId - `String(session.header.id)`.
   */
  stateOf(sessionId: string): PinningState
  /** The state only if it already exists (no creation). */
  peek(sessionId: string): PinningState | undefined
  /** Drop one session's state (Session disposal, §Capture TTL honesty). */
  delete(sessionId: string): void
  /** Live session ids (diagnostics/tests). */
  ids(): string[]
}

/**
 * Create the state registry. Caps come from the settings reader at ring
 * creation; the capture listener re-applies them per event so a mid-session
 * settings edit shrinks (or grows) the ring immediately.
 * @param readSettings - live settings reader (hot-read per use).
 * @returns the registry.
 */
export function createPinningStateRegistry(
  readSettings: () => CompactionPinningSettings,
): PinningStateRegistry {
  const states = new Map<string, PinningState>()
  return {
    stateOf: (sessionId: string): PinningState => {
      let state = states.get(sessionId)
      if (state === undefined) {
        const settings = readSettings()
        state = {
          ring: createPinRing({ maxPinned: settings.maxPinned, maxPinnedBytes: settings.maxPinnedBytes }),
          schedules: createScheduleStore(),
          turn: 0,
          lastSummary: undefined,
        }
        states.set(sessionId, state)
      }
      return state
    },
    peek: (sessionId: string): PinningState | undefined => states.get(sessionId),
    delete: (sessionId: string): void => {
      states.delete(sessionId)
    },
    ids: (): string[] => [...states.keys()],
  }
}

/** Additive plugin config (test seams only; both default to production wiring). */
export interface PinningPluginConfig {
  /** Test seam: inject a live settings reader instead of the namespace one. */
  readonly readSettings?: () => CompactionPinningSettings
  /** Test seam: inject a pre-built state registry (the restore half mounts over the same one). */
  readonly states?: PinningStateRegistry
}

/**
 * Register the capture listener (design §Capture) and the Session-disposal
 * cleanup. Observe-only: no append, no waterfall, no mutation.
 * @param ctx - the plug context.
 * @param readSettings - live settings reader.
 * @param states - the per-session state registry.
 */
export function registerCapture(
  ctx: Context,
  readSettings: () => CompactionPinningSettings,
  states: PinningStateRegistry,
): void {
  const debug = (message: string): void => {
    try {
      ctx.logger.debug(`compaction-pinning: ${message}`)
    } catch {
      // Never throw into a hot path.
    }
  }

  // The firehose observer ({ global: true } so every session's publications are
  // seen — session events dispatch to the session's captured emit scope).
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    try {
      // Direct literal comparison (not the widened `String(event.type)` idiom
      // used for plugin-declared event types): `user/message` is a core map
      // member, so this narrows `event.data` to `UserMessage`.
      if (event.type !== 'user/message') return
      const settings = readSettings()
      if (!settings.enabled) return
      // Capture read shape: the UserMessage IS `event.data` (design §Current
      // behavior). Reading `event.data.message.*` here was the r1 shape bug.
      const kind = (event.data as { source?: { kind?: unknown } }).source?.kind
      if (typeof kind !== 'string' || !settings.pinnedSourceKinds.includes(kind)) return
      const sessionId = String(session.header.id)
      const state = states.stateOf(sessionId)
      state.ring.setCaps(settings.maxPinned, settings.maxPinnedBytes)
      // Verbatim: the whole message object goes in by reference (§Capture).
      const stored = state.ring.add({
        seq: Number(event.seq),
        message: event.data,
        ts: event.time,
      })
      if (!stored) {
        bumpPinningHealth('dropped')
        debug(`drop: one ${kind} pin exceeds max-pinned-bytes (${settings.maxPinnedBytes})`)
        return
      }
      bumpPinningHealth('captured')
    } catch (error: unknown) {
      // §Failure semantics: drop the entry, debug-log, never cross the boundary.
      bumpPinningHealth('dropped')
      debug(`capture failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, { global: true })

  // §Capture TTL honesty: the ring is process memory, so a disposed session
  // leaves nothing behind.
  ctx.on('session/disposed', (session: Session) => {
    try {
      states.delete(String(session.header.id))
    } catch {
      // Never throw from cleanup.
    }
  }, { global: true })
}

/**
 * Mount the plugin: register the settings namespace (for /config UX and
 * validation) and the three seams — capture, detect, restore — over ONE
 * hot-read settings reader and ONE per-session state registry (so capture,
 * detect, and the drain can never disagree about what is pinned or what is
 * scheduled). The listeners re-read the namespace value per use, so a settings
 * edit applies immediately; the raw user-layer reader (`readUserSettings`) is
 * exported for callers that must exclude project scope.
 * @param ctx - the plug context.
 * @param config - optional test seams (settings reader, state registry).
 */
export function apply(ctx: Context, config: PinningPluginConfig = {}): void {
  const namespaceReader = registerSettings(ctx)
  const readSettings = config.readSettings
    ?? ((): CompactionPinningSettings => {
      try {
        return namespaceReader?.() ?? DEFAULT_COMPACTION_PINNING_SETTINGS
      } catch {
        return DEFAULT_COMPACTION_PINNING_SETTINGS
      }
    })
  const states = config.states ?? createPinningStateRegistry(readSettings)
  registerCapture(ctx, readSettings, states)
  registerDetect(ctx, readSettings, states)
  registerRestore(ctx, readSettings, states)
}
