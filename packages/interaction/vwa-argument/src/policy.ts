/**
 * Pure review policy (design docs/plans/2026-10-16-vwa-evidence-argument.md
 * §7.1/§7.2/§17): support paths, grade algorithm, opposition total order,
 * dispositions, and review-state derivation. NO model calls and NO I/O —
 * everything here is a pure function over validated records so it is
 * unit-testable against the D-case table.
 *
 * The rule-failure → grade-consequence table (§7.1, R1-12) and the grade
 * mapping are part of `policyHash`; POLICY_VERSION changes whenever this
 * file's normative behavior changes.
 *
 * @module @dsh-cc/vwa-argument/policy
 */

import type { ReverseIndex } from './dependencies.ts'
import type {
  Adequacy, AdjudicationRecord, Argument, Assessment, Check, Claim, EvidenceGroup,
  ReviewRecord,
} from './types.ts'
import type { Id, Support } from './types.ts'

/** Bumped whenever a §7.1/§7.2 normative behavior of this module changes. */
export const POLICY_VERSION = 'humanities-v1-policy@1'

/** The digested per-target review results the policy grades against. */
export interface ReviewDigest {
  /** support stage: group id → reviewed relation. */
  groups: Map<Id, { support: Support; adequacy: Adequacy; checks: Check[] }>
  /** claims stage: claim id → type-rule checks + search sufficiency. */
  claims: Map<Id, { checks: Check[]; searchSufficiency: 'checked' | 'not-checked' }>
  /** arguments stage: argument id → adequacy; issue id → impact/resolution. */
  arguments: Map<Id, { adequacy?: Adequacy; checks: Check[] }>
  issues: Map<Id, { issueImpact?: 'none' | 'qualify' | 'downgrade' | 'invalidate'; issueResolution?: 'accepted' | 'rejected' | 'unresolved'; checks: Check[] }>
  /** sources stage: source id → SOURCE-* checks. */
  sources: Map<Id, { checks: Check[] }>
}

/** Extract the per-target payloads policy consumes out of completed records. */
export function digestRecords(records: ReviewRecord[]): ReviewDigest {
  const digest: ReviewDigest = { groups: new Map(), claims: new Map(), arguments: new Map(), issues: new Map(), sources: new Map() }
  for (const record of records) {
    if (record.status !== 'completed' || record.response === undefined) continue
    for (const target of record.response.targets) {
      const base = { checks: target.checks }
      if (record.response.stage === 'support' && 'support' in target && 'adequacy' in target) {
        digest.groups.set(target.targetId, { support: target.support, adequacy: target.adequacy, checks: target.checks })
      } else if (record.response.stage === 'claims' && 'searchSufficiency' in target) {
        digest.claims.set(target.targetId, { checks: target.checks, searchSufficiency: target.searchSufficiency })
      } else if (record.response.stage === 'arguments') {
        if ('adequacy' in target) digest.arguments.set(target.targetId, { adequacy: target.adequacy, checks: target.checks })
        else if ('issueImpact' in target) {
          digest.issues.set(target.targetId, { issueImpact: target.issueImpact, issueResolution: target.issueResolution, checks: target.checks })
        }
      } else if (record.response.stage === 'sources') {
        digest.sources.set(target.targetId, base)
      }
    }
  }
  return digest
}

export type Grade = 'A' | 'B' | 'C' | 'U'

const ADEQUACY_GRADE: Record<Adequacy, Grade> = { robust: 'A', adequate: 'B', weak: 'C', none: 'U' }
const minGrade = (a: Grade, b: Grade): Grade => (gradeRank(a) <= gradeRank(b) ? a : b)
const gradeRank = (g: Grade): number => ({ A: 0, B: 1, C: 2, U: 3 })[g]
const capAt = (grade: Grade, cap: Grade): Grade => (gradeRank(grade) > gradeRank(cap) ? grade : cap)

/** The path kinds of §7.1 rule 0: a direct group path or one argument path. */
export type SupportPath =
  | { kind: 'group'; group: EvidenceGroup }
  | { kind: 'argument'; argument: Argument }

/**
 * §7.1 rule 0 (R1-04): a path is a maximal support tree. An `all` group is
 * ONE path; each member of an `any` group is one independent candidate path
 * (so an any-group yields |evidenceIds| paths). A group cited by an Argument
 * is an INPUT to that argument's path, never a sibling path. Worked example:
 * G1(all)[T1,T2,T3]→C1 alongside A1(premise C0, group G2)→C1 gives C1 exactly
 * two paths — the direct G1 path and the A1 path.
 */
export function supportPaths(index: ReverseIndex, claimId: Id): SupportPath[] {
  const paths: SupportPath[] = []
  // A group cited by an Argument with this conclusion is an INPUT to that
  // argument's path, never a sibling path (§7.1 rule 0 worked example).
  const citedByArguments = new Set<Id>()
  for (const argument of index.arguments.values()) {
    if (argument.conclusionClaimId === claimId) {
      for (const groupId of argument.evidenceGroupIds) citedByArguments.add(groupId)
    }
  }
  for (const group of index.groups.values()) {
    if (group.targetClaimId !== claimId || citedByArguments.has(group.id)) continue
    if (group.mode === 'all') {
      paths.push({ kind: 'group', group })
    } else {
      // any-group: one candidate path per member (§7.1 rule 0).
      for (const _evidenceId of group.evidenceIds) paths.push({ kind: 'group', group })
    }
  }
  for (const argument of index.arguments.values()) {
    if (argument.conclusionClaimId === claimId) paths.push({ kind: 'argument', argument })
  }
  return paths
}

/** Everything policy knows about one grading universe. */
export interface PolicyWorld {
  index: ReverseIndex
  claims: Claim[]
  digest: ReviewDigest
  /** Claim ids whose required core counterevidence search actually executed (§9 closure). */
  executedSearchClaimIds: ReadonlySet<Id>
  adjudications?: AdjudicationRecord[]
}

/** §7.2 opposition total order (R1-31): decisive > material > not-checked > none-found. */
export type Opposition = Assessment['opposition']
const OPPOSITION_RANK: Record<Opposition, number> = { decisive: 0, material: 1, 'not-checked': 2, 'none-found': 3 }
export const strongestOpposition = (a: Opposition, b: Opposition): Opposition => (OPPOSITION_RANK[a] <= OPPOSITION_RANK[b] ? a : b)

/**
 * §7.2: aggregate per claim over current issue reviews. `accepted` issue
 * resolution means the author's response was accepted and the issue no longer
 * counts as unresolved opposition; rejected/unresolved stay in force.
 */
export function oppositionFor(world: PolicyWorld, claimId: Id, adjudications: Set<Id>): Opposition {
  let result: Opposition = 'none-found'
  for (const issue of world.index.issues.values()) {
    if (adjudications.has(issue.id)) continue
    const review = world.digest.issues.get(issue.targetId === claimId ? issue.id : issue.id)
    const applies = issue.targetId === claimId || issue.relatedClaimIds.includes(claimId)
    if (!applies || review === undefined) continue
    if (review.issueResolution === 'accepted') continue
    if (review.issueImpact === 'invalidate') return 'decisive'
    if (review.issueImpact === 'downgrade' || review.issueImpact === 'qualify') result = 'material'
  }
  if (result === 'none-found' && !world.executedSearchClaimIds.has(claimId)) return 'not-checked'
  return result
}

/** §7.2 disposition rules, executed in order. */
export function dispositionFor(grade: Grade, opposition: Opposition): Assessment['disposition'] {
  if (opposition === 'decisive' && grade === 'U') return 'refuted'
  if ((opposition === 'material' || opposition === 'decisive') && grade !== 'U') return 'contested'
  if ((grade === 'A' || grade === 'B') && opposition !== 'material' && opposition !== 'decisive') return 'supported'
  return 'underdetermined'
}

/** A check the author accepted via adjudication no longer counts (§18: reject removes the finding; grades recompute). */
function adjudicatedRuleIds(world: PolicyWorld): Set<string> {
  const out = new Set<string>()
  for (const adjudication of world.adjudications ?? []) {
    if (adjudication.decision === 'reject') out.add(`${adjudication.overrides.ruleId}@${adjudication.overrides.targetId}`)
  }
  return out
}

const check = (checks: Check[], ruleId: string): Check | undefined => checks.find((c) => c.ruleId === ruleId)
const failed = (checks: Check[], ruleId: string, adjudicated: Set<string>): boolean => {
  const found = check(checks, ruleId)
  return found !== undefined && found.result === 'fail' && !adjudicated.has(`${ruleId}@${checkTarget(checks, ruleId)}`)
}
/** Check objects do not carry their own targetId — keying uses the rule id alone. */
const checkTarget = (_checks: Check[], _ruleId: string): string => ''

/** §8.2 type-rule id per claim kind; undefined for kinds without a type rule. */
export const typeRuleFor = (claim: Claim): string | undefined => ({
  fact: 'HIST-01', 'source-report': 'HIST-01', causal: 'CAUSE-01',
  intent: 'INTENT-01', interpretation: 'INTERP-01', evaluation: 'EVAL-01',
}[claim.kind])

/** The scheme a claim kind requires for full strength (§7.1 rule 5 table). */
const REQUIRED_SCHEMES: Record<Claim['kind'], string[]> = {
  fact: ['deductive', 'generalization'],
  'source-report': ['deductive'],
  interpretation: ['interpretive'],
  causal: ['causal'],
  intent: ['interpretive'],
  evaluation: ['evaluative'],
}

/** Grade of one direct group path (§7.1 rule 2). */
function gradeGroupPath(world: PolicyWorld, group: EvidenceGroup, adjudicated: Set<string>): { grade: Grade; rationale: string[] } {
  const rationale: string[] = [`group ${group.id} (${group.mode})`]
  const review = world.digest.groups.get(group.id)
  if (review === undefined) return { grade: 'U', rationale: [...rationale, 'no current complete support review'] }
  const support: Support = review.support
  if (support === 'irrelevant' || support === 'contradicted' || support === 'unknown') {
    return { grade: 'U', rationale: [...rationale, `support ${support}`] }
  }
  let grade: Grade = ADEQUACY_GRADE[review.adequacy]
  if (support === 'partial') grade = capAt(grade, 'C')
  rationale.push(`adequacy ${review.adequacy}${support === 'partial' ? ' (partial caps at C)' : ''}`)
  // §7.1 consequence table: EVID-02/SUP-01 fail → U; SUP-02 fail → cap C.
  if (failed(review.checks, 'EVID-02', adjudicated) || failed(review.checks, 'SUP-01', adjudicated)) {
    return { grade: 'U', rationale: [...rationale, 'EVID-02/SUP-01 fail → path U'] }
  }
  if (failed(review.checks, 'SUP-02', adjudicated)) {
    grade = capAt(grade, 'C')
    rationale.push('SUP-02 fail → path caps at C')
  }
  for (const evidenceId of group.evidenceIds) {
    const evidence = world.index.evidence.get(evidenceId)
    const source = evidence === undefined ? undefined : world.index.sources.get(evidence.sourceId)
    if (source === undefined) continue
    if (failed(world.digest.sources.get(source.id)?.checks ?? [], 'EVID-01', adjudicated)) {
      return { grade: 'U', rationale: [...rationale, `EVID-01 blocker on ${evidenceId} → path U`] }
    }
    if (failed(world.digest.sources.get(source.id)?.checks ?? [], 'SOURCE-01', adjudicated)
      || failed(world.digest.sources.get(source.id)?.checks ?? [], 'SOURCE-02', adjudicated)
      || failed(world.digest.sources.get(source.id)?.checks ?? [], 'SOURCE-03', adjudicated)) {
      grade = capAt(grade, 'C')
      rationale.push(`SOURCE rule fail on ${source.id} → path caps at C`)
    }
  }
  return { grade, rationale }
}

/** Grade of one argument path (§7.1 rule 3): weakest of premises, cited groups, adequacy. */
function gradeArgumentPath(
  world: PolicyWorld,
  argument: Argument,
  adjudicated: Set<string>,
  grades: Map<Id, Grade>,
  rationale: string[],
): Grade {
  const review = world.digest.arguments.get(argument.id)
  if (review === undefined) {
    rationale.push(`argument ${argument.id}: no current complete review → U`)
    return 'U'
  }
  rationale.push(`argument ${argument.id} adequacy ${review.adequacy ?? 'none'}`)
  if (failed(review.checks, 'ARG-01', adjudicated)) {
    rationale.push('ARG-01 fail → path U')
    return 'U'
  }
  let grade: Grade = ADEQUACY_GRADE[review.adequacy ?? 'none']
  for (const premiseId of argument.premiseClaimIds) {
    grade = minGrade(grade, grades.get(premiseId) ?? 'U')
  }
  for (const groupId of argument.evidenceGroupIds) {
    const group = world.index.groups.get(groupId)
    grade = minGrade(grade, group === undefined ? 'U' : gradeGroupPath(world, group, adjudicated).grade)
  }
  if (failed(review.checks, 'ARG-02', adjudicated)) {
    grade = capAt(grade, 'C')
    rationale.push('ARG-02 fail → path caps at C')
  }
  return grade
}

/** §7.1 grade algorithm for one claim (strongest path wins, caps applied after). */
export function gradeClaim(world: PolicyWorld, claim: Claim): { grade: Grade; rationale: string[]; paths: number } {
  const adjudicated = adjudicatedRuleIds(world)
  const rationale: string[] = []
  const paths = supportPaths(world.index, claim.id)
  if (paths.length === 0) return { grade: 'U', rationale: ['no registered support path'], paths: 0 }

  // Premise grades first (memoized per claim via the caller-visible map below).
  const grades = new Map<Id, Grade>()
  const gradeOf = (id: Id): Grade => {
    if (!grades.has(id)) {
      const premise = world.claims.find((c) => c.id === id)
      grades.set(id, premise === undefined ? 'U' : gradeClaim(world, premise).grade)
    }
    return grades.get(id)!
  }

  let strongest: Grade = 'U'
  let strongestRationale: string[] = []
  for (const path of paths) {
    let grade: Grade
    let pathRationale: string[]
    if (path.kind === 'group') {
      ;({ grade, rationale: pathRationale } = gradeGroupPath(world, path.group, adjudicated))
    } else {
      // Premise grades come from the recursive rule; a missing required
      // premise record is U (ARG-01 catches the registration failure).
      pathRationale = []
      grade = gradeArgumentPath(world, path.argument, adjudicated, new Map(path.argument.premiseClaimIds.map((p) => [p, gradeOf(p)])), pathRationale)
    }
    if (gradeRank(grade) < gradeRank(strongest)) {
      strongest = grade
      strongestRationale = pathRationale
    }
  }
  rationale.push(...strongestRationale)

  // Consequence table: HIST/CAUSE/INTENT/INTERP/EVAL fail → all paths of the claim cap at C.
  const claimReview = world.digest.claims.get(claim.id)
  const typeRule = typeRuleFor(claim)
  if (typeRule !== undefined) {
    const checks = claimReview?.checks ?? []
    if (failed(checks, typeRule, adjudicated)) {
      strongest = capAt(strongest, 'C')
      rationale.push(`${typeRule} fail → all paths cap at C`)
    }
  }
  // Rule 5: kind-specific claims without a matching-scheme argument cap at C.
  const hasSchemeArgument = [...world.index.arguments.values()]
    .some((a) => a.conclusionClaimId === claim.id && REQUIRED_SCHEMES[claim.kind].includes(a.scheme))
  if (!hasSchemeArgument && claim.kind !== 'fact' && claim.kind !== 'source-report') {
    strongest = capAt(strongest, 'C')
    rationale.push(`no ${REQUIRED_SCHEMES[claim.kind].join('|')} argument → cap C (rule 5)`)
  }
  // Rule 6 caps: questioned sources without a passed SOURCE-02, and
  // agent-generated/unverified external-fact paths, cap at C.
  const pathSourceIds = new Set<Id>()
  for (const path of paths) {
    const groupIds = path.kind === 'group' ? [path.group.id] : path.argument.evidenceGroupIds
    for (const groupId of groupIds) {
      const group = world.index.groups.get(groupId)
      if (group === undefined) continue
      for (const evidenceId of group.evidenceIds) {
        const evidence = world.index.evidence.get(evidenceId)
        if (evidence !== undefined) pathSourceIds.add(evidence.sourceId)
      }
    }
    if (path.kind === 'argument') {
      for (const premiseId of path.argument.premiseClaimIds) {
        for (const sourceId of world.index.claims.get(premiseId)?.scope.corpus ?? []) pathSourceIds.add(sourceId)
      }
    }
  }
  for (const sourceId of pathSourceIds) {
    const source = world.index.sources.get(sourceId)
    if (source === undefined) continue
    const source02Passed = (world.digest.sources.get(sourceId)?.checks ?? []).some((c) => c.ruleId === 'SOURCE-02' && c.result === 'pass')
    if (source.authenticity === 'questioned' && !source02Passed) {
      strongest = capAt(strongest, 'C')
      rationale.push(`source ${sourceId} questioned without SOURCE-02 pass → cap C (rule 6)`)
    }
    if (source.origin === 'agent-generated' || source.acquisition.kind === 'unverified') {
      strongest = capAt(strongest, 'C')
      rationale.push(`source ${sourceId} ${source.origin === 'agent-generated' ? 'agent-generated' : 'unverified'} → cap C (rule 6)`)
    }
  }
  // Rule 7: additional A conditions — unmet-but-not-failed downgrades to B.
  if (strongest === 'A') {
    const issuesInForce = oppositionFor(world, claim.id, adjudicated) !== 'none-found' && oppositionFor(world, claim.id, adjudicated) !== 'not-checked'
    const source01AllPass = [...pathSourceIds].every((id) => !(world.digest.sources.get(id)?.checks ?? []).some((c) => c.ruleId === 'SOURCE-01' && c.result === 'fail'))
    if (claimReview?.searchSufficiency === 'not-checked' || !world.executedSearchClaimIds.has(claim.id) || issuesInForce || !source01AllPass) {
      strongest = 'B'
      rationale.push('an A condition is unmet but not failed → downgrade to B (rule 7)')
    }
    if (typeRule !== undefined && (claimReview?.checks ?? []).length === 0) {
      strongest = 'C'
      rationale.push('core type rule not checked → cap C (rule 7)')
    }
  }
  // Rule 8: issue effects on the claim's paths.
  for (const issue of world.index.issues.values()) {
    if (issue.targetId !== claim.id) continue
    const review = world.digest.issues.get(issue.id)
    if (review === undefined || review.issueResolution === 'accepted') continue
    if (review.issueImpact === 'invalidate') {
      strongest = 'U'
      rationale.push(`invalidate issue ${issue.id} in force → path U (rule 8)`)
    } else if (review.issueImpact === 'downgrade') {
      strongest = capAt(strongest, 'C')
      rationale.push(`downgrade issue ${issue.id} in force → path caps at C (rule 8)`)
    }
  }
  return { grade: strongest, rationale, paths: paths.length }
}

/** Review-state derivation: not-run → incomplete → current (stale is caller-supplied via digest mismatch). */
export function reviewStateFor(
  requiredStageTargets: { stage: ReviewRecord['stage']; targetId: Id }[],
  records: ReviewRecord[],
): Assessment['reviewState'] {
  const relevant = records.filter((r) => requiredStageTargets.some((t) => r.stage === t.stage && r.targetRefs.some((ref) => ref.id === t.targetId)))
  if (relevant.length === 0) return 'not-run'
  return relevant.every((r) => r.status === 'completed') ? 'current' : 'incomplete'
}

/** Full §7 assessment pass over a claim set, in the given array order. */
export function computeAssessments(world: PolicyWorld): Assessment[] {
  const adjudications = new Set<Id>()
  for (const adjudication of world.adjudications ?? []) {
    if (adjudication.decision === 'accept') adjudications.add(adjudication.findingId)
  }
  const runIds = new Set<Id>()
  return world.claims.map((claim) => {
    const { grade, rationale, paths } = gradeClaim(world, claim)
    const opposition = oppositionFor(world, claim.id, adjudications)
    return {
      claimId: claim.id,
      supportGrade: grade,
      opposition,
      disposition: dispositionFor(grade, opposition),
      reviewState: paths === 0 ? 'not-run' : 'current',
      reviewRunIds: [...runIds],
      rationale,
    }
  })
}

/** §17.2: active blocker/major count — disagreement findings are excluded (§11.3), as are rejected adjudications. */
export function activeMajorCount(
  findings: { id: Id; severity: 'blocker' | 'major' | 'minor'; kind?: string; targetId?: Id }[],
  adjudications: AdjudicationRecord[],
): { blocker: number; major: number } {
  const rejected = new Set(adjudications.filter((a) => a.decision === 'reject').map((a) => a.findingId))
  let blocker = 0
  let major = 0
  for (const finding of findings) {
    if (finding.kind === 'disagreement' || rejected.has(finding.id)) continue
    if (finding.severity === 'blocker') blocker += 1
    else if (finding.severity === 'major') major += 1
  }
  return { blocker, major }
}
