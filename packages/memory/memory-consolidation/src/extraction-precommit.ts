/**
 * The skip pre-commit check (design
 * docs/plans/2026-11-02-systemone-04-memory-extraction-gate.md §"State machine
 * and commit rules": "Before committing a skip, recompute the current evidence
 * head, window hash, indexHash and scope and require them to equal the captured
 * ones").
 *
 * A skip is the only outcome that removes an extraction opportunity, so it is
 * also the only one that must prove the material it was asked about is still
 * the material in front of us. Every divergence discards the verdict: the
 * watermark does not move, no fallback fork is started, and the newest head is
 * left for the next stop (or the follow-up drain).
 *
 * The MODE snapshot is re-read here too (the amended 2026-11-10 row): an
 * active → off flip observed mid-gate is treated exactly like a scope change —
 * the verdict is discarded, and the legacy branch owns the next stop.
 *
 * @module @dsh-cc/memory-consolidation/extraction-precommit
 */

import type { BoundDecisionRunner, DecisionScope } from '@dsh-cc/systemone'
import type { ExtractionIndexRead } from './extraction-index.ts'
import type { ExtractionMode } from './extraction-settings.ts'
import type { ExtractionWindow, IndexSnapshot } from './extraction-window.ts'

/** The captured review the verdict was produced against. */
export interface SkipCapture {
  /** The window the gate answered for. */
  readonly window: ExtractionWindow
  /** The bound runner the gate used (absent ⇒ no scope re-mint is possible). */
  readonly runner: BoundDecisionRunner | undefined
  /** The scope minted for that window. */
  readonly scope: DecisionScope | undefined
  /** The captured evidence head (the window end, as the coordinator tracks it). */
  readonly through: number
}

/** The pre-commit check result. */
export type PreCommit = 'ok' | 'discard' | 'mode-off'

/** Live reads the check needs; every one of them is re-evaluated here. */
export interface SkipVerifyInput {
  readonly capture: SkipCapture
  /** Whether the generation still owns its entry (identity, generation, disposal). */
  readonly isCurrent: () => boolean
  /** The live mode snapshot. */
  readonly readMode: () => ExtractionMode
  /** The current evidence head of the session. */
  readonly evidenceHead: () => number | undefined
  /** A fresh index read. */
  readonly readIndex: () => Promise<ExtractionIndexRead>
  /** Rebuild the captured window over a fresh index snapshot. */
  readonly rebuild: (index: IndexSnapshot) => ExtractionWindow
  /** Re-mint the authoritative scope for the captured head. */
  readonly mintScope: (runner: BoundDecisionRunner, through: number) => DecisionScope | undefined
}

/**
 * Decide whether a skip verdict may still commit.
 * @param input - the capture and the live reads.
 * @returns `ok` to commit, `discard` to drop the verdict, or `mode-off` to drop
 *   it AND hand the next stop to the legacy branch.
 */
export async function verifySkipCommit(input: SkipVerifyInput): Promise<PreCommit> {
  const { capture } = input
  if (!input.isCurrent()) return 'discard'
  if (input.readMode() === 'off') return 'mode-off'
  // New evidence invalidates the verdict: the window no longer ends where it was
  // captured, so the skip would claim material nobody reviewed.
  if (input.evidenceHead() !== capture.window.throughInclusive) return 'discard'
  const read = await input.readIndex()
  if (input.readMode() === 'off') return 'mode-off'
  if (!input.isCurrent()) return 'discard'
  const rebuilt = input.rebuild(read.snapshot)
  if (
    rebuilt.fromExclusive !== capture.window.fromExclusive
    || rebuilt.throughInclusive !== capture.window.throughInclusive
    || rebuilt.evidenceHash !== capture.window.evidenceHash
    || rebuilt.indexHash !== capture.window.indexHash
  ) {
    return 'discard'
  }
  const { runner, scope } = capture
  if (runner !== undefined && scope !== undefined) {
    const again = input.mintScope(runner, capture.through)
    if (again === undefined) return 'discard'
    if (
      again.projectKey !== scope.projectKey
      || again.sessionId !== scope.sessionId
      || again.agentId !== scope.agentId
    ) {
      return 'discard'
    }
  }
  return 'ok'
}
