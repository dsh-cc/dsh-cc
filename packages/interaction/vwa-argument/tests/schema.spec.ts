/**
 * Schema-vs-type consistency fixtures (design §5/§6/§16.1/§23 P0): valid and
 * invalid samples for every contract — bad span, bad hash length, unknown
 * extra property (additionalProperties:false), wrong ID prefix, and the
 * per-stage ReviewResponse discriminated union. Plus the §25 explicit
 * UUID/Hash/Span runtime rules.
 */

import { describe, expect, it } from 'vitest'
import {
  isHash,
  isPrefixedId,
  isUuidV4,
  sha256Hex,
  spanError,
  stableJson,
  validateProjectSnapshot,
  validateReceiptV2,
  validateReviewRecord,
  validateReviewResponse,
} from '../src/schema.ts'
import type { ProjectSnapshot, ReviewResponse } from '../src/types.ts'

const NOW = '2026-10-16T00:00:00.000Z'
const U = (prefix: string, n: string): string => `${prefix}_11111111-2222-4333-8444-555555555555`.replace('555555555555', n.padStart(12, 'a'))

function snapshot(): ProjectSnapshot {
  return {
    schemaVersion: 1,
    projectId: U('prj', '000000000001'),
    revision: 1,
    workspaceIdentity: 'a'.repeat(64),
    contract: {
      question: 'Was the 1921 treaty decisive?',
      language: 'en',
      domain: 'history',
      requiredQuestions: [{ id: 'q1', text: 'Which archives were consulted?' }],
      plannedCorpus: ['National Archive, series 3'],
      expectedCoreTopics: ['treaty', 'ratification'],
      mode: 'draft',
    },
    sources: [],
    evidence: [],
    claims: [],
    groups: [],
    arguments: [],
    issues: [],
    searches: [],
    artifacts: [],
  }
}

describe('explicit §25 runtime rules (UUID/Hash/Span)', () => {
  it('checks UUID v4 shape and prefixes', () => {
    expect(isUuidV4('11111111-2222-4333-8444-555555555555')).toBe(true)
    expect(isUuidV4('11111111-2222-3333-8444-555555555555')).toBe(false)
    expect(isPrefixedId('cl_11111111-2222-4333-8444-555555555555', 'cl')).toBe(true)
    expect(isPrefixedId('src_11111111-2222-4333-8444-555555555555', 'cl')).toBe(false)
  })

  it('checks Hash = lowercase 64 hex (§4)', () => {
    expect(isHash('a'.repeat(64))).toBe(true)
    expect(isHash('A'.repeat(64))).toBe(false)
    expect(isHash('a'.repeat(63))).toBe(false)
    expect(stableJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}')
    expect(sha256Hex('x')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('validates spans over UTF-16 code units (§4)', () => {
    expect(spanError({ start: 0, end: 3 }, 'abc')).toBe('')
    expect(spanError({ start: 0, end: 4 }, 'abc')).not.toBe('')
    expect(spanError({ start: 2, end: 1 }, 'abc')).not.toBe('')
    expect(spanError({ start: -1, end: 1 }, 'abc')).not.toBe('')
  })
})

describe('author.schema.json (§5)', () => {
  it('accepts the minimal snapshot with explicitly empty arrays (§4)', () => {
    expect(validateProjectSnapshot(snapshot())).toBe(true)
  })

  it('rejects an unknown extra property (additionalProperties:false)', () => {
    const bad = { ...snapshot(), extraTopLevel: true } as unknown as Record<string, unknown>
    expect(validateProjectSnapshot(bad)).toBe(false)
  })

  it('rejects a wrong project ID prefix', () => {
    const bad = { ...snapshot(), projectId: U('cl', '000000000001') }
    expect(validateProjectSnapshot(bad)).toBe(false)
  })

  it('rejects a hash that is not 64 lowercase hex', () => {
    const bad = { ...snapshot(), workspaceIdentity: 'A'.repeat(64) }
    expect(validateProjectSnapshot(bad)).toBe(false)
    const short = { ...snapshot(), workspaceIdentity: 'a'.repeat(63) }
    expect(validateProjectSnapshot(short)).toBe(false)
  })

  it('rejects a schemaVersion other than 1', () => {
    const bad = { ...snapshot(), schemaVersion: 2 }
    expect(validateProjectSnapshot(bad)).toBe(false)
  })

  it('rejects a claim whose kind is not in the closed enum', () => {
    const snap = snapshot()
    snap.claims = [
      {
        id: U('cl', '000000000002'),
        entityVersion: 1,
        createdAt: NOW,
        updatedAt: NOW,
        text: 'The treaty was ratified in 1921.',
        kind: 'vibes' as never,
        scope: { subject: 'treaty', corpus: [], time: 'unspecified', geography: 'unspecified', exclusions: [] },
        importance: 'core',
        stance: 'asserted',
        evaluationCriteria: [],
      },
    ]
    expect(validateProjectSnapshot(snap)).toBe(false)
  })
})

function sourcesResponse(): ReviewResponse {
  return {
    stage: 'sources',
    rubricVersion: 'humanities-v1',
    findings: [],
    targets: [{ targetId: U('src', '000000000003'), checks: [] }],
  }
}

describe('review.schema.json (§6)', () => {
  it('accepts a valid sources response', () => {
    expect(validateReviewResponse(sourcesResponse())).toBe(true)
  })

  it('rejects a support/adequacy field smuggled onto the sources stage (§11.4 closure)', () => {
    const bad = { ...sourcesResponse(), targets: [{ targetId: U('src', '000000000003'), checks: [], support: 'direct' }] }
    expect(validateReviewResponse(bad)).toBe(false)
  })

  it('rejects an unknown stage in the discriminated union', () => {
    const bad = { ...sourcesResponse(), stage: 'audit' }
    expect(validateReviewResponse(bad)).toBe(false)
  })

  it('rejects a claims target without searchSufficiency', () => {
    const bad = { stage: 'claims', rubricVersion: 'humanities-v1', findings: [], targets: [{ targetId: U('cl', '000000000004'), checks: [] }] }
    expect(validateReviewResponse(bad)).toBe(false)
  })

  it('rejects an arguments target that has both adequacy and issueImpact (§11.4)', () => {
    const bad = {
      stage: 'arguments',
      rubricVersion: 'humanities-v1',
      findings: [],
      targets: [{ targetId: U('arg', '000000000005'), checks: [], adequacy: 'weak', issueImpact: 'qualify', issueResolution: 'accepted' }],
    }
    expect(validateReviewResponse(bad)).toBe(false)
  })

  it('accepts an arguments issue target with issueImpact/issueResolution and no adequacy', () => {
    const ok = {
      stage: 'arguments',
      rubricVersion: 'humanities-v1',
      findings: [],
      targets: [{ targetId: U('iss', '000000000006'), checks: [], issueImpact: 'none', issueResolution: 'unresolved' }],
    }
    expect(validateReviewResponse(ok)).toBe(true)
  })

  it('rejects a ReviewRecord whose runId lacks the run_ prefix', () => {
    const bad = {
      runId: U('rec', '000000000007'),
      stage: 'sources',
      targetRefs: [],
      dependencyDigest: 'b'.repeat(64),
      contractHash: 'b'.repeat(64),
      policyHash: 'b'.repeat(64),
      reviewerConfigHash: 'b'.repeat(64),
      promptHash: 'b'.repeat(64),
      inputHash: 'b'.repeat(64),
      status: 'completed',
      inputTokens: 0,
      outputTokens: 0,
      startedAt: NOW,
      endedAt: NOW,
    }
    expect(validateReviewRecord(bad)).toBe(false)
  })
})

describe('receipt-v2.schema.json (§16.1)', () => {
  const receipt = () => ({
    v: 2,
    receiptId: U('rec', '000000000008'),
    ts: 1_792_000_000_000,
    sessionId: 'sess-1',
    projectId: U('prj', '000000000001'),
    projectRevision: 1,
    artifactId: U('art', '000000000009'),
    artifactPath: 'docs/paper.md',
    artifactHash: 'c'.repeat(64),
    graphHash: 'c'.repeat(64),
    policyHash: 'c'.repeat(64),
    reviewerConfigHash: 'c'.repeat(64),
    claims: [],
    numbers: [],
    gates: [],
    checks: { mechanical: 'pass', evidence: 'not-run', argument: 'not-run', audit: 'not-run' },
    metrics: { mappedAtomicClaims: 0, extractedAtomicClaims: 0, reviewedCoreClaims: 0, coreClaims: 0 },
    reviewRunIds: [],
    findingCounts: { blocker: 0, major: 0, minor: 0 },
    report: { path: 'docs/paper.report.md', hash: 'd'.repeat(64) },
    provenance: { inputs: [], parentHash: '' },
    delivery: 'draft',
    overall: 'abstained',
    nudge: { round: 0 },
  })

  it('accepts a minimal v2 row', () => {
    expect(validateReceiptV2(receipt())).toBe(true)
  })

  it('rejects v:1-style rows and unknown fields', () => {
    expect(validateReceiptV2({ ...receipt(), v: 1 })).toBe(false)
    expect(validateReceiptV2({ ...receipt(), smuggled: true })).toBe(false)
  })

  it('rejects a parentHash that is not up to 64 hex or empty (§16.1)', () => {
    expect(validateReceiptV2({ ...receipt(), provenance: { inputs: [], parentHash: 'zz' } })).toBe(false)
  })
})
