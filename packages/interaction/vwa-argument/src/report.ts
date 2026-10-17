/**
 * The frozen evaluation handle + VwaArgumentService (design
 * docs/plans/2026-10-16-vwa-evidence-argument.md §16.1a, §17, Appendix A).
 * Rendering lives in report-render.ts (§19); this file owns the service:
 *
 * - checkForDelivery returns the frozen handle {evaluationId, bindingDigest,
 *   check}; the frozen inputs are persisted and hash-verified on read-back
 *   (D15: a write/read failure is identified, the old row is never mistaken
 *   for current). checkForDelivery never modifies the body, calls models,
 *   or writes receipts.
 * - renderReport carries the handle: a stale handle yields INPUT_CHANGED
 *   with ONE retry, then a failure — never a "passed" report (Appendix A).
 *   reportHash = SHA-256 over the report text; the report is written first
 *   and its hash goes into the receipt later (slice 5 owns receipts).
 * - bindingDigest = SHA256(stableJson({artifactHash, graphHash,
 *   dependencyDigest, policyHash, reviewerConfigHash, reviewRecordHashes,
 *   activeAdjudicationHashes})) per §16.1a.
 * - D16 (store level): artifact bytes changed after binding → INPUT_CHANGED;
 *   the store-level rehash/rebind behavior is: checkForDelivery throws until
 *   the artifact is re-bound against the new bytes.
 * - D21 (§18): the adjudication surface rejects any non-user signer.
 *
 * @module @dsh-cc/vwa-argument/report
 */

import { randomUUID, createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256Hex, stableJson } from './schema.ts'
import { buildReverseIndex, dependencyDigest } from './dependencies.ts'
import { activeMajorCount, computeAssessments, digestRecords } from './policy.ts'
import { policyHash } from './review-runner.ts'
import { ProjectStore } from './store.ts'
import { computeCoreSet } from './review-plan.ts'
import { ReviewRunStore } from './review-run-store.ts'
import {
  mapMechanical, renderReportJson, renderReportMarkdown, reportHashOf, stageVerdict,
  type GateEntry, type ReportInput,
} from './report-render.ts'
import type {
  AdjudicationRecord, Assessment, Finding, Hash, Id, MechanicalStatus,
  ProjectSnapshot, ReviewRecord, Verdict,
} from './types.ts'

export { HONESTY, REPORT_TEMPLATE, mapMechanical, renderReportMarkdown, renderReportJson } from './report-render.ts'
export type { GateEntry, ReportInput } from './report-render.ts'

export interface DeliveryCheck {
  artifactId: Id
  artifactHash: Hash
  projectRevision: number
  graphHash: Hash
  dependencyDigest: Hash
  policyHash: Hash
  reviewerConfigHash: Hash
  checks: { mechanical: MechanicalStatus; evidence: Verdict; argument: Verdict; audit: Verdict }
  metrics: { mappedAtomicClaims: number; extractedAtomicClaims: number; reviewedCoreClaims: number; coreClaims: number }
  assessments: Assessment[]
  findings: Finding[]
  reviewRunIds: Id[]
  sources: { sourceId: Id; snapshotHash: Hash; evidenceIds: Id[] }[]
  eligibleForReviewed: boolean
  /** Active (non-disagreement, non-rejected) severity counts, §16.1/§17.2. */
  findingCounts: { blocker: number; major: number; minor: number }
  pendingRunIds: Id[]
}

/** Frozen inputs of one evaluation (persisted + hash-verified on read-back, D15). */
export interface FrozenEvaluation {
  evaluationId: Id
  projectId: Id
  artifactId: Id
  bindingDigest: Hash
  check: DeliveryCheck
  /** The snapshot the check was computed from (frozen render input). */
  snapshot: ProjectSnapshot
  /** Active adjudications at freeze time (§16.1a: they enter every downstream cache). */
  adjudications: AdjudicationRecord[]
  inputTokens: number
  outputTokens: number
  calls: number
  modelId: string
}

export interface VwaArgumentServiceDeps {
  root: string
  reviewerConfigHash?: Hash
  /** Raw gate entries for the mechanical mapping (host-provided). */
  gates?(artifactPath: string): GateEntry[]
}

/** A stale-handle / changed-input condition (Appendix A). */
export class InputChangedError extends Error {
  readonly code = 'INPUT_CHANGED'
  constructor(message: string) {
    super(message)
    this.name = 'InputChangedError'
  }
}

/** §17.2 candidate predicate (the receipt read-back part is slice 5). */
function eligibleForReviewed(check: Omit<DeliveryCheck, 'eligibleForReviewed' | 'pendingRunIds'>): boolean {
  const { blocker, major } = activeMajorCount(check.findings.map((finding) => ({ ...finding })), [])
  const layer = (verdict: Verdict): boolean => verdict === 'pass'
  const layersPass = check.checks.mechanical === 'inapplicable' || check.checks.mechanical === 'pass'
  return blocker === 0 && major === 0 && layersPass
    && layer(check.checks.evidence) && layer(check.checks.argument) && layer(check.checks.audit)
    && check.metrics.extractedAtomicClaims > 0
    && check.metrics.mappedAtomicClaims === check.metrics.extractedAtomicClaims
    && check.metrics.coreClaims > 0
    && check.metrics.reviewedCoreClaims === check.metrics.coreClaims
    && check.assessments.every((assessment) => assessment.reviewState === 'current')
}

/** bindingDigest = SHA256(stableJson({…})) per §16.1a. */
export function computeBindingDigest(
  check: Omit<DeliveryCheck, 'eligibleForReviewed' | 'pendingRunIds'>,
  adjudications: AdjudicationRecord[],
): Hash {
  return sha256Hex(stableJson({
    artifactHash: check.artifactHash,
    graphHash: check.graphHash,
    dependencyDigest: check.dependencyDigest,
    policyHash: check.policyHash,
    reviewerConfigHash: check.reviewerConfigHash,
    reviewRecordHashes: check.reviewRunIds,
    activeAdjudicationHashes: adjudications.map((record) => sha256Hex(stableJson(record))).sort(),
  }))
}

/** The Appendix A service; registered as the cordis service `vwa-argument`. */
export class VwaArgumentService {
  constructor(private readonly deps: VwaArgumentServiceDeps) {}

  /** Bound artifacts of one project (artifactId + path). */
  listBoundArtifacts(projectId: Id): { artifactId: Id; path: string }[] {
    const head = new ProjectStore(this.deps.root, projectId).readHead()
    if (!head.ok) return []
    return head.data.snapshot.artifacts.map((artifact) => ({ artifactId: artifact.id, path: artifact.path }))
  }

  /**
   * Compute the DeliveryCheck from HEAD + ACTUAL bytes and freeze it
   * (Appendix A: no body modification, no model calls, no receipt writes).
   */
  async checkForDelivery(projectId: Id, artifactId: Id): Promise<{ evaluationId: Id; bindingDigest: Hash; check: DeliveryCheck }> {
    const store = new ProjectStore(this.deps.root, projectId)
    const head = store.readHead()
    if (!head.ok) throw new InputChangedError(`cannot read HEAD for ${projectId}: ${head.message}`)
    const snapshot = head.data.snapshot
    const artifact = snapshot.artifacts.find((art) => art.id === artifactId)
    if (artifact === undefined) throw new InputChangedError(`artifact ${artifactId} is not bound in project ${projectId}`)
    const absolute = join(this.deps.root, artifact.path)
    if (!existsSync(absolute)) throw new InputChangedError(`artifact file ${artifact.path} is missing`)
    const text = readFileSync(absolute, 'utf8')
    const artifactHash = createHash('sha256').update(text, 'utf8').digest('hex')
    if (artifactHash !== artifact.contentHash) {
      // D16 (store level): bytes changed after binding → re-bind/re-audit required.
      throw new InputChangedError('artifact bytes changed after binding; re-bind and re-audit are required')
    }

    const index = buildReverseIndex(snapshot)
    const records = readAllRecords(this.deps.root, projectId)
    const digest = digestRecords(records)
    const assessments = computeAssessments({
      index, claims: snapshot.claims, digest,
      executedSearchClaimIds: new Set(snapshot.searches.filter((search) => search.state === 'executed').flatMap((search) => search.targetIds)),
    })
    const findings = records.flatMap((record) => record.response?.findings ?? [])
    const reviewRunIds = [...new Set(records.map((record) => record.runId))]
    const pendingRunIds = pendingRuns(this.deps.root, projectId)
    const depDigest = dependencyDigest(index, snapshot.claims.map((claim) => claim.id), reviewRunIds)
    const reviewerConfigHash = this.deps.reviewerConfigHash ?? sha256Hex(stableJson({ reviewer: 'unconfigured' }))
    const core = computeCoreSet({
      index, artifactText: text,
      requiredQuestionTexts: snapshot.contract.requiredQuestions.map((question) => question.text),
    })
    const gates = this.deps.gates?.(artifact.path) ?? []
    const metrics = {
      mappedAtomicClaims: mappedCount(records),
      extractedAtomicClaims: extractedCount(records),
      reviewedCoreClaims: [...core].filter((claimId) =>
        assessments.find((assessment) => assessment.claimId === claimId)?.reviewState === 'current').length,
      coreClaims: core.size,
    }
    const base: Omit<DeliveryCheck, 'eligibleForReviewed' | 'pendingRunIds'> = {
      artifactId, artifactHash, projectRevision: head.data.head.revision, graphHash: head.data.head.graphHash,
      dependencyDigest: depDigest, policyHash: policyHash(), reviewerConfigHash,
      checks: {
        mechanical: mapMechanical(gates),
        evidence: stageVerdict(records, ['sources', 'support']),
        argument: stageVerdict(records, ['claims', 'arguments']),
        audit: stageVerdict(records, ['extract', 'align']),
      },
      metrics, assessments, findings, reviewRunIds,
      findingCounts: activeFindingCounts(findings, readAdjudications(this.deps.root, projectId)),
      sources: snapshot.sources.map((source) => ({
        sourceId: source.id, snapshotHash: source.snapshotHash,
        evidenceIds: snapshot.evidence.filter((ev) => ev.sourceId === source.id).map((ev) => ev.id),
      })),
    }
    const adjudications = readAdjudications(this.deps.root, projectId)
    const bindingDigest = computeBindingDigest(base, adjudications)
    const check: DeliveryCheck = { ...base, eligibleForReviewed: eligibleForReviewed(base), pendingRunIds }
    const evaluationId = `eval_${randomUUID()}`
    const frozen: FrozenEvaluation = {
      evaluationId, projectId, artifactId, bindingDigest, check, snapshot, adjudications,
      inputTokens: records.reduce((sum, record) => sum + record.inputTokens, 0),
      outputTokens: records.reduce((sum, record) => sum + record.outputTokens, 0),
      calls: records.length,
      modelId: 'unpinned',
    }
    persistEvaluation(this.deps.root, projectId, frozen)
    return { evaluationId, bindingDigest, check }
  }

  /**
   * Render the report bound to the frozen evaluation. A stale handle →
   * INPUT_CHANGED with ONE retry; still changing → failure, never a
   * "passed" report (Appendix A).
   */
  async renderReport(projectId: Id, artifactId: Id, evaluationId: Id, format: 'markdown' | 'json'): Promise<{ text: string; reportHash: Hash; bindingDigest: Hash }> {
    const frozen = loadEvaluation(this.deps.root, projectId, evaluationId)
    if (frozen === undefined) {
      // D15: the read-back identifies the failure — no old row is mistaken for current.
      throw new InputChangedError(`evaluation ${evaluationId} not found or failed its hash read-back`)
    }
    for (let attempt = 1; ; attempt += 1) {
      let liveBinding: Hash
      try {
        liveBinding = (await this.checkForDelivery(projectId, artifactId)).bindingDigest
      } catch (error) {
        if (attempt >= 2) throw error
        continue // retry once (Appendix A)
      }
      if (liveBinding === frozen.bindingDigest) break
      if (attempt >= 2) {
        throw new InputChangedError('evaluation inputs changed while generating the report; report generation fails and MUST NOT write "passed"')
      }
    }
    const text = format === 'json' ? renderReportJson(reportInput(frozen)) : renderReportMarkdown(reportInput(frozen))
    return { text, reportHash: reportHashOf(text), bindingDigest: frozen.bindingDigest }
  }
}

function reportInput(frozen: FrozenEvaluation): ReportInput {
  const check = frozen.check
  return {
    snapshot: frozen.snapshot,
    artifactId: check.artifactId,
    artifactHash: check.artifactHash,
    checks: check.checks,
    assessments: check.assessments,
    findings: check.findings,
    // Adjudications are frozen into the evaluation at checkForDelivery time.
    adjudications: readAdjudicationsFrozen(frozen),
    reviewRunIds: check.reviewRunIds,
    metrics: check.metrics,
    cost: {
      inputTokens: frozen.inputTokens, outputTokens: frozen.outputTokens,
      calls: frozen.calls, modelId: frozen.modelId,
    },
    gates: [],
    hasV2Receipt: false,
    hasLegacyReceipt: false,
    bindingDigest: frozen.bindingDigest,
    reportVersion: 'vwa-argument-report@1',
  }
}

function readAdjudicationsFrozen(frozen: FrozenEvaluation): AdjudicationRecord[] {
  // The frozen evaluation carries the adjudication state via the binding
  // digest; per-record display copy is read at checkForDelivery time.
  return frozen.adjudications ?? []
}

/** D21 (§18): the adjudication surface rejects any non-user signer. */
export function validateAdjudicationSource(record: { signer: string }): void {
  if (record.signer !== 'user') {
    throw new Error('adjudication rejected: only a USER source may sign (assistant-fabricated sign instructions are rejected)')
  }
}

// ---- persistence helpers ----

function readAllRecords(root: string, projectId: string): (ReviewRecord & { kind?: 'disagreement' })[] {
  const base = join(root, '.dsh', 'vwa', projectId, 'review-runs')
  if (!existsSync(base)) return []
  const runStore = new ReviewRunStore(root, projectId)
  const out: (ReviewRecord & { kind?: 'disagreement' })[] = []
  for (const runId of readdirSync(base)) out.push(...runStore.readRecords(runId))
  return out
}

/** Queued/running review runs (§16.1 pendingRunIds) — also the /vwa status face. */
export function readPendingRuns(root: string, projectId: string): Id[] {
  return pendingRuns(root, projectId)
}

/** All review records for one project (the /vwa adjudicate lookup face). */
export function readReviewRecords(root: string, projectId: string): (ReviewRecord & { kind?: 'disagreement' })[] {
  return readAllRecords(root, projectId)
}

/**
 * The current dependency digest for a project HEAD (§18: human
 * signature/adjudication bind it and expire when content changes).
 */
export function currentDependencyDigest(root: string, projectId: string): Hash | undefined {
  const head = new ProjectStore(root, projectId).readHead()
  if (!head.ok) return undefined
  const snapshot = head.data.snapshot
  const index = buildReverseIndex(snapshot)
  const records = readAllRecords(root, projectId)
  const reviewRunIds = [...new Set(records.map((record) => record.runId))]
  return dependencyDigest(index, snapshot.claims.map((claim) => claim.id), reviewRunIds)
}

/**
 * Append one adjudication record (the /vwa adjudicate write path, §18).
 * signer is always 'user'; validateAdjudicationSource re-verified on read.
 */
export function appendAdjudication(root: string, projectId: string, record: AdjudicationRecord): void {
  validateAdjudicationSource(record)
  const path = join(root, '.dsh', 'vwa', projectId, 'adjudications.json')
  let prior: { adjudications?: AdjudicationRecord[] } = { adjudications: [] }
  if (existsSync(path)) {
    try {
      prior = JSON.parse(readFileSync(path, 'utf8')) as { adjudications?: AdjudicationRecord[] }
      if (!Array.isArray(prior.adjudications)) prior = { adjudications: [] }
    } catch {
      prior = { adjudications: [] }
    }
  }
  prior.adjudications = [...(prior.adjudications ?? []), record]
  mkdirSync(join(root, '.dsh', 'vwa', projectId), { recursive: true })
  writeFileSync(path, stableJson(prior), 'utf8')
}

/** Signature record face (§18). */
export interface Signature {
  signatureId: Id
  artifactId: Id
  artifactHash: Hash
  graphHash: Hash
  receiptHash: Hash
  policyHash: Hash
  signer: 'user'
  ts: string
}

/** Append one user signature (§18) — /vwa sign is the only writer. */
export function appendSignature(root: string, projectId: string, signature: Signature): void {
  const path = join(root, '.dsh', 'vwa', projectId, 'signatures.json')
  let prior: { signatures?: Signature[] } = { signatures: [] }
  if (existsSync(path)) {
    try {
      prior = JSON.parse(readFileSync(path, 'utf8')) as { signatures?: Signature[] }
      if (!Array.isArray(prior.signatures)) prior = { signatures: [] }
    } catch {
      prior = { signatures: [] }
    }
  }
  prior.signatures = [...(prior.signatures ?? []), signature]
  mkdirSync(join(root, '.dsh', 'vwa', projectId), { recursive: true })
  writeFileSync(path, stableJson(prior), 'utf8')
}

function pendingRuns(root: string, projectId: string): Id[] {
  const base = join(root, '.dsh', 'vwa', projectId, 'review-runs')
  if (!existsSync(base)) return []
  const runStore = new ReviewRunStore(root, projectId)
  const out: Id[] = []
  for (const runId of readdirSync(base)) {
    const request = runStore.loadRequest(runId)
    if (request?.status === 'running' || request?.status === 'queued') out.push(runId)
  }
  return out
}

function readAdjudications(root: string, projectId: string): AdjudicationRecord[] {
  const path = join(root, '.dsh', 'vwa', projectId, 'adjudications.json')
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { adjudications?: AdjudicationRecord[] }
    for (const record of parsed.adjudications ?? []) validateAdjudicationSource(record)
    return parsed.adjudications ?? []
  } catch {
    return []
  }
}

function mappedCount(records: ReviewRecord[]): number {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!
    if (record.stage === 'align' && record.response !== undefined) {
      const alignment = (record.response as import('./types.ts').AlignResponse).alignment
      return alignment.filter((entry) => entry.relation === 'exact' || entry.relation === 'equivalent').length
    }
  }
  return 0
}

function extractedCount(records: ReviewRecord[]): number {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!
    if (record.stage === 'extract' && record.response !== undefined) {
      const items = (record.response as unknown as { items: { atomicClaims: unknown[] }[] }).items
      return items.reduce((sum, item) => sum + item.atomicClaims.length, 0)
    }
  }
  return 0
}

/** Evaluation layout: `.dsh/vwa/<projectId>/evaluations/<id>.json` with a frozenHash wrapper (D15). */
function persistEvaluation(root: string, projectId: string, frozen: FrozenEvaluation): void {
  const dir = join(root, '.dsh', 'vwa', projectId, 'evaluations')
  mkdirSync(dir, { recursive: true })
  const row = { frozenHash: sha256Hex(stableJson(frozen)), frozen }
  const tmp = `${join(dir, frozen.evaluationId)}.json.tmp`
  writeFileSync(tmp, stableJson(row))
  renameSync(tmp, join(dir, `${frozen.evaluationId}.json`))
}

function loadEvaluation(root: string, projectId: string, evaluationId: string): FrozenEvaluation | undefined {
  const path = join(root, '.dsh', 'vwa', projectId, 'evaluations', `${evaluationId}.json`)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { frozenHash: Hash; frozen: FrozenEvaluation }
    if (sha256Hex(stableJson(parsed.frozen)) !== parsed.frozenHash) return undefined
    return parsed.frozen
  } catch {
    return undefined
  }
}

/** Active severity counts (§17.2): disagreement findings and rejected adjudications are not active. */
function activeFindingCounts(
  findings: (Finding & { kind?: string })[],
  adjudications: AdjudicationRecord[],
): { blocker: number; major: number; minor: number } {
  const rejected = new Set(adjudications.filter((record) => record.decision === 'reject').map((record) => record.findingId))
  let blocker = 0
  let major = 0
  let minor = 0
  for (const finding of findings) {
    if (finding.kind === 'disagreement' || rejected.has(finding.id)) continue
    if (finding.severity === 'blocker') blocker += 1
    else if (finding.severity === 'major') major += 1
    else minor += 1
  }
  return { blocker, major, minor }
}

/**
 * The published `vwa-argument` service: one process-wide host, bound to a
 * workspace PER CALL. The store lives under the caller's session cwd, which
 * differs per session/worktree/subagent, so the root is never fixed at mount.
 */
export class VwaArgumentHost {
  constructor(private readonly deps: Omit<VwaArgumentServiceDeps, 'root'> = {}) {}

  /** The delivery provider bound to one workspace root (the caller's session cwd). */
  forWorkspace(root: string): VwaArgumentService {
    return new VwaArgumentService({ ...this.deps, root })
  }
}

/** Cordis service registration (name `vwa-argument`; vwa-evidence binds it per workspace). */
export function registerVwaArgumentService(
  ctx: { provide(name: string, value: unknown): unknown },
  deps: Omit<VwaArgumentServiceDeps, 'root'> = {},
): void {
  ctx.provide('vwa-argument', new VwaArgumentHost(deps))
}
