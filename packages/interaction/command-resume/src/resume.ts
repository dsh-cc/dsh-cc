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

/** The header fields the /resume filter needs (structural; real type is the harness SessionRecord). */
export interface FilterableSessionHeader {
  id: string
  parentSession?: string
}

/**
 * Ephemeral one-shot children are not resumable lanes: a session is filtered
 * from `/resume` only when it BOTH has a `parentSession` AND the shared
 * one-shot ledger (root-realm `ccOneShotLedger` service, published by the
 * cc-subagent-task plugin) marks its id as a `mode: 'one-shot'` child.
 * Mechanism note (design 2026-10-04 §3.5): the harness 0.2.0-rc.2
 * `SubagentStartRequest` carries NO resume-visibility flag, so the
 * descriptor-flag option does not exist and the ledger-membership fallback
 * is the implemented mechanism. Residual: ledger rows prune (5 min after
 * end), so a long-settled ephemeral child can reappear in the listing.
 */
export function isEphemeralOneShotSession(
  header: FilterableSessionHeader,
  oneShotChildIds: ReadonlySet<string>,
): boolean {
  return header.parentSession !== undefined && oneShotChildIds.has(header.id)
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
