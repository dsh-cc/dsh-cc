/**
 * Footer status line for the CC-mode TUI.
 * @module @dsh-cc/tui/statusline
 */

import { homedir } from 'node:os'

export interface StatusLineInput {
  cwd: string
  sessionId: string
  permissionMode: string
  model?: string
  /** Selected reasoning effort for the active model (omitted = provider default). */
  effort?: string
  /** Git branch of the session cwd (best-effort boot probe; omitted when unknown). */
  branch?: string
  /** Context occupancy percent, 0-100 (rounded here when fractional). */
  contextPercent?: number
  /**
   * Raw occupancy backing `contextPercent`, rendered as the exact
   * `ctx NN% (used/window)` detail when the window is known. The numerator is
   * the projected token count — never back-derived from the rounded percent.
   */
  contextTokens?: { readonly used: number; readonly window?: number }
  /** Cumulative token totals for the session. */
  tokens?: { input: number; output: number }
  busy: boolean
}

function shortenCwd(cwd: string): string {
  const home = homedir()
  if (home.length > 0 && (cwd === home || cwd.startsWith(`${home}/`))) {
    return `~${cwd.slice(home.length)}`
  }
  return cwd
}

/**
 * Compact a session id to its `prefix-first8hex` form (e.g.
 * `tui-abcdef01-…` → `tui-abcdef01`). Falls back to the full id when the
 * shape doesn't match. Shared by the footer and `/agents`.
 */
export function shortenSession(sessionId: string): string {
  const match = sessionId.match(/^([a-z]+-[0-9a-f]{8})/i)
  return match?.[1] ?? sessionId
}

/**
 * Compact a token count for the footer: exact below 1k, one decimal below
 * 100k (`12.3k`), integer above (`123k`), and `m` past a million. Negative
 * and non-finite inputs clamp to `0` — the line stays total on bad data.
 */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return '0'
  if (tokens < 1000) return String(Math.round(tokens))
  const scaled = (divisor: number, suffix: string): string => {
    const value = tokens / divisor
    const compact = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10
    return `${compact}${suffix}`
  }
  if (tokens < 1_000_000) return scaled(1000, 'k')
  return scaled(1_000_000, 'm')
}

/** Key-hint tail segments shared by the built-in line and the mode row. */
const MODE_HINTS = ['shift+tab', '/quit'] as const

/**
 * The client-drawn permission-mode row appended under a custom statusline
 * (`<mode> · shift+tab · /quit`); shares the hint constants with the
 * built-in line so the formats cannot drift.
 */
export function formatModeLine(permissionMode: string): string {
  return [permissionMode, ...MODE_HINTS].join(' · ')
}

/**
 * Compact footer: `cwd [branch] · session · mode · model · ctx NN% ·
 * ↑in ↓out tok` plus the busy marker and key hints. Absent optional fields
 * drop their segments; the function is pure and total on undefined inputs.
 *
 * When the context window is known the ctx segment grows an exact
 * `(used/window)` detail. `opts.width` is a terminal-width hint: when the
 * assembled line would overflow it, only that parenthetical detail is dropped
 * and the bare `ctx NN%` survives (other segments are never elided).
 */
export function formatStatusLine(input: StatusLineInput, opts?: { width?: number }): string {
  const left = input.branch === undefined || input.branch.length === 0
    ? shortenCwd(input.cwd)
    : `${shortenCwd(input.cwd)} [${input.branch}]`
  const build = (withDetail: boolean): string => {
    const parts = [
      left,
      shortenSession(input.sessionId),
      input.permissionMode,
    ]
    if (input.model !== undefined && input.model.length > 0) parts.push(input.model)
    if (input.effort !== undefined && input.effort.length > 0) parts.push(`effort: ${input.effort}`)
    if (input.contextPercent !== undefined) {
      const percent = Math.max(0, Math.min(100, Math.round(input.contextPercent)))
      const tokens = input.contextTokens
      const detail = withDetail && tokens !== undefined && tokens.window !== undefined && tokens.window > 0
        ? ` (${formatTokens(tokens.used)}/${formatTokens(tokens.window)})`
        : ''
      parts.push(`ctx ${percent}%${detail}`)
    }
    if (input.tokens !== undefined) {
      parts.push(`↑${formatTokens(input.tokens.input)} ↓${formatTokens(input.tokens.output)} tok`)
    }
    if (input.busy) parts.push('working')
    parts.push(...MODE_HINTS)
    return parts.join(' · ')
  }
  const line = build(true)
  const width = opts?.width
  if (width !== undefined && width > 0 && line.length > width) return build(false)
  return line
}
