/**
 * Per-project session index (sidecar). Session records live in harness
 * persistence and carry only a raw `cwd`; this sidecar pins the sessions a
 * project OWNS without depending on the host for new header fields. One
 * file per project bucket: `$DSH_HOME/tui/projects/<key>/sessions.txt`,
 * one session id per line.
 *
 * Membership in the /resume picker is `id ∈ index ∨ cwd-prefix heuristic`
 * (see session-list): the index is exact for sessions written after it
 * existed, the heuristic covers legacy sessions and worktree cwds. fs
 * access is best-effort throughout — a missing or unwritable file degrades
 * to an empty index and never breaks a session.
 *
 * @module @dsh-cc/tui/project-sessions
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Absolute path of the index file inside a project bucket directory. */
export function projectSessionsFile(bucketDir: string): string {
  return join(bucketDir, 'sessions.txt')
}

/**
 * Read the indexed session ids. Missing or unreadable file → empty set;
 * blank lines are ignored.
 */
export function readProjectSessionIds(bucketDir: string): Set<string> {
  try {
    const content = readFileSync(projectSessionsFile(bucketDir), 'utf8')
    const ids = new Set<string>()
    for (const line of content.split('\n')) {
      const id = line.trim()
      if (id.length > 0) ids.add(id)
    }
    return ids
  } catch {
    return new Set()
  }
}

/**
 * Append a session id to the index unless already present. Best-effort: fs
 * failures are swallowed (the cwd-prefix heuristic still covers the
 * session in the common case).
 */
export function recordProjectSessionId(bucketDir: string, sessionId: string): void {
  const id = sessionId.trim()
  if (id.length === 0) return
  try {
    if (readProjectSessionIds(bucketDir).has(id)) return
    mkdirSync(bucketDir, { recursive: true })
    appendFileSync(projectSessionsFile(bucketDir), `${id}\n`)
  } catch {
    // Best-effort — the index is a picker nicety, never session-critical.
  }
}
