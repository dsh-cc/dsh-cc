/**
 * Pure session-list helpers for the /resume picker: last-activity sort,
 * scope/query filtering, and row formatting. No imports — shared by the
 * driver, the overlay renderer, and the specs.
 * @module @dsh-cc/tui/harness/session-list
 */

/** One persisted session as the picker sees it (persistence header + extras). */
export type SessionListEntry = {
  id: string
  cwd?: string
  createdAt: number
  /** Durable-log mtime from the backend when observable; falls back to createdAt. */
  updatedAtMs?: number
  /** Async-decorated session title; absent until the title read lands. */
  title?: string
  /** Parent session id when this entry is a fork/child; omitted for top-level sessions. */
  parentSession?: string
}

/** Picker visibility scope: this project's cwd, or every project. */
export type SessionScope = 'cwd' | 'all'

/**
 * Order sessions by last activity: `(updatedAtMs ?? createdAt)` descending,
 * ties broken by createdAt then id (so the order is stable across reloads).
 * Returns a new list; the input is untouched.
 */
export function sortByActivity(entries: readonly SessionListEntry[]): SessionListEntry[] {
  return entries.slice().sort((a, b) => {
    const activeA = a.updatedAtMs ?? a.createdAt
    const activeB = b.updatedAtMs ?? b.createdAt
    if (activeA !== activeB) return activeB - activeA
    if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt
    return a.id.localeCompare(b.id)
  })
}

/**
 * Filter sessions for the picker: child/fork sessions (those with
 * `parentSession`) are hidden unless they are the live session; cwd scope
 * keeps only entries the `isMember` predicate accepts (the driver builds it
 * from the session's *project* — sidecar index ∪ cwd-prefix heuristic — so
 * worktree and subdirectory sessions of the same repo stay visible; a
 * missing predicate disables the scope); then a non-empty query keeps
 * entries whose title, id, or cwd contains it case-insensitively. Never
 * re-sorts — the caller controls order.
 */
export function filterSessions(
  entries: readonly SessionListEntry[],
  opts: {
    scope: SessionScope
    query: string
    currentId?: string
    /** Project-membership predicate for cwd scope; absence disables the scope. */
    isMember?: (entry: SessionListEntry) => boolean
  },
): SessionListEntry[] {
  let result = entries.slice()
  result = result.filter(entry =>
    entry.parentSession === undefined || entry.id === opts.currentId,
  )
  if (opts.scope === 'cwd' && opts.isMember !== undefined) {
    result = result.filter(opts.isMember)
  }
  const query = opts.query.trim().toLowerCase()
  if (query.length > 0) {
    result = result.filter(entry =>
      (entry.title ?? '').toLowerCase().includes(query)
      || entry.id.toLowerCase().includes(query)
      || (entry.cwd ?? '').toLowerCase().includes(query),
    )
  }
  return result
}

/** Short relative-time label for a session timestamp: "2m ago", "1h ago", "3d ago", or `M/D`. */
export function relativeDate(ts: number, now: number = Date.now()): string {
  const seconds = Math.floor((now - ts) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** First 8 chars of a session id — enough to distinguish in a short list. */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

/** Last path segment of a directory, accepting both `/` and `\` separators. */
function basename(path: string): string {
  const segments = path.split(/[\\/]/)
  return segments[segments.length - 1] ?? path
}

/**
 * Compute one picker row: relative time from last activity, the title (or
 * short id when untitled), the 8-char short id, the cwd basename when the
 * row should surface it (all-projects scope), and whether the entry is the
 * session the user is currently in.
 */
export function formatSessionRow(
  entry: SessionListEntry,
  opts: { now: number; currentId: string; showCwd: boolean },
): { time: string; label: string; shortId: string; cwdPart?: string; current: boolean } {
  const time = relativeDate(entry.updatedAtMs ?? entry.createdAt, opts.now)
  const short = shortId(entry.id)
  const label = entry.title !== undefined && entry.title.length > 0 ? entry.title : short
  return {
    time,
    label,
    shortId: short,
    ...opts.showCwd && entry.cwd !== undefined ? { cwdPart: basename(entry.cwd) } : {},
    current: entry.id === opts.currentId,
  }
}
