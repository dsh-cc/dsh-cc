/**
 * Feature 5 §6 (docs/plans/2026-10-28-vwa-batch-autonomous-review.md):
 * the two-step as-of report — freeze (write:false) → fix the page → as-of
 * re-render (evaluationId), the skipped layer-B live recheck, the as-of
 * header, the render-time adjudication overlay, the typed error pass-through
 * (STORE_CORRUPT / REFERENCE_INVALID) and atomic publication.
 * @module tests/report-asof
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { evaluateDelivery } from '../src/delivery-check.ts'
import { renderReportMarkdown } from '../src/report-render.ts'
import { appendAdjudication, VwaArgumentService, type FrozenEvaluation } from '../src/report.ts'
import { reportTool } from '../src/report-tool.ts'
import { disagreementContextOf, loadEvaluation, persistEvaluation, reportInput } from '../src/report-asof.ts'
import { ProjectStore } from '../src/store.ts'
import { initWorkspace } from './helpers.ts'
import { disagreementAdjudication, reviewedFixture, withDisagreement } from './review-helpers.ts'
import type { ProjectSnapshot } from '../src/types.ts'
import type { ToolDefinition } from '@dsh-cc/tools'

const ARTIFACT =
  '# Title\n\nThe policy shipped on 2026-10-16 with coverage at 90%.\n\n## Conclusion\n\nThe evidence is insufficient to confirm the causal claim.\n'

function bindArtifact(root: string, snapshot: ProjectSnapshot): { artifactId: string } {
  const text = readFileSync(`${root}/docs/a.md`, 'utf8')
  const artifactId = `art_${randomUUID()}`
  const applied = new ProjectStore(root, snapshot.projectId).withTransaction<void>({
    expectedRevision: snapshot.revision,
    requestId: `bind-${randomUUID()}`,
    payloadHash: randomUUID(),
    applyFn: (mutable) => {
      mutable.claims.push({
        id: `cl_${randomUUID()}`, entityVersion: 1, createdAt: '', updatedAt: '',
        text: 'The policy shipped on 2026-10-16', kind: 'fact',
        scope: { subject: 'policy', corpus: [], time: '', geography: '', exclusions: [] },
        importance: 'core', stance: 'asserted', evaluationCriteria: [],
      })
      mutable.artifacts.push({
        id: artifactId, entityVersion: 1, createdAt: '', updatedAt: '',
        path: 'docs/a.md', contentHash: createHash('sha256').update(text, 'utf8').digest('hex'),
        occurrences: [], outline: [],
      })
      return { result: undefined }
    },
  })
  if (!applied.ok) throw new Error(applied.message)
  return { artifactId }
}

function setup(): { root: string; projectId: string; artifactId: string } {
  const made = initWorkspace()
  mkdirSync(`${made.root}/docs`, { recursive: true })
  writeFileSync(`${made.root}/docs/a.md`, ARTIFACT, 'utf8')
  const head = made.store.readHead()
  if (!head.ok) throw new Error(head.message)
  const { artifactId } = bindArtifact(made.root, head.data.snapshot)
  return { root: made.root, projectId: made.projectId, artifactId }
}

function tool(root: string, service?: VwaArgumentService): ToolDefinition {
  return reportTool({
    workspaceRoot: () => root,
    ...(service ? { report: () => service } : {}),
  } as never)
}

function call(target: ToolDefinition, args: Record<string, unknown>) {
  return target.execute(args as never, { signal: new AbortController().signal, agent: {} } as never)
}

const reportPath = (projectId: string, artifactId: string, format = 'markdown') =>
  `docs/vwa-reports/${projectId}/${artifactId}.review.${format === 'json' ? 'json' : 'md'}`

describe('§6.2 step 1 — freeze (write:false) creates E and writes no report', () => {
  it('returns evaluationId + bindingDigest and leaves the report directory empty', async () => {
    const { root, projectId, artifactId } = setup()
    const result = await call(tool(root), { projectId, artifactId, format: 'markdown', write: false })
    expect(result.ok).toBe(true)
    const data = (result as { data: { evaluationId: string; bindingDigest: string; reportHash: string } }).data
    expect(data.evaluationId).toMatch(/^eval_/)
    expect(data.bindingDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(existsSync(join(root, reportPath(projectId, artifactId)))).toBe(false)
    // E is persisted and never garbage-collected (§6.3 retention); it also
    // freezes the record set and the (here empty) disagreement context.
    expect(existsSync(join(root, '.dsh', 'vwa', projectId, 'evaluations', `${data.evaluationId}.json`))).toBe(true)
    const stored = loadEvaluation(root, projectId, data.evaluationId)!
    expect(stored.records).toEqual([])
    expect(stored.disagreementContext).toEqual([])
  })
})

describe('§6.2 step 3 — as-of re-render', () => {
  it('renders E with diverged:false while the disk bytes still match, and writes the report', async () => {
    const { root, projectId, artifactId } = setup()
    const service = new VwaArgumentService({ root })
    const frozen = await service.checkForDelivery(projectId, artifactId)
    const result = await call(tool(root), { projectId, artifactId, format: 'markdown', write: true, evaluationId: frozen.evaluationId })
      .then((value) => value as { ok: boolean; data: { text: string; path: string; asOf: { diverged: boolean } } })
    expect(result.ok).toBe(true)
    expect(result.data.asOf.diverged).toBe(false)
    expect(result.data.text).toContain(`as-of evaluation ${frozen.evaluationId}`)
    expect(result.data.text).toContain('diverged: false')
    expect(result.data.text).not.toContain('artifact was modified after review')
    expect(result.data.text).toContain('adjudication overlay: applied at render time; all other inputs as-of E')
    expect(readFileSync(join(root, result.data.path), 'utf8')).toBe(result.data.text)
  })

  it('skips layer-B: a page fixed after the freeze renders as-of with diverged:true (no INPUT_CHANGED)', async () => {
    const { root, projectId, artifactId } = setup()
    const service = new VwaArgumentService({ root })
    const frozen = await service.checkForDelivery(projectId, artifactId)
    // The batch sequence: freeze → fix the page (uncommitted, unbound).
    writeFileSync(`${root}/docs/a.md`, `${ARTIFACT}\nFixed after the review.\n`, 'utf8')
    // The live path still refuses (D16) …
    await expect(service.checkForDelivery(projectId, artifactId)).rejects.toThrow(/re-bind and re-audit/)
    // … while the as-of path renders the reviewed revision.
    const result = await call(tool(root), { projectId, artifactId, format: 'markdown', write: true, evaluationId: frozen.evaluationId })
      .then((value) => value as { ok: boolean; data: { text: string; asOf: { diverged: boolean; currentArtifactHash: string } } })
    expect(result.ok).toBe(true)
    expect(result.data.asOf.diverged).toBe(true)
    expect(result.data.asOf.currentArtifactHash).toBe(
      createHash('sha256').update(`${ARTIFACT}\nFixed after the review.\n`, 'utf8').digest('hex'),
    )
    expect(result.data.text).toContain('diverged: true')
    expect(result.data.text).toContain('artifact was modified after review; findings apply to the reviewed revision')
  })

  it('the live path without evaluationId is unchanged: no as-of header', async () => {
    const { root, projectId, artifactId } = setup()
    const service = new VwaArgumentService({ root })
    const frozen = await service.checkForDelivery(projectId, artifactId)
    const live = await service.renderReport(projectId, artifactId, frozen.evaluationId, 'markdown')
    const viaTool = await call(tool(root), { projectId, artifactId, format: 'markdown', write: false })
      .then((value) => value as { data: { text: string } })
    expect(live.text).not.toContain('as-of evaluation')
    expect(viaTool.data.text).toBe(live.text)
  })
})

describe('§6.3 — typed error pass-through and atomic publication', () => {
  it('a tampered evaluation read-back is STORE_CORRUPT, not retryable', async () => {
    const { root, projectId, artifactId } = setup()
    const service = new VwaArgumentService({ root })
    const frozen = await service.checkForDelivery(projectId, artifactId)
    writeFileSync(
      join(root, '.dsh', 'vwa', projectId, 'evaluations', `${frozen.evaluationId}.json`),
      '{"frozenHash":"deadbeef","frozen":{"tampered":true}}',
      'utf8',
    )
    const result = await call(tool(root), { projectId, artifactId, format: 'markdown', write: true, evaluationId: frozen.evaluationId })
    expect(result).toMatchObject({ ok: false, code: 'STORE_CORRUPT', retryable: false })
  })

  it('an unknown evaluationId is REFERENCE_INVALID, not retryable', async () => {
    const { root, projectId, artifactId } = setup()
    const result = await call(tool(root), {
      projectId, artifactId, format: 'markdown', write: false, evaluationId: `eval_${randomUUID()}`,
    })
    expect(result).toMatchObject({ ok: false, code: 'REFERENCE_INVALID', retryable: false })
  })

  it('a genuine input change in live mode stays retryable INPUT_CHANGED', async () => {
    const { root, projectId, artifactId } = setup()
    writeFileSync(`${root}/docs/a.md`, `${ARTIFACT}\nUnbound edit.\n`, 'utf8')
    const result = await call(tool(root), { projectId, artifactId, format: 'markdown', write: false })
    expect(result).toMatchObject({ ok: false, code: 'INPUT_CHANGED', retryable: true })
  })

  it('a failure mid-render leaves the previous report intact and publishes no partial file', async () => {
    const { root, projectId, artifactId } = setup()
    const path = join(root, reportPath(projectId, artifactId))
    mkdirSync(join(root, 'docs/vwa-reports', projectId), { recursive: true })
    writeFileSync(path, 'previous report\n', 'utf8')
    const failing = {
      checkForDelivery: async () => ({ evaluationId: 'eval_x', bindingDigest: 'b'.repeat(64), check: { projectRevision: 1 } }),
      renderReport: async () => {
        throw new Error('boom mid-render')
      },
      renderReportAsOf: async () => {
        throw new Error('boom mid-render')
      },
    } as unknown as VwaArgumentService
    const result = await call(tool(root, failing), { projectId, artifactId, format: 'markdown', write: true })
    expect(result).toMatchObject({ ok: false, code: 'INPUT_CHANGED' })
    expect(readFileSync(path, 'utf8')).toBe('previous report\n')
    expect(readdirSync(join(root, 'docs/vwa-reports', projectId)).filter((file) => file.endsWith('.tmp'))).toEqual([])
  })
})

describe('§6.2 step 3 — adjudication overlay over E’s frozen inputs', () => {
  /**
   * The batch state: a fully reviewed page whose claims stage disagreed, frozen
   * as E before the fix. E is built the way checkForDelivery builds it (the same
   * deterministic pass, the same frozen fields) and persisted hash-verified, so
   * the render path under test is the real one.
   */
  async function frozenDisagreement() {
    const f = await reviewedFixture()
    const d = withDisagreement(f, f.records)
    const check = evaluateDelivery({
      root: f.root, snapshot: f.snapshot, artifactId: f.artifactId, text: f.body,
      records: d.records, pendingRunIds: [], adjudications: [], disagreementPolicy: 'blocking', gates: f.gates,
    })
    const frozen: FrozenEvaluation = {
      evaluationId: `eval_${randomUUID()}`, projectId: f.projectId, artifactId: f.artifactId,
      bindingDigest: 'b'.repeat(64), check, snapshot: f.snapshot, adjudications: [], gates: f.gates,
      artifactText: f.body, records: d.records,
      disagreementContext: disagreementContextOf(
        d.records,
        check.findings.filter((finding) => finding.code === 'REVIEWER_DISAGREEMENT'),
      ),
      inputTokens: 0, outputTokens: 0, calls: d.records.length, modelId: 'fake',
    }
    persistEvaluation(f.root, f.projectId, frozen)
    const service = new VwaArgumentService({ root: f.root })
    return { f, d, service, frozen }
  }

  it('reject (human rules the failing verdict spurious) flips eligible to true', async () => {
    const { f, d, service, frozen } = await frozenDisagreement()
    // As-of E is still blocked: the unresolved disagreement keeps needs-review.
    expect(frozen.check.checks.argument).toBe('needs-review')
    expect(frozen.check.eligibleForReviewed).toBe(false)
    // E carries the frozen conflicting-verdict context of the marker.
    expect(frozen.disagreementContext).toHaveLength(1)
    const entry = frozen.disagreementContext[0]!
    expect(entry.findingId).toBe(d.findingId)
    expect([[entry.runA, entry.verdictA], [entry.runB, entry.verdictB]]).toEqual(
      expect.arrayContaining([[d.passRunId, 'pass'], [d.failRunId, 'fail']]),
    )
    // The human adjudicates AFTER the freeze — the only live input of the render.
    appendAdjudication(f.root, f.projectId, disagreementAdjudication(f, d.records, d.findingId, 'reject', d.passRunId, d.failRunId))
    const rendered = await service.renderReportAsOf(f.projectId, f.artifactId, frozen.evaluationId, 'markdown')
    expect(rendered.eligible).toBe(true)
    expect(rendered.text).toContain('adjudication overlay: applied at render time; all other inputs as-of E')
    expect(rendered.text).toContain('| argument | pass |')
    expect(rendered.text).toContain('Status: reviewed candidate')
  })

  it('accept (the failing verdict stands) keeps the major force and eligibility false', async () => {
    const { f, d, service, frozen } = await frozenDisagreement()
    appendAdjudication(f.root, f.projectId, disagreementAdjudication(f, d.records, d.findingId, 'accept', d.failRunId, d.passRunId))
    const rendered = await service.renderReportAsOf(f.projectId, f.artifactId, frozen.evaluationId, 'markdown')
    expect(rendered.eligible).toBe(false)
    expect(rendered.text).toContain('| argument | fail |')
    expect(rendered.text).toContain('finding REVIEWER_DISAGREEMENT (major; human-accepted')
    expect(rendered.text).toContain('superseded run')
  })

  it('a re-render without new adjudications reproduces E (no live re-evaluation)', async () => {
    const { f, service, frozen } = await frozenDisagreement()
    // E rendered from its OWN frozen inputs — the as-of body must be exactly this.
    const eOwn = renderReportMarkdown(reportInput(frozen))
    const asOf = await service.renderReportAsOf(f.projectId, f.artifactId, frozen.evaluationId, 'markdown')
    // Only the as-of header block differs; every other line is E's own.
    const body = (text: string) =>
      text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('as-of evaluation') && !line.startsWith('adjudication overlay:'))
        .sort()
    expect(eOwn).not.toContain('as-of evaluation')
    expect(body(asOf.text)).toEqual(body(eOwn))
  })
})
