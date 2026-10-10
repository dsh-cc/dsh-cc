/**
 * Failure-class table loader and the pure `classify` decision core (design
 * doc docs/plans/2026-10-09-verify-before-retry.md §3.2). The table lives in
 * `data/classes.json` (first-match precedence, table order); this module
 * loads it once and evaluates a tool outcome against it. Every value-field
 * read is type-guarded — persistent-bash and pwsh results can be plain
 * strings. Pure and side-effect-free.
 *
 * @module
 */

import { isRecoveryCandidate } from '@dsh-cc/post-edit-verify'
import type { ToolExecutionResult } from '@dsh-cc/tools'
import tableData from '../data/classes.json' with { type: 'json' }
import { firstShellToken, secondShellToken, stripLeadingAssignments } from './shell-words.ts'

/** One row of the failure-class table. */
export interface ClassRow {
  class: string
  /** Exact tool names this class applies to (when set). */
  tools?: readonly string[]
  /** Tool-name prefix this class applies to (when set). */
  toolPrefix?: string
  /** Success-value triggers: `kind` / `timedOut` / `sandboxDenied` predicates. */
  value?: readonly { kind?: string; timedOut?: boolean; sandboxDenied?: boolean }[]
  /** Rendered-text markers matched on either branch. */
  markers?: readonly string[]
  /** Command-head trigger: required first token (or pattern) plus second-token set. */
  head?: { first?: string; firstRe?: string; second: readonly string[] }
  /** Outcome condition beyond tool/shape matching. */
  outcome?: 'error' | 'error-or-nonzero-exit' | 'error-not-excluded'
  /** Class-specific one-line guidance (≤ 200 chars). */
  guidance: string
}

/** The loaded class table (first-match precedence = array order). Cast: the JSON literal is validated by the class-table unit tests. */
export const CLASS_TABLE: readonly ClassRow[] = tableData.classes as unknown as ClassRow[]

const NOT_FOUND_ANCHOR = 'old_string was not found in'

/** Classify outcome: `{ class, guidance }` of the FIRST matching row, else undefined. */
export function classify(tool: string, execArguments: unknown, result: ToolExecutionResult): { class: string; guidance: string } | undefined {
  const text = resultText(result)
  const args = typeof execArguments === 'object' && execArguments !== null ? execArguments as Record<string, unknown> : {}
  for (const row of CLASS_TABLE) {
    if (row.tools !== undefined && !row.tools.includes(tool)) continue
    if (row.toolPrefix !== undefined && !tool.startsWith(row.toolPrefix)) continue
    if (!rowMatches(row, args, result, text)) continue
    return { class: row.class, guidance: row.guidance }
  }
  return undefined
}

function rowMatches(row: ClassRow, args: Record<string, unknown>, result: ToolExecutionResult, text: string): boolean {
  const value = result.isError ? undefined : result.value
  // Success-value triggers (guarded: value may be absent or non-object).
  if (row.value !== undefined && valueMatches(value, row.value)) return true
  // Rendered-text markers, either branch.
  if (row.markers !== undefined && row.markers.some((marker) => text.includes(marker))) return true
  // Command-head trigger + outcome condition.
  if (row.head !== undefined) {
    if (!headMatches(row.head, args)) return false
    return outcomeMatches(row, result)
  }
  if (row.outcome === 'error') return result.isError
  if (row.outcome === 'error-not-excluded') return result.isError && !writeExcluded(args, result, text)
  return false
}

/** Guarded success-value predicate evaluation (`value` is an unknown JSON value). */
function valueMatches(value: unknown, triggers: readonly { kind?: string; timedOut?: boolean; sandboxDenied?: boolean }[]): boolean {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return triggers.some((trigger) => {
    if (trigger.kind !== undefined && record['kind'] !== trigger.kind) return false
    if (trigger.timedOut !== undefined && record['timedOut'] !== trigger.timedOut) return false
    if (trigger.sandboxDenied !== undefined) {
      const sandbox = record['sandbox']
      if (typeof sandbox !== 'object' || sandbox === null) return false
      if ((sandbox as Record<string, unknown>)['denied'] !== true) return false
    }
    return true
  })
}

/** `git`-style head match: first token (exact or pattern) and second token ∈ set. */
function headMatches(head: NonNullable<ClassRow['head']>, args: Record<string, unknown>): boolean {
  const command = args['command']
  if (typeof command !== 'string') return false
  const stripped = stripLeadingAssignments(command)
  const first = firstShellToken(stripped)
  if (head.first !== undefined ? first !== head.first : new RegExp(head.firstRe ?? '').test(first) !== true) return false
  return head.second.includes(secondShellToken(stripped))
}

/** The row's outcome condition: plain error, or error / foreground nonzero-exit. */
function outcomeMatches(row: ClassRow, result: ToolExecutionResult): boolean {
  if (result.isError) return true
  if (row.outcome !== 'error-or-nonzero-exit') return false
  const value = result.value
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  // `null` exitCode (timeout shapes) does NOT match — bash-timeout keeps precedence.
  if (record['kind'] !== 'foreground') return false
  return typeof record['exitCode'] === 'number' && record['exitCode'] !== 0
}

/**
 * write-partial exclusion — the deliberate UNION (broader than
 * isRecoveryCandidate): recovery candidates, both no-write FS error codes,
 * and the single-line not-found anchor all wrote nothing.
 */
function writeExcluded(args: Record<string, unknown>, result: ToolExecutionResult, text: string): boolean {
  return isRecoveryCandidate(args, text)
    || result.error?.info?.code === 'FS_AMBIGUOUS_EDIT'
    || result.error?.info?.code === 'FS_STALE_VERSION'
    || text.includes(NOT_FOUND_ANCHOR)
}

/** Plain text of the model-facing result content (text blocks only). */
function resultText(result: ToolExecutionResult): string {
  return (result.content ?? [])
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}
