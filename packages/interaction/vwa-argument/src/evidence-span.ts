/**
 * §5.1 evidence quote/span validation against the decoded source snapshot.
 * Extracted from graph.ts to keep that module under the 500-line gate.
 *
 * @module @dsh-cc/vwa-argument/evidence-span
 */
import { spanError } from './schema.ts'
import { VwaFail, fail } from './store.ts'

/** Throw a uniform failure out of an apply function (no partial commit). */
function reject(code: Parameters<typeof fail>[0], message: string): never {
  throw new VwaFail(fail(code, message))
}

/** Quote === decodedSnapshot.slice(span) and contextSpan ⊇ span, ≤12000 units (§5.1). */
export function validateEvidenceAgainstSnapshot(
  evidence: Pick<import('./types.ts').Evidence, 'span' | 'quote' | 'contextSpan'>,
  snapshotText: string,
): void {
  const spanProblem = spanError(evidence.span, snapshotText)
  if (spanProblem !== '') reject('SCHEMA_INVALID', `evidence span invalid: ${spanProblem}`)
  if (evidence.quote !== snapshotText.slice(evidence.span.start, evidence.span.end)) {
    reject('SCHEMA_INVALID', 'quote does not match the snapshot slice (UTF-16 code-unit compare)')
  }
  const contextProblem = spanError(evidence.contextSpan, snapshotText)
  if (contextProblem !== '') reject('SCHEMA_INVALID', `contextSpan invalid: ${contextProblem}`)
  if (evidence.contextSpan.start > evidence.span.start || evidence.contextSpan.end < evidence.span.end) {
    reject('SCHEMA_INVALID', 'contextSpan must contain span')
  }
  if (evidence.contextSpan.end - evidence.contextSpan.start > 12000) {
    reject('CONTEXT_TOO_LARGE', 'context exceeds 12000 code units; provide an explicitly smaller range')
  }
}
