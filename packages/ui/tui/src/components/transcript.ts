/**
 * Transcript view: a Container that mirrors the TuiState rows. Assistant rows
 * render through the vendored Markdown component; other row kinds use Text.
 * Per-row identity caching avoids re-parsing unchanged historical markdown on
 * every streaming chunk, and a source-line budget clips the oldest rows when
 * the transcript grows very long.
 * @module @dsh-cc/tui/components/transcript
 */

import {
  Container,
  Markdown,
  Text,
  type Component,
} from '@dsh-cc/pi-tui'
import type { TranscriptRow } from '../store.ts'
import { toolVerb } from '../tool-verbs.ts'
import { renderDiffLines } from './diff-card.ts'
import { createMarkdownTheme } from './markdown-theme.ts'
import { groupReadRows, readGroupCacheKey, renderReadGroup } from './read-group.ts'
import { defaultTheme, type Theme } from './theme.ts'

/** Drop oldest rows once the total source-line count exceeds this. */
export const TRANSCRIPT_LINE_BUDGET = 2000

/** Cheap source-line count for a row (NOT rendered lines). */
export function rowSourceLines(
  row: TranscriptRow,
  theme: Theme,
  options?: RowRenderOptions,
): number {
  if (row.kind === 'tool') {
    return 1 + toolOutputLines(row, theme)
  }
  if (row.kind === 'compact') {
    const expanded = options?.compactExpanded ?? false
    if (!expanded || row.summary.length === 0) return 1
    return 1 + row.summary.split('\n').length
  }
  return row.text.split('\n').length
}

/**
 * Line count of a tool row's collapsible output: rendered diff hunks when a
 * diff card is present, otherwise the summary body/result (args as the last
 * fallback, matching the expanded renderer). 0 when there is nothing to hide.
 */
function toolOutputLines(row: Extract<TranscriptRow, { kind: 'tool' }>, theme: Theme): number {
  if (row.diffs !== undefined && row.diffs.length > 0) {
    // Diff hunks replace the summary body; count their rendered lines.
    return renderDiffLines(row.diffs, undefined, theme).length
  }
  const body = row.body ?? row.result ?? row.args
  if (body === undefined || body.length === 0) return 0
  return body.split('\n').length
}

/** Options that affect how a row renders (independent of row identity). */
export interface RowRenderOptions {
  /** Expand thinking rows; default false (collapsed to a one-line hint). */
  thinkingExpanded?: boolean
  /**
   * Expand tool rows' output (body/result/diffs); default true. When false a
   * collapsed tool row renders only its head plus a dim summary line.
   */
  toolOutputExpanded?: boolean
  /** Expand compact rows' summary body; default false (one-line boundary). */
  compactExpanded?: boolean
}

/** Collapse-mode line for a compact boundary row. */
function compactRowText(
  row: Extract<TranscriptRow, { kind: 'compact' }>,
  options: RowRenderOptions | undefined,
  theme: Theme,
): string {
  const expanded = options?.compactExpanded ?? false
  const head = `${row.trigger === 'auto' ? 'Auto-compacted' : 'Compacted'} ${row.items} messages (~${row.tokens} tokens)`
  if (!expanded) {
    return theme.muted(theme.italic(`── ${head} — Ctrl+O to show summary ──`))
  }
  return row.summary.length > 0
    ? theme.muted(`── ${head} ──\n${row.summary}`)
    : theme.muted(`── ${head} ──`)
}

export function renderRowText(row: TranscriptRow, options?: RowRenderOptions, theme: Theme = defaultTheme): string {
  switch (row.kind) {
    case 'user':
      return theme.accent(`> ${row.text}`)
    case 'assistant':
      return row.text
    case 'thinking': {
      const expanded = options?.thinkingExpanded ?? false
      if (!expanded) {
        const lines = row.text.split('\n').length
        return theme.muted(theme.italic(`▸ thinking (${lines} lines — Ctrl+O to toggle)`))
      }
      return theme.muted(theme.italic(`▾ ${row.text}`))
    }
    case 'tool': {
      // Running rows lead with a muted present-tense verb (Running/Reading/…);
      // completed rows drop the verb and show only a result glyph.
      const status = row.running ? '…' : (row.error === true ? '✗' : '✓')
      const verbPrefix = row.running ? `${theme.muted(toolVerb(row.name))} ` : ''
      const head = theme.warning(`⏺ ${verbPrefix}${row.title} ${status}`)
      const headLine = row.error === true ? theme.error(head) : head

      // Collapsed: drop the output entirely (diff hunks, body, or result) and
      // point at the toggle. Rows with no output keep the bare head line.
      if (!(options?.toolOutputExpanded ?? true)) {
        const lines = toolOutputLines(row, theme)
        return lines > 0
          ? `${headLine}\n${theme.muted(`▸ output (${lines} lines — Ctrl+O to toggle)`)}`
          : headLine
      }

      // When structured diffs are present, render real hunks beneath the head.
      // The one-line summary body is replaced to avoid duplicating the path info.
      if (row.diffs !== undefined && row.diffs.length > 0) {
        const diffLines = renderDiffLines(row.diffs, undefined, theme)
        return diffLines.length > 0 ? `${headLine}\n${diffLines.join('\n')}` : headLine
      }

      const body = row.body ?? row.result ?? row.args
      if (body !== undefined && body.length > 0) {
        const firstLine = body.split('\n')[0] ?? ''
        return `${headLine}\n  ⎿ ${row.error === true ? theme.error(firstLine) : firstLine}`
      }
      return headLine
    }
    case 'compact':
      return compactRowText(row, options, theme)
    case 'banner':
      // Pre-styled UI chrome (boot whale): rendered verbatim, never re-styled.
      return row.text
    case 'status':
      // Error status rows (turn/end failures) render in the error role; plain
      // status notices stay muted.
      return row.error === true ? theme.error(row.text) : theme.muted(row.text)
  }
}

/**
 * Banner art Text: suppresses the boot whale below 44 columns — pi-tui's
 * word-wrap shreds multi-line block art at narrow widths (internal spaces
 * become wrap opportunities and continuation lines lose leading whitespace),
 * so instead of a mangled smear the art collapses to a blank line.
 */
class BannerText extends Text {
  override render(width: number): string[] {
    if (width < 44) return ['']
    return super.render(width)
  }
}

/** Build the pi-tui component for a single row. */
function buildChild(row: TranscriptRow, options: RowRenderOptions, theme: Theme): Component {
  if (row.kind === 'assistant') {
    return new Markdown(row.text, 0, 0, createMarkdownTheme(theme))
  }
  if (row.kind === 'banner') {
    return new BannerText(renderRowText(row, options, theme), 0, 0)
  }
  return new Text(renderRowText(row, options, theme), 0, 0)
}

/**
 * Cache key space for child reuse. Plain rows key by their object reference
 * (the store only replaces changed row objects); read-group items key by
 * their member callId list, since the collapsed summary is independent of
 * result payloads and member rows are replaced on every result arrival.
 */
type ChildCacheKey = TranscriptRow | string

/**
 * Container that renders transcript rows as stacked Text/Markdown components.
 * Call `setRows` whenever the driver emits a new state. Styling comes from the
 * injected `theme` (default: the built-in palette).
 */
export class TranscriptView extends Container {
  private readonly theme: Theme
  private prevCache = new Map<ChildCacheKey, Component>()
  private prevThinkingExpanded = false
  private prevToolOutputExpanded = true
  private prevCompactExpanded = false

  constructor(theme: Theme = defaultTheme) {
    super()
    this.theme = theme
  }

  setRows(rows: readonly TranscriptRow[], options?: RowRenderOptions): void {
    const thinkingExpanded = options?.thinkingExpanded ?? false
    const toolOutputExpanded = options?.toolOutputExpanded ?? true
    const compactExpanded = options?.compactExpanded ?? false
    const thinkingFlagChanged = thinkingExpanded !== this.prevThinkingExpanded
    const toolFlagChanged = toolOutputExpanded !== this.prevToolOutputExpanded
    const compactFlagChanged = compactExpanded !== this.prevCompactExpanded

    // Apply the line budget: drop oldest rows until under budget (always keep
    // at least one row so a single huge paste is not emptied entirely). The
    // budget counts RAW rows; read grouping happens strictly after clipping
    // and only affects rendering.
    const clipped = Array.from(rows)
    let dropped = 0
    let total = clipped.reduce((sum, r) => sum + rowSourceLines(r, this.theme, { compactExpanded }), 0)
    while (total > TRANSCRIPT_LINE_BUDGET && clipped.length > 1) {
      total -= rowSourceLines(clipped[0]!, this.theme, { compactExpanded })
      clipped.shift()
      dropped++
    }

    // Build children with identity caching. The store's immutable updates
    // only replace changed row objects, so reference-keyed reuse keeps the
    // existing component (and its render cache) for unchanged rows. Thinking
    // and tool rows are the exception: their rendering depends on the
    // thinkingExpanded / toolOutputExpanded flags, so a flag change forces a
    // rebuild even when the row reference is unchanged (the collapse toggles
    // do not touch the rows array). Read-group children are flag-independent
    // (their cache key is the member callId list), so they reuse across flips.
    const cache = new Map<ChildCacheKey, Component>()
    const rowChildren: Component[] = []
    for (const item of groupReadRows(clipped)) {
      if (item.kind === 'readGroup') {
        const key = readGroupCacheKey(item.rows)
        const child = this.prevCache.get(key) ?? new Text(renderReadGroup(item.rows), 0, 0)
        cache.set(key, child)
        rowChildren.push(child)
        continue
      }
      const row = item.row
      const stale =
        (thinkingFlagChanged && row.kind === 'thinking') ||
        (toolFlagChanged && row.kind === 'tool') ||
        (compactFlagChanged && row.kind === 'compact')
      const child = (stale ? undefined : this.prevCache.get(row))
        ?? buildChild(row, { thinkingExpanded, toolOutputExpanded, compactExpanded }, this.theme)
      cache.set(row, child)
      rowChildren.push(child)
    }

    // Prepend a muted clip indicator when rows were dropped.
    this.children = dropped > 0
      ? [new Text(this.theme.muted(`… earlier output hidden (${dropped} rows)`), 0, 0), ...rowChildren]
      : rowChildren

    this.prevCache = cache
    this.prevThinkingExpanded = thinkingExpanded
    this.prevToolOutputExpanded = toolOutputExpanded
    this.prevCompactExpanded = compactExpanded
  }
}
