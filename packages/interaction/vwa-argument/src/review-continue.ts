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
import { policyHash, promptHash } from './review-contract.ts'
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
  return allRecords(root, projectId).filter((r) => r.inputHash === key)
}

/**
 * Frozen core set: contract coreness plus coreness discovered by prior align
 * records over the same artifact bytes (§A.3.4).
 */
export function frozenCoreSet(input: {
  root: string
  index: ReturnType<typeof buildReverseIndex>
  snapshot: ProjectSnapshot
  artifact?: { id: Id; text: string }
}): Set<Id> {
  const core = computeCoreSet({
    index: input.index,
    artifactText: input.artifact?.text ?? '',
    requiredQuestionTexts: input.snapshot.contract.requiredQuestions.map((q) => q.text),
  })
  if (input.artifact) {
    const artifactHash = sha256Hex(input.artifact.text)
    for (const r of allRecords(input.root, input.snapshot.projectId)) {
      if (r.stage !== 'align' || r.artifactHash !== artifactHash) continue
      for (const id of r.coreClaimIds ?? []) if (input.index.claims.has(id)) core.add(id)
    }
  }
  return core
}

/** Plan every non-audit stage task with its cache key, over the persisted history as of now. */
export function planContinueTasks(input: {
  root: string
  adapter: Pick<ReviewModelAdapter, 'configFingerprint'>
  contractHash: Hash
  snapshot: ProjectSnapshot
  stages: ReviewStage[]
  targetClaimIds: Id[]
  artifact?: { id: Id; text: string }
}): PlannedTask[] {
  const index = buildReverseIndex(input.snapshot)
  const history = allRecords(input.root, input.snapshot.projectId)
  const configHash = sha256Hex(stableJson(input.adapter.configFingerprint()))
  const core = frozenCoreSet({
    root: input.root,
    index,
    snapshot: input.snapshot,
    ...(input.artifact ? { artifact: input.artifact } : {}),
  })
  const out: PlannedTask[] = []
  for (const stage of input.stages) {
    // §A.2 caveat: audit/align records are never reusable (recordReusable
    // excludes 'extract'), so a continue run including 'audit' always has
    // fresh work — the NOTHING_TO_CONTINUE guard naturally won't fire.
    if (stage === 'audit') continue
    const tasks = planStage({ stage, snapshot: input.snapshot, index, targetClaimIds: input.targetClaimIds, core })
    for (const task of tasks) {
      const upstream = currentReviews(input.snapshot, history, input.targetClaimIds, configHash).records
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

/** §A.2 guard: true when at least one planned task lacks a reusable completed record. */
export function continueHasWork(input: { planned: PlannedTask[]; history: ReviewRecord[] }): boolean {
  return input.planned.some(({ inputHash, task }) => {
    const required = new Set(task.requiredRules.map((r) => r.ruleId))
    return !input.history.some((r) => r.inputHash === inputHash && recordReusable(r, required))
  })
}

/**
 * True when the requested stages include the audit stage: audit tasks are
 * planned and executed outside the per-target cache-key path, and their
 * records are never reusable, so such a continuation ALWAYS has fresh work —
 * the NOTHING_TO_CONTINUE guard must not fire (§A.2 "every planned task").
 */
export function continueIncludesAudit(stages: ReviewStage[]): boolean {
  return stages.includes('audit')
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
 * §A.2 synchronous tool pre-check: undefined when the continue run has work;
 * otherwise the NOTHING_TO_CONTINUE refusal. Uses the same planning logic as
 * the runner's guard, so the tool and the runner cannot diverge.
 */
export function continuePreCheck(input: {
  root: string
  adapter: Pick<ReviewModelAdapter, 'configFingerprint'>
  contractHash: Hash
  snapshot: ProjectSnapshot
  stages: ReviewStage[]
  targetClaimIds: Id[]
  artifact?: { id: Id; text: string }
}): Fail | undefined {
  // Audit stages always carry fresh work (§A.2; see continueIncludesAudit).
  if (continueIncludesAudit(input.stages)) return undefined
  const planned = planContinueTasks(input)
  if (continueHasWork({ planned, history: allRecords(input.root, input.snapshot.projectId) })) return undefined
  return nothingToContinue()
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
    return fail('REVIEW_UNAVAILABLE', 'reviewer initialization failed; retry the request', true)
  }
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
