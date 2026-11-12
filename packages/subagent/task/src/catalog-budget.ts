/**
 * Pure UTF-8 byte budgeting for the "Available subagents" catalog section
 * (design `docs/plans/2026-11-12-selective-system-prompt-sections.md` §B).
 *
 * Deliberately import-free at runtime (the definition type is a type-only
 * import), so the render is a stateless total function of
 * `(defs, settings)` — the design's property tests are its complete decision
 * procedure for the bound.
 *
 * Every size in this module is a UTF-8 byte count (`Buffer.byteLength`), never
 * `text.length`, and every slice cuts on char boundaries: a multi-byte
 * sequence (CJK glyph, surrogate pair) is never split.
 *
 * @module @dsh-cc/subagent-task/catalog-budget
 */

import type { AgentDefinition } from '@dsh-cc/claude-code-agents'

/** `max-bytes` lower bound (design §B table). */
export const MAX_BYTES_MIN = 1024
/** `max-bytes` upper bound (design §B table). */
export const MAX_BYTES_MAX = 65_536
/** `min-entry-bytes` lower bound (design §B table). */
export const MIN_ENTRY_BYTES_MIN = 20
/** `min-entry-bytes` upper bound (design §B table). */
export const MIN_ENTRY_BYTES_MAX = 400

/**
 * Resolved catalog budget settings, camelCase over the kebab-case raw keys.
 */
export interface SubagentCatalogSettings {
  /** `false` renders the catalog uncapped — the restore-previous-behavior valve. */
  readonly truncate: boolean
  /** Ceiling for the rendered catalog, measured in UTF-8 bytes. */
  readonly maxBytes: number
  /** Floor for one entry's `whenToUse` slice, measured in UTF-8 bytes. */
  readonly minEntryBytes: number
}

/**
 * The design table's defaults. `max-bytes: 8192` is PROVISIONAL until the
 * assemble-row ledger (doc 3) reports the section-byte distribution.
 */
export const DEFAULT_SUBAGENT_CATALOG_SETTINGS: SubagentCatalogSettings = {
  truncate: true,
  maxBytes: 8192,
  minEntryBytes: 40,
}

/** The section's header line. */
const CATALOG_HEADER = '## Available subagents'

/** The section's closing usage line; it always stays, truncated or not. */
const CATALOG_TRAILER = 'To delegate to one, pass its name as the `subagent_type` argument of the Task tool.'

/** UTF-8 byte length — the unit of every budget in this module. */
function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Longest prefix of `text` whose UTF-8 encoding fits in `budget` bytes.
 * Iterates CODE POINTS, so a multi-byte sequence is never split mid-character.
 * @param text - the text to slice.
 * @param budget - the byte ceiling for the result.
 * @returns the byte-bounded prefix ('' when nothing fits).
 */
export function truncateToBytes(text: string, budget: number): string {
  if (budget <= 0) return ''
  if (utf8Bytes(text) <= budget) return text
  let kept = ''
  let used = 0
  for (const char of text) {
    const size = utf8Bytes(char)
    if (used + size > budget) break
    kept += char
    used += size
  }
  return kept
}

/** One full roster line: `- agentType — whenToUse`. */
function entryLine(def: AgentDefinition, whenToUse: string): string {
  return `- ${def.agentType} — ${whenToUse}`
}

/** The pass-2 note counting the agents that appear by name only. */
function namesOnlyNote(count: number): string {
  return `… (${count} more agents listed by name only)`
}

/** The oversized-names floor line, worded as design §B step 4 prescribes. */
function oversizedNote(count: number): string {
  return `… (${count} more agents omitted by cc-subagent-catalog.max-bytes; the catalog's usage line stays)`
}

/** Join the section: header, roster lines, trailer (both blank lines kept). */
function assemble(roster: readonly string[]): string {
  return [CATALOG_HEADER, '', ...roster, '', CATALOG_TRAILER].join('\n')
}

/**
 * Compose the section text from the sorted definitions, within the byte
 * budget. Pure: the same `(defs, settings)` always renders the same bytes,
 * and nothing is cached.
 *
 * Budgeting (design § "B. Subagent catalog budget"):
 *
 * 1. header + trailer + the names-only note are reserved up front;
 * 2. pass 1 keeps every `agentType` name and truncates each `whenToUse` to
 *    `max(min-entry-bytes, floor((max-bytes - reserved) / N))` bytes;
 * 3. pass 2, when pass 1 still overflows, keeps the first K entries (the
 *    alphabetical prefix — stated, not a relevance claim) and collapses the
 *    rest into one names-only line plus the note; K is the largest count
 *    that fits;
 * 4. the oversized-names floor truncates the names line itself with the
 *    documented `… (N more agents omitted by cc-subagent-catalog.max-bytes;
 *    the catalog's usage line stays)` line — whole names only, since a name
 *    cut mid-token is unaddressable. Names drop ONLY here, never silently.
 *
 * `settings.truncate === false` renders the uncapped roster.
 * @param defs - the sorted definitions to list.
 * @param settings - the live budget settings.
 * @returns the rendered catalog, or '' when no definitions are available.
 */
export function renderCatalogBudgeted(
  defs: readonly AgentDefinition[],
  settings: SubagentCatalogSettings = DEFAULT_SUBAGENT_CATALOG_SETTINGS,
): string {
  if (defs.length === 0) return ''
  const full = assemble(defs.map(def => entryLine(def, def.whenToUse)))
  if (!settings.truncate) return full
  const maxBytes = settings.maxBytes
  if (utf8Bytes(full) <= maxBytes) return full

  const count = defs.length
  // The reserved skeleton (header + entries with empty whenToUse + trailer)
  // already pays for every name's line prefix; the note reserve covers the
  // names-only line pass 2 may need.
  const skeleton = utf8Bytes(assemble(defs.map(def => entryLine(def, ''))))
  const reserved = skeleton + utf8Bytes(namesOnlyNote(count))
  const entryBudget = Math.max(settings.minEntryBytes, Math.floor((maxBytes - reserved) / count))
  const truncated = defs.map(def => entryLine(def, truncateToBytes(def.whenToUse, entryBudget)))

  const pass1 = assemble(truncated)
  if (utf8Bytes(pass1) <= maxBytes) return pass1

  // Pass 2: the alphabetical prefix that fits keeps its (truncated) lines;
  // the remainder collapses into one names-only line. Descending K returns
  // the largest prefix that fits.
  for (let keep = count - 1; keep >= 0; keep--) {
    const rest = defs.slice(keep).map(def => def.agentType)
    const namesLine = `- ${rest.join(', ')}`
    const roster = keep === 0
      ? [namesLine]
      : [...truncated.slice(0, keep), namesLine, namesOnlyNote(rest.length)]
    const candidate = assemble(roster)
    if (utf8Bytes(candidate) <= maxBytes) return candidate
  }

  // Oversized-names floor: even the names-only render overflows the cap, so
  // the names line itself gives way. Descending K keeps the longest whole-name
  // prefix that fits beside the documented overflow line.
  const names = defs.map(def => def.agentType)
  for (let keep = names.length - 1; keep >= 1; keep--) {
    const candidate = assemble([`- ${names.slice(0, keep).join(', ')} ${oversizedNote(names.length - keep)}`])
    if (utf8Bytes(candidate) <= maxBytes) return candidate
  }
  return assemble([oversizedNote(names.length)])
}
