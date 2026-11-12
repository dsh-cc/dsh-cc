/**
 * Byte budget for the combined memory-topic index block (design
 * docs/plans/2026-11-12-selective-system-prompt-sections.md §A).
 *
 * Only the combined index block is capped: it keeps its `## Memory index`
 * header, drops whole entries from the BOTTOM of the alphabetical list (never a
 * partial line), and closes with a note counting the omitted ENTRIES. When even
 * one entry plus the note exceeds the budget, the floor rule wins: the header
 * and the note render with no entries at all, so the retention guidance in the
 * rest of the section is never what gets cut.
 *
 * Every measurement is UTF-8 bytes (`Buffer.byteLength`), matching the existing
 * entrypoint truncation layer — never `text.length`.
 *
 * @module @dsh-cc/memory/index-budget
 */

import { Buffer } from 'node:buffer'
import type { MemorySectionSettings } from './section-settings.ts'

/** The index block's section heading; it always renders. */
export const MEMORY_INDEX_HEADING = '## Memory index'

/**
 * Byte size of `text` in UTF-8.
 * @param text - the text to measure.
 * @returns its UTF-8 byte length.
 */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * The note that closes a truncated index: it counts omitted ENTRIES (not
 * lines) and names the retrieval path that still works for them.
 * @param omitted - how many topic entries were dropped.
 * @returns the note line.
 */
export function memoryIndexNote(omitted: number): string {
  return `… (${omitted} more memory topics; grep the memory directory for older entries)`
}

/**
 * Cap the combined index block to the configured UTF-8 byte budget.
 *
 * Evaluation order: uncapped when `truncate` is false or the block already
 * fits; otherwise the largest retained prefix of whole entries (bottom-up
 * omission, alphabetical order preserved); otherwise the floor form (header +
 * note, no entries).
 * @param entries - the rendered index entry lines, already alphabetically
 *   ordered by filename.
 * @param settings - the resolved `cc-memory-section` settings.
 * @returns the block's lines, including its heading.
 */
export function capMemoryIndex(
  entries: readonly string[],
  settings: MemorySectionSettings,
): string[] {
  const block = [MEMORY_INDEX_HEADING, '', ...entries]
  if (!settings.truncate) return block
  if (blockBytes(block) <= settings.maxBytes) return block
  // Largest retained prefix that still fits WITH the note; entries are dropped
  // from the bottom so the retained prefix keeps today's alphabetical order.
  for (let keep = entries.length - 1; keep >= 1; keep--) {
    const candidate = [
      MEMORY_INDEX_HEADING,
      '',
      ...entries.slice(0, keep),
      memoryIndexNote(entries.length - keep),
    ]
    if (blockBytes(candidate) <= settings.maxBytes) return candidate
  }
  // Floor rule: even one entry plus the note exceeds the budget, so the block
  // keeps its heading and retrieval note and loses only the enumeration.
  return [MEMORY_INDEX_HEADING, '', memoryIndexNote(entries.length)]
}

/** UTF-8 bytes of a block rendered as consecutive lines. */
function blockBytes(lines: readonly string[]): number {
  return utf8Bytes(lines.join('\n'))
}
