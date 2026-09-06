/**
 * Last-model fold for `/doctor`, copied from `/status` (do not import
 * command-status): the most recent `request/header` provider/model, plus an
 * optional duck-read `reasoningEffort`.
 * @module @dsh-cc/command-doctor/last-model
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** A resolved provider route/model pair from a request header. */
export interface ModelRef {
  readonly provider: string
  readonly model: string
  /** Duck-read effort from the header config, when present. */
  readonly reasoningEffort?: string
}

/**
 * Fold the session log for the most recent model route. `request/header`
 * snapshots record the conversation's call config; the last one wins. This is
 * *not* necessarily "the main model" — a command can run from a child agent.
 * @param events - the session's durable event log, in sequence order.
 * @returns the latest provider/model pair, or undefined when no header was logged.
 */
export function lastModel(events: readonly SessionEvent[]): ModelRef | undefined {
  let result: ModelRef | undefined
  for (const event of events) {
    if (event.type !== 'request/header') continue
    const config = event.data.header.config as { reasoningEffort?: unknown }
    result = {
      provider: event.data.header.config.provider,
      model: event.data.header.config.model,
      ...(typeof config.reasoningEffort === 'string' && config.reasoningEffort.length > 0
        ? { reasoningEffort: config.reasoningEffort }
        : {}),
    }
  }
  return result
}
