/**
 * The governor pipeline seam — plan doc
 * `docs/plans/2026-11-12-per-step-input-budget-governor.md` §"Dependencies &
 * interactions": the `govern()` order is **dedupe → caps → budget trim**, and
 * doc 7 (injection dedupe / per-class caps) plugs its two stages into this same
 * listener ahead of the trim.
 *
 * This module fixes the ORDER and nothing else: the trim stage IS `govern()`,
 * the two earlier stages are typed hook slots that slice 5 leaves empty. No
 * dedupe and no cap logic lives here — the stages exist so that slice cannot be
 * added as a post-trim patch that would arbitrate against already-charged
 * bytes.
 *
 * @module @dsh-cc/input-budget/pipeline
 */

import {
  govern,
  type GovernedMessage,
  type GovernInput,
  type GovernorSettings,
  type GovernResult,
} from './core.ts'

/** The three ordered stages; `trim` is the budget governor itself. */
export type GovernorStage = 'dedupe' | 'caps' | 'trim'

/** The fixed stage order (dedupe → caps → budget trim), as a runtime value. */
export const GOVERNOR_STAGES: readonly GovernorStage[] = Object.freeze([
  'dedupe',
  'caps',
  'trim',
] as const)

/**
 * One pre-trim stage. A hook sees the batch the listener received — the claimed
 * enter batch after every inner `agent/pre-step` listener ran — and returns the
 * batch the following stage (and finally the trim) evaluates.
 */
export interface GovernorStageHook<T extends GovernedMessage = GovernedMessage> {
  /** Which pre-trim stage this hook belongs to. */
  readonly stage: 'dedupe' | 'caps'
  /**
   * Rewrite the fresh batch for this stage.
   * @param messages - the batch produced by the preceding stage.
   * @param settings - the hot-read governor settings of this invocation.
   * @returns the batch the next stage evaluates.
   */
  run(messages: readonly T[], settings: GovernorSettings): readonly T[]
}

/**
 * Run one gate invocation through the pipeline: every registered hook in stage
 * order over the fresh batch, then the budget trim over the result.
 *
 * Hook failures propagate to the caller: the listener contains them by
 * returning the unmodified decision and recording `{ error: true }`, so a
 * broken stage can never half-apply a batch.
 *
 * @param input - the gate invocation: batch, settings, backlog and `gateSeq`.
 * @param hooks - pre-trim stages; empty until doc 7 lands.
 * @returns the same shape {@link govern} returns.
 */
export function runGovernorPipeline<T extends GovernedMessage>(
  input: GovernInput<T>,
  hooks: readonly GovernorStageHook<T>[] = [],
): GovernResult<T> {
  let messages: readonly T[] = input.messages
  for (const stage of GOVERNOR_STAGES) {
    if (stage === 'trim') continue
    for (const hook of hooks) {
      if (hook.stage !== stage) continue
      messages = hook.run(messages, input.settings)
    }
  }
  return govern({ ...input, messages })
}
