/**
 * Pure `/status` folding and rendering: the latest routed model, plus the
 * per-line status summary where absent fields are omitted. No cordis imports,
 * so the fold and formatting are unit-testable in isolation.
 * @module @dsh-cc/command-status/status
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** A resolved provider route/model pair from a request header. */
export interface ModelRef {
  readonly provider: string
  readonly model: string
}

/** The status lines available to `/status`; absent optional fields are omitted. */
export interface StatusFields {
  /** Current model route `provider/model`, when a request header has been logged. */
  readonly model?: string
  /** Effective permission preset name, when the permission service is mounted. */
  readonly preset?: string
  /** The owning session id. */
  readonly sessionId: string
  /** The session working directory (from the header, falling back to the process cwd). */
  readonly cwd: string
  /** Optional extra informational lines (e.g. mounted-hooks summary) rendered verbatim. */
  readonly extra?: readonly string[]
}

/**
 * Fold the session log for the most recent model route. `request/header`
 * snapshots record the conversation's call config; the last one wins.
 * @param events - the session's durable event log, in sequence order.
 * @returns the latest provider/model pair, or undefined when no header was logged.
 */
export function lastModel(events: readonly SessionEvent[]): ModelRef | undefined {
  let result: ModelRef | undefined
  for (const event of events) {
    if (event.type !== 'request/header') continue
    result = {
      provider: event.data.header.config.provider,
      model: event.data.header.config.model,
    }
  }
  return result
}

/**
 * Render a status summary as human shell text. Absent optional fields are
 * omitted line-by-line per the command contract.
 * @param fields - the gathered status fields.
 * @returns the multi-line report, never empty (the session id line is always present).
 */
export function formatStatus(fields: StatusFields): string {
  const lines: string[] = []
  if (fields.model !== undefined) lines.push(`Model: ${fields.model}`)
  if (fields.preset !== undefined) lines.push(`Permission preset: ${fields.preset}`)
  lines.push(`Session: ${fields.sessionId}`)
  lines.push(`Directory: ${fields.cwd}`)
  for (const extra of fields.extra ?? []) lines.push(extra)
  return lines.join('\n')
}
