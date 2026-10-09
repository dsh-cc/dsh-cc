/**
 * The post-compact rebuild brief renderer (design
 * docs/plans/2026-10-09-structured-progress-and-post-compact-rebuild.md
 * §3.3 step 2): pure Markdown derivation from the registered
 * `progress-rebuild` projection state. Hard budget on BOTH axes —
 * ≤ `maxLines` lines AND ≤ {@link BRIEF_MAX_BYTES} bytes, every line
 * truncated at {@link MAX_LINE_CHARS} chars, the todo section elided with
 * TAIL preference (recent todos matter more than the opening ones).
 *
 * @module @dsh-cc/progress-rebuild/brief
 */

import type { ProgressRebuildState } from './state.ts'

/** Per-line hard truncation (§3.3 step 2). */
export const MAX_LINE_CHARS = 240

/** Whole-brief byte ceiling (§5.2: ≤ 6 KiB). */
export const BRIEF_MAX_BYTES = 6 * 1024

/** The stub-marker note sentence (§3.4): fixed text, never derived. */
export const STUB_MARKER_NOTE =
  'Note: earlier tool outputs may appear as deterministic placeholder stubs '
  + '(microcompact collapsed them out of the window); their content is elided, not lost.'

/** The closing anti-fabrication paragraph (§3.3 step 2). */
export const NOT_VERIFIED_NOTE =
  'Not verified: any completion claim not listed above is NOT backed by a '
  + 'receipt — re-verify before claiming.'

/** The fixed header line. */
export const BRIEF_HEADER =
  '## Resume after compaction (auto-generated, derived from session events — trust over prose memory)'

/** The verified-commands section header. */
export const VERIFIED_HEADER =
  'Verified commands (executed, exit 0 — execution evidence, NOT inferred completion claims)'

/** One rendered brief plus the section count for the measurement event. */
export interface RenderedBrief {
  /** The full Markdown brief. */
  text: string
  /** Number of top-level sections rendered (goal / verified / todos / last-user). */
  sections: number
}

/** Rendering options (resolved settings). */
export interface BriefOptions {
  /** Line budget (§3.5 `progress-rebuild.max-lines`). */
  maxLines: number
  /** §3.5 `progress-rebuild.include-verified`: governs the WHOLE verified section. */
  includeVerified: boolean
}

/** ISO-ish short timestamp for brief lines. */
function stamp(ts: number): string {
  return new Date(ts).toISOString()
}

/** Hard-truncate one line at {@link MAX_LINE_CHARS} chars. */
export function truncateLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) : line
}

/** The Goal line: objective + phase, replay-failure, or none-recorded. */
export function renderGoalLine(state: ProgressRebuildState): string {
  if (state.goal.failure !== null) return '- Goal: goal state unavailable (replay failure)'
  const current = state.goal.current
  if (current === null) return '- Goal: none recorded'
  return `- Goal: ${current.goal.objective} (phase: ${current.goal.phase})`
}

/**
 * Render the brief. Never throws: every field read is defensive and the
 * budget pass is total (worst case a truncated header-only brief).
 * @param state - the current projection state.
 * @param options - resolved rendering settings.
 * @returns the bounded brief text and its section count.
 */
export function renderBrief(state: ProgressRebuildState, options: BriefOptions): RenderedBrief {
  const lines: string[] = [BRIEF_HEADER, '']
  let sections = 0

  lines.push(truncateLine(renderGoalLine(state)))
  sections += 1

  if (options.includeVerified && state.verified.length > 0) {
    lines.push(`- ${VERIFIED_HEADER}:`)
    for (const receipt of state.verified) {
      lines.push(truncateLine(`  - ${stamp(receipt.ts)} \`${receipt.commandHead}\``))
    }
    sections += 1
  }

  if (state.todos !== null && state.todos.length > 0) {
    lines.push('- Todo snapshot (verbatim):')
    for (const todo of state.todos) {
      const mark = todo.status === 'completed' ? 'x' : ' '
      lines.push(truncateLine(`  - [${mark}] ${todo.content}`))
    }
    sections += 1
  }

  lines.push(truncateLine(STUB_MARKER_NOTE))

  if (state.lastUser !== null) {
    lines.push(truncateLine(`- Last user instruction at ${stamp(state.lastUser.ts)}: ${state.lastUser.text}`))
    sections += 1
  }

  lines.push(truncateLine(NOT_VERIFIED_NOTE), '')

  const budgeted = applyBudget(lines, options.maxLines)
  return { text: budgeted.join('\n'), sections }
}

/**
 * Line-and-byte budget (§3.3 step 2): drop from the MIDDLE of the todo
 * lines only (tail preference — head lines and the fixed sentences stay),
 * until both the line count and the byte size fit. Non-todo lines are
 * never dropped: if the fixed content alone exceeds the budget the brief
 * is byte-clipped, which can only happen with pathological settings.
 */
export function applyBudget(lines: string[], maxLines: number): string[] {
  const todoRange = todoLineRange(lines)
  let out = lines
  if (out.length > maxLines && todoRange !== undefined) {
    out = elideTodos(out, todoRange, maxLines)
  }
  let text = out.join('\n')
  if (Buffer.byteLength(text, 'utf8') > BRIEF_MAX_BYTES) {
    const room = BRIEF_MAX_BYTES - Buffer.byteLength(BRIEF_HEADER + '\n' + NOT_VERIFIED_NOTE, 'utf8') - 2
    if (todoRange !== undefined) {
      out = elideTodos(out, todoLineRange(out) ?? todoRange, Math.max(4, Math.ceil(room / (MAX_LINE_CHARS + 1))))
      text = out.join('\n')
    }
    if (Buffer.byteLength(text, 'utf8') > BRIEF_MAX_BYTES) {
      text = Buffer.from(text, 'utf8').subarray(0, BRIEF_MAX_BYTES).toString('utf8')
      out = text.split('\n')
    }
  }
  return out
}

/** First..last indexes (inclusive) of the verbatim todo lines (an elision marker counts as part of the block). */
function todoLineRange(lines: readonly string[]): { first: number; last: number } | undefined {
  const isTodoLine = (line: string): boolean => line.startsWith('  - [') || line.startsWith('  - … (')
  const first = lines.findIndex(isTodoLine)
  if (first === -1) return undefined
  let last = first
  while (last + 1 < lines.length && isTodoLine(lines[last + 1]!)) last += 1
  return { first, last }
}

/**
 * Elide todo lines with TAIL preference: keep the head few and the tail
 * many, dropping from the middle. `budget` is the TOTAL line budget for the
 * whole brief, so the todo allowance is what remains after the fixed lines.
 */
function elideTodos(lines: readonly string[], range: { first: number; last: number }, budget: number): string[] {
  const fixedCount = lines.length - (range.last - range.first + 1)
  // Reserve one line for the elision marker itself.
  const allowance = Math.max(0, budget - fixedCount - 1)
  const available = range.last - range.first + 1
  if (allowance >= available) return [...lines]
  const marker = '  - … (todo snapshot elided to fit the line budget; tail kept)'
  if (allowance <= 0) {
    const out = [...lines]
    out.splice(range.first, available, marker)
    return out
  }
  const head = Math.max(1, Math.floor(allowance / 3)) // head:tail 1:2 (rendering-order precedent)
  const tail = Math.max(0, allowance - head)
  const out = [...lines]
  out.splice(
    range.first + head,
    available - head - tail,
    `  - … (${available - head - tail} earlier todos elided)`,
  )
  return out
}
