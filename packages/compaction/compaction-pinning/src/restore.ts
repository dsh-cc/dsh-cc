/**
 * Restore half (design docs/plans/2026-11-12-compaction-governed-pinning.md
 * §Restore + §Restore timing): drain eligible schedules back into the session.
 *
 * The drain runs from an `agent/pre-step` listener registered
 * `{ prepend: true }` and implemented **delegate-first** (`await next()` BEFORE
 * any work). That ordering is the whole timing contract: prepend makes this
 * listener the outermost wrapper, so `await next()` runs every inner listener —
 * including the compaction engine's own pressure trigger, which appends
 * summary → checkpoint → end inside the same pre-step — and only then does the
 * drain append. Schedules created by inner listeners therefore restore before
 * the loop derives the request: the harness pressure path has **no** model-
 * visible exposure (design §Restore timing).
 *
 * `await next()` deliberately sits OUTSIDE the containment block: if the
 * downstream chain already threw, the waterfall is failing and re-invoking it
 * would run every inner hook twice (progress-rebuild's documented shape). Only
 * this listener's own post-processing is fail-soft.
 *
 * Appends: `session.append('user/message', message, { surfaceOp: 'append' })`
 * with the verbatim stored object, one append per pin, ascending by ORIGINAL
 * seq (§Restore: each restore is its own append so source boundaries survive;
 * never batched into one message). A restored message re-enters the capture
 * ring under its new seq with the same kind, which is what makes re-shadowing
 * self-healing instead of a loop.
 *
 * The session is reached through the pre-step payload's `agent.session` — the
 * same seam progress-rebuild / mcp-ready-notice use; the payload is typed
 * structurally so this package needs no `@deepseek-ai/dsh-agent` dependency.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { bumpPinningHealth } from './health.ts'
import type { PinningStateRegistry } from './index.ts'
import { raiseTurn, type RestoreItem } from './schedule.ts'
import type { CompactionPinningSettings } from './settings.ts'

/** The `agent/pre-step` payload fields the drain reads (agent + turn). */
interface PreStepPayload {
  readonly agent?: { readonly session?: Session }
  /** The turn the proposed step belongs to (the rule-(b) clock reading). */
  readonly turn?: number
}

/** Debug notice (fail-soft). */
function debug(ctx: Context, message: string): void {
  try {
    ctx.logger.debug(`compaction-pinning: ${message}`)
  } catch {
    // Never throw into a hot path.
  }
}

/**
 * Drain every eligible schedule for one session: collect the items ascending by
 * original seq (deduplicated — one live copy per pin), drop the schedules
 * BEFORE appending so a failing append can never re-drain, then append one
 * message at a time.
 * @param ctx - the plug context (logging).
 * @param readSettings - live settings reader.
 * @param states - the per-session state registry.
 * @param payload - the pre-step payload.
 */
function drain(
  ctx: Context,
  readSettings: () => CompactionPinningSettings,
  states: PinningStateRegistry,
  payload: PreStepPayload,
): void {
  if (!readSettings().enabled) return
  const session = payload.agent?.session
  if (session === undefined) return
  const state = states.peek(String(session.header.id))
  if (state === undefined) return
  const turn = raiseTurn(state, payload.turn)
  // Bounded memory: schedules that aged past the rule-(b) window without ever
  // becoming eligible are dead (model `Dead`), never a growing backlog.
  state.schedules.gcDead(turn)
  const eligible = state.schedules.eligible(turn)
  if (eligible.length === 0) return
  const restored = new Set<number>()
  const queue: RestoreItem[] = []
  for (const schedule of eligible) {
    state.schedules.drop(schedule.compactionId)
    for (const item of schedule.items) {
      if (restored.has(item.seq)) continue
      restored.add(item.seq)
      queue.push(item)
    }
  }
  queue.sort((left, right) => left.seq - right.seq)
  for (const item of queue) {
    try {
      // Verbatim payload, surface intent REQUIRED (`surfaceOp: 'append'` is the
      // only legal form for a plain user/message append —
      // core/session/src/index.ts + surface.ts in the pinned harness copy).
      session.append('user/message', item.message, { surfaceOp: 'append' })
      bumpPinningHealth('restored')
    } catch (error: unknown) {
      // §Failure semantics: drop the entry, count it, keep draining — a
      // disposed session must never throw across the waterfall boundary.
      bumpPinningHealth('dropped')
      debug(ctx, `restore of seq ${item.seq} dropped: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * Register the restore drain (design §Restore). Delegate-first, `{ prepend: true }`.
 * @param ctx - the plug context.
 * @param readSettings - live settings reader (hot-read).
 * @param states - the per-session state registry (shared with capture/detect).
 */
export function registerRestore(
  ctx: Context,
  readSettings: () => CompactionPinningSettings,
  states: PinningStateRegistry,
): void {
  ctx.on('agent/pre-step', async (payload: PreStepPayload, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> => {
    // Delegate FIRST and outside the try: the whole waterfall (compaction
    // engine included) runs here, so schedules it creates are drainable below.
    const decision = await next()
    try {
      // A rejected step derives no request; leave the schedules pending so the
      // next admitted step restores them (nothing is lost, nothing is wasted).
      if (decision.kind === 'enter') drain(ctx, readSettings, states, payload)
    } catch (error: unknown) {
      debug(ctx, `drain failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return decision
  }, { prepend: true })
}
