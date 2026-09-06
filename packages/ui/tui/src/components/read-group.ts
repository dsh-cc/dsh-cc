/**
 * View-layer grouping of consecutive completed file-read tool rows. The store
 * keeps a strict 1:1 mapping between rows and durable events, so collapsing
 * N reads into one summary line can only happen here — after the transcript's
 * line-budget clipping and purely for rendering. Nothing in this module feeds
 * back into state.
 * @module @dsh-cc/tui/components/read-group
 */

import type { TranscriptRow } from '../store.ts'

/**
 * One slot in the grouped render sequence: either an untouched row (rendered
 * by the normal per-row path) or a group of completed read rows collapsed
 * into a single summary line.
 */
export type RenderItem =
  | { kind: 'row'; row: TranscriptRow }
  | { kind: 'readGroup'; rows: readonly TranscriptRow[] }

/** Tool names that collapse together (case-insensitive). */
const READ_TOOL_NAMES: ReadonlySet<string> = new Set(['read', 'read_image'])

/**
 * A read row is groupable only when it has finished cleanly: a running call
 * still streams its own trail line, and an errored call must stay visible.
 */
function isGroupableRead(row: TranscriptRow): boolean {
  return row.kind === 'tool'
    && READ_TOOL_NAMES.has(row.name.toLowerCase())
    && !row.running
    && row.error !== true
}

/**
 * Collapse runs of ≥2 consecutive groupable read rows into `readGroup`
 * items. Any other row (running/errored read, non-read tool, user text,
 * status, …) closes the current segment. Single reads pass through as plain
 * rows so a lone call keeps its familiar per-row rendering.
 */
export function groupReadRows(rows: readonly TranscriptRow[]): readonly RenderItem[] {
  const items: RenderItem[] = []
  let segment: TranscriptRow[] = []

  const flush = (): void => {
    if (segment.length === 1) {
      items.push({ kind: 'row', row: segment[0]! })
    } else if (segment.length > 1) {
      items.push({ kind: 'readGroup', rows: segment })
    }
    segment = []
  }

  for (const row of rows) {
    if (isGroupableRead(row)) {
      segment.push(row)
    } else {
      flush()
      items.push({ kind: 'row', row })
    }
  }
  flush()

  return items
}

/**
 * Stable cache key for a group: its member callId list. Deliberately free of
 * row references — the store replaces row objects in place as results arrive,
 * and the collapsed summary never depends on results.
 */
export function readGroupCacheKey(rows: readonly TranscriptRow[]): string {
  return rows.map(row => row.kind === 'tool' ? row.callId : '').join('\n')
}

/** Most paths shown before the remainder collapses into "+M more". */
export const READ_GROUP_MAX_PATHS = 4

/** Character cap for the rendered path list before it is truncated. */
export const READ_GROUP_LIST_MAX_CHARS = 160

/**
 * Extract the display path for one read row: the `file_path`/`path` field of
 * the call's args JSON first, then the presenter title, then the bare tool
 * name as a last resort (so the slot is never empty — an unstyled fallback
 * beats rendering nothing between commas).
 */
export function readDisplayPath(row: TranscriptRow): string {
  if (row.kind !== 'tool') return ''
  try {
    const parsed: unknown = JSON.parse(row.args)
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>
      for (const key of ['file_path', 'path']) {
        const value = record[key]
        if (typeof value === 'string' && value.length > 0) return value
      }
    }
  } catch {
    // Unparseable args fall through to the title fallback.
  }
  if (row.title.length > 0) return row.title
  return row.name
}

/**
 * Render a read group as one line:
 * `⏺ Read N files · a.ts, b.ts +M more`
 */
export function renderReadGroup(rows: readonly TranscriptRow[]): string {
  const paths = rows.map(readDisplayPath)
  const shown = paths.slice(0, READ_GROUP_MAX_PATHS)
  const moreCount = paths.length - shown.length
  const more = moreCount > 0 ? ` +${moreCount} more` : ''

  let list = shown.join(', ')
  if (list.length > READ_GROUP_LIST_MAX_CHARS) {
    list = `${list.slice(0, READ_GROUP_LIST_MAX_CHARS)}…`
  }

  return `⏺ Read ${rows.length} files · ${list}${more}`
}
