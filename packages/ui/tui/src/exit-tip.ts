/**
 * Exit resume tip: after the TUI tears down the alternate screen, print the
 * session id and the resume command to normal terminal output so the user
 * knows how to get back. Pure presentation — read-only, no side effects on
 * the resume marker or session index.
 * @module @dsh-cc/tui/exit-tip
 */

import { sgr } from './components/theme.ts'

const muted = sgr('2')

/**
 * Format the two tip lines. Every line is closed with a SGR reset — pi-tui's
 * AnsiCodeTracker carries active SGR across lines, so an unclosed style would
 * leak into subsequent terminal output.
 */
export function formatExitTip(sessionId: string, binName: string): string[] {
  return [
    muted(`Session saved: ${sessionId}`),
    muted(`Resume with:   ${binName} --resume ${sessionId}    (or: ${binName} -c for latest)`),
  ]
}

/**
 * Print the exit tip to stdout. No-ops when there is no session id (early
 * boot failure) or when the kill switch env is set. A write failure (EPIPE
 * after the terminal went away) must never change the exit code.
 */
export function printExitTip(opts: { sessionId?: string }): void {
  if (opts.sessionId === undefined || process.env.DSH_CC_DISABLE_EXIT_TIP === '1') return
  try {
    const binName = process.argv[1]?.split('/').pop() || 'dsh-cc'
    for (const line of formatExitTip(opts.sessionId, binName)) {
      process.stdout.write(line + '\n')
    }
  } catch {
    // best-effort: the tip is informational, never fatal
  }
}
