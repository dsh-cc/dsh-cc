/** Conservative aggregation of every valid judgment over identical inputs. */
import type { ReviewDigest } from './policy.ts'
import type { Adequacy, Check, ReviewRecord, Support } from './types.ts'
const resultRank = { fail: 0, 'needs-review': 1, 'not-run': 2, pass: 3 }
function mergeChecks(a: Check[] | undefined, b: Check[]): Check[] {
  const map = new Map((a ?? []).map((c) => [c.ruleId, c]))
  for (const check of b) {
    const prior = map.get(check.ruleId)
    if (!prior || resultRank[check.result] < resultRank[prior.result]) map.set(check.ruleId, check)
  }
  return [...map.values()]
}
const adequacyRank: Record<Adequacy, number> = { robust: 0, adequate: 1, weak: 2, none: 3 }
function weakest(a: Adequacy | undefined, b: Adequacy): Adequacy {
  return a && adequacyRank[a] > adequacyRank[b] ? a : b
}
const supportRank: Record<Support, number> = {
  direct: 0,
  inferential: 0,
  partial: 1,
  unknown: 2,
  irrelevant: 3,
  contradicted: 3,
}
function conservative(a: Support | undefined, b: Support): Support {
  return a && supportRank[a] > supportRank[b] ? a : b
}
export function digestRecords(records: ReviewRecord[]): ReviewDigest {
  const digest: ReviewDigest = {
    groups: new Map(),
    claims: new Map(),
    arguments: new Map(),
    issues: new Map(),
    sources: new Map(),
  }
  for (const record of records) {
    if (record.stage === 'extract' || record.status !== 'completed' || !record.response) continue
    for (const target of record.response.targets) {
      const id = target.targetId
      if (record.response.stage === 'support' && 'support' in target) {
        const prior = digest.groups.get(id)
        digest.groups.set(id, {
          support: conservative(prior?.support, target.support),
          adequacy: weakest(prior?.adequacy, target.adequacy),
          checks: mergeChecks(prior?.checks, target.checks),
          evidenceRelations: target.evidenceRelations,
        })
      } else if (record.response.stage === 'claims' && 'searchSufficiency' in target) {
        const prior = digest.claims.get(id)
        digest.claims.set(id, {
          checks: mergeChecks(prior?.checks, target.checks),
          searchSufficiency: prior?.searchSufficiency === 'not-checked' ? 'not-checked' : target.searchSufficiency,
        })
      } else if (record.response.stage === 'arguments' && 'adequacy' in target) {
        const prior = digest.arguments.get(id)
        digest.arguments.set(id, {
          adequacy: weakest(prior?.adequacy, target.adequacy),
          checks: mergeChecks(prior?.checks, target.checks),
        })
      } else if (record.response.stage === 'arguments' && 'issueImpact' in target) {
        const prior = digest.issues.get(id),
          rank = { none: 0, qualify: 1, downgrade: 2, invalidate: 3 }
        digest.issues.set(id, {
          issueImpact:
            prior?.issueImpact && rank[prior.issueImpact] > rank[target.issueImpact]
              ? prior.issueImpact
              : target.issueImpact,
          issueResolution:
            prior?.issueResolution && prior.issueResolution !== 'accepted'
              ? prior.issueResolution
              : target.issueResolution,
          checks: mergeChecks(prior?.checks, target.checks),
        })
      } else if (record.response.stage === 'sources')
        digest.sources.set(id, { checks: mergeChecks(digest.sources.get(id)?.checks, target.checks) })
    }
  }
  return digest
}
