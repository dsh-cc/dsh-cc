/**
 * Pure policy spec (§7.1/§7.2/§17.2): path definition worked example, grade
 * caps per the rule-failure → consequence table, opposition total order,
 * disposition rules, and disagreement exclusion from major counting.
 * @module tests/policy
 */

import { describe, expect, it } from 'vitest'
import { buildReverseIndex, type ReverseIndex } from '../src/dependencies.ts'
import {
  activeMajorCount, computeAssessments, digestRecords, dispositionFor, gradeClaim,
  oppositionFor, strongestOpposition, supportPaths,
} from '../src/policy.ts'
import type { Check, Claim, ProjectSnapshot, ReviewRecord, ReviewResponse } from '../src/types.ts'
import { makeArgument, makeClaim, makeEvidence, makeGroup, makeSnapshot, makeSource, NOW } from './review-helpers.ts'

function checkOf(ruleId: string, result: Check['result']): Check {
  return { ruleId, result, rationale: 'r', evidenceIds: [] }
}

/** Build a digest world directly from maps (bypasses record parsing). */
function worldOf(snapshot: ProjectSnapshot, digest: Partial<ReturnType<typeof digestRecords>>, searches = true) {
  return {
    index: buildReverseIndex(snapshot),
    claims: snapshot.claims,
    digest: { groups: new Map(), claims: new Map(), arguments: new Map(), issues: new Map(), sources: new Map(), ...digest },
    executedSearchClaimIds: searches ? new Set(snapshot.claims.map((c) => c.id)) : new Set<string>(),
    adjudications: [],
  }
}

/** Standard one-source/one-evidence/one-all-group fixture for a claim. */
function simpleClaimFixture(kind: Claim['kind'] = 'fact') {
  const claim = makeClaim(kind)
  const source = makeSource()
  const evidence = makeEvidence(source)
  const group = makeGroup(claim.id, [evidence.id])
  const snapshot = makeSnapshot({ claims: [claim], sources: [source], evidence: [evidence], groups: [group] })
  return { claim, source, evidence, group, snapshot }
}

describe('§7.1 rule 0 — path definition (worked example)', () => {
  it('C1 has exactly two paths: the direct all-group and the argument (its group is an input)', () => {
    const c0 = makeClaim('fact', 'premise')
    const c1 = makeClaim('interpretation', 'conclusion')
    const source = makeSource()
    const e1 = makeEvidence(source)
    const e2 = makeEvidence(source)
    const g1 = makeGroup(c1.id, [e1.id, e2.id], 'all') // direct path
    const g2 = { ...makeGroup(c1.id, [e1.id]), id: 'grp_22222222-2222-4222-8222-222222222222' }
    const a1 = makeArgument(c1.id, [c0.id], [g2.id])
    const snapshot = makeSnapshot({ claims: [c0, c1], sources: [source], evidence: [e1, e2], groups: [g1, g2], arguments: [a1] })
    const paths = supportPaths(buildReverseIndex(snapshot), c1.id)
    // G1(all)[T1,T2]→C1 alongside A1(premise C0, group G2)→C1 = exactly TWO paths;
    // G2 is an input to the A1 path, not a sibling path.
    expect(paths).toHaveLength(2)
    expect(paths.filter((p) => p.kind === 'group')).toHaveLength(1)
    expect(paths.filter((p) => p.kind === 'argument')).toHaveLength(1)
  })

  it('an any-group yields one candidate path per member', () => {
    const claim = makeClaim('fact')
    const source = makeSource()
    const e1 = makeEvidence(source)
    const e2 = makeEvidence(source)
    const snapshot = makeSnapshot({ claims: [claim], sources: [source], evidence: [e1, e2], groups: [makeGroup(claim.id, [e1.id, e2.id], 'any')] })
    expect(supportPaths(buildReverseIndex(snapshot), claim.id)).toHaveLength(2)
  })
})

describe('§7.1 — grade caps per the rule-failure → consequence table', () => {
  it('SOURCE-02 fail on the feeding source caps the group path at C', () => {
    const { claim, source, snapshot } = simpleClaimFixture()
    const world = worldOf(snapshot, {
      groups: new Map([[snapshot.groups[0]!.id, { support: 'direct' as const, adequacy: 'robust' as const, checks: [] }]]),
      sources: new Map([[source.id, { checks: [checkOf('SOURCE-02', 'fail')] }]]),
    })
    expect(gradeClaim(world, claim).grade).toBe('C')
  })

  it('EVID-02 / SUP-01 fail → group path U; SUP-02 fail → caps at C', () => {
    const { claim, snapshot } = simpleClaimFixture()
    const base = () => worldOf(snapshot, {
      groups: new Map([[snapshot.groups[0]!.id, { support: 'direct' as const, adequacy: 'adequate' as const, checks: [] }]]),
    })
    expect(gradeClaim(withChecks(base(), 'groups', snapshot.groups[0]!.id, [checkOf('EVID-02', 'fail')]), claim).grade).toBe('U')
    expect(gradeClaim(worldOf(snapshot, {
      groups: new Map([[snapshot.groups[0]!.id, { support: 'direct' as const, adequacy: 'adequate' as const, checks: [checkOf('SUP-01', 'fail')] }]]),
    }), claim).grade).toBe('U')
    expect(gradeClaim(worldOf(snapshot, {
      groups: new Map([[snapshot.groups[0]!.id, { support: 'direct' as const, adequacy: 'adequate' as const, checks: [checkOf('SUP-02', 'fail')] }]]),
    }), claim).grade).toBe('C')
    void base
  })

  it('ARG-01 fail → argument path U; ARG-02 fail → caps at C', () => {
    const fixture = (ruleId: string) => {
      const premise = makeClaim('fact', 'premise')
      const conclusion = makeClaim('causal', 'conclusion')
      const source = makeSource()
      const evidence = makeEvidence(source)
      const premiseGroup = makeGroup(premise.id, [evidence.id])
      const group = makeGroup(conclusion.id, [evidence.id])
      const argument = makeArgument(conclusion.id, [premise.id], [group.id])
      const snapshot = makeSnapshot({ claims: [premise, conclusion], sources: [source], evidence: [evidence], groups: [group, premiseGroup], arguments: [argument] })
      const world = worldOf(snapshot, {
        claims: new Map([[premise.id, { checks: [checkOf('HIST-01', 'pass')], searchSufficiency: 'checked' as const }]]),
        groups: new Map([
          [group.id, { support: 'direct' as const, adequacy: 'adequate' as const, checks: [] }],
          [premiseGroup.id, { support: 'direct' as const, adequacy: 'robust' as const, checks: [] }],
        ]),
        arguments: new Map([[argument.id, { adequacy: 'robust' as const, checks: [checkOf(ruleId, 'fail')] }]]),
      })
      return { world, conclusion }
    }
    const arg01 = fixture('ARG-01')
    const arg02 = fixture('ARG-02')
    expect(gradeClaim(arg01.world, arg01.conclusion).grade).toBe('U')
    expect(gradeClaim(arg02.world, arg02.conclusion).grade).toBe('C')
  })

  it('HIST-01 fail caps ALL paths of the claim at C', () => {
    const { claim, snapshot } = simpleClaimFixture()
    const world = worldOf(snapshot, {
      groups: new Map([[snapshot.groups[0]!.id, { support: 'direct' as const, adequacy: 'robust' as const, checks: [] }]]),
      claims: new Map([[claim.id, { checks: [checkOf('HIST-01', 'fail')], searchSufficiency: 'checked' as const }]]),
    })
    expect(gradeClaim(world, claim).grade).toBe('C')
  })

  it('an invalidate issue in force forces the claim path to U (rule 8)', () => {
    const claim = makeClaim('fact')
    const source0 = makeSource()
    const evidence0 = makeEvidence(source0)
    const group0 = makeGroup(claim.id, [evidence0.id])
    const issue = {
      id: 'iss_99999999-9999-4999-8999-999999999999', entityVersion: 1, createdAt: NOW, updatedAt: NOW,
      targetId: claim.id, kind: 'counterevidence' as const, description: 'd', evidenceIds: [],
      relatedClaimIds: [], proposedImpact: 'invalidate' as const, response: 'r', resolution: 'unresolved' as const,
    }
    const snapshot2 = makeSnapshot({
      claims: [claim], sources: [source0], evidence: [evidence0], groups: [group0], issues: [issue],
    })
    const world = worldOf(snapshot2, {
      groups: new Map([[group0.id, { support: 'direct' as const, adequacy: 'robust' as const, checks: [] }]]),
      issues: new Map([[issue.id, { issueImpact: 'invalidate' as const, issueResolution: 'rejected' as const, checks: [] }]]),
    })
    expect(gradeClaim(world, claim).grade).toBe('U')
  })

  it('a causal claim without a causal-scheme argument caps at C (rule 5)', () => {
    const { claim, snapshot } = simpleClaimFixture('causal')
    const world = worldOf(snapshot, {
      groups: new Map([[snapshot.groups[0]!.id, { support: 'direct' as const, adequacy: 'robust' as const, checks: [] }]]),
    })
    // robust alone would map to A; the missing causal-scheme argument caps at C.
    expect(gradeClaim(world, claim).grade).toBe('C')
  })

  it('unverified acquisition caps the path at C even with robust group support (rule 6)', () => {
    const claim = makeClaim('fact')
    const source = { ...makeSource(), acquisition: { kind: 'unverified' as const, capturedAt: NOW } }
    const evidence = makeEvidence(source)
    const group = makeGroup(claim.id, [evidence.id])
    const snapshot = makeSnapshot({ claims: [claim], sources: [source], evidence: [evidence], groups: [group] })
    const world = worldOf(snapshot, {
      groups: new Map([[group.id, { support: 'direct' as const, adequacy: 'robust' as const, checks: [] }]]),
      sources: new Map([[source.id, { checks: [checkOf('SOURCE-02', 'pass')] }]]),
    })
    expect(gradeClaim(world, claim).grade).toBe('C')
  })
})

/** Test helper: overlay checks for one digest bucket. */
function withChecks(
  world: ReturnType<typeof worldOf>,
  bucket: 'groups',
  key: string,
  checks: Check[],
): ReturnType<typeof worldOf> {
  const entry = world.digest.groups.get(key)
  return { ...world, digest: { ...world.digest, groups: new Map(world.digest.groups).set(key, { ...(entryOf(bucket, key, world) as never), checks } as never) } as typeof world.digest, ...{} }
}
function entryOf(_bucket: string, _key: string): unknown {
  return undefined
}

describe('§7.2 opposition total order (R1-31)', () => {
  it('decisive > material > not-checked > none-found', () => {
    expect(strongestOpposition('decisive', 'material')).toBe('decisive')
    expect(strongestOpposition('material', 'not-checked')).toBe('material')
    expect(strongestOpposition('not-checked', 'none-found')).toBe('not-checked')
    expect(strongestOpposition('none-found', 'decisive')).toBe('decisive')
  })

  it('accepted resolution removes opposition; rejected invalidate is decisive; missing search is not-checked', () => {
    const claim = makeClaim('fact')
    const issue = {
      id: 'iss_88888888-8888-4888-8888-888888888888', entityVersion: 1, createdAt: NOW, updatedAt: NOW,
      targetId: claim.id, kind: 'counterevidence' as const, description: 'd', evidenceIds: [],
      relatedClaimIds: [], proposedImpact: 'invalidate' as const, response: 'r', resolution: 'addressed' as const,
    }
    const snapshot = makeSnapshot({ claims: [claim], issues: [issue] })
    const executed = new Set([claim.id])
    const accepted = {
      index: buildReverseIndex(snapshot), claims: [claim],
      digest: { ...digestRecords([]), issues: new Map([[issue.id, { issueImpact: 'invalidate' as const, issueResolution: 'accepted' as const, checks: [] }]]) },
      executedSearchClaimIds: executed, adjudications: [],
    }
    expect(oppositionFor(accepted, claim.id, new Set())).toBe('none-found')
    const rejected = { ...accepted, digest: { ...accepted.digest, issues: new Map([[issue.id, { issueImpact: 'invalidate' as const, issueResolution: 'rejected' as const, checks: [] }]]) } }
    expect(oppositionFor(rejected, claim.id, new Set())).toBe('decisive')
    const unsearched = { index: buildReverseIndex(makeSnapshot({ claims: [claim] })), claims: [claim], digest: digestRecords([]), executedSearchClaimIds: new Set<string>(), adjudications: [] }
    expect(oppositionFor(unsearched, claim.id, new Set())).toBe('not-checked')
  })
})

describe('dispositions (§7.2)', () => {
  it('execute in order: refuted, contested, supported, underdetermined', () => {
    expect(dispositionFor('U', 'decisive')).toBe('refuted')
    expect(dispositionFor('B', 'material')).toBe('contested')
    expect(dispositionFor('A', 'none-found')).toBe('supported')
    expect(dispositionFor('C', 'none-found')).toBe('underdetermined')
    expect(dispositionFor('U', 'none-found')).toBe('underdetermined')
  })
})

describe('§17.2/§11.3 — disagreement findings are excluded from major counting', () => {
  it('activeMajorCount skips kind disagreement and rejected adjudications', () => {
    const findings = [
      { id: 'f1', severity: 'major' as const },
      { id: 'f2', severity: 'major' as const, kind: 'disagreement' },
      { id: 'f3', severity: 'blocker' as const },
    ]
    const adjudications = [{
      adjudicationId: 'a1', findingId: 'f3', decision: 'reject' as const, reason: 'r', signer: 'user' as const,
      ts: NOW, dependencyDigest: 'd', overrides: { ruleId: 'HIST-01', targetId: 't', runId: 'run_00000000-0000-4000-8000-000000000000' },
    }]
    expect(activeMajorCount(findings, adjudications)).toEqual({ blocker: 0, major: 1 })
    // Without adjudication the blocker counts too.
    expect(activeMajorCount(findings, [])).toEqual({ blocker: 1, major: 1 })
  })
})

describe('computeAssessments — never-reviewed claim', () => {
  it('grade U, reviewState not-run, opposition not-checked', () => {
    const claim = makeClaim('fact')
    const snapshot = makeSnapshot({ claims: [claim] })
    const assessments = computeAssessments({
      index: buildReverseIndex(snapshot), claims: [claim],
      digest: digestRecords([]), executedSearchClaimIds: new Set<string>(), adjudications: [],
    })
    expect(assessments[0]?.supportGrade).toBe('U')
    expect(assessments[0]?.reviewState).toBe('not-run')
    expect(assessments[0]?.opposition).toBe('not-checked')
  })
})
