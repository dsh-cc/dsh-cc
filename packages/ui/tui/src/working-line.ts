/**
 * Pure helpers for the live working line (claude-code style spinner row).
 * Deliberately a leaf module: the store imports `VERBS`/`TurnAnchor` from
 * here, so nothing here may import back from the store or components.
 * @module @dsh-cc/tui/working-line
 */

import { formatTokens } from './statusline.ts'

/**
 * Whimsical progressive verbs the working line cycles through. Lives in this
 * leaf module (not the component) so `store.ts` can derive
 * `verbIndex = startedAt % VERBS.length` without a store → components
 * reverse dependency.
 */
export const VERBS: readonly string[] = [
  'Thinking',
  'Galloping',
  'Cogitating',
  'Pondering',
  'Brewing',
  'Percolating',
  'Deliberating',
  'Musing',
]

/**
 * Anchor for the currently-running turn: when it started, the session's
 * cumulative output-token total at anchor time (`undefined` when the HUD was
 * not yet seeded — the first tokenUsage change pins it, see the driver's
 * rebase guard), and the deterministic spinner verb index. `stepStartedAt`
 * (optional) is the current step's clock, reset by the driver on each
 * `tool/call`/`tool/result`; when absent the step clock falls back to
 * `startedAt`, so elapsed time shows the whole turn.
 */
export interface TurnAnchor {
  startedAt: number
  outputBase: number | undefined
  verbIndex: number
  stepStartedAt?: number
}

/**
 * Compact elapsed time: `12s` under a minute, `4m 23s` under an hour, `1h 5m`
 * beyond. Negative inputs clamp to `0s` — the line stays calm on clock skew.
 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  if (hours === 0) return `${minutes}m ${totalSeconds % 60}s`
  return `${hours}h ${minutes}m`
}

/**
 * Render the working-line message for a live turn:
 * `Galloping… (4m 23s · ↓ 5.8k tokens)`. Elapsed time counts from the current
 * step (`stepStartedAt`, falling back to `startedAt`) — the driver resets the
 * step clock per tool call/result, so the line shows this step's duration.
 * The token segment is omitted while the baseline is unseeded
 * (`outputBase === undefined`) or the delta has not yet gone positive — no
 * `↓ 0 tokens` flicker at turn start.
 */
export function formatWorkingLine(turn: TurnAnchor, currentOutput: number, now: number): string {
  const elapsed = formatElapsed(now - (turn.stepStartedAt ?? turn.startedAt))
  const delta = turn.outputBase === undefined ? 0 : currentOutput - turn.outputBase
  const tokens = turn.outputBase !== undefined && delta > 0
    ? ` · ↓ ${formatTokens(delta)} tokens`
    : ''
  const verb = VERBS[turn.verbIndex % VERBS.length] ?? VERBS[0]!
  return `${verb}… (${elapsed}${tokens})`
}
