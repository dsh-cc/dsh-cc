/**
 * Byte budget for the "Available subagents" catalog (design
 * docs/plans/2026-11-12-selective-system-prompt-sections.md §B).
 *
 * `renderCatalog` stays a pure total function over `(defs, settings)`: every
 * measurement is UTF-8 bytes (`Buffer.byteLength`), every cut is a
 * code-point-safe slice, and no cross-call state exists.
 *
 * Allocation order (allocation is by ENTRY, and "first" is the caller's
 * alphabetical order — stated, not embellished: neither the roster nor the
 * memory index carries a relevance signal today):
 *
 * 1. Fits the budget after reserving the header, the usage trailer and the
 *    ellipsis note? Render unchanged (byte-identical to the pre-budget text).
 * 2. First pass: keep EVERY `agentType` name; slice each `whenToUse` to
 *    `max(min-entry-bytes, floor((max-bytes - reserved) / N))` bytes.
 * 3. Second pass: still over? Keep the first K entries (sliced), collapse the
 *    remaining agents into one names-only line, and add the ellipsis note.
 *    K = the largest count that fits (descending search: fit shrinks
 *    monotonically as K grows).
 * 4. Oversized-names floor: even the names-only render (header + trailer + all
 *    names) exceeds the budget, so names themselves are dropped from the bottom
 *    and the documented overflow note counts them. Names are dropped only in
 *    this form, never silently; when even the header + trailer + note skeleton
 *    exceeds the budget, the floor wins (the permission/usage guidance is never
 *    what gets cut).
 *
 * @module @dsh-cc/subagent-task/catalog-budget
 */

import { Buffer } from 'node:buffer'
import type { AgentDefinition } from '@dsh-cc/claude-code-agents'
import type { CatalogSettings } from './catalog-settings.ts'

/** The catalog section heading; it always renders. */
const CATALOG_HEADER = '## Available subagents'

/** The usage trailer that must survive every truncation form. */
const CATALOG_TRAILER = 'To delegate to one, pass its name as the `subagent_type` argument of the Task tool.'

/**
 * Byte size of `text` in UTF-8.
 * @param text - the text to measure.
 * @returns its UTF-8 byte length.
 */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Slice `text` to at most `maxBytes` UTF-8 bytes on a code-point boundary, so
 * a cut never splits a multi-byte sequence (CJK included).
 * @param text - the text to slice.
 * @param maxBytes - the byte ceiling for the slice.
 * @returns the longest prefix whose UTF-8 size is `<= maxBytes`.
 */
export function sliceToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (utf8Bytes(text) <= maxBytes) return text
  let used = 0
  let out = ''
  for (const char of text) {
    const cost = utf8Bytes(char)
    if (used + cost > maxBytes) break
    used += cost
    out += char
  }
  return out
}

/** The names-only line that carries agents whose usage text was dropped. */
function namesOnlyLine(names: readonly string[]): string[] {
  return names.length === 0 ? [] : [`… names only: ${names.join(', ')}`]
}

/** The ellipsis note for the second pass (names kept, usage text dropped). */
function usageOnlyNote(omitted: number): string {
  return `… (${omitted} agents listed by name only; usage text omitted by cc-subagent-catalog.max-bytes)`
}

/** The documented oversized-names floor note. */
function overflowNote(omitted: number): string {
  return `… (${omitted} more agents omitted by cc-subagent-catalog.max-bytes; the catalog's usage line stays)`
}

/** Compose the section text from its entry lines and any note lines. */
function compose(entryLines: readonly string[], noteLines: readonly string[]): string {
  return [CATALOG_HEADER, '', ...entryLines, ...noteLines, '', CATALOG_TRAILER].join('\n')
}

/**
 * The per-entry `whenToUse` byte slice for the first pass: the larger of
 * `min-entry-bytes` and an even share of the post-reserve budget.
 */
function perEntryBudget(count: number, settings: CatalogSettings): number {
  const reserved = utf8Bytes(compose([], [usageOnlyNote(count)]))
  const allowance = settings.maxBytes - reserved
  return Math.max(settings.minEntryBytes, Math.floor(allowance / count))
}

/**
 * Render the catalog under the configured budget.
 *
 * Preconditions: `defs.length > 0` (the caller returns '' for an empty roster)
 * and `defs` already in the intended (alphabetical) order.
 * @param defs - the roster, in the caller's display order.
 * @param settings - the resolved `cc-subagent-catalog` settings.
 * @returns the rendered catalog text.
 */
export function renderCatalogBudgeted(
  defs: readonly AgentDefinition[],
  settings: CatalogSettings,
): string {
  const full = compose(defs.map(def => `- ${def.agentType} — ${def.whenToUse}`), [])
  if (!settings.truncate) return full
  if (utf8Bytes(full) <= settings.maxBytes) return full

  // First pass: every name survives, every whenToUse takes an even byte slice.
  const perEntry = perEntryBudget(defs.length, settings)
  const sliced = defs.map(def => `- ${def.agentType} — ${sliceToBytes(def.whenToUse, perEntry)}`)
  const firstPass = compose(sliced, [])
  if (utf8Bytes(firstPass) <= settings.maxBytes) return firstPass

  // Second pass: keep the largest prefix of sliced entries that fits; the
  // remaining agents collapse into one names-only line plus the note.
  for (let keep = defs.length - 1; keep >= 0; keep--) {
    const rest = defs.slice(keep)
    const candidate = compose(sliced.slice(0, keep), [
      ...namesOnlyLine(rest.map(def => def.agentType)),
      usageOnlyNote(rest.length),
    ])
    if (utf8Bytes(candidate) <= settings.maxBytes) return candidate
  }

  // Oversized-names floor: the names-only render does not fit either, so names
  // are dropped from the bottom under the documented overflow note.
  for (let keep = defs.length - 1; keep >= 0; keep--) {
    const candidate = compose([], [
      ...namesOnlyLine(defs.slice(0, keep).map(def => def.agentType)),
      overflowNote(defs.length - keep),
    ])
    if (utf8Bytes(candidate) <= settings.maxBytes) return candidate
  }
  // The mandatory skeleton itself exceeds the budget: the floor wins.
  return compose([], [overflowNote(defs.length)])
}
