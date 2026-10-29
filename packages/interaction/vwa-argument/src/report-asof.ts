/**
 * The as-of report path (design docs/plans/2026-10-28-vwa-batch-autonomous-review.md
 * §6.2/§6.3) + the FrozenEvaluation persistence (D15 hash-verified read-back).
 *
 * An as-of render reuses a FrozenEvaluation and SKIPS the layer-B live
 * recheck (no checkForDelivery, no HEAD read). The only live input is the
 * adjudication state: the §4.3/§4.4 post-pass is replayed over the frozen
 * snapshot/records/bytes, so excludedFromForce rule ② (adjudicated markers)
 * applies to a page fixed after its review. Everything else stays as-of E.
 *
 * @module @dsh-cc/vwa-argument/report-asof
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256Hex, stableJson } from './schema.ts'
import { evaluateDelivery, mechanicalFindings, type DeliveryInputs } from './delivery-check.ts'
import { auditSkipInEffect } from './audit-skip.ts'
import { renderReportJson, renderReportMarkdown, reportHashOf, type ReportInput } from './report-render.ts'
import type { DeliveryCheck, FrozenEvaluation } from './report.ts'
import type { AdjudicationRecord, Finding, Hash, Id, ReviewRecord, Verdict } from './types.ts'

/** Records as the delivery pass reads them (a disagreement marker carries `kind`). */
export type StoredRecord = ReviewRecord & { kind?: 'disagreement' }

/** The full frozen record set of one evaluation. */
export type StoredRecords = StoredRecord[]

/** Runtime observations read once at delivery-check time, never during replay. */
export type FrozenRuntime = NonNullable<DeliveryInputs['runtime']>

export function freezeDeliveryRuntime(
  root: string,
  snapshot: FrozenEvaluation['snapshot'],
  artifactId: Id,
  text: string,
): FrozenRuntime {
  const artifact = snapshot.artifacts.find((candidate) => candidate.id === artifactId)!
  const auditSkip = auditSkipInEffect(root, snapshot.projectId, artifactId, sha256Hex(text), artifact.entityVersion)
  return {
    ...(auditSkip === undefined ? {} : { auditSkip }),
    mechanicalFindings: mechanicalFindings(root, snapshot, artifactId, text),
    sourceByteHashes: snapshot.sources.map((source) => {
      try {
        return sha256Hex(readFileSync(join(root, source.snapshotPath), 'utf8'))
      } catch {
        return 'unreadable'
      }
    }),
  }
}

/** Older evaluations can recover only findings whose provenance is unambiguous. */
function replayRuntime(frozen: FrozenEvaluation, records: StoredRecords): FrozenRuntime | undefined {
  if (frozen.runtime !== undefined) return frozen.runtime
  const recordedIds = new Set(records.flatMap((record) => record.stage === 'extract' ? [] :
    (record.response?.findings ?? []).map((finding) => finding.id)))
  const generated = frozen.check.findings.filter((finding) => !recordedIds.has(finding.id))
  if (generated.some((finding) => finding.code !== 'EVID-01' && finding.code !== 'REVIEWER_DISAGREEMENT'))
    return undefined
  return {
    ...(frozen.check.auditSkip === undefined ? {} : { auditSkip: frozen.check.auditSkip }),
    mechanicalFindings: generated.filter((finding) => finding.code === 'EVID-01'),
  }
}

/** §6.2 step 1: the minimal conflicting-verdict context the adjudication overlay needs. */
export interface DisagreementContext {
  findingId: Id
  targetId: Id
  ruleId: string
  runA: Id
  runB: Id
  verdictA: Verdict
  verdictB: Verdict
}

/** The (target, rule) checks of one semantic record (empty for an extraction record). */
function checksOf(record: StoredRecord | undefined) {
  if (record === undefined || record.stage === 'extract' || record.response === undefined) return []
  return record.response.targets.flatMap((target) =>
    target.checks.map((check) => ({ ruleId: check.ruleId, targetId: target.targetId, result: check.result })),
  )
}

/** The (target, rule) slot whose verdicts differ between the conflicting runs (§4.4). */
function differingSlot(records: StoredRecords): { ruleId: string; targetId: Id } | undefined {
  const known = new Map(checksOf(records[0]).map((slot) => [`${slot.targetId}|${slot.ruleId}`, slot]))
  for (const record of records.slice(1))
    for (const slot of checksOf(record)) {
      const prior = known.get(`${slot.targetId}|${slot.ruleId}`)
      if (prior !== undefined && prior.result !== slot.result) return { ruleId: prior.ruleId, targetId: prior.targetId }
    }
  return undefined
}

function slotVerdict(record: StoredRecord, slot: { ruleId: string; targetId: Id }): Verdict {
  return (
    checksOf(record).find((check) => check.targetId === slot.targetId && check.ruleId === slot.ruleId)?.result ??
    'not-run'
  )
}

/**
 * §6.2 step 1: freeze the disagreement context of every marker in E. Only the
 * two conflicting runs and the differing slot are kept — the overlay needs no
 * other record detail from here.
 */
export function disagreementContextOf(records: StoredRecords, markers: Finding[]): DisagreementContext[] {
  const context: DisagreementContext[] = []
  // A marker is listed both via its record and via the selected findings; the
  // context is per marker id, not per finding copy.
  for (const marker of markers) {
    if (context.some((entry) => entry.findingId === marker.id)) continue
    const home = records.find(
      (record) => record.stage !== 'extract' && record.response?.findings.some((f) => f.id === marker.id),
    )
    if (home === undefined || home.stage === 'extract' || home.response === undefined) continue
    const conflicts = [
      ...new Map(
        records
          .filter(
            (record) =>
              record.stage === home.stage &&
              record.status === 'completed' &&
              record.response !== undefined &&
              // The marker copy is not a conflicting verdict.
              (record as { kind?: string }).kind !== 'disagreement' &&
              record.inputHash === home.inputHash,
          )
          .map((record) => [record.runId, record]),
      ).values(),
    ]
    const slot = conflicts.length < 2 ? undefined : differingSlot(conflicts)
    const [runA, runB] = conflicts
    if (slot === undefined || runA === undefined || runB === undefined) continue
    context.push({
      findingId: marker.id,
      targetId: slot.targetId,
      ruleId: slot.ruleId,
      runA: runA.runId,
      runB: runB.runId,
      verdictA: slotVerdict(runA, slot),
      verdictB: slotVerdict(runB, slot),
    })
  }
  return context
}

/**
 * §6.2 step 3 (adjudication overlay): replay the §4.3/§4.4 post-pass over the
 * frozen inputs with the LIVE adjudication set. Rule ② is mode-independent,
 * so the frozen snapshot's own disagreementPolicy is used — never a live one.
 */
export function applyAdjudicationOverlay(
  root: string,
  frozen: FrozenEvaluation,
  adjudications: AdjudicationRecord[],
): DeliveryCheck {
  // Missing replay records on legacy rows must not erase a completed review.
  if (!Array.isArray(frozen.records)) return frozen.check
  const records = frozen.records
  const runtime = replayRuntime(frozen, records)
  if (runtime === undefined) return frozen.check
  // The check's reviewerConfigHash is DERIVED when the freeze had no explicit
  // hash; feeding a derived value back in would filter every record out, so it
  // is only forwarded when it cannot have been derived from these records.
  const derived = sha256Hex(stableJson([...new Set(records.map((record) => record.reviewerConfigHash))].sort()))
  const config = frozen.runtime !== undefined ? frozen.reviewerConfigHashInput
    : frozen.check.reviewerConfigHash === derived ? undefined : frozen.check.reviewerConfigHash
  return evaluateDelivery({
    root,
    snapshot: frozen.snapshot,
    artifactId: frozen.artifactId,
    text: frozen.artifactText,
    records,
    pendingRunIds: frozen.check.pendingRunIds,
    adjudications,
    gates: frozen.gates,
    runtime,
    ...(config === undefined ? {} : { reviewerConfigHash: config }),
    disagreementPolicy: frozen.snapshot.contract.reviewSettings?.disagreementPolicy ?? 'blocking',
  })
}

/** The current disk bytes of E's artifact, hashed (§6.2 step 3: never a re-evaluation). */
export function currentArtifactHash(root: string, frozen: FrozenEvaluation): Hash {
  const artifact = frozen.snapshot.artifacts.find((candidate) => candidate.id === frozen.artifactId)
  if (artifact === undefined) return 'unreadable'
  const absolute = join(root, artifact.path)
  if (!existsSync(absolute)) return 'unreadable'
  try {
    return createHash('sha256').update(readFileSync(absolute, 'utf8'), 'utf8').digest('hex')
  } catch {
    return 'unreadable'
  }
}

/** §6.2 step 3: E rendered as-of, with the live adjudication overlay applied. */
export function renderAsOfReport(
  root: string,
  frozen: FrozenEvaluation,
  format: 'markdown' | 'json',
  adjudications: AdjudicationRecord[],
): {
  text: string
  reportHash: Hash
  bindingDigest: Hash
  eligible: boolean
  revision: number
  asOf: NonNullable<ReportInput['asOf']>
} {
  const check = applyAdjudicationOverlay(root, frozen, adjudications)
  const currentHash = currentArtifactHash(root, frozen)
  const asOf = {
    evaluationId: frozen.evaluationId,
    reviewedArtifactHash: check.artifactHash,
    currentArtifactHash: currentHash,
    diverged: currentHash !== check.artifactHash,
    adjudicationOverlay: true,
  }
  const input = reportInput(frozen, { check, adjudications, asOf })
  const text = format === 'json' ? renderReportJson(input) : renderReportMarkdown(input)
  return {
    text,
    reportHash: reportHashOf(text),
    bindingDigest: frozen.bindingDigest,
    eligible: check.eligibleForReviewed,
    revision: frozen.snapshot.revision,
    asOf,
  }
}

/** The render input of one frozen evaluation (live: no parts; as-of: overlaid). */
export function reportInput(
  frozen: FrozenEvaluation,
  parts: { check?: DeliveryCheck; adjudications?: AdjudicationRecord[]; asOf?: ReportInput['asOf'] } = {},
): ReportInput {
  const check = parts.check ?? frozen.check
  return {
    snapshot: frozen.snapshot,
    artifactId: check.artifactId,
    artifactHash: check.artifactHash,
    checks: check.checks,
    assessments: check.assessments,
    findings: check.findings,
    deferredDisagreements: check.deferredDisagreements ?? [],
    ...(check.auditSkip === undefined ? {} : { auditSkip: check.auditSkip }),
    adjudications: parts.adjudications ?? frozen.adjudications ?? [],
    reviewRunIds: check.reviewRunIds,
    metrics: check.metrics,
    cost: {
      inputTokens: frozen.inputTokens,
      outputTokens: frozen.outputTokens,
      calls: frozen.calls,
      modelId: frozen.modelId,
    },
    gates: frozen.gates,
    artifactText: frozen.artifactText,
    stageProgress: check.stageProgress,
    failures: check.failures,
    eligibleCandidate: check.eligibleForReviewed,
    hasV2Receipt: false,
    hasLegacyReceipt: false,
    bindingDigest: frozen.bindingDigest,
    reportVersion: 'vwa-argument-report@1',
    ...(parts.asOf === undefined ? {} : { asOf: parts.asOf }),
  }
}

/** Evaluation layout: `.dsh/vwa/<projectId>/evaluations/<id>.json` with a frozenHash wrapper (D15). */
export function evaluationPath(root: string, projectId: string, evaluationId: string): string {
  return join(root, '.dsh', 'vwa', projectId, 'evaluations', `${evaluationId}.json`)
}

export function persistEvaluation(root: string, projectId: string, frozen: FrozenEvaluation): void {
  const dir = join(root, '.dsh', 'vwa', projectId, 'evaluations')
  mkdirSync(dir, { recursive: true })
  const row = { frozenHash: sha256Hex(stableJson(frozen)), frozen }
  const tmp = `${join(dir, frozen.evaluationId)}.json.tmp`
  writeFileSync(tmp, stableJson(row))
  renameSync(tmp, join(dir, `${frozen.evaluationId}.json`))
}

export function loadEvaluation(
  root: string,
  projectId: string,
  evaluationId: string,
): FrozenEvaluation | undefined {
  const path = evaluationPath(root, projectId, evaluationId)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { frozenHash: Hash; frozen: FrozenEvaluation }
    if (sha256Hex(stableJson(parsed.frozen)) !== parsed.frozenHash) return undefined
    return parsed.frozen
  } catch {
    return undefined
  }
}
