/**
 * Pure `/diff` rendering: cap long diff output to a bounded line count and
 * render the `--stat` summary. No cordis or shell imports.
 * @module @dsh-cc/command-diff/diff
 */

/** Cap raw diff text to at most `maxLines` lines, noting truncation. */
export function capDiff(text: string, maxLines: number): string {
  const raw = text.replace(/\r\n/gu, '\n').replace(/\n+$/u, '')
  const lines = raw.split('\n')
  if (lines.length <= maxLines) return raw
  return `${lines.slice(0, maxLines).join('\n')}\n… (${lines.length - maxLines} more lines)`
}

/** The default maximum number of diff lines rendered for a targeted file diff. */
export const MAX_DIFF_LINES = 400

/**
 * Render a `git diff --stat` summary, or a friendly note when it is empty.
 * @param stat - the trimmed `--stat` output.
 * @returns the summary, or a no-changes note when empty.
 */
export function formatDiffStat(stat: string): string {
  const trimmed = stat.trim()
  return trimmed.length === 0 ? 'No changes.' : trimmed
}
