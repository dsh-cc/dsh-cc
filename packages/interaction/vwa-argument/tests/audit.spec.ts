/**
 * Slice-4 audit spec (§12): CommonMark extraction units, over-long block
 * splitting with 512-char context, claim-marker stripping with a valid
 * offset map (D24 cross-package fixture), align relation rules, the three
 * fixed-major AUDIT finding codes, §12.1 core discovery (needs-review + new
 * run required), and the §20/§21 worked examples as end-to-end fake-adapter
 * cases.
 * @module tests/audit
 */

import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AuditInvalidError, executeAudit, extractionUnits, stripClaimMarkers, validateAlignment } from '../src/audit.ts'
import { rootBlocks } from '../src/review-plan.ts'
import type { ReviewModelAdapter, ReviewMessages } from '../src/review-adapter.ts'
import type { AlignEnvelope, ExtractEnvelope } from '../src/audit.ts'
import type { Claim, ExtractedItem, ProjectSnapshot, ReviewRecord } from '../src/types.ts'
import { makeClaim, makeSnapshot } from './review-helpers.ts'

// ---- helpers ----

/** A fake adapter that answers the extract call with fixed items and the align call via a callback. */
function auditAdapter(options: {
  items: ExtractedItem[]
  align: (envelope: AlignEnvelope) => Record<string, unknown>
}): ReviewModelAdapter {
  let call = 0
  return {
    async prepareReviewCall(req) {
      const envelope = JSON.parse(req.messages[1]!.content) as unknown
      return {
        describe: () => ({ modelId: 'fake', providerId: 'fake', version: 'unpinned', effectiveOptions: {} }),
        dispatch: async () => {
          const index = call++
          if (index === 0) return { raw: JSON.stringify({ items: options.items }), inputTokens: 5, outputTokens: 7 }
          const response = options.align(envelope as AlignEnvelope)
          const rules = (envelope as { requiredRules?: { targetId: string; ruleId: string }[] }).requiredRules
          if (rules)
            response.targets = [...new Set(rules.map((r) => r.targetId))].map((targetId) => ({
              targetId,
              checks: rules
                .filter((r) => r.targetId === targetId)
                .map((r) => ({ ruleId: r.ruleId, result: 'pass', rationale: 'reviewed', evidenceIds: [] })),
            }))
          return { raw: JSON.stringify(response), inputTokens: 6, outputTokens: 8 }
        },
      }
    },
    async countInput(messages: ReviewMessages) {
      return { tokens: messages.reduce((sum, m) => sum + m.content.length, 0), method: 'tokenizer' }
    },
    configFingerprint: () => ({ fake: true }),
  }
}

function item(text: string, artifactText: string, importance: 'core' | 'supporting' = 'supporting'): ExtractedItem {
  const start = artifactText.indexOf(text)
  if (start < 0) throw new Error(`fixture text not in artifact: ${text}`)
  return {
    span: { start, end: start + text.length },
    exactText: text,
    atomicClaims: [
      {
        text: `atomic:${text}`,
        kind: 'fact',
        scope: { subject: 's', corpus: [], time: 'unspecified', geography: 'unspecified', exclusions: [] },
        importance,
      },
    ],
    isQuotation: false,
  }
}

const ARTIFACT =
  '# Title\n\nPerson A claimed in memoirs to have opposed the plan. The minutes record only the vote.\n\n## Conclusion\n\nThe record is insufficient to confirm this.\n'

function auditInput(artifact: string, snapshot: ProjectSnapshot, adapter: ReviewModelAdapter) {
  return {
    adapter,
    runId: `run_${randomUUID()}`,
    artifact: { id: snapshot.artifacts[0]?.id ?? `art_${randomUUID()}`, path: 'docs/a.md', text: artifact },
    snapshot,
    rubricVersion: 'humanities-v1',
    contractHash: 'c'.repeat(64),
    policyHash: 'p'.repeat(64),
    reviewerConfigHash: 'r'.repeat(64),
    maxOutputTokens: 3000,
    maxUnitChars: 48_000,
    signal: new AbortController().signal,
  }
}

// ---- extraction units (§12) ----

describe('extraction units — CommonMark AST root children', () => {
  it('a list with blank lines stays ONE root block (the parser AST, not a blank-line split)', () => {
    const text = 'Intro paragraph.\n\n- item one\n\n- item two\n\nClosing paragraph.'
    const blocks = rootBlocks(text)
    expect(blocks.map((block) => block.body.trim().split('\n')[0])).toEqual([
      'Intro paragraph.',
      '- item one',
      'Closing paragraph.',
    ])
  })

  it('headings are detected on root blocks', () => {
    const blocks = rootBlocks('# Title\n\nBody.')
    expect(blocks[0]!.heading).toEqual({ level: 1, text: 'Title' })
  })

  it('an over-long block is sentence-split with 512-char context', () => {
    const sentence = 'A'.repeat(600) + '. '
    const body = sentence.repeat(6)
    const text = `# H\n\n${body}`
    const units = extractionUnits(text, 1000)
    const long = units.filter((unit) => unit.text.length > 500)
    expect(long.length).toBeGreaterThanOrEqual(3)
    for (const unit of long) {
      expect(unit.context.start).toBe(Math.max(0, unit.span.start - 512))
      expect(unit.context.end).toBe(Math.min(text.length, unit.span.end + 512))
    }
  })

  it('a block with no sentence boundary is hard-split', () => {
    const body = 'x'.repeat(2500)
    const text = `${body}`
    const units = extractionUnits(text, 1000)
    expect(units.length).toBe(3)
    expect(units[0]!.context.end - units[0]!.span.end).toBe(512)
  })
})

// ---- claim-marker stripping (§19/D24) ----

describe('stripClaimMarkers — D24 cross-package fixture', () => {
  it('removes claim markers and maps spans back to the ORIGINAL text', () => {
    const original = 'Uses 40% less memory 〔claim:cl_abc〕 and v1.2 here.'
    const { text, strippedToOriginal } = stripClaimMarkers(original)
    expect(text).toBe('Uses 40% less memory  and v1.2 here.')
    const start = text.indexOf('and v1.2')
    expect(original.slice(strippedToOriginal(start), strippedToOriginal(start + 8))).toBe('and v1.2')
    // The end of the stripped text maps to the end of the original.
    expect(strippedToOriginal(text.length)).toBe(original.length)
  })

  it('lane-2 extraction spans stay valid against the original after stripping (mixed markers)', () => {
    const original = 'The timeout is 30s 〔src:ws:docs/a.md#L1-L2〕 and the release is v1.2 〔claim:cl_abc〕.'
    const { text, strippedToOriginal } = stripClaimMarkers(original)
    const units = extractionUnits(text, 48_000)
    expect(units.length).toBeGreaterThanOrEqual(1)
    for (const unit of units) {
      const slice = original.slice(strippedToOriginal(unit.span.start), strippedToOriginal(unit.span.end))
      // Same content once the removed claim marker is dropped: the span
      // locates exactly the unit's text in the original coordinates.
      expect(slice.replaceAll(/〔claim:[^\s〕]+〕/g, '')).toBe(unit.text)
    }
  })
})

// ---- alignment validation (§11.4) ----

describe('align relation rules', () => {
  const derivations = [{ extractedId: 'ext_1' }, { extractedId: 'ext_2' }]

  it('relation new with non-empty claimIds is invalid', () => {
    expect(() =>
      validateAlignment(
        {
          stage: 'align',
          rubricVersion: 'r',
          findings: [],
          targets: [],
          alignment: [{ extractedId: 'ext_1', claimIds: ['cl_x'], relation: 'new', rationale: 'r' }],
        },
        derivations,
        [],
      ),
    ).toThrow(AuditInvalidError)
  })

  it('non-new relations require non-empty valid claimIds', () => {
    expect(() =>
      validateAlignment(
        {
          stage: 'align',
          rubricVersion: 'r',
          findings: [],
          targets: [],
          alignment: [{ extractedId: 'ext_1', claimIds: [], relation: 'exact', rationale: 'r' }],
        },
        derivations,
        ['cl_a'],
      ),
    ).toThrow(AuditInvalidError)
    expect(() =>
      validateAlignment(
        {
          stage: 'align',
          rubricVersion: 'r',
          findings: [],
          targets: [],
          alignment: [{ extractedId: 'ext_1', claimIds: ['cl_unknown'], relation: 'exact', rationale: 'r' }],
        },
        derivations,
        ['cl_a'],
      ),
    ).toThrow(AuditInvalidError)
  })

  it('each extracted item appears exactly once', () => {
    expect(() =>
      validateAlignment(
        { stage: 'align', rubricVersion: 'r', findings: [], targets: [], alignment: [] },
        derivations,
        [],
      ),
    ).toThrow(AuditInvalidError)
    expect(() =>
      validateAlignment(
        {
          stage: 'align',
          rubricVersion: 'r',
          findings: [],
          targets: [],
          alignment: [
            { extractedId: 'ext_1', claimIds: ['cl_a'], relation: 'exact', rationale: 'r' },
            { extractedId: 'ext_1', claimIds: ['cl_a'], relation: 'exact', rationale: 'r' },
          ],
        },
        derivations,
        ['cl_a'],
      ),
    ).toThrow(AuditInvalidError)
  })
})

// ---- full audit (§12) ----

describe('executeAudit — findings, core discovery, span validation', () => {
  it('relation new with a core atomic claim → AUDIT_NEW_CLAIM (fixed major) + needsReview + new run required', async () => {
    const snapshot = makeSnapshot({ claims: [makeClaim('fact')] })
    const adapter = auditAdapter({
      items: [item('The minutes record only the vote.', ARTIFACT, 'core')],
      align: (envelope) => ({
        stage: 'align',
        rubricVersion: 'humanities-v1',
        findings: [],
        targets: [],
        alignment: envelope.items.map((entry: { extractedId: string }) => ({
          extractedId: entry.extractedId,
          claimIds: [],
          relation: 'new',
          rationale: 'unregistered',
        })),
      }),
    })
    const outcome = await executeAudit(auditInput(ARTIFACT, snapshot, adapter))
    expect(outcome.needsReview).toBe(true) // §12.1: a new run is required
    expect(outcome.findings.map((finding) => finding.code)).toContain('AUDIT_NEW_CLAIM')
    const finding = outcome.findings.find((f) => f.code === 'AUDIT_NEW_CLAIM')!
    expect(finding.severity).toBe('major') // fixed major (§11.4)
    expect(finding.artifactSpans[0]).toEqual(outcome.newClaimProposals[0]!.span)
    // The extraction record is stored independently as an ExtractionRecord.
    expect(outcome.extractionRecord.stage).toBe('extract')
    expect(outcome.extractionRecord.response.items).toHaveLength(1)
    expect(outcome.alignRecord.stage).toBe('align')
  })

  it('a span that does not exactly match the artifact is a runtime validation failure', async () => {
    const snapshot = makeSnapshot({ claims: [makeClaim('fact')] })
    const adapter = auditAdapter({
      items: [{ ...item('The minutes record only the vote.', ARTIFACT), exactText: 'FABRICATED TEXT' }],
      align: () => ({ stage: 'align', rubricVersion: 'r', findings: [], targets: [], alignment: [] }),
    })
    await expect(executeAudit(auditInput(ARTIFACT, snapshot, adapter))).rejects.toThrow(AuditInvalidError)
  })

  it('a span crossing its unit boundary (not a boundary sentence) is rejected', async () => {
    const text = 'B'.repeat(2000) + '.'
    const snapshot = makeSnapshot({ claims: [makeClaim('fact')] })
    const [unit] = extractionUnits(text, 500)
    // Start inside the unit, end far beyond its 512-char context (no boundary sentence).
    const span = { start: unit!.span.start, end: unit!.span.end + 600 }
    const adapter = auditAdapter({
      items: [{ span, exactText: text.slice(span.start, span.end), atomicClaims: [dummyAtomic()], isQuotation: false }],
      align: () => ({ stage: 'align', rubricVersion: 'r', findings: [], targets: [], alignment: [] }),
    })
    await expect(executeAudit(auditInput(text, snapshot, adapter))).rejects.toThrow(AuditInvalidError)
  })

  it('author occurrence validation: exactText must slice-match the artifact before any model call', async () => {
    const claim = makeClaim('fact')
    const snapshot = makeSnapshot({ claims: [claim] })
    snapshot.artifacts.push({
      id: 'art_x',
      entityVersion: 1,
      createdAt: '',
      updatedAt: '',
      path: 'docs/a.md',
      contentHash: 'h',
      occurrences: [{ claimId: claim.id, span: { start: 0, end: 5 }, exactText: 'WRONG' }],
      outline: [],
    })
    const adapter = auditAdapter({
      items: [],
      align: () => ({ stage: 'align', rubricVersion: 'r', findings: [], targets: [], alignment: [] }),
    })
    let calls = 0
    const counting: ReviewModelAdapter = {
      ...adapter,
      prepareReviewCall: async (...args) => {
        calls += 1
        return adapter.prepareReviewCall(...args)
      },
    }
    await expect(executeAudit(auditInput(ARTIFACT, snapshot, counting))).rejects.toThrow(AuditInvalidError)
    expect(calls).toBe(0) // broken input never spends model budget (§11.1)
  })

  it('stronger/broader map to AUDIT_STRONGER/AUDIT_BROADER against the mapped claims (never overwrite)', async () => {
    const claim = makeClaim('fact', 'The timeout is 30s')
    const snapshot = makeSnapshot({ claims: [claim] })
    const adapter = auditAdapter({
      items: [item('Person A claimed in memoirs to have opposed the plan.', ARTIFACT)],
      align: (envelope) => ({
        stage: 'align',
        rubricVersion: 'humanities-v1',
        findings: [],
        targets: [],
        alignment: envelope.items.map((entry: { extractedId: string }) => ({
          extractedId: entry.extractedId,
          claimIds: [claim.id],
          relation: 'stronger',
          rationale: 'stance stronger',
        })),
      }),
    })
    const outcome = await executeAudit(auditInput(ARTIFACT, snapshot, adapter))
    expect(outcome.findings.map((finding) => finding.code)).toEqual(['AUDIT_STRONGER'])
    expect(outcome.findings[0]!.targetIds).toEqual([claim.id])
    expect(outcome.metrics.extractedAtomicClaims).toBe(1)
    expect(outcome.metrics.mappedAtomicClaims).toBe(0) // stronger never counts as aligned
    expect(outcome.needsReview).toBe(false)
  })
})

function dummyAtomic(): ExtractedItem['atomicClaims'][number] {
  return {
    text: 'atomic',
    kind: 'fact',
    scope: { subject: 's', corpus: [], time: 'unspecified', geography: 'unspecified', exclusions: [] },
    importance: 'supporting',
  }
}

// ---- worked example §20 (historical narrative) ----

describe('worked example §20 — historical narrative', () => {
  const problematicBody = '甲当时确实反对方案。'
  const revisedBody =
    '# Title\n\n甲在回忆中声称曾反对方案。同期记录不足以确认这一点。\n\n## Conclusion\n\n同期记录不足以确认这一点。'

  function historySnapshot(): ProjectSnapshot {
    const c1 = makeClaim('source-report', '甲在回忆中声称曾反对方案')
    const c2 = makeClaim('fact', '甲当时确实反对方案')
    const snapshot = makeSnapshot({ claims: [c1, c2] })
    snapshot.contract.question = '甲当时是否反对方案？'
    return snapshot
  }

  it('initial problematic body: the over-strong fact claim is located to a specific span', async () => {
    const snapshot = historySnapshot()
    // The extracted "确实反对" claim maps to NO author claim that matches its
    // strength — C2 (fact) exists but is over-strong relative to S2's silence.
    const adapter = auditAdapter({
      items: [item(problematicBody, `# Title\n\n${problematicBody}\n\n## Conclusion\n\n同期记录不足以确认这一点。`)],
      align: (envelope) => ({
        stage: 'align',
        rubricVersion: 'humanities-v1',
        findings: [],
        targets: [],
        // 'stronger': the body asserts the fact outright; the graph only
        // carries the attributed memoir claim — located to the exact span.
        alignment: envelope.items.map((entry: { extractedId: string }) => ({
          extractedId: entry.extractedId,
          claimIds: [snapshot.claims.find((claim: Claim) => claim.kind === 'fact')!.id],
          relation: 'stronger',
          rationale: 'body asserts the fact; the record does not hold it',
        })),
      }),
    })
    const outcome = await executeAudit(
      auditInput(`# Title\n\n${problematicBody}\n\n## Conclusion\n\n同期记录不足以确认这一点。`, snapshot, adapter),
    )
    expect(outcome.findings).toHaveLength(1)
    expect(outcome.findings[0]!.code).toBe('AUDIT_STRONGER')
    expect(outcome.findings[0]!.severity).toBe('major')
    const span = outcome.findings[0]!.artifactSpans[0]!
    expect(`# Title\n\n${problematicBody}`.slice(span.start, span.end)).toBe(problematicBody)
  })

  it('revised body: the attributed sentence aligns exact with C1; the under-determined part stays a proposal', async () => {
    const snapshot = historySnapshot()
    const c1 = snapshot.claims.find((claim) => claim.kind === 'source-report')!
    const adapter = auditAdapter({
      items: [item('甲在回忆中声称曾反对方案。', revisedBody), item('同期记录不足以确认这一点。', revisedBody)],
      align: (envelope) => ({
        stage: 'align',
        rubricVersion: 'humanities-v1',
        findings: [],
        targets: [],
        alignment: envelope.items.map((entry: { extractedId: string; quote: string }) =>
          entry.quote.startsWith('甲在回忆中')
            ? {
                extractedId: entry.extractedId,
                claimIds: [c1.id],
                relation: 'exact',
                rationale: 'verbatim attribution',
              }
            : {
                extractedId: entry.extractedId,
                claimIds: [],
                relation: 'new',
                rationale: 'qualified claim not yet registered',
              },
        ),
      }),
    })
    const outcome = await executeAudit(auditInput(revisedBody, snapshot, adapter))
    // The attributed sentence aligns (exact); the "insufficient to confirm"
    // sentence is a PROPOSAL, never an automatic graph write (§12).
    expect(outcome.metrics.mappedAtomicClaims).toBe(1)
    expect(outcome.newClaimProposals.map((proposal) => proposal.text)).toEqual(['atomic:同期记录不足以确认这一点。'])
    expect(outcome.needsReview).toBe(false)
  })
})

// ---- worked example §21 (literary interpretation) ----

describe('worked example §21 — literary interpretation', () => {
  it('the universal-intent claim is flagged stronger and the T4 boundary is a proposal, not a mechanical invalidation', async () => {
    const c1 = makeClaim('interpretation', '前三个场景的沉默与受伤后的自我保护有关')
    const snapshot = makeSnapshot({ claims: [c1] })
    const body = '在三个场景中，沉默源于自我保护。'
    const adapter = auditAdapter({
      items: [item(body, body)],
      align: (envelope) => ({
        stage: 'align',
        rubricVersion: 'humanities-v1',
        findings: [],
        targets: [],
        alignment: [
          {
            extractedId: envelope.items[0]!.extractedId,
            claimIds: [c1.id],
            relation: 'broader',
            rationale: 'body universalizes beyond the declared T1–T3 scope',
          },
        ],
      }),
    })
    const outcome = await executeAudit(auditInput(body, snapshot, adapter))
    // T4 does not mechanically overturn C1: the counterexample surfaces as an
    // AUDIT_BROADER finding (fixed major) — scope narrowing is the repair.
    expect(outcome.findings.map((finding) => finding.code)).toEqual(['AUDIT_BROADER'])
    expect(outcome.findings[0]!.repair).toBe('narrow-claim')
    expect(outcome.needsReview).toBe(false)
  })
})

// ---- runner wiring: stage 'audit' through executeReviewRun ----

describe('audit via executeReviewRun (stage union)', () => {
  it('run marked needs-review when a new core claim is discovered; outcome carries auditMetrics', async () => {
    const { executeReviewRun } = await import('../src/review-runner.ts')
    const snapshot = makeSnapshot({ claims: [makeClaim('fact')] })
    const adapter = auditAdapter({
      items: [item('The minutes record only the vote.', ARTIFACT, 'core')],
      align: (envelope) => ({
        stage: 'align',
        rubricVersion: 'humanities-v1',
        findings: [],
        targets: [],
        alignment: envelope.items.map((entry: { extractedId: string }) => ({
          extractedId: entry.extractedId,
          claimIds: [],
          relation: 'new',
          rationale: 'unregistered core claim',
        })),
      }),
    })
    const outcome = await executeReviewRun({
      deps: {
        root: '/tmp/unused-audit-root',
        adapter,
        budget: {
          maxCallsPerRun: 40,
          maxInputTokensPerRun: 1e6,
          maxOutputTokensPerRun: 1e6,
          maxOutputTokensPerCall: 3000,
          wallMs: 60000,
          callTimeoutMs: 5000,
          concurrency: 2,
        },
        contractHash: 'c'.repeat(64),
      },
      runId: `run_${randomUUID()}`,
      requestId: `req-${randomUUID()}`,
      stages: ['audit'],
      targetClaimIds: [],
      snapshot,
      signal: new AbortController().signal,
      artifact: { id: snapshot.artifacts[0]?.id ?? `art_${randomUUID()}`, path: 'docs/a.md', text: ARTIFACT },
      maxUnitChars: 48_000,
    })
    expect(outcome.status).toBe('incomplete')
    expect(outcome.newCoreDiscovered).toBe(true)
    expect(outcome.auditMetrics?.extractedAtomicClaims).toBe(1)
    expect(outcome.records.some((record) => record.stage === 'extract')).toBe(true)
    expect(outcome.records.some((record: ReviewRecord) => record.stage === 'align')).toBe(true)
  })

  it('audit without a bound artifact → incomplete (§12: the artifact MUST NOT be claimed as checked)', async () => {
    const { executeReviewRun } = await import('../src/review-runner.ts')
    const snapshot = makeSnapshot({ claims: [makeClaim('fact')] })
    const outcome = await executeReviewRun({
      deps: {
        root: '/tmp/unused-audit2',
        adapter: auditAdapter({ items: [], align: () => ({}) }) as never,
        budget: {
          maxCallsPerRun: 40,
          maxInputTokensPerRun: 1e6,
          maxOutputTokensPerRun: 1e6,
          maxOutputTokensPerCall: 3000,
          wallMs: 60000,
          callTimeoutMs: 5000,
          concurrency: 2,
        },
        contractHash: 'c'.repeat(64),
      },
      runId: `run_${randomUUID()}`,
      requestId: `req-${randomUUID()}`,
      stages: ['audit'],
      targetClaimIds: [],
      snapshot,
      signal: new AbortController().signal,
    })
    expect(outcome.status).toBe('incomplete')
  })
})
