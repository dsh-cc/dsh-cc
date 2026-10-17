import { describe, it, expect } from 'vitest'
import { gradeClaim, digestRecords } from '../src/policy.ts'
import { buildReverseIndex } from '../src/dependencies.ts'
import { makeClaim, makeSource, makeEvidence, makeGroup, makeSnapshot } from './review-helpers.ts'

describe('alternative support paths are graded independently', () => {
  it('an unused unverified alternative does not cap an adequate verified path', () => {
    const claim = makeClaim(),
      good = makeSource(),
      bad = makeSource()
    bad.acquisition.kind = 'unverified'
    const e1 = makeEvidence(good),
      e2 = makeEvidence(bad),
      g1 = makeGroup(claim.id, [e1.id]),
      g2 = makeGroup(claim.id, [e2.id])
    const snapshot = makeSnapshot({ claims: [claim], sources: [good, bad], evidence: [e1, e2], groups: [g1, g2] })
    const digest = digestRecords([])
    digest.groups.set(g1.id, { support: 'direct', adequacy: 'adequate', checks: [] })
    digest.groups.set(g2.id, { support: 'partial', adequacy: 'weak', checks: [] })
    expect(
      gradeClaim(
        { index: buildReverseIndex(snapshot), claims: [claim], digest, executedSearchClaimIds: new Set() },
        claim,
      ).grade,
    ).toBe('B')
  })
  it('source-report may analyze unverified source text without adopting its external claims', () => {
    const claim = makeClaim('source-report'),
      source = makeSource()
    source.acquisition.kind = 'unverified'
    source.origin = 'agent-generated'
    const evidence = makeEvidence(source),
      group = makeGroup(claim.id, [evidence.id])
    const snapshot = makeSnapshot({ claims: [claim], sources: [source], evidence: [evidence], groups: [group] })
    const digest = digestRecords([])
    digest.groups.set(group.id, { support: 'direct', adequacy: 'adequate', checks: [] })
    expect(
      gradeClaim(
        { index: buildReverseIndex(snapshot), claims: [claim], digest, executedSearchClaimIds: new Set() },
        claim,
      ).grade,
    ).toBe('B')
  })
})
