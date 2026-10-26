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
import { ReviewTruncatedError, type ReviewModelAdapter, type ReviewMessages } from '../src/review-adapter.ts'
import { ReviewCaller } from '../src/review-call.ts'
import { BudgetTracker } from '../src/review-tasks.ts'
import type { ReviewBudget } from '../src/review-runner.ts'
import type { UsageRow } from '../src/review-run-store.ts'
import { auditCostModel } from '../src/audit-cost.ts'
import { auditUnitChars } from '../src/audit-reuse.ts'
import type { ReviewCaller as ReviewCallerType } from '../src/review-call.ts'
import type { AlignEnvelope, ExtractEnvelope } from '../src/audit.ts'
import type { Claim, ExtractedItem, ProjectSnapshot, ReviewRecord, AlignResponse } from '../src/types.ts'
import { mergeAlignChunks, dispatchAlignChunks } from '../src/audit-align.ts'
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
          // Fix 4: dispatch counts changed — extract and align each run in
          // multiple dispatches, so the stage is read from the envelope
          // instead of assuming index 0 = extract, 1+ = align.
          if ((envelope as { stage?: string }).stage === 'extract') {
            // Each extract dispatch owns only its own units: return just the
            // fixture items whose spans fall inside this batch's units.
            const units = (envelope as { units: { span: { start: number; end: number } }[] }).units
            const scoped = options.items.filter((it) =>
              units.some((u) => it.span.start >= u.span.start && it.span.start < u.span.end),
            )
            return { raw: JSON.stringify({ items: scoped }), inputTokens: 5, outputTokens: 7 }
          }
          void index
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

  it('model-returned AUDIT_NEW_CLAIM findings are dropped; proposal spans stay paired with their own atomics', async () => {
    // Review finding: the model may echo an AUDIT_* code the runtime owns.
    // The pairing in auditOutcomeFromRecords matches AUDIT_NEW_CLAIM spans to
    // 'new' atomics BY ORDER, so a model-returned entry would shift every
    // span onto the wrong proposal. Reproduction: two new claims with spans
    // [first, second]; the model returns a finding for the SECOND claim.
    const first = item('Person A claimed in memoirs to have opposed the plan.', ARTIFACT)
    const second = item('The minutes record only the vote.', ARTIFACT)
    const secondStart = ARTIFACT.indexOf('The minutes record only the vote.')
    const secondSpan = { start: secondStart, end: secondStart + 'The minutes record only the vote.'.length }
    const snapshot = makeSnapshot({ claims: [makeClaim('fact')] })
    const adapter = auditAdapter({
      items: [first, second],
      align: (envelope) => ({
        stage: 'align',
        rubricVersion: 'humanities-v1',
        // The model returns a runtime-owned code for the SECOND new claim.
        findings: [{
          id: `finding_${randomUUID()}`,
          code: 'AUDIT_NEW_CLAIM',
          targetIds: [],
          severity: 'major',
          explanation: 'model-echoed new claim for the second item',
          evidenceIds: [],
          artifactSpans: [secondSpan],
          repair: 'add-evidence',
        }],
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
    // Each proposal keeps ITS OWN original-coordinate span (review repro:
    // without the fix the pair comes back swapped as [secondSpan, first.span]).
    expect(outcome.newClaimProposals).toHaveLength(2)
    expect(outcome.newClaimProposals[0]!.span).toEqual(first.span)
    expect(outcome.newClaimProposals[1]!.span).toEqual(second.span)
    // The runtime-generated findings remain, one per new atomic.
    expect(outcome.findings.filter((f) => f.code === 'AUDIT_NEW_CLAIM')).toHaveLength(2)
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

// ---- Fix 4 (docs/plans/2026-10-23-vwa-audit-extract-output-budget.md §F4.3/§F4.4):
// output-bounded packing, truncation bisect, chunked align merge ----

type Fix4Envelope = AlignEnvelope & {
  stage: string
  units?: { span: { start: number; end: number }; text: string }[]
  requiredRules?: { targetId: string; ruleId: string }[]
}

/** One item exactly covering a unit (valid: span inside the unit, exact text). */
function unitItem(artifactText: string, u: { span: { start: number; end: number } }): ExtractedItem {
  return {
    span: u.span,
    exactText: artifactText.slice(u.span.start, u.span.end),
    atomicClaims: [dummyAtomic()],
    isQuotation: false,
  }
}

function fix4Budget(over: Partial<ReviewBudget> = {}): ReviewBudget {
  return {
    maxCallsPerRun: 40, maxInputTokensPerRun: 1_000_000, maxOutputTokensPerRun: 1_000_000,
    maxOutputTokensPerCall: 3000, wallMs: 600_000, callTimeoutMs: 1_000, concurrency: 1,
    ...over,
  }
}

/**
 * Fake adapter driven by envelope stage (Fix 4: dispatch counts changed, the
 * stage is read per dispatch). Options inject truncation / other errors per
 * (stage, unit count) and record every dispatch's shape.
 */
function fix4Adapter(
  artifactText: string,
  options: {
    truncate?: (stage: string, unitCount: number) => boolean
    throwOn?: (stage: string, unitCount: number) => Error | undefined
    observed?: { stage: string; unitCount: number }[]
    align?: (envelope: AlignEnvelope) => Record<string, unknown>
    /** Per-chunk check results: overrides the default all-pass target injection. */
    alignTargets?: (envelope: AlignEnvelope) => unknown[]
    /** Extract returns zero items (models the zero-extraction approximation case). */
    emptyExtract?: boolean
  } = {},
): ReviewModelAdapter {
  return {
    async prepareReviewCall(req) {
      const envelope = JSON.parse(req.messages[1]!.content) as Fix4Envelope
      return {
        describe: () => ({ modelId: 'fake', providerId: 'fake', version: 'unpinned', effectiveOptions: {} }),
        dispatch: async () => {
          if (envelope.stage === 'extract') {
            const units = envelope.units ?? []
            options.observed?.push({ stage: 'extract', unitCount: units.length })
            const thrown = options.throwOn?.('extract', units.length)
            if (thrown) throw thrown
            if (options.truncate?.('extract', units.length)) throw new ReviewTruncatedError()
            return {
              raw: JSON.stringify({
                items: options.emptyExtract ? [] : units.map((u) => unitItem(artifactText, u)),
              }),
              inputTokens: 5,
              outputTokens: 7,
            }
          }
          options.observed?.push({ stage: 'align', unitCount: envelope.items.length })
          const thrown = options.throwOn?.('align', envelope.items.length)
          if (thrown) throw thrown
          if (options.truncate?.('align', envelope.items.length)) throw new ReviewTruncatedError()
          const response = options.align?.(envelope) ?? {
            stage: 'align',
            rubricVersion: 'humanities-v1',
            findings: [],
            targets: [],
            alignment: envelope.items.map((entry: { extractedId: string }) => ({
              extractedId: entry.extractedId,
              claimIds: [],
              relation: 'new',
              rationale: 'r',
            })),
          }
          const rules = envelope.requiredRules
          if (options.alignTargets) {
            response.targets = options.alignTargets(envelope) as never
          } else if (rules) {
            response.targets = [...new Set(rules.map((r) => r.targetId))].map((targetId) => ({
              targetId,
              checks: rules
                .filter((r) => r.targetId === targetId)
                .map((r) => ({ ruleId: r.ruleId, result: 'pass', rationale: 'reviewed', evidenceIds: [] })),
            }))
          }
          return { raw: JSON.stringify(response), inputTokens: 6, outputTokens: 8 }
        },
      }
    },
    async countInput() {
      return { tokens: 10, method: 'tokenizer' as const }
    },
    configFingerprint: () => ({ fake: true }),
  }
}

const FIX4_TEXT = (n: number) =>
  Array.from({ length: n }, (_, i) => `Sentence number ${i + 1} stands here.\n`).join('\n')

describe('Fix 4 — estimate/runtime parity and truncation bisect', () => {
  it('§4.5 parity: auditCostModel().calls equals executeAudit dispatches, including the 48k-default path', async () => {
    const snapshot = makeSnapshot({ claims: [makeClaim('fact')] })
    for (const withCaller of [false, true] as const) {
      const observed: { stage: string; unitCount: number }[] = []
      const adapter = fix4Adapter(ARTIFACT, { observed })
      let caller: ReviewCallerType | undefined
      if (withCaller) {
        // Real caller, default 48k context — exercises the caller-dispatch path.
        const budget = fix4Budget()
        caller = new ReviewCaller(adapter, new BudgetTracker(budget), budget, new AbortController().signal, () => {})
      }
      const input = { ...auditInput(ARTIFACT, snapshot, adapter), ...(caller ? { caller } : {}) }
      await executeAudit(input)
      const model = auditCostModel({
        artifactText: ARTIFACT,
        maxUnitChars: auditUnitChars(48_000, caller?.maxContextChars),
        maxContextChars: caller?.maxContextChars ?? 48_000,
        maxOutputTokensPerCall: 3000,
      })
      expect(observed.filter((o) => o.stage === 'extract')).toHaveLength(model.extractBatches)
      expect(observed.filter((o) => o.stage === 'align')).toHaveLength(model.alignBatches)
      expect(observed).toHaveLength(model.calls)
    }
  })

  it('§4.7a: >1-unit truncation bisects — all items returned, new ledger rows, zero retry-pool charge', async () => {
    const snapshot = makeSnapshot({ claims: [makeClaim('fact')] })
    const observed: { stage: string; unitCount: number }[] = []
    const adapter = fix4Adapter(FIX4_TEXT(3), { observed, truncate: (stage, n) => stage === 'extract' && n > 1 })
    const rows: Omit<UsageRow, 'runId'>[] = []
    const budget = fix4Budget()
    const caller = new ReviewCaller(adapter, new BudgetTracker(budget), budget, new AbortController().signal, (row) =>
      rows.push(row),
    )
    const outcome = await executeAudit({ ...auditInput(FIX4_TEXT(3), snapshot, adapter), caller })
    expect(outcome.extractionRecord.response.items).toHaveLength(3)
    // [2 units] truncates → [1],[1] re-queued ahead of [1]; then one align call.
    expect(observed.map((o) => [o.stage, o.unitCount])).toEqual([
      ['extract', 2],
      ['extract', 1],
      ['extract', 1],
      ['extract', 1],
      ['align', 3],
    ])
    // Each dispatch reserves (2 rows per call: reserved + actual); 5 calls.
    expect(rows.filter((row) => row.kind === 'reserved')).toHaveLength(5)
    expect(rows.every((row) => row.retryOf === undefined)).toBe(true)
  })

  it('§4.7b: odd splits and multiple queued batches dispatch in exact work-queue order', async () => {
    const snapshot = makeSnapshot({ claims: [makeClaim('fact')] })
    const observed: { stage: string; unitCount: number }[] = []
    const adapter = fix4Adapter(FIX4_TEXT(5), { observed, truncate: (stage, n) => stage === 'extract' && n > 1 })
    await executeAudit({ ...auditInput(FIX4_TEXT(5), snapshot, adapter), maxOutputTokens: 3000 })
    // Batches [2,2,1]; each truncated batch splits odd-first (ceil) and the
    // halves jump the queue ahead of the untouched later batches.
    expect(observed.filter((o) => o.stage === 'extract').map((o) => o.unitCount)).toEqual([2, 1, 1, 2, 1, 1, 1])
  })

  it('§4.7c: single-unit truncation rethrows REVIEW_TRUNCATED with the root-block guidance', async () => {
    const snapshot = makeSnapshot({ claims: [makeClaim('fact')] })
    const adapter = fix4Adapter(FIX4_TEXT(1), { truncate: () => true })
    const error = await executeAudit(auditInput(FIX4_TEXT(1), snapshot, adapter)).catch((e: unknown) => e)
    expect((error as { code?: string }).code).toBe('REVIEW_TRUNCATED')
    expect((error as Error).message).toContain('split the artifact root block')
  })

  it('§4.7d: a non-truncation error propagates unchanged', async () => {
    const snapshot = makeSnapshot({ claims: [makeClaim('fact')] })
    const adapter = fix4Adapter(FIX4_TEXT(2), { throwOn: () => new Error('boom') })
    await expect(executeAudit(auditInput(FIX4_TEXT(2), snapshot, adapter))).rejects.toThrow('boom')
  })

  it('§4.7e: BUDGET_EXHAUSTED raised by a bisect dispatch surfaces as the run budget failure', async () => {
    const snapshot = makeSnapshot({ claims: [makeClaim('fact')] })
    const adapter = fix4Adapter(FIX4_TEXT(3), { truncate: (stage, n) => stage === 'extract' && n > 1 })
    const budget = fix4Budget({ maxCallsPerRun: 1 }) // first extract call spends it
    const caller = new ReviewCaller(adapter, new BudgetTracker(budget), budget, new AbortController().signal, () => {})
    await expect(
      executeAudit({ ...auditInput(FIX4_TEXT(3), snapshot, adapter), caller }),
    ).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' })
  })

  it('§4.8: 19 derivations at cap 12,000 → 2 align dispatches, merged in order, findings and token sums', async () => {
    const snapshot = makeSnapshot({ claims: [makeClaim('fact')] })
    const claimId = snapshot.claims[0]!.id
    const observed: { stage: string; unitCount: number }[] = []
    const adapter = fix4Adapter(FIX4_TEXT(19), {
      observed,
      align: (envelope) => ({
        stage: 'align',
        rubricVersion: 'humanities-v1',
        findings: [
          {
            id: `finding_${randomUUID()}`,
            code: 'MODEL_X',
            targetIds: [claimId],
            severity: 'major',
            explanation: `chunk of ${envelope.items.length}`,
            evidenceIds: [],
            artifactSpans: [],
            repair: 'add-evidence',
          },
        ],
        targets: [],
        alignment: envelope.items.map((entry: { extractedId: string }) => ({
          extractedId: entry.extractedId,
          claimIds: [claimId],
          relation: 'exact',
          rationale: 'r',
        })),
      }),
    })
    const outcome = await executeAudit({ ...auditInput(FIX4_TEXT(19), snapshot, adapter), maxOutputTokens: 12_000 })
    // 12,000 → 16 align items/batch → chunks [16, 3]; extract 8/batch → [8,8,3].
    expect(observed.filter((o) => o.stage === 'extract').map((o) => o.unitCount)).toEqual([8, 8, 3])
    expect(observed.filter((o) => o.stage === 'align').map((o) => o.unitCount)).toEqual([16, 3])
    const alignment = (outcome.alignRecord.response as { alignment: { extractedId: string }[] }).alignment
    expect(alignment).toHaveLength(19)
    expect(new Set(alignment.map((a) => a.extractedId)).size).toBe(19)
    // Every derivation pairs (order-sensitive): all 19 atomics count as mapped.
    expect(outcome.metrics.mappedAtomicClaims).toBe(19)
    // Chunk findings concatenated, then runtime AUDIT_* findings appended.
    const modelFindings = outcome.findings.filter((f) => f.code === 'MODEL_X')
    expect(modelFindings.map((f) => f.explanation)).toEqual(['chunk of 16', 'chunk of 3'])
    expect(outcome.alignRecord.inputTokens).toBe(12) // 2 × 6
    expect(outcome.alignRecord.outputTokens).toBe(16) // 2 × 8
  })

  it('§4.8: a truncated align chunk bisects into smaller chunks', async () => {
    const snapshot = makeSnapshot({ claims: [makeClaim('fact')] })
    const observed: { stage: string; unitCount: number }[] = []
    const adapter = fix4Adapter(FIX4_TEXT(19), { observed, truncate: (stage, n) => stage === 'align' && n > 8 })
    const outcome = await executeAudit({ ...auditInput(FIX4_TEXT(19), snapshot, adapter), maxOutputTokens: 12_000 })
    // [16] truncates → [8],[8] jump ahead of [3].
    expect(observed.filter((o) => o.stage === 'align').map((o) => o.unitCount)).toEqual([16, 8, 8, 3])
    expect((outcome.alignRecord.response as { alignment: unknown[] }).alignment).toHaveLength(19)
  })
})

describe('Fix 4 review fixes — cross-chunk check merging and cost-model approximation', () => {
  const check = (ruleId: string, result: 'pass' | 'fail' | 'needs-review' | 'not-run', rationale = 'r') => ({
    ruleId,
    result,
    rationale,
    evidenceIds: [] as [],
  })
  const chunkOf = (targets: unknown[], alignment: unknown[] = []): AlignResponse =>
    ({ stage: 'align', rubricVersion: 'humanities-v1', findings: [], targets, alignment }) as unknown as AlignResponse
  const derivations = [{ extractedId: 'e1' }, { extractedId: 'e2' }]
  // Each chunk carries only ITS OWN alignment entries (merged = the union).
  const own = (id: string) => [
    { extractedId: id, claimIds: [], relation: 'new', rationale: 'r' },
  ]

  it('mergeAlignChunks: a later pass does not overwrite an earlier fail (same target, same rule)', () => {
    const merged = mergeAlignChunks(
      [
        chunkOf([{ targetId: 't1', checks: [check('AUDIT-02', 'fail', 'first batch found drift')] }], own('e1')),
        chunkOf([{ targetId: 't1', checks: [check('AUDIT-02', 'pass', 'second batch ok')] }], own('e2')),
      ],
      derivations,
      [],
    )
    const c = merged.targets[0]!.checks.find((x) => x.ruleId === 'AUDIT-02')!
    expect(c.result).toBe('fail')
    expect(c.rationale).toBe('first batch found drift')
  })

  it('mergeAlignChunks: an earlier pass does not survive a later fail (order-independent worst-wins)', () => {
    const merged = mergeAlignChunks(
      [
        chunkOf([{ targetId: 't1', checks: [check('AUDIT-02', 'pass', 'first ok')] }], own('e1')),
        chunkOf([{ targetId: 't1', checks: [check('AUDIT-02', 'fail', 'second found drift')] }], own('e2')),
      ],
      derivations,
      [],
    )
    expect(merged.targets[0]!.checks.find((x) => x.ruleId === 'AUDIT-02')!.result).toBe('fail')
  })

  it('mergeAlignChunks: needs-review beats pass; fail beats needs-review; pass beats not-run; ties keep the first', () => {
    const merged = mergeAlignChunks(
      [
        chunkOf([
          { targetId: 't1', checks: [check('AUDIT-01', 'needs-review', 'first'), check('AUDIT-02', 'pass', 'first')] },
        ], own('e1')),
        chunkOf([
          { targetId: 't1', checks: [check('AUDIT-01', 'pass', 'second'), check('AUDIT-02', 'fail', 'second')] },
        ], own('e2')),
      ],
      derivations,
      [],
    )
    const byRule = new Map(merged.targets[0]!.checks.map((c) => [c.ruleId, c]))
    expect(byRule.get('AUDIT-01')!.result).toBe('needs-review')
    expect(byRule.get('AUDIT-02')!.result).toBe('fail')
    const ties = mergeAlignChunks(
      [
        chunkOf([{ targetId: 't1', checks: [check('AUDIT-01', 'pass', 'first')] }], own('e1')),
        chunkOf([{ targetId: 't1', checks: [check('AUDIT-01', 'pass', 'second')] }], own('e2')),
      ],
      derivations,
      [],
    )
    expect(ties.targets[0]!.checks[0]!.rationale).toBe('first')
    const notRun = mergeAlignChunks(
      [
        chunkOf([{ targetId: 't1', checks: [check('AUDIT-01', 'not-run', 'first')] }], own('e1')),
        chunkOf([{ targetId: 't1', checks: [check('AUDIT-01', 'pass', 'second')] }], own('e2')),
      ],
      derivations,
      [],
    )
    expect(notRun.targets[0]!.checks[0]!.result).toBe('pass')
  })

  it('mergeAlignChunks: rule set unions across chunks (one entry per targetId/ruleId stays valid)', () => {
    const merged = mergeAlignChunks(
      [
        chunkOf([{ targetId: 't1', checks: [check('AUDIT-01', 'pass')] }], own('e1')),
        chunkOf([{ targetId: 't1', checks: [check('AUDIT-02', 'fail'), check('AUDIT-03', 'pass')] }], own('e2')),
      ],
      derivations,
      [],
    )
    expect(merged.targets).toHaveLength(1)
    expect(merged.targets[0]!.checks.map((c) => c.ruleId).sort()).toEqual(['AUDIT-01', 'AUDIT-02', 'AUDIT-03'])
  })

  it('executeAudit: cross-chunk conflict — first chunk fail survives the second chunk pass, findings stay consistent', async () => {
    const snapshot = makeSnapshot({ claims: [makeClaim('fact')] })
    const claimId = snapshot.claims[0]!.id
    const observed: { stage: string; unitCount: number }[] = []
    const adapter = fix4Adapter(FIX4_TEXT(19), {
      observed,
      // The artifact target id comes from the chunk's own requiredRules
      // (auditInput mints one when the snapshot has no artifact).
      alignTargets: (envelope) => {
        const targetId = envelope.requiredRules![0]!.targetId
        return envelope.items.length > 10
          ? [{ targetId, checks: [check('AUDIT-02', 'fail', 'first chunk found drift')] }]
          : [{ targetId, checks: [check('AUDIT-02', 'pass', 'second chunk ok')] }]
      },
      align: (envelope) => ({
        stage: 'align',
        rubricVersion: 'humanities-v1',
        findings: [
          {
            id: `finding_${randomUUID()}`,
            code: 'MODEL_X',
            targetIds: [claimId],
            severity: 'major',
            explanation: `chunk of ${envelope.items.length}`,
            evidenceIds: [],
            artifactSpans: [],
            repair: 'add-evidence',
          },
        ],
        targets: [],
        alignment: envelope.items.map((entry: { extractedId: string }) => ({
          extractedId: entry.extractedId,
          claimIds: [claimId],
          relation: 'exact',
          rationale: 'r',
        })),
      }),
    })
    const outcome = await executeAudit({ ...auditInput(FIX4_TEXT(19), snapshot, adapter), maxOutputTokens: 12_000 })
    // chunks [16, 3]: the [16] chunk failed AUDIT-02, the [3] chunk passed it.
    expect(observed.filter((o) => o.stage === 'align').map((o) => o.unitCount)).toEqual([16, 3])
    const targets = (outcome.alignRecord.response as AlignResponse).targets
    expect(targets).toHaveLength(1)
    expect(targets[0]!.checks.find((c) => c.ruleId === 'AUDIT-02')!.result).toBe('fail')
    // Findings from BOTH chunks survive the merge (checks and findings stay consistent).
    expect(outcome.findings.filter((f) => f.code === 'MODEL_X').map((f) => f.explanation)).toEqual([
      'chunk of 16',
      'chunk of 3',
    ])
  })

  it('cost model approximation: one→many — the runtime chunks by ITEM count, the estimate by UNIT count', async () => {
    // One unit can yield several extracted items (or none): the runtime align
    // chunking keys on derivations, while auditCostModel can only key on
    // extraction units. The estimate is a documented approximation, not a hard
    // feasibility guarantee — under-estimates are covered by the runtime budget
    // guard and the bisect; over-estimates refuse early (conservative).
    const dispatches: number[] = []
    const derivations = Array.from({ length: 7 }, (_, i) => ({
      extractedId: `e${i}`,
      item: { span: { start: 0, end: 1 }, exactText: 'x', atomicClaims: [], isQuotation: false },
      originalSpan: { start: 0, end: 1 },
    }))
    const result = await dispatchAlignChunks({
      dispatch: async (_prompt, env, _schema, parse) => {
        const items = (env as { items: { extractedId: string }[] }).items
        dispatches.push(items.length)
        return {
          raw: parse(
            JSON.stringify({
              stage: 'align',
              rubricVersion: 'humanities-v1',
              findings: [],
              targets: [],
              alignment: items.map((e) => ({ extractedId: e.extractedId, claimIds: [], relation: 'new', rationale: 'r' })),
            }),
          ),
          inputTokens: 1,
          outputTokens: 1,
        }
      },
      alignPrompt: 'p',
      schema: {},
      envelope: { stage: 'align' } as never,
      derivations,
      maxChunkItems: 2,
      claimIds: [],
      withCaller: false,
      taskSpec: {} as never,
    })
    // Item-keyed runtime: 7 items at 2 per chunk → [2, 2, 2, 1].
    expect(dispatches).toEqual([2, 2, 2, 1])
    expect(result.responses).toHaveLength(4)
    // A 1-unit artifact at cap 3,000 estimates ONE align batch — the estimate
    // cannot know the unit produced 7 items (needs 4 chunks). Divergence is
    // the documented approximation, bounded by the runtime budget guard.
    const model = auditCostModel({
      artifactText: 'Single root block.\n',
      maxUnitChars: auditUnitChars(48_000),
      maxContextChars: 48_000,
      maxOutputTokensPerCall: 3_000,
    })
    expect(model.units).toBe(1)
    expect(model.alignBatches).toBe(1)
  })

  it('cost model approximation: zero extraction — the runtime still makes exactly one align dispatch', async () => {
    const snapshot = makeSnapshot({ claims: [makeClaim('fact')] })
    const observed: { stage: string; unitCount: number }[] = []
    const adapter = fix4Adapter(FIX4_TEXT(9), { observed, emptyExtract: true })
    const outcome = await executeAudit({ ...auditInput(FIX4_TEXT(9), snapshot, adapter), maxOutputTokens: 3_000 })
    const model = auditCostModel({
      artifactText: FIX4_TEXT(9),
      maxUnitChars: auditUnitChars(48_000),
      maxContextChars: 48_000,
      maxOutputTokensPerCall: 3_000,
    })
    // 9 units at cap 3,000 estimate 3 align batches (4 items/chunk) while the
    // runtime dispatches the single empty chunk (pre-Fix-4 shape preserved).
    expect(model.alignBatches).toBe(3)
    expect(observed.filter((o) => o.stage === 'align').map((o) => o.unitCount)).toEqual([0])
    expect((outcome.alignRecord.response as { alignment: unknown[] }).alignment).toHaveLength(0)
  })

  it('cost model approximation: the char constraint binds the EXTRACT estimate — extract-side parity holds', () => {
    const model = auditCostModel({
      artifactText: FIX4_TEXT(3),
      maxUnitChars: auditUnitChars(48_000),
      // 0.7 × 250 chars: each stableJson(unit) alone exceeds it → one unit per
      // batch even though maxExtractUnitsPerBatch(3000) = 2 would allow pairs.
      maxContextChars: 250,
      maxOutputTokensPerCall: 3_000,
    })
    // The estimate follows the char bound on the extract side (3 batches, not
    // the count-bound 2) — the same packing the runtime extract loop applies.
    expect(model.extractBatches).toBe(3)
    expect(Math.ceil(3 / 2)).toBe(2) // the count-only bound would under-count
    // The align estimate applies the SAME unit packing (chars + count) and so
    // also follows the char bound (3), while the runtime align chunks by ITEM
    // count only — the documented approximation gap.
    expect(model.alignBatches).toBe(3)
  })
})

// ---- extract scope normalization (design §3.1) ----

describe('executeAudit — extract scope normalization', () => {
  it('empty model scopes are default-filled in the persisted record and the align envelope', async () => {
    const snapshot = makeSnapshot({ claims: [makeClaim('fact')] })
    const base = item('The minutes record only the vote.', ARTIFACT, 'core')
    const emptyScopeItem: ExtractedItem = {
      ...base,
      atomicClaims: [{ ...base.atomicClaims[0]!, scope: {} as ExtractedItem['atomicClaims'][number]['scope'] }],
    }
    let alignScope: ExtractedItem['atomicClaims'][number]['scope'] | undefined
    const adapter = auditAdapter({
      items: [emptyScopeItem],
      align: (envelope) => {
        alignScope = envelope.items[0]?.atomicClaims[0]?.scope
        return {
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
        }
      },
    })
    const outcome = await executeAudit(auditInput(ARTIFACT, snapshot, adapter))
    const expected = {
      subject: 'unspecified',
      corpus: [],
      time: 'unspecified',
      geography: 'unspecified',
      exclusions: [],
    }
    expect(outcome.extractionRecord.response.items[0]!.atomicClaims[0]!.scope).toEqual(expected)
    expect(alignScope).toEqual(expected)
  })
})
