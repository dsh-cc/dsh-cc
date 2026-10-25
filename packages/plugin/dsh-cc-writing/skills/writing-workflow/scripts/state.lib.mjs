/**
 * Run metadata, brief immutability, current-review selection, and phase
 * derivation shared by the mutating commands (plan §5.3, §6, §7.5).
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  validateBrief,
  validateContext,
  validatePlan,
  validateProfile,
  validateReview,
  validateRun,
} from './contracts.lib.mjs'
import {
  decodeUtf8,
  fail,
  readJsonFile,
  readJsonIfExists,
  readSnapshot,
  resolveWorkspacePath,
  sha256,
  writeJsonAtomic,
} from './files.lib.mjs'

export function validateOrFail(result, label) {
  if (!result.ok) fail('INVALID_INPUT', `${label}: ${result.message}`)
  return result.value
}

/** Load run.json and brief.json, enforcing brief immutability (STALE_BRIEF). */
export function loadContext(root, runPath) {
  const { abs: runAbs, rel: runRel } = resolveWorkspacePath(root, runPath, 'runPath')
  if (!existsSync(join(runAbs, 'run.json'))) fail('INVALID_INPUT', 'runPath: no run.json in that directory')
  const brief = validateOrFail(validateBrief(readJsonFile(join(runAbs, 'brief.json'), 'brief.json')), 'brief.json')
  const run = validateOrFail(
    validateRun(readJsonFile(join(runAbs, 'run.json'), 'run.json'), { repairRounds: brief.repairRounds }),
    'run.json',
  )
  if (run.runId !== brief.runId) fail('INVALID_INPUT', 'run.json and brief.json disagree on runId')
  const briefHash = sha256(readFileSync(join(runAbs, 'brief.json')))
  if (briefHash !== run.briefHash) {
    fail('STALE_BRIEF', 'brief.json changed after init; start a new run', { runPath: runRel })
  }
  const { profile, protectedTerms } = loadProfile(brief.profile)
  return { root, runAbs, runRel, brief, run, briefHash, profile, profileTerms: protectedTerms }
}

const PROFILE_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..', 'profiles')

/** Profiles are plugin resources; a missing profile contributes no terms. */
export function loadProfile(profileId) {
  const raw = readJsonIfExists(join(PROFILE_DIRECTORY, `${profileId}.json`), `profile ${profileId}`)
  if (raw === null) return { profile: null, protectedTerms: [] }
  const profile = validateOrFail(validateProfile(raw), `profile ${profileId}`)
  return { profile, protectedTerms: profile.protectedTerms }
}

export function saveRun(ctx) {
  ctx.run.updatedAt = new Date().toISOString()
  const validated = validateOrFail(validateRun(ctx.run, { repairRounds: ctx.brief.repairRounds }), 'run.json')
  writeJsonAtomic(join(ctx.runAbs, 'run.json'), validated)
  ctx.run = validated
  return validated
}

export function readSnapshotText(ctx, hash, label = 'snapshot') {
  const bytes = readSnapshot(ctx.runAbs, hash)
  if (bytes === null) fail('PREREQUISITE_MISSING', `${label}: snapshot ${hash} is missing`)
  return decodeUtf8(bytes, label)
}

export function addArtifact(run, path, hash, kind) {
  run.artifactPaths = run.artifactPaths.filter((entry) => entry.path !== path)
  run.artifactPaths.push({ path, hash, kind })
}

export function artifactOfKind(run, kind) {
  for (let i = run.artifactPaths.length - 1; i >= 0; i -= 1) {
    if (run.artifactPaths[i].kind === kind) return run.artifactPaths[i]
  }
  return null
}

export function runRelative(ctx, path) {
  const prefix = `${ctx.runRel}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

export function loadArtifact(ctx, entry, label) {
  if (entry === null) return null
  return readJsonIfExists(join(ctx.runAbs, runRelative(ctx, entry.path)), label)
}

/** Latest coverage-complete review per stage matching the current body/plan. */
export function currentReviews(ctx) {
  const byStage = {}
  for (const entry of ctx.run.artifactPaths) {
    if (entry.kind !== 'review') continue
    const raw = loadArtifact(ctx, entry, 'review')
    if (raw === null) continue
    const result = validateReview(raw)
    if (!result.ok) continue
    const review = result.value
    if (review.runId !== ctx.run.runId) continue
    if (review.coverage !== 'complete') continue
    if (review.bodyHash !== ctx.run.bodyHash) continue
    if (review.planHash !== ctx.run.planHash) continue
    if (review.stage === 'semantics') {
      // The pre-language beforeHash stays recorded after the final check moves
      // the accepted baseline; bodyHash matching still invalidates old reviews.
      if (review.beforeHash === null) continue
    } else if (review.beforeHash !== null) continue
    byStage[review.stage] = { review, path: entry.path }
  }
  return byStage
}

/** Latest check pairing the accepted baseline with the current body. */
export function currentCheck(ctx) {
  let found = null
  for (const entry of ctx.run.artifactPaths) {
    if (entry.kind !== 'check') continue
    const raw = loadArtifact(ctx, entry, 'check')
    // A passing check moves acceptedBodyHash to the final body, so match on the
    // final side; the latest recorded check for this body is current.
    if (raw === null || raw.afterHash !== ctx.run.bodyHash) continue
    found = raw
  }
  return found
}

export function projection(ctx, kind) {
  const entry = artifactOfKind(ctx.run, kind)
  if (entry === null) return null
  return readJsonIfExists(join(ctx.runAbs, runRelative(ctx, entry.path)), `${kind} projection`)
}

export function projectionMatches(ctx, kind, expectedHash) {
  const entry = artifactOfKind(ctx.run, kind)
  if (entry === null || expectedHash === null || entry.hash !== expectedHash) return false
  const abs = join(ctx.runAbs, runRelative(ctx, entry.path))
  if (!existsSync(abs)) return false
  try {
    return sha256(readFileSync(abs)) === expectedHash
  } catch {
    return false
  }
}

export function contextComplete(ctx) {
  if (ctx.run.planHash === null) return false
  const plan = projection(ctx, 'plan')
  const context = projection(ctx, 'context')
  if (plan === null || context === null) return false
  const planResult = validatePlan(plan)
  const contextResult = validateContext(context)
  if (!planResult.ok || !contextResult.ok) return false
  const planIds = planResult.value.sections.map((section) => section.id).sort()
  const contextIds = contextResult.value.sections.map((section) => section.sectionId).sort()
  if (planIds.length !== contextIds.length) return false
  return planIds.every((id, index) => id === contextIds[index])
}

function finalChecked(ctx, reviews) {
  if (reviews.semantics === undefined || currentCheck(ctx) === null) return false
  return true
}

/**
 * Latest completed milestone per the §6 transition table and §7.5. Phases are
 * monotonic: record never moves a run backwards.
 */
export function derivePhase(ctx) {
  const { run, brief } = ctx
  const reviews = currentReviews(ctx)
  if (brief.operation === 'review') {
    if (reviews.language) return 'language-revised'
    if (reviews.structure) return 'diagnosed'
    return null
  }
  if (brief.operation === 'edit') {
    if (finalChecked(ctx, reviews)) return 'checked'
    if (reviews.language) return 'language-revised'
    return null
  }
  if (finalChecked(ctx, reviews)) return 'checked'
  if (run.languagePass > 0 && reviews.language) return 'language-revised'
  if (run.structuralRound > 0 && reviews.structure) return 'structurally-revised'
  if (reviews.structure) return 'diagnosed'
  if (contextComplete(ctx) && run.bodyHash !== null) return 'drafted'
  if (projectionMatches(ctx, 'plan', run.planHash)) return 'planned'
  if (artifactOfKind(run, 'research') !== null) return 'researched'
  return null
}

const PHASE_ORDER = [
  'initialized',
  'researched',
  'planned',
  'drafted',
  'diagnosed',
  'structurally-revised',
  'language-revised',
  'checked',
  'finalized',
]

/** Monotonic phase update; finalized is never lowered. */
export function advancePhase(ctx) {
  const derived = derivePhase(ctx)
  if (derived === null || ctx.run.phase === 'finalized') return ctx.run.phase
  if (PHASE_ORDER.indexOf(derived) > PHASE_ORDER.indexOf(ctx.run.phase)) ctx.run.phase = derived
  return ctx.run.phase
}

export function bodyAbs(ctx) {
  return resolveWorkspacePath(ctx.root, ctx.brief.bodyPath, 'brief.bodyPath').abs
}
