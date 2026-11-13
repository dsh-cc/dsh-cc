/**
 * Detect half (design docs/plans/2026-11-12-compaction-governed-pinning.md
 * §Detect): turn `compaction/*` traffic into restore schedules.
 *
 * One observation-only `{ global: true }` `session/event` listener — appends are
 * forbidden here (`reenter`, harness core/session/src/index.ts
 * `publicationEntry`), so this half only ever mutates per-session memory.
 *
 * Event vocabulary (harness `compaction/compaction/src/types.ts` in the pinned
 * copy): `compaction/summary` carries `{compactionId, shadowedSeqs, …}` and is
 * appended BEFORE the checkpoint commit; `compaction/end` carries only
 * `{compactionId, sourceCommandId?, turn, error?}`. Reading `shadowedSeqs` off
 * the end event is the shape bug this split exists to prevent.
 *
 * The three things this listener does:
 *
 * 1. **Arms** a schedule on `compaction/summary` when the summary carries
 *    `shadowedSeqs` and at least one of them is still in the capture ring
 *    (`restorable = shadowedSeqs ∩ ring`, ascending). The summary is
 *    provisional, so nothing here decides that a restore is owed.
 * 2. **Settles** on `compaction/end`: an end carrying `error` CANCELS the
 *    schedule (the belt — the failed-commit path at `region.ts` appends that
 *    end after the summary was already logged); a clean end marks the schedule
 *    restorable (rule (a)).
 * 3. **Witnesses the checkpoint commit** for rule (b): the replacement
 *    `user/message` the engine appends immediately after the summary carries
 *    `surfaceOp: { op: 'replace', … }` and `sourceEventSeqs` include the
 *    summary's own seq (contractual adjacency — a consumer may pair a
 *    replacement with the metering event directly before it). That citation is
 *    the only durable proof the shadowing actually happened, and rule (b)
 *    requires it (see `./schedule.ts` for why: the F3 double-failure window).
 *
 * TURN SIGNAL (rule (b) ageing, §Detect). The per-session turn clock is fed by
 * `'turn/start'` session events (`{turn}`, harness core/session/src/types.ts;
 * the loop appends one per turn before that turn's first `agent/pre-step`),
 * raised monotonically and additionally by the drain from its `agent/pre-step`
 * payload `turn` (the loop's authoritative position). Why not
 * `compaction/end.turn`? That field is `number | null` and is `null` on the
 * idle paths (manual `/compact`, cost-gate idle), i.e. exactly the compactions
 * where rule (b) matters; and it is absent from `compaction/summary`
 * altogether. `turn/start` is the only signal present for every turn.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { PinningState, PinningStateRegistry } from './index.ts'
import { raiseTurn, type RestoreItem } from './schedule.ts'
import type { CompactionPinningSettings } from './settings.ts'

/** `compaction/summary` payload fields this half reads (all optional here: casts are checked). */
interface SummaryData {
  readonly compactionId?: unknown
  readonly shadowedSeqs?: unknown
}

/** `compaction/end` payload fields this half reads. */
interface EndData {
  readonly compactionId?: unknown
  /** Present exactly on the failed-commit path (the belt). */
  readonly error?: unknown
}

/** Surface metadata on a `user/message` event (the checkpoint replacement). */
interface SurfaceMetadata {
  readonly surfaceOp?: unknown
  readonly sourceEventSeqs?: unknown
}

/** One `session/event` handler's worth of per-session state, or `undefined`. */
function stateOf(states: PinningStateRegistry, session: Session): PinningState | undefined {
  return states.peek(String(session.header.id))
}

/**
 * Arm a schedule from one `compaction/summary` event.
 * @param state - the session's pinning state.
 * @param event - the summary event.
 */
function onSummary(state: PinningState, event: SessionEvent): void {
  const data = event.data as SummaryData
  if (typeof data.compactionId !== 'string') return
  if (!Array.isArray(data.shadowedSeqs)) return
  const restorable: RestoreItem[] = []
  for (const raw of data.shadowedSeqs) {
    const seq = Number(raw)
    if (!Number.isSafeInteger(seq)) continue
    const entry = state.ring.get(seq)
    if (entry === undefined) continue
    // Keep the message by reference: restore re-appends this exact object, and
    // holding it here means a later ring eviction cannot shrink a scheduled
    // restore batch that was already decided.
    restorable.push({ seq: entry.seq, message: entry.message })
  }
  // Empty intersection (§Detect): nothing was pinned inside the shadowed span.
  if (restorable.length === 0) return
  restorable.sort((left, right) => left.seq - right.seq)
  state.schedules.arm(String(data.compactionId), restorable, state.turn)
  // Provisional evidence only — remembered so a following replacement can
  // prove the commit happened (rule (b)); it is not completion evidence.
  state.lastSummary = { compactionId: String(data.compactionId), summarySeq: Number(event.seq) }
}

/**
 * Settle a schedule from one `compaction/end` event: the belt on `error`,
 * rule (a) otherwise.
 * @param state - the session's pinning state.
 * @param event - the end event.
 */
function onEnd(state: PinningState, event: SessionEvent): void {
  const data = event.data as EndData
  if (typeof data.compactionId !== 'string') return
  const compactionId = String(data.compactionId)
  if (state.lastSummary?.compactionId === compactionId) state.lastSummary = undefined
  if (data.error !== undefined) {
    // BELT: a failed commit logged a summary but shadowed nothing, so a
    // restore here would duplicate live governance content.
    state.schedules.cancel(compactionId)
    return
  }
  state.schedules.succeed(compactionId)
}

/**
 * Witness the checkpoint commit from the replacement `user/message` that cites
 * the pending summary (rule (b)'s gate).
 * @param state - the session's pinning state.
 * @param event - a `user/message` event.
 */
function onCheckpoint(state: PinningState, event: SessionEvent): void {
  const witness = state.lastSummary
  if (witness === undefined) return
  // Single-shot adjacency: the engine appends the replacement immediately after
  // the summary, so the first `user/message` that follows consumes the
  // witness either way — a stale witness can never be claimed later.
  state.lastSummary = undefined
  const metadata = event as unknown as SurfaceMetadata
  const surfaceOp = metadata.surfaceOp as { op?: unknown } | undefined
  if (surfaceOp === undefined || surfaceOp === null || surfaceOp.op !== 'replace') return
  const sources = metadata.sourceEventSeqs
  if (!Array.isArray(sources) || !sources.includes(witness.summarySeq)) return
  state.schedules.commit(witness.compactionId)
}

/**
 * Register the detect listener (design §Detect). Observe-only; every fault is
 * contained — nothing may throw across the firehose boundary.
 * @param ctx - the plug context.
 * @param readSettings - live settings reader (hot-read).
 * @param states - the per-session state registry (shared with capture/drain).
 */
export function registerDetect(
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

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    try {
      // `compaction/*` and `turn/start` are declared by other packages'
      // augmentations (not this plugin's), so compare as widened strings — the
      // in-repo precedent (progress-rebuild/src/delivery.ts, hooks-claude-code
      // register-events.ts). `user/message` stays a literal: it is a core map
      // member, so `event.data` narrows to `UserMessage`.
      const type = event.type as string
      if (type === 'turn/start') {
        // The rule-(b) clock. Kept even while the feature is disabled so a
        // later re-enable never resumes on a stale clock.
        const state = stateOf(states, session)
        if (state !== undefined) raiseTurn(state, (event.data as { turn?: unknown }).turn)
        return
      }
      if (type === 'user/message') {
        const state = stateOf(states, session)
        if (state !== undefined) onCheckpoint(state, event)
        return
      }
      if (type !== 'compaction/summary' && type !== 'compaction/end') return
      if (!readSettings().enabled) return
      const state = stateOf(states, session)
      if (state === undefined) return
      if (type === 'compaction/summary') onSummary(state, event)
      else onEnd(state, event)
    } catch (error: unknown) {
      // §Failure semantics: never cross the firehose boundary.
      debug(`detect failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, { global: true })
}
