import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Ajv2020 from 'ajv/dist/2020'
import { digestRecords, gradeClaim, computeAssessments } from '../src/policy.ts'
import { planStage, computeCoreSet } from '../src/review-plan.ts'
import { buildReverseIndex, dependencyDigest } from '../src/dependencies.ts'
import { responseSchemaFor, executeReviewRun, buildEnvelope } from '../src/review-runner.ts'
import { ReviewRunStore } from '../src/review-run-store.ts'
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

describe('review engine: regressions at the real data boundaries', () => {
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
})
