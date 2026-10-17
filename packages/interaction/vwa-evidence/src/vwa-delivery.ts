/**
 * The vwa-argument delivery provider seam (design
 * docs/plans/2026-10-16-vwa-evidence-argument.md §3, §16.2).
 *
 * The cycle-break contract: vwa-evidence NEVER imports @dsh-cc/vwa-argument.
 * The provider is resolved structurally at turn-end via cordis `ctx.get`
 * duck-typing (§16.2 step 4); all check shapes are locally-declared minimal
 * faces ({@link DeliveryCheckLike} and friends) that mirror the argument
 * package's `DeliveryCheck`/review-schema types. `MechanicalStatus`/
 * `Verdict` unions and the v2 row types come from receipt.ts.
 *
 * Delivery event (§17.3): the only accepted delivery event is the host
 * `deliverables/presented` session event (the model `present` tool). The
 * event carries paths but no hashes, so hashes are computed from the
 * presented files' CURRENT bytes at check time and compared against the
 * binding (artifactHash) and the receipt's report hash. Events are never
 * fabricated.
 *
 * @module @dsh-cc/vwa-evidence/vwa-delivery
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { sha256Hex, type AssessmentEntry, type MechanicalStatus, type ReceiptV2, type Verdict } from './receipt.ts'
import type { EvalEvent } from './evaluator.ts'

/** Minimal assessment face (mirrors the review schema Assessment). */
export type AssessmentLike = AssessmentEntry

/** Minimal finding face (mirrors the review schema Finding). */
export interface FindingLike {
  id: string
  targetIds: string[]
  severity: 'blocker' | 'major' | 'minor'
  explanation: string
  kind?: string
}

/**
 * Minimal DeliveryCheck face consumed from the vwa-argument service
 * (§3 cycle-break). Fields mirror the argument package's `DeliveryCheck`.
 */
export interface DeliveryCheckLike {
  artifactId: string
  artifactHash: string
  projectRevision: number
  graphHash: string
  dependencyDigest: string
  policyHash: string
  reviewerConfigHash: string
  checks: { mechanical: MechanicalStatus; evidence: Verdict; argument: Verdict; audit: Verdict }
  metrics: { mappedAtomicClaims: number; extractedAtomicClaims: number; reviewedCoreClaims: number; coreClaims: number }
  assessments: AssessmentLike[]
  findings: FindingLike[]
  reviewRunIds: string[]
  pendingRunIds: string[]
  sources: { sourceId: string; snapshotHash: string; evidenceIds: string[] }[]
  eligibleForReviewed: boolean
  gates?: ReceiptV2['gates']
  claimBindings?: {
    claimId: string
    spans: [number, number][]
    sources: { sourceId: string; snapshotHash: string; evidenceIds: string[] }[]
  }[]
  findingCounts: { blocker: number; major: number; minor: number }
}

/**
 * The structural provider the turn-end integration consumes (§16.2). The
 * cordis service `vwa-argument` implements this face when mounted.
 */
export interface VwaArgumentDeliveryProvider {
  /** Bound artifacts of the current project (artifactId + workspace-relative path). */
  listBoundArtifacts(projectId: string): { artifactId: string; path: string }[]
  /** Freeze the current evaluation inputs and return the delivery check handle. */
  checkForDelivery(
    projectId: string,
    artifactId: string,
  ): Promise<{ evaluationId: string; bindingDigest: string; check: DeliveryCheckLike }>
  /** Render the report bound to the frozen evaluation (report written BEFORE the receipt, §16.1a). */
  renderReport(
    projectId: string,
    artifactId: string,
    evaluationId: string,
    format: 'markdown' | 'json',
  ): Promise<{ text: string; reportHash: string; bindingDigest: string }>
}

/**
 * The published `vwa-argument` service face: a host that binds the delivery
 * provider to the caller's workspace (the store lives under each session's
 * cwd, so no single root is correct process-wide).
 */
export interface VwaArgumentDeliveryHost {
  forWorkspace(workspaceRoot: string, agent?: unknown): unknown
}

/**
 * Duck-typed resolution of the `vwa-argument` service (§16.2), bound to the
 * caller's workspace root. Returns undefined when the service is absent or
 * lacks the host/provider face — the artifact then stays on the v1 path
 * (fail-soft; lane 1 is unchanged). Resolved per dispatch, so mount order of
 * vwa-evidence vs vwa-argument does not matter (same isolate realm).
 */
export function resolveDeliveryProvider(
  ctx: unknown,
  workspaceRoot: string,
  agent?: unknown,
): VwaArgumentDeliveryProvider | undefined {
  try {
    const host = (ctx as { get?(name: string): unknown }).get?.('vwa-argument') as VwaArgumentDeliveryHost | undefined
    if (host === undefined || typeof host !== 'object' || typeof host.forWorkspace !== 'function') return undefined
    const candidate = host.forWorkspace(workspaceRoot, agent) as VwaArgumentDeliveryProvider | undefined
    if (candidate === undefined || typeof candidate !== 'object') return undefined
    if (typeof candidate.listBoundArtifacts !== 'function') return undefined
    if (typeof candidate.checkForDelivery !== 'function') return undefined
    if (typeof candidate.renderReport !== 'function') return undefined
    return candidate
  } catch {
    return undefined
  }
}

/**
 * The current-project pointer (§10.2): `<workspaceRoot>/.dsh/vwa/
 * current-project.json` = `{schemaVersion:1, projectId, workspaceIdentity}`.
 * Fail-soft: missing/corrupt ⇒ undefined (lane-1-only turn, no error).
 */
export function readCurrentProject(workspaceRoot: string): string | undefined {
  let text: string
  try {
    text = readFileSync(join(workspaceRoot, '.dsh', 'vwa', 'current-project.json'), 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(text) as { schemaVersion?: unknown; projectId?: unknown }
    if (parsed.schemaVersion !== 1) return undefined
    const projectId = parsed.projectId
    return typeof projectId === 'string' && projectId.startsWith('prj_') ? projectId : undefined
  } catch {
    return undefined
  }
}

/** Presented files of the turn's session (§17.3 — the only delivery event). */
export function presentedFiles(events: readonly EvalEvent[]): { path: string }[] {
  const out: { path: string }[] = []
  for (const event of events) {
    if (event.type !== 'deliverables/presented') continue
    const files = event.data?.files
    if (!Array.isArray(files)) continue
    for (const file of files) {
      if (typeof file?.path === 'string' && file.path.length > 0) out.push({ path: file.path })
    }
  }
  return out
}

/** SHA-256 of a file's current bytes, or undefined when unreadable. */
function fileHash(path: string): string | undefined {
  try {
    return sha256Hex(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Delivery state per §17.3: `eligibleForReviewed` is the reviewed CANDIDATE
 * (the receipt read-back result upgrades it in the caller); the
 * delivered-* states require a real `deliverables/presented` event listing
 * BOTH the artifact and the report with hashes matching the current
 * binding. Otherwise the state stays draft/reviewed ("delivery
 * unconfirmed").
 */
export function deliveryState(input: {
  eligibleForReviewed: boolean
  workspaceRoot: string
  events: readonly EvalEvent[]
  artifactPath: string
  artifactHash: string
  reportPath: string
  reportHash: string
}): ReceiptV2Delivery {
  let bodyPresented = false,
    reportPresented = false
  const artifact = resolve(input.workspaceRoot, input.artifactPath)
  const report = resolve(input.workspaceRoot, input.reportPath)
  for (const file of presentedFiles(input.events)) {
    const absolute = resolve(input.workspaceRoot, file.path),
      hash = fileHash(absolute)
    if (absolute === artifact && hash === input.artifactHash) bodyPresented = true
    if (input.reportPath && absolute === report && hash === input.reportHash) reportPresented = true
  }
  if (bodyPresented && reportPresented) return input.eligibleForReviewed ? 'delivered-reviewed' : 'delivered-unverified'

  return input.eligibleForReviewed ? 'reviewed' : 'draft'
}

type ReceiptV2Delivery = ReceiptV2['delivery']

/**
 * Write the report artifact for the frozen evaluation under
 * `.dsh/vwa/<projectId>/reports/<artifactId>.md` (§16.1a: the report is
 * written FIRST; the receipt references its hash). Best-effort: on failure
 * the report hash is the empty-file digest and the gap is disclosed to the
 * debug sink by the caller.
 */
export function writeBoundReport(
  workspaceRoot: string,
  projectId: string,
  text: string,
  artifactId: string,
): { path: string; hash: string } {
  const absoluteDir = join(workspaceRoot, 'docs', 'vwa-reports', projectId)
  const relativePath = `docs/vwa-reports/${projectId}/${artifactId}.review.md`
  const absolute = join(workspaceRoot, relativePath)
  mkdirSync(absoluteDir, { recursive: true })
  writeFileSync(absolute, text, 'utf8')
  if (fileHash(absolute) !== sha256Hex(text)) throw new Error('report read-back failed')
  return { path: relativePath, hash: sha256Hex(text) }
}

/** Exists only for tests/providers that pre-check report rendering. */
export function reportPresent(absolutePath: string): boolean {
  return existsSync(absolutePath)
}

/** Input for building one v:2 receipt row from a frozen delivery check. */
export interface BuildReceiptV2Input {
  sessionId: string
  ts: number
  receiptId: string
  projectId: string
  artifactPath: string
  events: readonly EvalEvent[]
  workspaceRoot: string
  parentHash: string
  report: { path: string; hash: string }
  check: DeliveryCheckLike
  /** When review has never run, the row is abstained with no pendingRunIds. */
  neverRun: boolean
}

/**
 * The §16.2/§17.2 overall for one bound artifact: any layer fail or an
 * active blocker/major finding (not of kind disagreement — already netted
 * out by the provider's findingCounts) → fail; all machine predicates met
 * → pass; otherwise (incl. never-run/pending) → abstained. Never-run and
 * pending rows carry pendingRunIds and overall abstained (§16.2).
 */
export function overallOf(check: DeliveryCheckLike, neverRun: boolean): 'pass' | 'fail' | 'abstained' {
  if (neverRun || check.pendingRunIds.length > 0) return 'abstained'
  const layers = [check.checks.evidence, check.checks.argument, check.checks.audit]
  if (check.checks.mechanical === 'fail') return 'fail'
  if (layers.includes('fail')) return 'fail'
  if (check.findingCounts.blocker > 0 || check.findingCounts.major > 0) return 'fail'
  if (
    check.eligibleForReviewed &&
    check.checks.mechanical !== 'not-run' &&
    !layers.includes('needs-review') &&
    !layers.includes('not-run')
  )
    return 'pass'
  return 'abstained'
}

/** Assemble the v:2 receipt row (§16.1). Pure: no writes, no model calls. */
export function buildReceiptV2(input: BuildReceiptV2Input): ReceiptV2 {
  const { check, neverRun } = input
  const pendingRunIds = neverRun ? [] : [...check.pendingRunIds]
  const overall = overallOf(check, neverRun)
  return {
    v: 2,
    receiptId: input.receiptId,
    ts: input.ts,
    sessionId: input.sessionId,
    projectId: input.projectId,
    projectRevision: check.projectRevision,
    artifactId: check.artifactId,
    artifactPath: input.artifactPath,
    artifactHash: check.artifactHash,
    graphHash: check.graphHash,
    policyHash: check.policyHash,
    reviewerConfigHash: check.reviewerConfigHash,
    claims: check.assessments.map((assessment) => ({
      claimId: assessment.claimId,
      spans: check.claimBindings?.find((b) => b.claimId === assessment.claimId)?.spans ?? [],
      sources: check.claimBindings?.find((b) => b.claimId === assessment.claimId)?.sources ?? [],
      assessment,
    })),
    numbers: [],
    gates: check.gates ?? [],
    checks: check.checks,
    metrics: check.metrics,
    reviewRunIds: [...check.reviewRunIds],
    ...(pendingRunIds.length > 0 ? { pendingRunIds } : {}),
    findingCounts: check.findingCounts,
    report: input.report,
    provenance: {
      inputs: dedupeSortedInputs(check.sources),
      parentHash: input.parentHash,
    },
    delivery: deliveryState({
      eligibleForReviewed: overall !== 'abstained' && check.eligibleForReviewed,
      workspaceRoot: input.workspaceRoot,
      events: input.events,
      artifactPath: input.artifactPath,
      artifactHash: check.artifactHash,
      reportPath: input.report.path,
      reportHash: input.report.hash,
    }),
    overall,
    nudge: { round: 0 },
  }
}

/** Deduplicated, sorted list of all sources actually used (§16.1). */
function dedupeSortedInputs(
  sources: readonly { sourceId: string; snapshotHash: string }[],
): { sourceId: string; revisionHash: string }[] {
  const seen = new Map<string, string>()
  for (const source of sources) seen.set(source.sourceId, source.snapshotHash)
  return [...seen.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([sourceId, revisionHash]) => ({ sourceId, revisionHash }))
}

/**
 * Nudge targets for a failing bound artifact (§16.2 step 7): exact targets
 * (failing layers, blocker/major findings) + the suggested tool request.
 */
export function boundNudgeTargets(projectId: string, check: DeliveryCheckLike, neverRun: boolean): string[] {
  if (neverRun) return [`review has never run for ${check.artifactId}`]
  const targets: string[] = []
  if (check.checks.mechanical === 'fail') targets.push('mechanical checks fail')
  for (const [layer, verdict] of [
    ['evidence', check.checks.evidence],
    ['argument', check.checks.argument],
    ['audit', check.checks.audit],
  ] as const) {
    if (verdict === 'fail' || verdict === 'needs-review') targets.push(`${layer} checks: ${verdict}`)
  }
  const active = check.findings.filter(
    (finding) => (finding.severity === 'blocker' || finding.severity === 'major') && finding.kind !== 'disagreement',
  )
  for (const finding of active.slice(0, 10)) targets.push(`${finding.severity} ${finding.id}: ${finding.explanation}`)
  if (check.pendingRunIds.length > 0) targets.push(`pending review runs: ${check.pendingRunIds.join(', ')}`)
  return [
    `suggested: argument.review {projectId: "${projectId}", expectedRevision: ${check.projectRevision}, requestId: "<new UUID v4>", input: {artifactId: "${check.artifactId}", stage: "all"}}`,
    ...targets,
  ]
}
