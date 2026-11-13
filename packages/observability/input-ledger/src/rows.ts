/**
 * The single schema source for every input-governance row type: the ledger
 * rows themselves plus the governor, dedupe and cap rows that program docs 1
 * and 7 emit. Those docs reference this file; they do not redefine shapes.
 *
 * Units are UTF-8 bytes everywhere — no chars/bytes mix. The privacy boundary
 * is structural: no row shape carries a free-text field. The only strings that
 * can echo upstream data are section names and source-kind strings, both
 * hard-capped by {@link clampLabel}.
 *
 * @module @dsh-cc/input-ledger/rows
 */

/** Schema version carried by every row (`v: 1`). */
export const LEDGER_SCHEMA_VERSION = 1

/** Hard cap for section names and source-kind strings (privacy boundary). */
export const MAX_LABEL_CHARS = 64

/** The three trim actions the budget governor's algorithm can take (doc 1). */
export type TrimAction = 'defer' | 'drop-expired' | 'drop-oversize'

/** Fields every row type carries. */
export type BaseRow = {
  v: 1
  /** Observation timestamp, epoch milliseconds. */
  ts: number
  sessionId: string
  /** Process boot id (random at apply). */
  gen: string
  /** Attribution from the pre-step payload; undefined for auxiliary calls. */
  turn?: number
  step?: number
}

/** One system-prompt section as assembled (name, byte size, fingerprint). */
export type AssembleSection = { name: string; bytes: number; hash8: string }

/** An `system-prompt/assemble` observation (Observer A). */
export type AssembleRow = BaseRow & {
  type: 'assemble'
  isSubagent: boolean
  sections: AssembleSection[]
  totalBytes: number
  renderedFromCache: boolean
}

/** Per-message-source composition of an outgoing request. */
export type RequestMessageStats = {
  count: number
  bytesTotal: number
  nonTextBlocks: number
  bySourceKind: Record<string, { count: number; bytes: number }>
  toolResults: { count: number; bytes: number }
  assistantBytes: number
}

/** An `llm/stream` observation (Observer B). */
export type RequestRow = BaseRow & {
  type: 'request'
  seqPerGen: number
  provider: string
  model: string
  purpose?: string
  mainLoop: boolean
  systemBytes: number
  systemHash8: string
  toolsCount: number
  toolsBytes: number
  messages: RequestMessageStats
}

/** One trim decision recorded by the budget governor (doc 1). */
export type GovernorTrim = { kind: string; bytes: number; action: TrimAction }

/** A budget-governor decision row (doc 1); observe mode maps onto the same fields. */
export type GovernorRow = BaseRow & {
  type: 'governor'
  mode: 'observe' | 'enforce'
  bytesByClass: Record<string, number>
  trimmed: GovernorTrim[]
  offeredBacklog: number
  hardOver: boolean
  error?: true
}

/** An injection-dedupe decision row (doc 7). */
export type DedupeRow = BaseRow & {
  type: 'dedupe'
  applied: boolean
  kind: string
  hash12: string
  suppressedWithin: number
}

/** A per-class cap row (doc 7). */
export type CapRow = BaseRow & {
  type: 'cap'
  applied: boolean
  kind: string
  runningCount: number
  suppressedTotal: number
}

/** Every row type this package defines and its readers accept. */
export type LedgerRow = AssembleRow | RequestRow | GovernorRow | DedupeRow | CapRow

/** Discriminant of a {@link LedgerRow}. */
export type LedgerRowType = LedgerRow['type']

/**
 * Hard-cap a section name or source-kind string at {@link MAX_LABEL_CHARS}
 * code units. The cap bounds row size; it is not a content transform, so a
 * label that already fits is returned untouched. Byte-level truncation would
 * split a multi-byte sequence and produce invalid UTF-8 in the row.
 *
 * @param label - the section name or source-kind string to bound.
 * @param maxChars - override for the default cap (settings may narrow it).
 * @returns the label, truncated to at most `maxChars` code units.
 */
export function clampLabel(label: string, maxChars: number = MAX_LABEL_CHARS): string {
  return label.length <= maxChars ? label : label.slice(0, maxChars)
}
