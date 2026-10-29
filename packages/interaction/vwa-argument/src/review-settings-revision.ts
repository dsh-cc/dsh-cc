/**
 * F3.3 `set-review-settings` revision-op support (design
 * docs/plans/2026-10-21-vwa-review-settings-revision.md §F3.3): merge a
 * partial capacity patch into the frozen review settings without touching
 * record identity (the semantic contract hash excludes `reviewSettings`,
 * F3.1), and disclose the reuse semantics of the revision.
 *
 * @module @dsh-cc/vwa-argument/review-settings-revision
 */
import { ajvErrors, authorDefValidator } from './schema.ts'
import { VwaFail, fail } from './store.ts'
import type { ReviewBudget } from './review-budget.ts'
import type { DisagreementPolicy, FrozenReviewSettings, ProjectBudget } from './review-config.ts'
import { updateLatestCycleBudget } from './review-cycle.ts'

/** The seven ReviewBudget keys, each with its settings field name (F3.3 field map). */
export const REVIEW_BUDGET_KEYS = [
  'maxCallsPerRun', 'maxInputTokensPerRun', 'maxOutputTokensPerRun',
  'maxOutputTokensPerCall', 'wallMs', 'callTimeoutMs', 'concurrency',
] as const satisfies readonly (keyof ReviewBudget)[]

const ALLOWED_TOP = new Set(['budget', 'claimsBatchSize', 'maxArtifactChars', 'disagreementPolicy', 'projectBudget'])

/** F3.3 reuse disclosure surfaced with every successful revision result. */
export const REUSE_STATEMENT =
  'Sources, evidence, claims and completed review records are preserved: review-record identity ' +
  'excludes review settings. claimsBatchSize revision is reuse-shape-scoped — records match only ' +
  'within the same claims-batch shape, so delivery/progress may report claims not-run after a ' +
  'reshape. In-flight admissions that lose the revision race get REVISION_CONFLICT and must retry.'

type Patch = { budget?: Record<string, unknown>; claimsBatchSize?: unknown; maxArtifactChars?: unknown; disagreementPolicy?: unknown; projectBudget?: ProjectBudget }

function reject(code: Parameters<typeof fail>[0], message: string): never {
  throw new VwaFail(fail(code, message))
}

/**
 * Deep-merge ONLY explicitly provided keys of the patch over the current
 * frozen settings (no default materialization), then validate the MERGED
 * result against the FrozenReviewSettings author schema — a partial patch
 * cannot validate alone (the schema requires the full object).
 */
export function applyReviewSettingsPatch(
  current: FrozenReviewSettings,
  patch: Patch,
): { settings: FrozenReviewSettings; fieldsChanged: Record<string, { old: unknown; new: unknown }> } {
  for (const key of Object.keys(patch)) {
    if (key === 'maxContextChars') {
      // F3.3: maxContextChars is identity via effectiveAuditUnitChars in the
      // audit key and the envelope windowing budget — capacity revision refuses it.
      reject('SCHEMA_INVALID', 'maxContextChars cannot be revised: it is part of review-record identity (effectiveAuditUnitChars in the audit key) and the envelope windowing budget')
    }
    if (!ALLOWED_TOP.has(key)) {
      reject('SCHEMA_INVALID', `unknown set-review-settings field: ${key}; allowed: budget (7 ReviewBudget fields), claimsBatchSize, maxArtifactChars, disagreementPolicy, projectBudget`)
    }
  }
  const patchBudget = patch.budget
  if (patchBudget !== undefined && (typeof patchBudget !== 'object' || patchBudget === null || Array.isArray(patchBudget))) {
    reject('SCHEMA_INVALID', 'reviewSettings.budget must be an object of ReviewBudget fields')
  }
  for (const key of patchBudget === undefined ? [] : Object.keys(patchBudget)) {
    if (!(REVIEW_BUDGET_KEYS as readonly string[]).includes(key)) {
      reject('SCHEMA_INVALID', `unknown ReviewBudget field: ${key}`)
    }
  }
  const budget: ReviewBudget = { ...current.budget, ...(patchBudget ?? {}) }
  const patchProjectBudget = patch.projectBudget
  if (patchProjectBudget !== undefined && (typeof patchProjectBudget !== 'object' || patchProjectBudget === null || Array.isArray(patchProjectBudget))) {
    reject('SCHEMA_INVALID', 'reviewSettings.projectBudget must be an object of ProjectBudget fields')
  }
  // §5.1 trap: the rebuilt literal below must carry projectBudget too, or the
  // next revision silently drops it.
  const projectBudget = patchProjectBudget === undefined
    ? current.projectBudget
    : { ...current.projectBudget, ...patchProjectBudget }
  const disagreementPolicy =
    patch.disagreementPolicy !== undefined
      ? (patch.disagreementPolicy as DisagreementPolicy)
      : current.disagreementPolicy
  const merged: FrozenReviewSettings = {
    budget,
    maxArtifactChars: patch.maxArtifactChars !== undefined
      ? (patch.maxArtifactChars as number)
      : current.maxArtifactChars,
    maxContextChars: current.maxContextChars,
    claimsBatchSize: patch.claimsBatchSize !== undefined
      ? (patch.claimsBatchSize as number)
      : current.claimsBatchSize,
    ...(projectBudget === undefined ? {} : { projectBudget }),
    ...(disagreementPolicy === undefined ? {} : { disagreementPolicy }),
  }
  const validate = authorDefValidator('FrozenReviewSettings')
  if (!validate(merged)) {
    reject('SCHEMA_INVALID', `FrozenReviewSettings schema violation: ${ajvErrors(validate)}`)
  }
  const fieldsChanged: Record<string, { old: unknown; new: unknown }> = {}
  const note = (key: string, oldV: unknown, newV: unknown) => {
    if (oldV !== newV) fieldsChanged[key] = { old: oldV, new: newV }
  }
  for (const key of REVIEW_BUDGET_KEYS) note(`budget.${key}`, current.budget[key], budget[key])
  if (patch.claimsBatchSize !== undefined) note('claimsBatchSize', current.claimsBatchSize, merged.claimsBatchSize)
  if (patch.maxArtifactChars !== undefined) note('maxArtifactChars', current.maxArtifactChars, merged.maxArtifactChars)
  if (patch.disagreementPolicy !== undefined)
    note('disagreementPolicy', current.disagreementPolicy, merged.disagreementPolicy)
  if (patch.projectBudget !== undefined) note('projectBudget', current.projectBudget, merged.projectBudget)
  return { settings: merged, fieldsChanged }
}

/** F3.3 revision patch: only explicitly provided keys merge (partial allowed). */
export interface PatchReviewSettings {
  budget?: Partial<ReviewBudget>
  claimsBatchSize?: number
  maxArtifactChars?: number
  disagreementPolicy?: DisagreementPolicy
  /** Feature 4 §5.1: project-cumulative budget (merged key by key). */
  projectBudget?: ProjectBudget
}

/**
 * F3.3: merge the patch into the current frozen settings and return the new
 * contract plus the richer per-op revision result. contractChanged is
 * deliberately FALSE: record identity is the semantic contract hash (F3.1),
 * which excludes reviewSettings, so §15 invalidation does not apply.
 */
export function reviseFrozenSettings(
  contract: import('./types.ts').ProjectContract,
  patch: PatchReviewSettings,
): {
  contract: import('./types.ts').ProjectContract
  revision: ReviewSettingsRevisionOutcome & { reviewSettings: FrozenReviewSettings }
} {
  const current = contract.reviewSettings
  if (current === undefined) {
    reject('SCHEMA_INVALID', 'this project has no frozen review settings to revise')
  }
  const { settings, fieldsChanged } = applyReviewSettingsPatch(current, patch)
  return {
    contract: { ...contract, reviewSettings: settings },
    revision: { fieldsChanged, reuseStatement: REUSE_STATEMENT, contractChanged: false, reviewSettings: settings },
  }
}

/**
 * F3.4 post-commit side effect: after a successful set-review-settings commit,
 * update the LATEST review cycle's persisted budget (delegates to
 * review-cycle.ts). Future admissions see the new ceiling; in-flight runs
 * keep their locally frozen `deps.budget`. A failed update never fails the
 * already-committed mutation — it returns false so the caller can DISCLOSE
 * the not-yet-applied cycle budget (P3); returns undefined for non-revision
 * ops (nothing to sync).
 */
export function afterRevisionCommit(
  root: string, projectId: string, op: unknown, result: { ok: boolean; revision?: number; data?: unknown },
): boolean | undefined {
  if (result.ok !== true || op !== 'set-review-settings') return undefined
  const revised = (result.data as { reviewSettings?: FrozenReviewSettings }).reviewSettings
  if (revised === undefined) return undefined
  // The project revision fences the sync: a delayed sync from an older
  // revision cannot overwrite a newer cycle budget (F2).
  return updateLatestCycleBudget(root, projectId, revised.budget, result.revision ?? 0)
}

/** P3 disclosure appended when a committed revision could not update the current cycle's budget. */
export const CYCLE_BUDGET_NOT_APPLIED =
  'The current review cycle keeps its previous ceiling (its budget ledger could not be updated ' +
  'concurrently); the revised settings already apply to new cycles and to records — retry the same ' +
  'revision to apply it to the current cycle.'

/**
 * P3: annotate an otherwise-successful revision result when the cycle-budget
 * rewrite did not take effect, instead of silently swallowing the failure.
 * Returns the input unchanged for any other outcome.
 */
export function discloseCycleBudgetStatus<T extends { ok: boolean; data?: unknown }>(
  result: T, cycleBudgetUpdated: boolean | undefined,
): T {
  if (cycleBudgetUpdated !== false || result.ok !== true) return result
  return {
    ...result,
    data: {
      ...(result.data as Record<string, unknown>),
      cycleBudgetUpdated: false,
      cycleBudgetNote: CYCLE_BUDGET_NOT_APPLIED,
    },
  } as T
}

/** The full result shape of one committed set-review-settings mutation (§F3.3). */
export interface ReviewSettingsRevisionOutcome {
  fieldsChanged: Record<string, { old: unknown; new: unknown }>
  reuseStatement: string
  contractChanged: false
}
