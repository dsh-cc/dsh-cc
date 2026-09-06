/**
 * Pure `/resume` rendering helpers: session-line folding and index formatting.
 * The session-query seam lives in the host composition; these functions only
 * shape already loaded records, so they are unit-testable without cordis.
 * @module @dsh-cc/command-resume/resume
 */

/** One recent session as rendered by `/resume`; only real header fields. */
export interface SessionLine {
  /** The session id. */
  id: string
  /** The latest folded title, when the log has one. */
  title?: string
  /** The working directory the session was created in, when recorded. */
  cwd?: string
  /** The session this one was forked from, when any. */
  parent?: string
  /** Epoch ms when the session was created. */
  createdAt: number
  /** Whether the id currently exists in `ctx.sessions`. */
  live: boolean
  /** Whether the active persistence backend currently materializes the id. */
  persisted: boolean
}

/** Format the `createdAt` epoch as a narrow non-ambiguous label. */
export function formatCreatedAt(createdAt: number): string {
  return new Date(createdAt).toISOString()
}

/** Render one session line with the fields that are present. */
export function formatSessionLine(line: SessionLine): string {
  const parts: string[] = [line.id]
  if (line.title !== undefined) parts.push(line.title)
  if (line.cwd !== undefined) parts.push(`cwd: ${line.cwd}`)
  if (line.parent !== undefined) parts.push(`parent: ${line.parent}`)
  parts.push(line.live && line.persisted ? 'available' : line.live ? 'live' : line.persisted ? 'persisted' : 'archived')
  parts.push(`created ${formatCreatedAt(line.createdAt)}`)
  return `- ${parts.join(' — ')}`
}

/**
 * Render the recent-sessions index, newest first as listed. Ends with the
 * host-owned resume pointer.
 * @param lines - the recent session lines, in listing order.
 */
export function formatResumeIndex(lines: readonly SessionLine[]): string {
  const out: string[] = []
  if (lines.length === 0) {
    out.push('No sessions are available to resume.')
  } else {
    out.push('Recent sessions:')
    for (const line of lines) out.push(formatSessionLine(line))
  }
  out.push('To switch, restart with: dsh --resume <sessionId>')
  return out.join('\n')
}
