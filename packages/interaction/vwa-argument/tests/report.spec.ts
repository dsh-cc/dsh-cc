/**
 * Slice-4 report/service spec (§19, §16.1a, §17, Appendix A): the fixed
 * 7-part template with the required honesty wordings, D15 (frozen-input
 * read-back identifies a write failure), D16 (store-level rehash/rebind),
 * D17 (mechanical mapping: style not-run, exec inapplicable),
 * D20 (legacy disclosure), D21 (non-user signers rejected), D22 (runtime
 * output trees excluded from sources), and INPUT_CHANGED retry-once.
 * @module tests/report
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { HONESTY, mapMechanical, renderReportMarkdown } from '../src/report-render.ts'
import { InputChangedError, validateAdjudicationSource, VwaArgumentService } from '../src/report.ts'
import { readSourceBytes } from '../src/sources.ts'
import { ProjectStore } from '../src/store.ts'
import { initWorkspace } from './helpers.ts'
import type { ProjectSnapshot } from '../src/types.ts'

const ARTIFACT = '# Title\n\nThe policy shipped on 2026-10-16 with coverage at 90%.\n\n## Conclusion\n\nThe evidence is insufficient to confirm the causal claim.\n'

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

function headRevision(store: ProjectStore): number {
  const head = store.readHead()
  if (!head.ok) throw new Error(head.message)
  return head.data.head.revision
}

function setup(): { root: string; projectId: string; artifactId: string; store: ProjectStore } {
  const made = initWorkspace()
  writeFileSync(`${made.root}/docs/a.md`, ARTIFACT, 'utf8')
  const head = made.store.readHead()
  if (!head.ok) throw new Error(head.message)
  const { artifactId } = bindArtifact(made.root, head.data.snapshot)
  return { ...made, artifactId }
}

describe('§19 report template', () => {
  it('renders all 7 parts in fixed order with the honesty wordings and no forbidden templates', async () => {
    const { root, projectId, artifactId } = setup()
    const service = new VwaArgumentService({ root })
    const handle = await service.checkForDelivery(projectId, artifactId)
    const { text } = await service.renderReport(projectId, artifactId, handle.evaluationId, 'markdown')
    const positions = [
      '## 2. Checks (mechanical / evidence / argument / audit)',
      '## 3. Core conclusions',
      '## 4. Explanation cards',
      '## 5. Unresolved disputes and evidence gaps',
      '## 6. Sources and lineage',
      '## 7. Review configuration, cost, adjudications, and binding',
    ].map((needle) => text.indexOf(needle))
    expect(text).toContain('# VWA Reader Report')
    expect(positions.every((position) => position > 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    // Explanation-card fixed fields.
    for (const field of ['conclusion:', 'supported scope:', 'evidence:', 'reasoning summary:',
      'competing explanations / counter-evidence:', 'missing evidence:', 'next steps:',
      'limits of applicability:', 'reviewer / rule version:']) {
      expect(text).toContain(field)
    }
    // Honesty wordings + the §16.1a boundary line.
    expect(text).toContain(HONESTY.noGap)
    expect(text).toContain(HONESTY.checksCompleted)
    expect(text).toContain('delivery summary')
    // Forbidden templates are never generated.
    expect(text.toLowerCase()).not.toContain('no disputes')
    expect(text.toLowerCase()).not.toContain('proven absolutely correct')
  })

  it('is deterministic: same input → byte-identical markdown; reportHash = SHA-256 of the text', async () => {
    const { root, projectId, artifactId } = setup()
    const service = new VwaArgumentService({ root })
    const handle = await service.checkForDelivery(projectId, artifactId)
    const first = await service.renderReport(projectId, artifactId, handle.evaluationId, 'markdown')
    const second = await service.renderReport(projectId, artifactId, handle.evaluationId, 'markdown')
    expect(second.text).toBe(first.text)
    expect(second.reportHash).toBe(first.reportHash)
    expect(second.bindingDigest).toBe(handle.bindingDigest)
    const json = await service.renderReport(projectId, artifactId, handle.evaluationId, 'json')
    expect(json.reportHash).toBe(createHash('sha256').update(json.text).digest('hex'))
  })
})

describe('D17 — checks.mechanical mapping', () => {
  it('style abstained with no ruleset → not-run; exec with no fence → inapplicable', () => {
    expect(mapMechanical([
      { gate: 'style', status: 'abstained', detail: 'no runnable style ruleset' },
      { gate: 'exec', status: 'abstained', detail: 'no fence', fenceCount: 0 },
    ])).toBe('not-run')
  })

  it('exec with a fence and a pass, style loaded and passing → pass', () => {
    expect(mapMechanical([
      { gate: 'style', status: 'pass', rulesetLoaded: true },
      { gate: 'exec', status: 'pass', fenceCount: 2 },
    ])).toBe('pass')
  })

  it('a failing required link gate is fail — never mapped away', () => {
    expect(mapMechanical([{ gate: 'link', status: 'fail' }])).toBe('fail')
  })

  it('no gates at all → not-run (disclosed, never a fake pass)', () => {
    expect(mapMechanical([])).toBe('not-run')
  })

  it('the service maps gates into checks.mechanical (not the raw gate statuses)', async () => {
    const { root, projectId, artifactId } = setup()
    const service = new VwaArgumentService({
      root,
      gates: () => [{ gate: 'style', status: 'abstained', detail: 'no ruleset' }, { gate: 'exec', status: 'abstained', fenceCount: 0 }],
    })
    const { check } = await service.checkForDelivery(projectId, artifactId)
    expect(check.checks.mechanical).toBe('not-run')
    expect(check.checks.mechanical).not.toBe('abstained')
  })
})

describe('D15 — frozen-evaluation read-back identifies a failure', () => {
  it('a corrupted evaluation file is identified; the old row is never mistaken for current', async () => {
    const { root, projectId, artifactId } = setup()
    const service = new VwaArgumentService({ root })
    const handle = await service.checkForDelivery(projectId, artifactId)
    // Simulate a failed/corrupted evaluation write.
    const path = `${root}/.dsh/vwa/${projectId}/evaluations/${handle.evaluationId}.json`
    writeFileSync(path, '{"frozenHash":"deadbeef","frozen":{"tampered":true}}', 'utf8')
    await expect(service.renderReport(projectId, artifactId, handle.evaluationId, 'markdown'))
      .rejects.toThrow(/read-back/)
  })

  it('an unknown evaluation id fails instead of reusing an old row', async () => {
    const { root, projectId, artifactId } = setup()
    const service = new VwaArgumentService({ root })
    await expect(service.renderReport(projectId, artifactId, 'eval_does-not-exist', 'markdown'))
      .rejects.toThrow(InputChangedError)
  })
})

describe('D16 — store-level rehash/rebind after a shell write', () => {
  it('bytes changed after binding → INPUT_CHANGED; after re-bind the handle is fresh', async () => {
    const { root, projectId, artifactId, store } = setup()
    const service = new VwaArgumentService({ root })
    const first = await service.checkForDelivery(projectId, artifactId)
    // Body written via shell AFTER binding.
    writeFileSync(`${root}/docs/a.md`, `${ARTIFACT}\nAppended by a shell redirect.\n`, 'utf8')
    await expect(service.checkForDelivery(projectId, artifactId)).rejects.toThrow(InputChangedError)
    // Store-level rebind: re-binding against the new bytes produces a NEW handle.
    const bytes = readFileSync(`${root}/docs/a.md`)
    const rebound = store.withTransaction<void>({
      expectedRevision: headRevision(store),
      requestId: `rebind-${randomUUID()}`, payloadHash: 'rebind',
      applyFn: (mutable) => {
        const artifact = mutable.artifacts.find((art) => art.id === artifactId)!
        artifact.contentHash = createHash('sha256').update(bytes).digest('hex')
        artifact.entityVersion += 1
        return { result: undefined }
      },
    })
    expect(rebound.ok).toBe(true)
    const second = await service.checkForDelivery(projectId, artifactId)
    expect(second.bindingDigest).not.toBe(first.bindingDigest)
    expect(second.evaluationId).not.toBe(first.evaluationId)
    // The OLD handle no longer renders: INPUT_CHANGED, never a stale pass.
    await expect(service.renderReport(projectId, artifactId, first.evaluationId, 'markdown')).rejects.toThrow(InputChangedError)
  })
})

describe('INPUT_CHANGED retry-once (Appendix A)', () => {
  it('dependencies changing between freeze and render fail after one retry — never a "passed" report', async () => {
    const { root, projectId, artifactId, store } = setup()
    const service = new VwaArgumentService({ root })
    const handle = await service.checkForDelivery(projectId, artifactId)
    // A related dependency changes AFTER the freeze.
    const applied = store.withTransaction<void>({
      expectedRevision: headRevision(store),
      requestId: 'later-write', payloadHash: 'later',
      applyFn: (mutable) => {
        mutable.claims.push({
          id: `cl_${randomUUID()}`, entityVersion: 1, createdAt: '', updatedAt: '',
          text: 'A new downstream claim', kind: 'fact',
          scope: { subject: 's', corpus: [], time: '', geography: '', exclusions: [] },
          importance: 'supporting', stance: 'asserted', evaluationCriteria: [],
        })
        return { result: undefined }
      },
    })
    expect(applied.ok).toBe(true)
    await expect(service.renderReport(projectId, artifactId, handle.evaluationId, 'markdown'))
      .rejects.toThrow(/MUST NOT write/)
  })
})

describe('D20 — legacy receipt disclosure', () => {
  it('a v1-only artifact is disclosed as legacy/not-run', async () => {
    const { root, projectId, artifactId } = setup()
    const head = new ProjectStore(root, projectId).readHead()
    if (!head.ok) throw new Error(head.message)
    const { HONESTY: honesty } = await import('../src/report-render.ts')
    const text = renderReportMarkdown({
      snapshot: head.data.snapshot,
      artifactId, artifactHash: 'a'.repeat(64),
      checks: { mechanical: 'pass', evidence: 'not-run', argument: 'not-run', audit: 'not-run' },
      assessments: [], findings: [], adjudications: [], reviewRunIds: [],
      metrics: { mappedAtomicClaims: 0, extractedAtomicClaims: 0, reviewedCoreClaims: 0, coreClaims: 1 },
      cost: { inputTokens: 0, outputTokens: 0, calls: 0, modelId: 'unpinned' },
      gates: [], hasV2Receipt: false, hasLegacyReceipt: true,
      bindingDigest: 'b'.repeat(64), reportVersion: 'vwa-argument-report@1',
    })
    expect(text).toContain(HONESTY.legacy)
    expect(text).toContain('semantic guarantees are not upgraded')
  })
})

describe('D21 — assistant-fabricated sign instructions are rejected', () => {
  it('only a USER source may sign an adjudication', () => {
    expect(() => validateAdjudicationSource({ signer: 'assistant' })).toThrow(/USER/)
    expect(() => validateAdjudicationSource({ signer: 'user' })).not.toThrow()
  })
})

describe('D22 — runtime output trees are excluded from source registration', () => {
  it.each([
    '/x/.dsh/vwa/prj/x.md',
    '/x/docs/vwa-sources/prj/src.md',
    '/x/docs/vwa-reports/report.md',
  ])('rejects %s', (path) => {
    expect(() => readSourceBytes('/x', path)).toThrow()
  })
})
