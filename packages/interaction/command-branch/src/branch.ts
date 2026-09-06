/**
 * Pure `/branch` rendering helpers: fork-success and fork-failure formatting.
 * Session forking happens in the command handler via the session store; these
 * functions only shape the result, so they are unit-testable without cordis.
 * @module @dsh-cc/command-branch/branch
 */

/**
 * Render the success report for a forked session.
 * @param childId - the newly forked child session id.
 * @param note - the user-supplied branch note, when any.
 */
export function formatBranchSuccess(childId: string, note: string): string {
  const lines: string[] = []
  if (note.length > 0) lines.push(`Branch "${note}" forked: ${childId}`)
  else lines.push(`Forked new session: ${childId}`)
  lines.push('')
  lines.push('Entry instructions:')
  lines.push(`  dsh --resume ${childId}`)
  return lines.join('\n')
}

/**
 * Render a friendly fork-failure report.
 * @param reason - the underlying error message from the store.
 */
export function formatBranchError(reason: string): string {
  return `Could not fork the current session: ${reason}`
}
