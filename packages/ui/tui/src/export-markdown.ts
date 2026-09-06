/**
 * Render the transcript rows as a Markdown document for `/export-md`. Pure
 * formatting: no fs access, no driver imports, so it unit-tests without a
 * harness. Row mapping: user → blockquote, assistant → verbatim text,
 * thinking → collapsed `<details>`, tool → fenced `tool <name>` block (with
 * the result summary, or a `…running` marker) plus a fenced `diff` block when
 * structured diffs are present, status → italics (errors get a ⚠ marker), banner
 * → skipped (pre-styled UI chrome must not leak raw SGR/block glyphs).
 * @module @dsh-cc/tui/export-markdown
 */

import type { FileDiff } from './tool-card.ts'
import type { TranscriptRow } from './store.ts'

/** Placeholder for a tool call still running (or one that never returned a result). */
const RUNNING_MARK = '…running'

type ToolRow = Extract<TranscriptRow, { kind: 'tool' }>

/** Prefix every line so multi-line text stays inside one blockquote. */
function blockquote(text: string): string {
  return text.split('\n').map(line => `> ${line}`).join('\n')
}

/** Wrap text in a collapsed-by-default details block. */
function details(text: string): string {
  return ['<details>', '<summary>thinking</summary>', '', text, '', '</details>'].join('\n')
}

function fence(tag: string, body: string): string {
  return ['```' + tag, body, '```'].join('\n')
}

/** Split into lines, dropping the phantom empty element of a trailing newline. */
function lines(text: string): string[] {
  const parts = text.split('\n')
  return parts.at(-1) === '' ? parts.slice(0, -1) : parts
}

/**
 * One self-contained ```diff fence per FileDiff list: `---`/`+++` headers are
 * assembled here (oldText `null` renders as a new file against /dev/null),
 * with the full old text as `-` lines followed by the new text as `+` lines.
 */
function diffBlock(diffs: readonly FileDiff[]): string {
  const out: string[] = []
  for (const diff of diffs) {
    out.push(diff.oldText === null ? '--- /dev/null' : `--- a/${diff.path}`)
    out.push(`+++ b/${diff.path}`)
    if (diff.oldText !== null) {
      for (const line of lines(diff.oldText)) out.push(`-${line}`)
    }
    for (const line of lines(diff.newText)) out.push(`+${line}`)
  }
  return fence('diff', out.join('\n'))
}

/**
 * A tool row renders a fenced `tool <name>` block with the result summary —
 * running or result-less calls show the {@link RUNNING_MARK} marker, an
 * explicit empty result renders an empty fence, errored results get a ⚠
 * prefix. Structured diffs, when present, follow as their own ```diff block
 * (a finished diff-only row skips the otherwise-bogus running marker).
 */
function toolBlocks(row: ToolRow): string[] {
  const blocks: string[] = []
  // Summary fence: running calls (and result-less calls without diffs) show
  // the running marker; an explicit empty result renders an empty fence. A
  // finished diff-only row skips the summary — its diff block IS the payload.
  if (row.running || row.result !== undefined || row.diffs === undefined) {
    let summary = row.running || row.result === undefined ? RUNNING_MARK : row.result
    if (row.error === true) summary = `⚠ ${summary}`
    blocks.push(fence(`tool ${row.name}`, summary))
  }
  if (row.diffs !== undefined) blocks.push(diffBlock(row.diffs))
  return blocks
}

/**
 * A compact boundary exports as an italic one-liner plus a collapsed details
 * block carrying the checkpoint summary (omitted when there is none).
 */
function compactBlock(row: Extract<TranscriptRow, { kind: 'compact' }>): string {
  const head = `${row.trigger === 'auto' ? 'Auto-compacted' : 'Compacted'} ${row.items} messages (~${row.tokens} tokens)`
  if (row.summary.length === 0) return `*${head}*`
  const details = [
    '<details>',
    '<summary>compacted summary</summary>',
    '',
    row.summary,
    '',
    '</details>',
  ].join('\n')
  return `*${head}*\n\n${details}`
}

/**
 * Italicize per line so multi-line status text stays valid Markdown. Error
 * rows get a ⚠ marker — unless the text already carries one (the transcript
 * fold bakes `⚠` into turn-failure texts), in which case it must not double.
 */
function statusBlock(text: string, error?: boolean): string {
  const body = text.split('\n').map(line => `*${line}*`).join('\n')
  return error === true && !text.startsWith('⚠') ? `⚠ ${body}` : body
}

/**
 * Render the whole transcript as one Markdown document: blocks separated by
 * a blank line, terminated by a single trailing newline. An empty transcript
 * produces an empty string.
 */
export function rowsToMarkdown(rows: readonly TranscriptRow[]): string {
  const blocks: string[] = []
  for (const row of rows) {
    if (row.kind === 'banner') continue
    else if (row.kind === 'user') blocks.push(blockquote(row.text))
    else if (row.kind === 'assistant') blocks.push(row.text)
    else if (row.kind === 'thinking') blocks.push(details(row.text))
    else if (row.kind === 'tool') blocks.push(...toolBlocks(row))
    else if (row.kind === 'compact') blocks.push(compactBlock(row))
    else blocks.push(statusBlock(row.text, row.error))
  }
  if (blocks.length === 0) return ''
  return `${blocks.join('\n\n')}\n`
}
