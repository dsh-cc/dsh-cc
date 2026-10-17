import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Ajv2020 from 'ajv/dist/2020'
import { digestRecords, gradeClaim, computeAssessments } from '../src/policy.ts'
import { stageVerdict } from '../src/report-render.ts'
import { planStage, computeCoreSet } from '../src/review-plan.ts'
import { buildReverseIndex, dependencyDigest } from '../src/dependencies.ts'
import { responseSchemaFor, executeReviewRun, buildEnvelope } from '../src/review-runner.ts'
import { ReviewRunStore } from '../src/review-run-store.ts'
import { VwaArgumentService } from '../src/report.ts'
import { readSourceBytes } from '../src/sources.ts'
import { sha256Hex } from '../src/schema.ts'
import { initWorkspace } from './helpers.ts'
import {
  makeSnapshot,
  makeClaim,
  makeArgument,
  makeSource,
  makeEvidence,
  makeGroup,
  fakeAdapter,
  BUDGET,
} from './review-helpers.ts'

const ART_ID = 'art_11111111-1111-4111-8111-111111111111'

function world(snapshot: any) {
  return {
    index: buildReverseIndex(snapshot),
    claims: snapshot.claims,
    digest: digestRecords([]),
    executedSearchClaimIds: new Set<string>(),
  }
}
function record(stage: string, response: unknown): any {
  return {
    runId: `run_${randomUUID()}`,
    stage,
    targetRefs: [],
    dependencyDigest: '',
    contractHash: '',
    policyHash: '',
    reviewerConfigHash: '',
    promptHash: '',
    inputHash: '',
    status: 'completed',
    inputTokens: 0,
    outputTokens: 0,
    startedAt: '',
    endedAt: '',
    response,
  }
}

describe('review: missing behavior at the real data boundaries', () => {
  it('a completed extraction can be consumed by delivery grading', async () => {
    const { root, projectId, store } = initWorkspace(),
      artId = `art_${randomUUID()}`,
      text = 'A fact.'
    writeFileSync(join(root, 'a.md'), text)
    const bound = store.withTransaction({
      expectedRevision: 1,
      requestId: randomUUID(),
      payloadHash: 'bind',
      applyFn(s) {
        s.artifacts.push({
          id: artId,
          entityVersion: 1,
          createdAt: '',
          updatedAt: '',
          path: 'a.md',
          contentHash: sha256Hex(text),
          outline: [],
          occurrences: [],
        })
        return { result: {} }
      },
    })
    expect(bound.ok).toBe(true)
    const head = store.readHead()
    if (!head.ok) throw new Error(head.message)
    const adapter = fakeAdapter([
      () => ({ raw: JSON.stringify({ items: [] }) }),
      (req) => ({
        raw: JSON.stringify({
          stage: 'align',
          rubricVersion: 'humanities-v1',
          findings: [],
          targets: [
            {
              targetId: artId,
              checks: JSON.parse(req.messages[1].content).requiredRules.map((r: any) => ({
                ruleId: r.ruleId,
                result: 'pass',
                rationale: 'r',
                evidenceIds: [],
              })),
            },
          ],
          alignment: [],
        }),
      }),
    ])
    await executeReviewRun({
      deps: { root, adapter, budget: BUDGET, contractHash: '' },
      runId: `run_${randomUUID()}`,
      requestId: randomUUID(),
      stages: ['audit'],
      targetClaimIds: [],
      snapshot: head.data.snapshot,
      signal: new AbortController().signal,
      artifact: { id: artId, path: 'a.md', text },
    })
    await expect(new VwaArgumentService({ root }).checkForDelivery(projectId, artId)).resolves.toBeDefined()
  })

  it('an unsupported premise caps an otherwise adequate argument at U', () => {
    const premise = makeClaim('fact', 'unsupported premise')
    const conclusion = makeClaim('fact', 'conclusion')
    const arg = makeArgument(conclusion.id, [premise.id], [])
    const snapshot = makeSnapshot({ claims: [premise, conclusion], arguments: [arg] })
    const w = world(snapshot)
    w.digest.arguments.set(arg.id, { adequacy: 'adequate', checks: [] })
    expect(gradeClaim(w, premise).grade).toBe('U')
    expect(gradeClaim(w, conclusion).grade).toBe('U')
  })

  it('a support path with zero reviews is not current', () => {
    const c = makeClaim(),
      source = makeSource(),
      ev = makeEvidence(source)
    const snapshot = makeSnapshot({
      claims: [c],
      sources: [source],
      evidence: [ev],
      groups: [makeGroup(c.id, [ev.id])],
    })
    expect(computeAssessments(world(snapshot))[0].reviewState).toBe('not-run')
  })

  it('a completed model call with a needs-review check is not a passed stage', () => {
    const r = record('claims', {
      stage: 'claims',
      findings: [],
      targets: [
        {
          targetId: 'cl_x',
          checks: [{ ruleId: 'HIST-01', result: 'needs-review', evidenceIds: [], rationale: 'cannot tell' }],
          searchSufficiency: 'not-checked',
        },
      ],
    })
    expect(stageVerdict([r], ['claims', 'arguments'])).toBe('needs-review')
  })

  it('the standalone schema given to the model has resolvable references', () => {
    expect(() => new Ajv2020({ strict: false }).compile(responseSchemaFor('support'))).not.toThrow()
  })

  it('support review receives the actual target claim and scope', () => {
    const c = makeClaim('fact', 'THE UNIQUE CLAIM WHICH MUST BE REVIEWED')
    const source = makeSource(),
      ev = makeEvidence(source),
      group = makeGroup(c.id, [ev.id])
    const snapshot = makeSnapshot({ claims: [c], sources: [source], evidence: [ev], groups: [group] })
    const [task] = planStage({
      stage: 'support',
      snapshot,
      index: buildReverseIndex(snapshot),
      targetClaimIds: [c.id],
      core: new Set(),
    })
    const env = buildEnvelope({
      stage: 'support',
      runId: 'run_x',
      task,
      contract: snapshot.contract,
      dependencies: [],
      maxOutputTokens: 3000,
    })
    expect(JSON.stringify(env)).toContain(c.text)
  })

  it('changing a group changes its review dependency digest', () => {
    const c = makeClaim(),
      group = makeGroup(c.id, [])
    const snapshot = makeSnapshot({ claims: [c], groups: [group] })
    const before = dependencyDigest(buildReverseIndex(snapshot), [group.id], [])
    group.rationale = 'changed'
    group.entityVersion++
    expect(dependencyDigest(buildReverseIndex(snapshot), [group.id], [])).not.toBe(before)
  })

  it('a conclusion section makes its paragraph claims core', () => {
    const c = makeClaim()
    c.importance = 'supporting'
    const text = '# Title\n\nIntro.\n\n## Conclusion\n\nThis is the conclusion.\n'
    const start = text.indexOf('This is')
    const snapshot = makeSnapshot({
      claims: [c],
      artifacts: [
        {
          id: ART_ID,
          path: 'a.md',
          occurrences: [{ claimId: c.id, span: { start, end: text.length - 1 }, exactText: text.slice(start, -1) }],
          outline: [],
        } as any,
      ],
    })
    expect(
      computeCoreSet({ index: buildReverseIndex(snapshot), artifactText: text, requiredQuestionTexts: [] }).has(c.id),
    ).toBe(true)
  })

  it('runtime generated reports cannot be registered as evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'review-output-'))
    const dir = join(root, '.dsh/vwa/prj_x/reports')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'report.md')
    writeFileSync(file, 'agent generated report')
    expect(() => readSourceBytes(root, file)).toThrow()
  })

  it('audit observes the shared one-call budget and accounts for its calls', async () => {
    const snapshot = makeSnapshot()
    const adapter = fakeAdapter([
      () => ({ raw: JSON.stringify({ items: [] }), inputTokens: 10, outputTokens: 10 }),
      () => ({
        raw: JSON.stringify({
          stage: 'align',
          rubricVersion: 'humanities-v1',
          findings: [],
          targets: [],
          alignment: [],
        }),
        inputTokens: 10,
        outputTokens: 10,
      }),
    ])
    const outcome = await executeReviewRun({
      deps: {
        root: mkdtempSync(join(tmpdir(), 'review-budget-')),
        adapter,
        budget: { ...BUDGET, maxCallsPerRun: 1 },
        contractHash: '',
      },
      runId: `run_${randomUUID()}`,
      requestId: randomUUID(),
      stages: ['audit'],
      targetClaimIds: [],
      snapshot,
      signal: new AbortController().signal,
      artifact: { id: ART_ID, path: 'a.md', text: 'A fact.' },
    })
    expect.soft(adapter.state.dispatches).toBeLessThanOrEqual(1)
    expect.soft(outcome.calls).toBe(adapter.state.dispatches)
  })

  it('runtime-generated audit findings survive persistence', async () => {
    const snapshot = makeSnapshot(),
      text = 'An unregistered fact.'
    const root = mkdtempSync(join(tmpdir(), 'review-findings-')),
      runId = `run_${randomUUID()}`
    const adapter = fakeAdapter([
      () => ({
        raw: JSON.stringify({
          items: [
            {
              span: { start: 0, end: text.length },
              exactText: text,
              isQuotation: false,
              atomicClaims: [{ text, kind: 'fact', importance: 'core', scope: makeClaim().scope }],
            },
          ],
        }),
      }),
      (req) => {
        const env = JSON.parse(req.messages[1].content)
        return {
          raw: JSON.stringify({
            stage: 'align',
            rubricVersion: 'humanities-v1',
            targets: [
              {
                targetId: ART_ID,
                checks: env.requiredRules.map((r: any) => ({
                  ruleId: r.ruleId,
                  result: 'pass',
                  rationale: 'r',
                  evidenceIds: [],
                })),
              },
            ],
            findings: [],
            alignment: env.items.map((i: any) => ({
              extractedId: i.extractedId,
              claimIds: [],
              relation: 'new',
              rationale: 'unregistered',
            })),
          }),
        }
      },
    ])
    const outcome = await executeReviewRun({
      deps: { root, adapter, budget: BUDGET, contractHash: '' },
      runId,
      requestId: randomUUID(),
      stages: ['audit'],
      targetClaimIds: [],
      snapshot,
      signal: new AbortController().signal,
      artifact: { id: ART_ID, path: 'a.md', text },
    })
    expect(outcome.findings).toHaveLength(1)
    const storedFindings = new ReviewRunStore(root, snapshot.projectId)
      .readRecords(runId)
      .flatMap((r) => r.response?.findings ?? [])
    expect(storedFindings).toHaveLength(1)
  })

  it('editing a previously-reviewed claim invalidates its previous support grade', async () => {
    const { root, projectId, store } = initWorkspace()
    const claim = makeClaim('fact', 'The port opened in May.')
    const source = makeSource(),
      ev = makeEvidence(source),
      group = makeGroup(claim.id, [ev.id])
    const text = 'The port opened in May.'
    const artId = `art_${randomUUID()}`
    writeFileSync(join(root, 'a.md'), text)
    store.withTransaction({
      expectedRevision: 1,
      requestId: randomUUID(),
      payloadHash: 'seed',
      applyFn(s) {
        s.claims.push(claim)
        s.sources.push(source)
        s.evidence.push(ev)
        s.groups.push(group)
        s.artifacts.push({
          id: artId,
          entityVersion: 1,
          createdAt: '',
          updatedAt: '',
          path: 'a.md',
          contentHash: sha256Hex(text),
          outline: [],
          occurrences: [],
        })
        return { result: {} }
      },
    })
    const rs = new ReviewRunStore(root, projectId),
      runId = `run_${randomUUID()}`
    rs.initRun(runId)
    rs.writeRecord(runId, {
      ...record('support', {
        stage: 'support',
        rubricVersion: 'humanities-v1',
        findings: [],
        targets: [
          {
            targetId: group.id,
            checks: ['EVID-02', 'SUP-01', 'SUP-02'].map((ruleId) => ({
              ruleId,
              result: 'pass',
              rationale: 'r',
              evidenceIds: [],
            })),
            support: 'direct',
            adequacy: 'adequate',
            evidenceRelations: [{ evidenceId: ev.id, support: 'direct', rationale: 'r' }],
          },
        ],
      }),
      runId,
      targetRefs: [{ id: group.id, entityVersion: 1 }],
    })
    store.withTransaction({
      expectedRevision: 2,
      requestId: randomUUID(),
      payloadHash: 'change',
      applyFn(s) {
        s.claims[0].text = 'The port NEVER opened in May.'
        s.claims[0].entityVersion++
        return { result: {} }
      },
    })
    const check = (await new VwaArgumentService({ root }).checkForDelivery(projectId, artId)).check
    expect.soft(check.assessments[0].reviewState).toBe('stale')
    expect.soft(check.assessments[0].supportGrade).not.toBe('B')
  })
})
