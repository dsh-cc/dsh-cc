/**
 * Feature 5 §6.3 retention (docs/plans/2026-10-28-vwa-batch-autonomous-review.md):
 * an as-of re-render reuses the passed evaluationId and does NOT call
 * checkForDelivery — no new FrozenEvaluation is created, and the frozen one is
 * never garbage-collected.
 * @module tests/report-asof-retention
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendAdjudication, VwaArgumentService } from '../src/report.ts'
import { disagreementAdjudication, reviewedFixture, withDisagreement } from './review-helpers.ts'

describe('§6.3 — as-of reuse and retention', () => {
  it('re-renders E in place: same evaluationId, no second freeze, no GC', async () => {
    const f = await reviewedFixture()
    const d = withDisagreement(f, f.records)
    const service = new VwaArgumentService({ root: f.root })
    const frozen = await service.checkForDelivery(f.projectId, f.artifactId)
    const dir = join(f.root, '.dsh', 'vwa', f.projectId, 'evaluations')
    const evaluations = () => readdirSync(dir).filter((file) => file.endsWith('.json'))

    expect(evaluations()).toEqual([`${frozen.evaluationId}.json`])
    const first = await service.renderReportAsOf(f.projectId, f.artifactId, frozen.evaluationId, 'markdown')
    appendAdjudication(f.root, f.projectId, disagreementAdjudication(f, d.records, d.findingId, 'reject', d.passRunId, d.failRunId))
    const second = await service.renderReportAsOf(f.projectId, f.artifactId, frozen.evaluationId, 'markdown')

    // No checkForDelivery on the as-of path: the evaluation set never grows.
    expect(evaluations()).toEqual([`${frozen.evaluationId}.json`])
    expect(second.asOf.evaluationId).toBe(first.asOf.evaluationId)
    expect(second.bindingDigest).toBe(frozen.bindingDigest)
    // The live adjudication is the only difference between the two renders.
    expect(first.text).not.toContain('human adjudication')
    expect(second.text).toContain('human adjudication')
  })
})
