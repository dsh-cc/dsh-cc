/**
 * Brief rendering (design §3.3 step 2 template verbatim + §3.4 microcompact
 * stub sentence, with the LINE-CAP head-2/3 + tail-1/3 elision on the todo
 * section). Pure over the shadow state.
 *
 * @module @dsh-cc/progress-rebuild/brief
 */

import type { ShadowState } from './shadow.ts'
import { todoMark } from './shadow.ts'

/** Title line, byte-exact per design §3.3 step 2. */
export const BRIEF_TITLE
  = '## Resume after compaction (auto-generated, derived from session events — trust over prose memory)'

/** Fixed microcompact stub-marker sentence (design §3.4). */
export const MICROCOMPACT_STUB_SENTENCE
  = 'Note: tool results may have been replaced by microcompact placeholder stubs — treat stub-marker texts as placeholders for the original output, not as lost work.'

/** Fixed not-verified warning, byte-exact per design §3.3 step 2. */
export const NOT_VERIFIED_WARNING
  = '- Not verified: any completion claim not listed above is NOT backed by a\n  receipt — re-verify before claiming.'

export interface BriefOptions {
  /** Hard line cap for the whole brief. */
  maxLines: number
  /** Whether the Verified-done section renders. */
  includeVerified: boolean
}

/**
 * Render the resume brief. Sections present only when the shadow has data;
 * an empty shadow degenerates (design §4): stub sentence + last-user line
 * when known + the not-verified warning. Never exceeds `maxLines` — the
 * todo section absorbs the budget with head-2/3 + tail-1/3 elision.
 */
export function renderBrief(shadow: ShadowState, options: { maxLines: number; includeVerified: boolean }): string {
  const lines: string[] = [BRIEF_TITLE, '']
  lines.push(`- Goal: ${shadow.goal ? shadow.goal.objective : 'none recorded'}`)

  const verified = shadow.verified.slice().reverse()
  if (options.includeVerified && verified.length > 0) {
    lines.push('- Verified done (execution receipts):')
    for (const receipt of verified) lines.push(`  - ${receipt.ts} ${receipt.label} [bash ok]`)
  }

  const todoLines = shadow.todos.map((todo) => `  - ${todoMark(todo)} ${todo.content}`)
  if (todoLines.length > 0) {
    lines.push('- Todo snapshot (verbatim):')
    lines.push(...elideLines(todoLines, options.maxLines - lines.length - 2))
  }

  if (shadow.lastUserText !== undefined) {
    lines.push(`- Last user instruction at ${shadow.lastUserTs}: ${shadow.lastUserText}`)
  }

  lines.push(MICROCOMPACT_STUB_SENTENCE)
  lines.push(NOT_VERIFIED_WARNING)
  return lines.slice(0, options.maxLines).join('\n')
}

/**
 * Head-2/3 + tail-1/3 elision (probe-systemone.ts:67,72 precedent) against a
 * per-section line budget; `… (N elided)` marker in the middle.
 */
function elideLines(lines: string[], budget: number): string[] {
  if (lines.length <= Math.max(budget, 0)) return lines
  if (budget <= 1) return budget <= 0 ? [] : ['… (N elided)'.replace('N', String(lines.length))]
  const head = Math.floor((budget * 2) / 3)
  const tail = budget - head
  const elided = lines.length - head - tail
  if (elided <= 0) return lines.slice(0, budget)
  return [
    ...lines.slice(0, head),
    `… (${elided} elided)`,
    ...lines.slice(lines.length - tail),
  ]
}
