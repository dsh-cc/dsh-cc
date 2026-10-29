/**
 * §A.2/A.3.2 continuation planning: the shared task plan + reuse selection used
 * by BOTH the tool-level NOTHING_TO_CONTINUE pre-check (tools.ts) and the
 * runner's continue-mode guard, so they cannot diverge.
 *
 * The plan is computed over the full persisted history only (§A.3.4): records
 * from prior runs determine reuse eligibility. Because `taskDependencyDigest`
 * hashes only semantic record content (§A.3.3), digests computed here match
 * the digests baked into prior records.
 *
 * @module @dsh-cc/vwa-argument/review-continue
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { sha256Hex, stableJson } from './schema.ts'
import { buildReverseIndex } from './dependencies.ts'
import { computeCoreSet, planStage, type ReviewStage, type ReviewTask } from './review-plan.ts'
import { ReviewRunStore, cacheKey, recordReusable } from './review-run-store.ts'
import { taskDependencyDigest } from './review-input.ts'
import { currentReviews } from './review-current.ts'
import { policyHash, promptHash, recordMatchesKey } from './review-contract.ts'
import { auditInputHash, effectiveAuditUnitChars, hasReusableAudit } from './audit-reuse.ts'
import { cycleBudgetRefusal, cycleUsage } from './review-cycle.ts'
import type { ReviewBudget } from './review-budget.ts'
import { fail, type Fail } from './store.ts'
import type { ReviewModelAdapter } from './review-adapter.ts'
import type { Hash, Id, ProjectSnapshot, ReviewRecord } from './types.ts'

export interface PlannedTask {
  stage: ReviewStage
  task: ReviewTask
  inputHash: Hash
}

/** All hash-verified records across every run of one project. */
export function allRecords(root: string, projectId: string): ReviewRecord[] {
  const store = new ReviewRunStore(root, projectId)
  try {
    return readdirSync(join(root, '.dsh', 'vwa', projectId, 'review-runs')).flatMap((id) => store.readRecords(id))
  } catch {
    return []
  }
}

export function collectCachedRecords(root: string, projectId: string, key: Hash): ReviewRecord[] {
  // F3.1: key comparison goes through the one shared matcher.
  return allRecords(root, projectId).filter((r) => recordMatchesKey(r, key))
}

/**
 * Frozen core set: contract coreness plus coreness discovered by prior align
 * records over the same artifact bytes (§A.3.4). Pass `history` when the
 * caller already read it; otherwise it is read here.
 */
export function frozenCoreSet(input: {
  root: string
  index: ReturnType<typeof buildReverseIndex>
  snapshot: ProjectSnapshot
  artifact?: { id: Id; text: string }
  history?: ReviewRecord[]
}): Set<Id> {
  const core = computeCoreSet({
    index: input.index,
    artifactText: input.artifact?.text ?? '',
    requiredQuestionTexts: input.snapshot.contract.requiredQuestions.map((q) => q.text),
  })
  if (input.artifact) {
    const artifactHash = sha256Hex(input.artifact.text)
    for (const r of input.history ?? allRecords(input.root, input.snapshot.projectId)) {
      if (r.stage !== 'align' || r.artifactHash !== artifactHash) continue
      for (const id of r.coreClaimIds ?? []) if (input.index.claims.has(id)) core.add(id)
    }
  }
  return core
}

/** Inputs shared by the tool pre-check and the runner guard. */
export interface ContinuePlanInput {
  root: string
  adapter: Pick<ReviewModelAdapter, 'configFingerprint'>
  contractHash: Hash
  snapshot: ProjectSnapshot
  stages: ReviewStage[]
  targetClaimIds: Id[]
  artifact?: { id: Id; text: string }
  /** Audit unit sizing (same defaults as the runner) — part of the audit cache key. */
  skipAudit?: boolean
  maxUnitChars?: number
  maxContextChars?: number
  /** Frozen per-cycle budget; when present, a spent cycle refuses with BUDGET_EXHAUSTED. */
  budget?: ReviewBudget
  /** The run asking (runner guard): excluded from its own cycle's spend. */
  runId?: Id
  /** Persisted history the caller already read (read once per check otherwise). */
  history?: ReviewRecord[]
}

/** Everything planning derives from history, computed once per check. */
interface PlanningContext {
  history: ReviewRecord[]
  index: ReturnType<typeof buildReverseIndex>
  configHash: Hash
  core: Set<Id>
  /** Current upstream judgments over history (planning only sees persisted records). */
  upstream: ReviewRecord[]
}

function planningContext(input: ContinuePlanInput): PlanningContext {
  const history = input.history ?? allRecords(input.root, input.snapshot.projectId)
  const index = buildReverseIndex(input.snapshot)
  const configHash = sha256Hex(stableJson(input.adapter.configFingerprint()))
  const core = frozenCoreSet({
    root: input.root,
    index,
    snapshot: input.snapshot,
    history,
    ...(input.artifact ? { artifact: input.artifact } : {}),
  })
  const upstream = currentReviews(input.snapshot, history, input.targetClaimIds, configHash).records
  return { history, index, configHash, core, upstream }
}

/** Plan every non-audit stage task with its cache key, over the persisted history as of now. */
export function planContinueTasks(input: ContinuePlanInput, context = planningContext(input)): PlannedTask[] {
  const { index, configHash, core, upstream } = context
  const out: PlannedTask[] = []
  for (const stage of input.stages) {
    // The audit is keyed separately (audit-reuse.ts; see continueHasWork).
    if (stage === 'audit') continue
    const tasks = planStage({
      stage, snapshot: input.snapshot, index, targetClaimIds: input.targetClaimIds, core,
      claimsBatchSize: input.snapshot.contract.reviewSettings?.claimsBatchSize ?? 1,
    })
    for (const task of tasks) {
      out.push({
        stage,
        task,
        inputHash: cacheKey({
          stage,
          targetRefs: task.targetRefs,
          requiredRules: task.requiredRules,
          dependencyDigest: taskDependencyDigest(index, task, upstream),
          contractHash: input.contractHash,
          policyHash: policyHash(),
          reviewerConfigHash: configHash,
          promptHash: promptHash(stage),
        }),
      })
    }
  }
  return out
}

/**
 * §A.2 guard: true when at least one planned semantic task lacks a reusable
 * completed record, or the requested audit has no reusable completed audit
 * under its full input key (artifact bytes, audit dependency digest, core set,
 * contract, policy, prompts, reviewer config, unit size).
 */
export function continueHasWork(input: ContinuePlanInput): boolean {
  const context = planningContext(input)
  const { history } = context
  const semantic = planContinueTasks(input, context).some(({ inputHash, task }) => {
    const required = new Set(task.requiredRules.map((r) => r.ruleId))
    return !history.some((r) => recordMatchesKey(r, inputHash) && r.kind !== 'disagreement' && recordReusable(r, required))
  })
  if (semantic || !input.stages.includes('audit')) return semantic
  // Without a bound artifact the runner ends 'incomplete'; never refuse that as "nothing to do".
  if (input.artifact === undefined) return true
  // §5.2: the shared predicate — an in-effect skip means audit is not re-planned.
  if (input.skipAudit === true) return false
  const inputHash = auditInputHash({
    snapshot: input.snapshot,
    artifact: input.artifact,
    records: context.upstream,
    coreClaimIds: context.core,
    contractHash: input.contractHash,
    reviewerConfigHash: context.configHash,
    unitChars: effectiveAuditUnitChars(input),
  })
  return !hasReusableAudit(history, inputHash)
}

/**
 * §A.3.2 record selection. Default mode keeps the legacy behavior: the first
 * reusable record from the SAME requestId's runs (prior.find). Continue mode
 * widens reuse to any run and picks deterministically: most recent `endedAt`
 * first, tie-broken by recordHash (sha256 of the stable record) ascending.
 * A completed record with a `fail` verdict IS reusable (fail-stands) —
 * recordReusable implements that; no verdict filtering here. Disagreement
 * marker copies are excluded in both modes.
 */
export function reusableRecord(
  prior: ReviewRecord[],
  task: ReviewTask,
  continueMode: boolean,
  ownRuns: ReadonlySet<string>,
): ReviewRecord | undefined {
  const required = new Set(task.requiredRules.map((r) => r.ruleId))
  // A disagreement marker is a runtime copy whose findings REPLACE the real
  // judgment's; it shares endedAt/inputHash, so it must never be a reuse source.
  const eligible = prior.filter(
    (r) => r.kind !== 'disagreement' && recordReusable(r, required) && (continueMode || ownRuns.has(r.runId)),
  )
  if (!continueMode) return eligible[0]
  return [...eligible].sort(
    (a, b) =>
      b.endedAt.localeCompare(a.endedAt) || sha256Hex(stableJson(a)).localeCompare(sha256Hex(stableJson(b))),
  )[0]
}

/**
 * §A.2 synchronous tool pre-check: undefined when the continue run has work
 * and its review cycle has budget left; otherwise NOTHING_TO_CONTINUE or
 * BUDGET_EXHAUSTED. The runner's in-run guard calls
 * the same function, so the tool and the runner cannot diverge.
 */
export function continuePreCheck(input: ContinuePlanInput): Fail | undefined {
  if (!continueHasWork(input)) return nothingToContinue()
  if (input.budget === undefined) return undefined
  return cycleBudgetRefusal(input.budget, cycleUsage(input.root, input.snapshot.projectId, input.runId))
}

/** The single NOTHING_TO_CONTINUE refusal shared by the tool pre-check, the runner guard and replay. */
export function nothingToContinue(): Fail {
  return fail(
    'NOTHING_TO_CONTINUE',
    'All planned tasks already have completed records. Use a fresh request (without continue) for an explicit second opinion.',
    false,
  )
}

/** Freeze the effective reviewer config before the tool hashes or reserves anything. */
export async function prepareContinuePreCheck(input: Parameters<typeof continuePreCheck>[0] & {
  adapter: Pick<ReviewModelAdapter, 'configFingerprint' | 'initialize'>
  maxOutputTokens: number
  signal: AbortSignal
}): Promise<Fail | undefined> {
  try {
    await input.adapter.initialize?.(input.maxOutputTokens, input.signal)
  } catch {
    // A cancelled request is final for this requestId (§10.1 table), never "retry".
    if (input.signal.aborted) return fail('CANCELLED', 'the review request was cancelled during reviewer initialization', false)
    return fail('REVIEW_UNAVAILABLE', 'reviewer initialization failed; retry the request', true)
  }
  if (input.signal.aborted) return fail('CANCELLED', 'the review request was cancelled during reviewer initialization', false)
  return continuePreCheck(input)
}

/**
 * §10.6 target defaulting: an empty targetClaimIds means every claim with an
 * occurrence in the bound artifact (the named one, or the only one); with no
 * bound artifact, every project claim.
 */
export function resolveTargetClaimIds(
  snapshot: ProjectSnapshot,
  body: { artifactId?: string; targetClaimIds?: string[] },
): Id[] {
  if (body.targetClaimIds !== undefined && body.targetClaimIds.length > 0) return body.targetClaimIds
  const artifact =
    body.artifactId !== undefined
      ? snapshot.artifacts.find((candidate) => candidate.id === body.artifactId)
      : snapshot.artifacts.length === 1
        ? snapshot.artifacts[0]
        : undefined
  if (artifact !== undefined) return [...new Set(artifact.occurrences.map((occurrence) => occurrence.claimId))]
  return snapshot.claims.map((claim) => claim.id)
}
