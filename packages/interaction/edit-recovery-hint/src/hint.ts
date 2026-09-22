/**
 * Pure decision core for the edit recovery hint (design doc
 * docs/plans/2026-09-21-edit-fuzzy-matching-and-read-state.md, Track B):
 * whether a failed edit is a "not-found on a multi-line old_string" event,
 * and the FIXED recovery text to append. No interpolation of user content —
 * the hint is a static string, so model-facing text can never smuggle
 * tool-output bytes into a new instruction slot.
 *
 * @module
 */

import type { PostToolDecision, ToolExecutionResult } from '@dsh-cc/tools'

/**
 * The recovery hint, verbatim and static. Never append tool output, file
 * bytes, or argument fragments here — the message is model-visible context,
 * and static-only keeps it injection-proof.
 */
export const RECOVERY_HINT: string =
  'The edit failed because old_string did not match the file byte-for-byte (usual causes: smart quotes vs ASCII quotes, indentation drift, unicode arrows, CRLF). Do not retry the same payload and do not re-read the whole file yet. Recover cheaply: (1) retry with a single-line anchor — pick one distinctive line from old_string and use only that line as the new old_string; or (2) split the change into one edit per hunk. Only if the anchor also fails: Read just the target region (offset/limit) and rebuild old_string from that output.'

/**
 * Anchor pinned to the harness: the model-facing FS_EDIT_NOT_FOUND text passes
 * through `remediateFsError` verbatim (deepseek-harness
 * packages/fs/fs-local/src/fsio.ts:811). If harness wording drifts, the
 * hint goes inert by design — the unit test matrix pins the exact substring
 * so drift is caught in CI, not in the field.
 */
const NOT_FOUND_ANCHOR = 'old_string was not found in'

/**
 * True iff this failed edit is a cheap-recovery candidate: the call carried a
 * MULTI-LINE `old_string` (single-line not-found is already its own anchor,
 * so there is nothing to advise) and the result text is the not-found failure.
 * The ambiguity error (FS_AMBIGUOUS_EDIT — multiple matches) is a different
 * failure class and is deliberately NOT matched: there the string matched,
 * so anchoring advice would misfire.
 */
export function isRecoveryCandidate(args: unknown, resultText: string): boolean {
  if (typeof args !== 'object' || args === null) return false
  const oldString = (args as Record<string, unknown>)['old_string']
  if (typeof oldString !== 'string' || !oldString.includes('\n')) return false
  return resultText.includes(NOT_FOUND_ANCHOR)
}

/** Plain text of the model-facing result: downstream decision content, else the tool result's own content (text blocks only). */
export function resultTextOf(result: Readonly<ToolExecutionResult>, downstream: PostToolDecision): string {
  const base = downstream.kind === 'accept' && downstream.value === undefined
    ? (downstream.content ?? result.content)
    : result.content
  return (base ?? [])
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}
