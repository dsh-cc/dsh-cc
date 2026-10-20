import { describe, expect, it } from 'vitest'
import { computeStageProgress } from '../src/review-progress.ts'
import { buildReverseIndex } from '../src/dependencies.ts'
import { makeSnapshot } from './review-helpers.ts'
import type { ReviewRecord } from '../src/types.ts'

function record(stage: 'claims' | 'audit', status: ReviewRecord['status'], endedAt: string, runId = 'run_same'): ReviewRecord {
  return {
    stage, status, endedAt, runId, startedAt: '2026-10-20T00:00:00.000Z',
    targetRefs: [], dependencyDigest: '', contractHash: '', policyHash: '',
    reviewerConfigHash: '', promptHash: '', inputHash: '', inputTokens: 0, outputTokens: 0,
  }
}
function progress(records: ReviewRecord[]) {
  const snapshot = makeSnapshot()
  return computeStageProgress({
    snapshot, index: buildReverseIndex(snapshot), core: new Set(), targets: [],
    records, claimsBatchSize: 1,
  }).stageProgress
}

describe('last task status chronology', () => {
  it.each(['claims', 'audit'] as const)('%s uses completion time regardless of record order', (stage) => {
    const earlier = record(stage, 'completed', '2026-10-20T00:00:01.000Z')
    const later = record(stage, 'error', '2026-10-20T00:00:02.000Z')
    expect(progress([earlier, later])[stage].lastRunStatus).toBe('error')
    expect(progress([later, earlier])[stage].lastRunStatus).toBe('error')
    // A run that started earlier can still finish later.
    later.runId = 'run_earlier'
    earlier.startedAt = '2026-10-20T00:00:00.500Z'
    expect(progress([later, earlier])[stage].lastRunStatus).toBe('error')
  })

  it.each(['claims', 'audit'] as const)('%s resolves equal timestamps without hiding errors', (stage) => {
    const rows = [record(stage, 'error', '2026-10-20T00:00:01.000Z'), record(stage, 'completed', '2026-10-20T00:00:01.000Z')]
    expect(progress(rows)[stage].lastRunStatus).toBe('error')
    expect(progress([...rows].reverse())[stage].lastRunStatus).toBe('error')
  })

  it('allows a later successful task to replace an older error status', () => {
    const rows = [record('claims', 'error', '2026-10-20T00:00:01.000Z'), record('claims', 'completed', '2026-10-20T00:00:02.000Z')]
    expect(progress(rows).claims.lastRunStatus).toBe('completed')
    expect(progress([...rows].reverse()).claims.lastRunStatus).toBe('completed')
  })
})
