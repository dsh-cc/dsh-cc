/** Current-input delivery evaluation. No semantic model dispatch and no receipt writes. */
import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import { runGates } from '@dsh-cc/vwa-evidence'
import { buildReverseIndex, dependencyEntries } from './dependencies.ts'
import { sha256Hex, stableJson } from './schema.ts'
import { currentReviews, combineVerdicts, auditDependencyDigest, stageFamily } from './review-current.ts'
import { computeCoreSet, planStage } from './review-plan.ts'
import { computeAssessments, digestRecords, activeMajorCount } from './policy.ts'
import { mapMechanical, stageVerdict, type GateEntry } from './report-render.ts'
import { policyHash, promptHash } from './review-contract.ts'
import { verifySnapshot } from './sources.ts'
import { validateEvidenceAgainstSnapshot } from './graph.ts'
import { ProjectStore } from './store.ts'
import type { DeliveryCheck } from './report.ts'
import type { AdjudicationRecord, Finding, Hash, Id, ProjectSnapshot, ReviewRecord } from './types.ts'

export interface DeliveryInputs {
  root: string
  snapshot: ProjectSnapshot
  artifactId: Id
  text: string
  records: ReviewRecord[]
  pendingRunIds: Id[]
  adjudications: AdjudicationRecord[]
  reviewerConfigHash?: Hash
  gates?: GateEntry[]
}
export function activeAdjudications(
  snapshot: ProjectSnapshot,
  records: ReviewRecord[],
  adjudications: AdjudicationRecord[],
): AdjudicationRecord[] {
  const current = currentReviews(
    snapshot,
    records,
    snapshot.claims.map((c) => c.id),
  ).records
  return adjudications.filter(
    (a) =>
      a.dependencyDigest === projectDependencyDigest(snapshot, records) &&
      current.some(
        (r) =>
          r.stage !== 'extract' &&
          r.runId === a.overrides.runId &&
          r.response?.findings.some((f) => f.id === a.findingId),
      ),
  )
}
export function projectDependencyDigest(snapshot: ProjectSnapshot, records: ReviewRecord[]): Hash {
  return sha256Hex(
    stableJson({
      contract: snapshot.contract,
      sources: snapshot.sources,
      evidence: snapshot.evidence,
      claims: snapshot.claims,
      groups: snapshot.groups,
      arguments: snapshot.arguments,
      issues: snapshot.issues,
      searches: snapshot.searches,
      artifacts: snapshot.artifacts,
      records: records
        .filter((r) => r.kind !== 'disagreement')
        .map((r) => sha256Hex(stableJson(r)))
        .sort(),
    }),
  )
}
/** Check only required gates for eligibility; optional style remains explicitly not-run in the report. */
export function requiredMechanical(gates: GateEntry[]): DeliveryCheck['checks']['mechanical'] {
  const required = gates.filter((g) => g.gate !== 'style' || g.rulesetLoaded === true)
  if (!required.some((g) => g.gate === 'link') || !required.some((g) => g.gate === 'exec')) return 'not-run'
  return mapMechanical(required)
}
export async function defaultGates(root: string, path: string): Promise<GateEntry[]> {
  const gates = await runGates([path], root, async () => {
    throw new Error('exec runner unavailable')
  })
  const text = readFileSync(join(root, path), 'utf8')
  const fenceCount = Math.ceil([...text.matchAll(/^\s*(`{3,}|~{3,})[^\n]*\n/gm)].length / 2)
  return gates.map((g) => ({
    ...g,
    ...(g.gate === 'exec' ? { fenceCount } : {}),
    ...(g.gate === 'style' ? { rulesetLoaded: false } : {}),
  }))
}
function runtimeFinding(code: string, targetIds: Id[], explanation: string): Finding {
  return {
    id: `finding_${randomUUID()}`,
    code,
    targetIds,
    severity: 'blocker',
    explanation,
    evidenceIds: [],
    artifactSpans: [],
    repair: 'manual-review',
  }
}
export function mechanicalFindings(root: string, snapshot: ProjectSnapshot, artifactId: Id, text: string): Finding[] {
  const store = new ProjectStore(root, snapshot.projectId),
    findings: Finding[] = []
  const artifact = snapshot.artifacts.find((a) => a.id === artifactId)
  for (const source of snapshot.sources) {
    const verified = verifySnapshot(store, source)
    if (!verified.ok) {
      findings.push(runtimeFinding('EVID-01', [source.id], verified.message))
      continue
    }
    try {
      const body = readFileSync(join(store.snapshotDir, source.snapshotPath.split('/').pop()!), 'utf8')
      for (const ev of snapshot.evidence.filter((e) => e.sourceId === source.id)) {
        if (ev.sourceSnapshotHash !== source.snapshotHash)
          throw new Error(`evidence ${ev.id} uses an old snapshot hash`)
        validateEvidenceAgainstSnapshot(ev, body)
      }
    } catch (error) {
      findings.push(runtimeFinding('EVID-01', [source.id], String(error)))
    }
  }
  for (const occurrence of artifact?.occurrences ?? [])
    if (text.slice(occurrence.span.start, occurrence.span.end) !== occurrence.exactText)
      findings.push(
        runtimeFinding('EVID-01', [occurrence.claimId], 'bound occurrence no longer exactly matches the artifact'),
      )
  return findings
}
export function evaluateDelivery(input: DeliveryInputs): DeliveryCheck {
  const { snapshot, artifactId, text } = input,
    index = buildReverseIndex(snapshot)
  const artifact = snapshot.artifacts.find((a) => a.id === artifactId)!
  const core = computeCoreSet({
    index,
    artifactText: text,
    requiredQuestionTexts: snapshot.contract.requiredQuestions.map((q) => q.text),
    artifactId,
  })
  const targets = [...new Set([...artifact.occurrences.map((o) => o.claimId), ...core])]
  const selected = currentReviews(snapshot, input.records, targets, input.reviewerConfigHash)
  const contractHash = sha256Hex(stableJson(snapshot.contract)),
    artifactHash = sha256Hex(text)
  const expectedAudit = auditDependencyDigest(snapshot, artifactId, selected.records)
  const audit = input.records.filter(
    (r) =>
      (r.stage === 'extract' || r.stage === 'align') &&
      r.artifactHash === artifactHash &&
      r.contractHash === contractHash &&
      r.policyHash === policyHash() &&
      r.promptHash === promptHash(r.stage) &&
      r.dependencyDigest === expectedAudit &&
      r.targetRefs.some((ref) => ref.id === artifactId && ref.entityVersion === artifact.entityVersion) &&
      (input.reviewerConfigHash === undefined || r.reviewerConfigHash === input.reviewerConfigHash),
  )
  // Keep extract and align from ONE run. Directory iteration order is not chronology.
  const completeRuns = new Map<Id, ReviewRecord[]>()
  for (const r of audit) {
    const rows = completeRuns.get(r.runId) ?? []
    rows.push(r)
    completeRuns.set(r.runId, rows)
  }
  const audits = [...completeRuns.values()]
    .filter((rows) => rows.some((r) => r.stage === 'extract') && rows.some((r) => r.stage === 'align'))
    .sort((a, b) => a[0]!.startedAt.localeCompare(b[0]!.startedAt) || a[0]!.runId.localeCompare(b[0]!.runId))
  const latest = audits.at(-1) ?? []
  const align = latest.find((r) => r.stage === 'align')
  if (align) for (const id of align.coreClaimIds ?? []) core.add(id)
  const records = [...selected.records, ...latest]
  const adjudications = activeAdjudications(snapshot, input.records, input.adjudications)
  const rejected = new Set(adjudications.filter((a) => a.decision === 'reject').map((a) => a.findingId))
  const effective = structuredClone(records)
  for (const record of effective) {
    if (record.stage === 'extract' || !record.response) continue
    for (const target of record.response.targets)
      for (const check of target.checks) {
        if (
          adjudications.some(
            (a) =>
              a.decision === 'reject' &&
              a.overrides.runId === record.runId &&
              a.overrides.targetId === target.targetId &&
              a.overrides.ruleId === check.ruleId &&
              !record.response?.findings.some(
                (f) => f.code === check.ruleId && f.targetIds.includes(target.targetId) && !rejected.has(f.id),
              ),
          )
        )
          check.result = 'pass'
      }
  }
  if (adjudications.length) {
    for (const stage of ['sources', 'support', 'claims', 'arguments'] as const) {
      const reviewed = effective
        .filter((r) => r.stage === stage)
        .map((r) =>
          r.stage === 'extract' || !r.response
            ? r
            : { ...r, response: { ...r.response, findings: r.response.findings.filter((f) => !rejected.has(f.id)) } },
        ) as ReviewRecord[]
      if (reviewed.length && selected.stages[stage] !== 'not-run')
        selected.stages[stage] = stageVerdict(reviewed, [stage])
    }
  }
  if (selected.stages.claims === 'pass') {
    for (const stage of ['sources', 'support', 'arguments'] as const)
      if (planStage({ stage, snapshot, index, targetClaimIds: targets, core, claimsBatchSize: snapshot.contract.reviewSettings?.claimsBatchSize ?? 1 }).length === 0)
        selected.stages[stage] = 'pass'
  }
  const assessments = computeAssessments({
    index,
    claims: snapshot.claims.filter((c) => targets.includes(c.id)),
    digest: digestRecords(effective),
    executedSearchClaimIds: new Set(
      snapshot.searches
        .filter((s) => s.state === 'executed' && (s.executionEventRef || s.externalAttestation))
        .flatMap((s) => s.targetIds),
    ),
  })
  for (const assessment of assessments) {
    const tasks = (['sources', 'support', 'claims', 'arguments'] as const).flatMap((stage) =>
      planStage({ stage, snapshot, index, targetClaimIds: [assessment.claimId], core, claimsBatchSize: snapshot.contract.reviewSettings?.claimsBatchSize ?? 1 }),
    )
    const complete = tasks.every((task) =>
      effective.some(
        (r) =>
          r.stage === task.stage &&
          r.targetRefs.some((ref) => ref.id === task.targetRefs[0]?.id) &&
          r.status === 'completed' &&
          task.requiredRules.every((rule) =>
            r.response?.targets.some(
              (t) =>
                t.targetId === rule.targetId &&
                t.checks.some((c) => c.ruleId === rule.ruleId && (c.result === 'pass' || c.result === 'fail')),
            ),
          ),
      ),
    )
    const someCurrent = effective.some((r) =>
      r.targetRefs.some((ref) => tasks.some((t) => t.targetRefs.some((x) => x.id === ref.id))),
    )
    const someHistory = input.records.some((r) =>
      r.targetRefs.some((ref) => tasks.some((t) => t.targetRefs.some((x) => x.id === ref.id))),
    )
    assessment.reviewState =
      complete && tasks.length > 0 && assessment.reviewState !== 'incomplete'
        ? 'current'
        : someCurrent
          ? 'incomplete'
          : someHistory
            ? 'stale'
            : 'not-run'
    assessment.reviewRunIds = [
      ...new Set(
        effective
          .filter((r) => r.targetRefs.some((ref) => tasks.some((t) => t.targetRefs.some((x) => x.id === ref.id))))
          .map((r) => r.runId),
      ),
    ]
  }
  const findings = [
    ...records.flatMap((r) => (r.stage === 'extract' ? [] : (r.response?.findings ?? []))),
    ...selected.findings,
    ...mechanicalFindings(input.root, snapshot, artifactId, text),
  ]
  const active = findings.filter((f) => !rejected.has(f.id) && f.code !== 'REVIEWER_DISAGREEMENT')
  const extraction = latest.find((r) => r.stage === 'extract')
  const items = extraction?.stage === 'extract' ? extraction.response.items : []
  const alignment = align?.stage === 'align' && align.response?.stage === 'align' ? align.response.alignment : []
  const metrics = {
    extractedAtomicClaims: items.reduce((n, item) => n + item.atomicClaims.length, 0),
    mappedAtomicClaims: items.reduce(
      (n, item, i) =>
        n + (['exact', 'equivalent'].includes(alignment[i]?.relation ?? '') ? item.atomicClaims.length : 0),
      0,
    ),
    coreClaims: core.size,
    reviewedCoreClaims: [...core].filter((id) =>
      assessments.some((a) => a.claimId === id && a.reviewState === 'current'),
    ).length,
  }
  const mechanical = requiredMechanical(input.gates ?? [])
  const checks = {
    mechanical: findings.some((f) => f.code === 'EVID-01') ? ('fail' as const) : mechanical,
    evidence: stageFamily(selected.stages, ['sources', 'support']),
    argument: stageFamily(selected.stages, ['claims', 'arguments']),
    audit: latest.length ? stageVerdict(latest, ['extract', 'align']) : ('not-run' as const),
  }
  if (selected.findings.length) checks.argument = combineVerdicts([checks.argument, 'needs-review'])
  const counts = activeMajorCount(active, [])
  const findingCounts = { ...counts, minor: active.filter((f) => f.severity === 'minor').length }
  const stanceSafe = assessments.every((a) => {
    const c = index.claims.get(a.claimId)!
    return (
      c.stance !== 'asserted' || ((a.supportGrade === 'A' || a.supportGrade === 'B') && a.disposition !== 'refuted')
    )
  })
  const corePaths = [...core].every(
    (id) =>
      snapshot.groups.some((g) => g.targetClaimId === id) ||
      snapshot.arguments.some((a) => a.conclusionClaimId === id) ||
      snapshot.issues.some((i) => i.targetId === id && i.kind === 'missing-evidence' && i.gap),
  )
  const eligibleForReviewed =
    Object.values(checks).every((v) => v === 'pass' || v === 'inapplicable') &&
    counts.blocker === 0 &&
    counts.major === 0 &&
    input.pendingRunIds.length === 0 &&
    metrics.extractedAtomicClaims > 0 &&
    metrics.mappedAtomicClaims === metrics.extractedAtomicClaims &&
    metrics.coreClaims > 0 &&
    metrics.reviewedCoreClaims === metrics.coreClaims &&
    assessments.every((a) => a.reviewState === 'current') &&
    stanceSafe &&
    corePaths
  return {
    gates: (input.gates ?? [])
      .filter((g) => ['link', 'style', 'exec'].includes(g.gate))
      .map((g) => ({
        gate: g.gate as 'link' | 'style' | 'exec',
        status: g.status,
        ...(g.detail ? { detail: g.detail } : {}),
      })),
    claimBindings: assessments.map((a) => {
      const ids = new Set(dependencyEntries(index, [a.claimId]).map((e) => e.id))
      return {
        claimId: a.claimId,
        spans: artifact.occurrences
          .filter((o) => o.claimId === a.claimId)
          .map((o) => [o.span.start, o.span.end] as [number, number]),
        sources: snapshot.sources
          .filter((s) => ids.has(s.id))
          .map((s) => ({
            sourceId: s.id,
            snapshotHash: s.snapshotHash,
            evidenceIds: snapshot.evidence.filter((e) => e.sourceId === s.id && ids.has(e.id)).map((e) => e.id),
          })),
      }
    }),
    artifactId,
    artifactHash,
    projectRevision: snapshot.revision,
    graphHash: sha256Hex(stableJson(snapshot)),
    dependencyDigest: sha256Hex(
      stableJson({
        project: projectDependencyDigest(snapshot, records),
        gates: input.gates ?? [],
        sourceBytes: snapshot.sources.map((source) => {
          try {
            return sha256Hex(readFileSync(join(input.root, source.snapshotPath), 'utf8'))
          } catch {
            return 'unreadable'
          }
        }),
      }),
    ),
    policyHash: policyHash(),
    reviewerConfigHash:
      input.reviewerConfigHash ?? sha256Hex(stableJson([...new Set(records.map((r) => r.reviewerConfigHash))].sort())),
    checks,
    metrics,
    assessments,
    findings,
    reviewRunIds: [...new Set(records.map((r) => r.runId))],
    pendingRunIds: input.pendingRunIds,
    sources: snapshot.sources.map((s) => ({
      sourceId: s.id,
      snapshotHash: s.snapshotHash,
      evidenceIds: snapshot.evidence.filter((e) => e.sourceId === s.id).map((e) => e.id),
    })),
    findingCounts,
    eligibleForReviewed,
  }
}
/** Realpath and UTF-8 checks apply at every read, including after bind-time symlink changes. */
export function artifactText(root: string, path: string): string {
  const base = realpathSync(root),
    file = realpathSync(join(base, path))
  if (!file.startsWith(base + sep)) throw new Error('artifact escaped the workspace')
  const bytes = readFileSync(file),
    text = bytes.toString('utf8')
  if (bytes.includes(0) || !Buffer.from(text, 'utf8').equals(bytes)) throw new Error('invalid artifact UTF-8')
  return text
}
