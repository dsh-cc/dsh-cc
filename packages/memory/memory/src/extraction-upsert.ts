/**
 * Host-side pointer upserts for the extraction write-back (design
 * docs/plans/2026-11-12-extraction-index-coverage-fix.md §A.3).
 *
 * An extraction fork no longer carries index authority: its `MEMORY.md` write is
 * dropped and the host derives one pointer line per batch topic from that
 * topic's own frontmatter. Two rules make the invariant total — an extraction
 * write-back may only alter a line whose first pointer target is a path in its
 * own batch:
 *
 * - **Ownership** is the line's FIRST pointer target (`firstPointerTarget`,
 *   the same rule `pointerAdditions` uses); a description link to the batch
 *   path never makes a foreign line ours.
 * - **Single-target replacement**: a line is only replaced when it carries NO
 *   other target. A grouped line (`- [batch](batch.md), [foreign](foreign.md)`)
 *   is preserved byte-identical and the refresh is skipped — replacing it (or
 *   appending a second line) would either lose the foreign pointer or duplicate
 *   the batch one.
 *
 * Every degraded outcome (cap skip, multi-target skip, clamped description) is
 * reported as a warning string; nothing here throws, so a batch always commits
 * its topic files.
 * @module @dsh-cc/memory/extraction-upsert
 */

import { Buffer } from 'node:buffer'
import { firstPointerTarget } from './index-commit.ts'
import { MAX_DESCRIPTION_CHARS } from './save.ts'
import { MAX_ENTRYPOINT_BYTES, MAX_ENTRYPOINT_LINES } from './truncate.ts'

/** Every pointer target on one line, titled links included (`](<name>.md …)`). */
const ALL_POINTER_TARGETS = /\]\(([^()\s]+\.md)[^)]*\)/g

/** Run-of-whitespace, newlines included (a pointer must stay one line). */
const WHITESPACE_RUN = /\s+/g

/** Markdown link syntax characters, stripped from display-only text. */
const LINK_SYNTAX = /[[\]()]/g

/**
 * Reduce arbitrary frontmatter text to a single safe line of display text:
 * newlines/tabs collapse to spaces, markdown link syntax (`[` `]` `(` `)`) is
 * stripped so the text can never manufacture or hide a pointer target, and
 * surrounding whitespace goes.
 * @param text - raw frontmatter name or description.
 * @returns the sanitized display text (possibly empty).
 */
export function sanitizePointerText(text: string): string {
  return text.replace(WHITESPACE_RUN, ' ').replace(LINK_SYNTAX, '').trim()
}

/** One rendered pointer line plus the warnings its rendering produced. */
export interface RenderedPointer {
  /** The one-line pointer: `- [display](batchPath) — description`. */
  readonly line: string
  /** Degradation warnings (description truncation); empty on a clean render. */
  readonly warnings: readonly string[]
}

/**
 * Render the pointer line for one batch topic.
 *
 * The link target is the BATCH path (never the frontmatter name — the file that
 * was written is what the index must point at), while the display text and the
 * description come from the topic's frontmatter, sanitized and clamped so the
 * line stays one line under `MAX_DESCRIPTION_CHARS`.
 * @param batchPath - the topic filename the write-back is committing.
 * @param frontmatter - the topic's parsed name/description.
 * @returns the line and any truncation warning.
 */
export function renderExtractionPointer(
  batchPath: string,
  frontmatter: { readonly name: string; readonly description: string },
): RenderedPointer {
  const warnings: string[] = []
  // An empty display text after sanitization would render `- [](path)`; fall
  // back to the filename so the line stays a readable pointer.
  const display = sanitizePointerText(frontmatter.name) || batchPath
  let description = sanitizePointerText(frontmatter.description)
  if (description.length > MAX_DESCRIPTION_CHARS) {
    description = `${description.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`
    warnings.push(
      `memory-consolidation: extraction write-back: the description for "${batchPath}" was truncated to `
      + `${MAX_DESCRIPTION_CHARS} characters for the index`,
    )
  }
  return { line: `- [${display}](${batchPath}) — ${description}`, warnings }
}

/** What an upsert did: the line landed, was refreshed in place, or was skipped. */
export type ExtractionUpsertAction = 'appended' | 'replaced' | 'skipped'

/** The outcome of one pointer upsert. */
export interface ExtractionUpsert {
  /** The index content afterwards (byte-identical to the input when skipped). */
  readonly content: string
  /** The action taken. */
  readonly action: ExtractionUpsertAction
  /** Why the upsert degraded; `undefined` on a clean append/replacement. */
  readonly warning: string | undefined
}

/** The entrypoint caps' view of one candidate index: trimmed lines and bytes. */
interface IndexSize {
  readonly lines: number
  readonly bytes: number
}

/** Measure an index the way `validateMemoryWrites` gates it (trimmed). */
function measure(content: string): IndexSize {
  const trimmed = content.trim()
  return { lines: trimmed.split('\n').length, bytes: Buffer.byteLength(trimmed, 'utf8') }
}

/** True when the measured index fits both entrypoint caps. */
function withinCaps(size: IndexSize): boolean {
  return size.lines <= MAX_ENTRYPOINT_LINES && size.bytes <= MAX_ENTRYPOINT_BYTES
}

/**
 * True when `after` shrinks `before` without regressing it: neither dimension
 * grows and at least one strictly shrinks. The only repair direction this path
 * may take on an index that is already over the caps.
 */
function shrinks(before: IndexSize, after: IndexSize): boolean {
  return after.lines <= before.lines
    && after.bytes <= before.bytes
    && (after.lines < before.lines || after.bytes < before.bytes)
}

/** All pointer targets on one line, in order, deduplicated by target. */
function pointerTargets(line: string): string[] {
  return [...new Set([...line.matchAll(ALL_POINTER_TARGETS)].map(match => match[1]!))]
}

/** Append one pointer line, newline-terminated, to a (possibly empty) body. */
function appendLine(body: string, line: string): string {
  // Byte-preserving append (grok r4 P2): never rewrite the trailing bytes of a
  // non-owned last line — only add the separator the one-line-per-entry shape
  // requires when the body does not already end on a line boundary.
  if (body === '') return `${line}\n`
  return body.endsWith('\n') ? `${body}${line}\n` : `${body}\n${line}\n`
}

/**
 * Upsert one rendered pointer into the durable index content.
 *
 * Ownership and ordering rules (design §A.3):
 * - the OWNED line is the first whose first pointer target is `batchPath`;
 * - it is replaced only when it carries no other pointer target; a multi-target
 *   line is preserved byte-identical and the refresh skipped (with a warning,
 *   and without appending a duplicate line for the same target);
 * - otherwise the line is appended;
 * - a candidate that would exceed the entrypoint caps is skipped (the old line
 *   stays for a replacement, nothing lands for an append), except a
 *   replacement that shrinks an already-over-cap index, which is allowed.
 * @param index - the durable index content at this commit attempt.
 * @param batchPath - the batch topic filename the line points at.
 * @param line - the rendered pointer line (see {@link renderExtractionPointer}).
 * @returns the resulting content, the action, and any skip warning.
 */
export function upsertExtractionPointer(index: string, batchPath: string, line: string): ExtractionUpsert {
  const lines = index.split('\n')
  const at = lines.findIndex(candidate => firstPointerTarget(candidate) === batchPath)

  if (at >= 0) {
    if (pointerTargets(lines[at]!).length > 1) {
      return {
        content: index,
        action: 'skipped',
        warning: `memory-consolidation: extraction write-back: the ${batchPath} index line also points at another `
          + 'topic; the pointer refresh was skipped and the line kept byte-identical',
      }
    }
    const next = [...lines]
    next[at] = line
    const content = next.join('\n')
    if (content === index) return { content, action: 'replaced', warning: undefined }
    const before = measure(index)
    const after = measure(content)
    if (!withinCaps(after) && !shrinks(before, after)) {
      return {
        content: index,
        action: 'skipped',
        warning: `memory-consolidation: extraction write-back: the index is at its cap; kept the existing pointer for `
          + `"${batchPath}" (the topic file was written)`,
      }
    }
    return { content, action: 'replaced', warning: undefined }
  }

  const content = appendLine(index, line)
  if (!withinCaps(measure(content))) {
    return {
      content: index,
      action: 'skipped',
      warning: `memory-consolidation: extraction write-back: the index is at its cap; skipped the pointer for `
        + `"${batchPath}" (the topic file was written)`,
    }
  }
  return { content, action: 'appended', warning: undefined }
}
