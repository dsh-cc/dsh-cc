/**
 * Quarantine scan (plan docs/plans/2026-09-23-advisor-watchdog.md §4.5):
 * each surviving note's text is scanned against
 * `DEFAULT_DANGEROUS_PATTERNS` (packages/interaction/permission-rules) before
 * delivery. CAVEAT: those patterns are tuned for shell-command strings, so
 * matching advisory prose is a heuristic — false positives (a note discussing
 * `sudo`) drop safely, which is the correct failure direction.
 *
 * @module
 */

import { DEFAULT_DANGEROUS_PATTERNS } from '@dsh-cc/permission-rules'

/**
 * The quarantine verdict for one note text: the matched `reason`, or
 * `undefined` when the note passes.
 */
export function quarantineHit(text: string): string | undefined {
  for (const pattern of DEFAULT_DANGEROUS_PATTERNS) {
    if (pattern.regex.test(text)) return pattern.reason
  }
  return undefined
}
