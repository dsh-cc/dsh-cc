/**
 * Mutating revision commands: apply, compare, restore, finalize, and link
 * (plan §6, §7.5, §11). `dispatch` holds the lock; these functions assume it.
 */

import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  readBoolean,
  readHash,
  readUuid,
  validateApplication,
  validateCheck,
  validateProposal,
} from './contracts.lib.mjs'
import {
  atomicWrite,
  decodeUtf8,
  fail,
  readBytes,
  readJsonIfExists,
  readSnapshot,
  sha256,
  writeSnapshot,
} from './files.lib.mjs'
import {
  addArtifact,
  advancePhase,
  bodyAbs,
  contextComplete,
  currentCheck,
  currentReviews,
  projectionMatches,
  saveRun,
  validateOrFail,
} from './state.lib.mjs'
import { checkSpans, compareBodies } from './preservation.lib.mjs'
import { hashInput, schemaCall } from './inputs.lib.mjs'
import { computeOutline, verifyOutline } from './outline.lib.mjs'
import { profileStructure } from './record.lib.mjs'
import { renderReport } from './report.lib.mjs'

const LANGUAGE_INTENTS = ['clarity', 'concision', 'style']

function bodyHashOnDisk(ctx) {
  return sha256(readBytes(bodyAbs(ctx), 'body'))
}

// ----------------------------------------------------------------------- apply

export function applyCommand(ctx, shape) {
  const expectedBodyHash = hashInput(shape.expectedBodyHash, 'expectedBodyHash')
  const proposalId = schemaCall(() => readUuid(shape.proposalId, 'proposalId'))
  const raw = readJsonIfExists(join(ctx.runAbs, 'proposals', `${proposalId}.json`), 'proposal')
  if (raw === null) fail('INVALID_INPUT', 'proposalId: no recorded proposal with that id')
  if (ctx.brief.operation === 'review' || !ctx.brief.allowBodyChanges) {
    fail('PERMISSION_REQUIRED', 'apply: this run has no permission to change the body')
  }
  if (expectedBodyHash !== ctx.run.bodyHash) fail('STALE_BODY', 'body changed since the expected hash was read')
  if (raw.bodyHash !== ctx.run.bodyHash) fail('STALE_BODY', 'proposal base hash does not match the current body')
  const replay = ctx.run.appliedProposals.find((entry) => entry.proposalId === proposalId)
  if (replay !== undefined) return { runPath: ctx.runRel, proposalId, alreadyApplied: true, ...replay }
  const proposal = validateOrFail(validateProposal(raw), 'proposal')
  const intent = proposal.intent
  checkBudget(ctx, intent)
  const target = bodyAbs(ctx)
  const baseBytes = readBytes(target, 'body')
  const baseHash = sha256(baseBytes)
  if (baseHash !== expectedBodyHash) fail('STALE_BODY', 'body changed since the proposal was recorded')
  const baseText = decodeUtf8(baseBytes, 'body')
  const checked = checkSpans(
    baseText,
    proposal.edits.map((edit) => ({ start: edit.start, end: edit.end, quote: edit.before })),
  )
  if (!checked.ok) fail(checked.code, checked.message, checked.details)
  const candidateText = buildCandidate(baseText, proposal.edits)
  checkLineEndings(baseText, candidateText)
  const candidateBytes = Buffer.from(candidateText, 'utf8')
  const afterHash = sha256(candidateBytes)

  // Write order (plan §6): before-snapshot, immutable application, run.json
  // reservation, re-hash body, atomic rename, after-snapshot, artifactPaths.
  const beforeSnapshot = writeSnapshot(ctx.runAbs, ctx.runRel, baseBytes)
  const applicationId = randomUUID()
  const appliedAt = new Date().toISOString()
  const application = {
    schemaVersion: 1,
    kind: 'application',
    id: applicationId,
    runId: ctx.run.runId,
    proposalId,
    intent,
    beforeHash: baseHash,
    afterHash,
    appliedAt,
  }
  validateOrFail(validateApplication(application), 'application')
  const applicationBytes = Buffer.from(`${JSON.stringify(application, null, 2)}\n`, 'utf8')
  atomicWrite(join(ctx.runAbs, 'applications', `${applicationId}.json`), applicationBytes)
  const beforeLanguagePass = ctx.run.languagePass
  const beforeSemanticRepair = ctx.run.semanticRepairUsed
  reserveCounter(ctx.run, intent)
  ctx.run.appliedProposals.push({ proposalId, intent, beforeHash: baseHash, afterHash, appliedAt })
  addArtifact(ctx.run, `${ctx.runRel}/applications/${applicationId}.json`, sha256(applicationBytes), 'application')
  addArtifact(ctx.run, beforeSnapshot.path, beforeSnapshot.hash, 'snapshot')
  saveRun(ctx)

  if (bodyHashOnDisk(ctx) !== expectedBodyHash) {
    fail('STALE_BODY', 'body changed between the reservation and the rename; the body was not replaced', { proposalId })
  }
  atomicWrite(target, candidateBytes)
  const afterSnapshot = writeSnapshot(ctx.runAbs, ctx.runRel, candidateBytes)
  ctx.run.bodyHash = afterHash
  addArtifact(ctx.run, afterSnapshot.path, afterSnapshot.hash, 'snapshot')
  if (LANGUAGE_INTENTS.includes(intent) && beforeLanguagePass === 0 && !beforeSemanticRepair) {
    // During language editing the accepted baseline is the pre-language snapshot (§5.3).
    ctx.run.acceptedBodyHash = baseHash
  }
  advancePhase(ctx)
  saveRun(ctx)
  return {
    runPath: ctx.runRel,
    proposalId,
    applicationId,
    beforeHash: baseHash,
    afterHash,
    appliedAt,
    phase: ctx.run.phase,
    structuralRound: ctx.run.structuralRound,
    languagePass: ctx.run.languagePass,
    languageIntentsUsed: ctx.run.languageIntentsUsed,
    semanticRepairUsed: ctx.run.semanticRepairUsed,
  }
}

function checkBudget(ctx, intent) {
  const run = ctx.run
  if (intent === 'structure' && run.structuralRound >= ctx.brief.repairRounds) {
    fail('BUDGET_EXHAUSTED', 'apply: no structural repair rounds remain', { limit: ctx.brief.repairRounds })
  }
  if (intent === 'clarity' && (run.languagePass >= 2 || run.languageIntentsUsed.includes('clarity'))) {
    fail('BUDGET_EXHAUSTED', 'apply: the clarity pass is already consumed')
  }
  if (
    (intent === 'concision' || intent === 'style') &&
    (run.languagePass >= 2 || run.languageIntentsUsed.includes('concision-style'))
  ) {
    fail('BUDGET_EXHAUSTED', 'apply: the concision/style slot is already consumed')
  }
  if (intent === 'semantic-repair' && run.semanticRepairUsed) {
    fail('BUDGET_EXHAUSTED', 'apply: the semantic repair allowance is already consumed')
  }
}

function reserveCounter(run, intent) {
  if (intent === 'structure') {
    run.structuralRound += 1
  } else if (LANGUAGE_INTENTS.includes(intent)) {
    run.languagePass += 1
    run.languageIntentsUsed.push(intent === 'clarity' ? 'clarity' : 'concision-style')
  } else if (intent === 'semantic-repair') {
    run.semanticRepairUsed = true
  }
}

function buildCandidate(text, edits) {
  let candidate = text
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    candidate = `${candidate.slice(0, edit.start)}${edit.after}${candidate.slice(edit.end)}`
  }
  return candidate
}

function checkLineEndings(baseText, candidateText) {
  if (baseText.includes('\r\n')) {
    if (/(?<!\r)\n/.test(candidateText)) fail('INVALID_INPUT', 'edit would introduce a bare LF into a CRLF body')
  } else if (candidateText.includes('\r')) {
    fail('INVALID_INPUT', 'edit would introduce a CR into an LF body')
  }
}

// -------------------------------------------------------------------- compare

export function compareCommand(ctx, shape) {
  const beforeHash = schemaCall(() => readHash(shape.beforeHash, 'beforeHash'))
  const afterHash = schemaCall(() => readHash(shape.afterHash, 'afterHash'))
  const beforeBytes = readSnapshot(ctx.runAbs, beforeHash)
  const afterBytes = readSnapshot(ctx.runAbs, afterHash)
  if (beforeBytes === null || afterBytes === null) {
    fail('PREREQUISITE_MISSING', 'compare: both snapshots must be recorded before comparing')
  }
  const afterText = decodeUtf8(afterBytes, 'after snapshot')
  const changes =
    beforeHash === afterHash
      ? []
      : compareBodies(decodeUtf8(beforeBytes, 'before snapshot'), afterText, {
          protectedTerms: ctx.brief.protectedTerms,
          profileProtectedTerms: ctx.profileTerms ?? [],
        }).map((change) => ({ ...change, disposition: 'pending', reason: null }))
  // The second checks writer: the compare path takes no model payload, so the
  // outline is computed here and verified by construction (§6).
  const structure = profileStructure(ctx)
  const outline = structure === null ? null : computeOutline(structure, afterText)
  const check = {
    schemaVersion: 1,
    kind: 'check',
    id: randomUUID(),
    runId: ctx.run.runId,
    beforeHash,
    afterHash,
    mechanicalStatus: changes.length === 0 ? 'clean' : 'changed',
    semanticStatus: 'not-run',
    changes,
    semanticReviewId: null,
    ...(outline === null ? {} : { outline }),
  }
  validateOrFail(validateCheck(check), 'check')
  const bytes = Buffer.from(`${JSON.stringify(check, null, 2)}\n`, 'utf8')
  atomicWrite(join(ctx.runAbs, 'checks', `${check.id}.json`), bytes)
  addArtifact(ctx.run, `${ctx.runRel}/checks/${check.id}.json`, sha256(bytes), 'check')
  saveRun(ctx)
  return {
    runPath: ctx.runRel,
    checkId: check.id,
    beforeHash,
    afterHash,
    mechanicalStatus: check.mechanicalStatus,
    semanticStatus: 'not-run',
    changes,
    outline: outline ?? null,
    profile: ctx.profile === null ? null : ctx.profile.id,
  }
}

// -------------------------------------------------------------------- restore

export function restoreCommand(ctx, shape) {
  const snapshotHash = schemaCall(() => readHash(shape.snapshotHash, 'snapshotHash'))
  const expectedBodyHash = hashInput(shape.expectedBodyHash, 'expectedBodyHash')
  if (ctx.brief.operation === 'review' || !ctx.brief.allowBodyChanges) {
    fail('PERMISSION_REQUIRED', 'restore: this run has no permission to change the body')
  }
  if (expectedBodyHash !== ctx.run.bodyHash) fail('STALE_BODY', 'restore: body changed since the expected hash was read')
  if (snapshotHash !== ctx.run.acceptedBodyHash) {
    fail('INVALID_INPUT', 'restore: only the run accepted baseline may be restored', {
      acceptedBodyHash: ctx.run.acceptedBodyHash,
    })
  }
  const baseline = readSnapshot(ctx.runAbs, snapshotHash)
  if (baseline === null) fail('PREREQUISITE_MISSING', 'restore: the accepted baseline snapshot is missing')
  decodeUtf8(baseline, 'restore snapshot')
  const target = bodyAbs(ctx)
  if (sha256(readBytes(target, 'body')) !== expectedBodyHash) fail('STALE_BODY', 'restore: body changed before the rename')
  atomicWrite(target, baseline)
  ctx.run.bodyHash = snapshotHash
  saveRun(ctx)
  return {
    runPath: ctx.runRel,
    restored: snapshotHash,
    bodyHash: snapshotHash,
    structuralRound: ctx.run.structuralRound,
    languagePass: ctx.run.languagePass,
    semanticRepairUsed: ctx.run.semanticRepairUsed,
  }
}

// ------------------------------------------------------------------- finalize

export function finalizeCommand(ctx, shape) {
  const expectedBodyHash = hashInput(shape.expectedBodyHash, 'expectedBodyHash')
  const cancelled =
    shape.cancelled === undefined ? false : schemaCall(() => readBoolean(shape.cancelled, 'cancelled'))
  const currentHash = bodyHashOnDisk(ctx)
  if (expectedBodyHash !== ctx.run.bodyHash || currentHash !== ctx.run.bodyHash) {
    fail('STALE_BODY', 'finalize: the body changed since the run recorded it', {
      bodyHash: ctx.run.bodyHash,
      currentHash,
    })
  }
  if (cancelled) {
    const report = renderReport(ctx, 'incomplete', { reason: 'cancelled by the user' })
    ctx.run.outcome = 'cancelled'
    saveRun(ctx)
    return { ...report, cancelled: true, phase: ctx.run.phase, outcome: 'cancelled' }
  }
  const completion = evaluateCompletion(ctx)
  const report = renderReport(ctx, completion.outcome, {
    reason: completion.missing.length === 0 ? undefined : `missing stages: ${completion.missing.join(', ')}`,
  })
  if (completion.outcome === 'checked-no-major-findings') {
    ctx.run.phase = 'finalized'
    ctx.run.outcome = 'completed'
    saveRun(ctx)
    return { ...report, editorialOutcome: report.outcome, phase: ctx.run.phase, outcome: 'completed' }
  }
  // The disjunction keeps the existing snapshot-loss 'blocked' semantics of
  // completion.blocked untouched (design §6 (c)).
  ctx.run.outcome = completion.outcome === 'blocked' || completion.blocked ? 'blocked' : 'active'
  saveRun(ctx)
  fail('REVIEW_INCOMPLETE', 'finalize: completion predicates are not met', {
    reportPath: report.reportPath,
    outcome: completion.outcome,
    missing: completion.missing,
  })
}

function evaluateCompletion(ctx) {
  const reviews = currentReviews(ctx)
  const rawCheck = currentCheck(ctx)
  const missing = []
  if (ctx.brief.operation === 'write') {
    if (!projectionMatches(ctx, 'plan', ctx.run.planHash)) missing.push('plan')
    if (!contextComplete(ctx)) missing.push('context')
    if (reviews.structure === undefined) missing.push('structure-review')
    if (reviews.semantics === undefined) missing.push('semantic-review')
    if (rawCheck === null) missing.push('final-check')
  } else if (ctx.brief.operation === 'edit') {
    if (reviews.language === undefined) missing.push('language-review')
    if (reviews.semantics === undefined) missing.push('semantic-review')
    if (rawCheck === null) missing.push('final-check')
  } else {
    if (reviews.structure === undefined) missing.push('structure-review')
    if (reviews.language === undefined) missing.push('language-review')
  }
  // Check-consuming replay (design §6): validate the stored shape, then
  // recompute the outline from the afterHash snapshot and compare field by
  // field. A missing snapshot skips the recompute — and the skip short-circuits
  // before presence symmetry — so the check is unavailable: 'final-check' enters
  // `missing`, the stored outline is not consumed, and finalize persists
  // 'blocked' through the existing completion.blocked arm.
  const check = rawCheck === null ? null : validateOrFail(validateCheck(rawCheck), 'check')
  const structure = profileStructure(ctx)
  if (check !== null && structure !== null) {
    const snapshot = readSnapshot(ctx.runAbs, check.afterHash)
    if (snapshot === null) {
      missing.push('final-check')
    } else {
      const outline = verifyOutline(check, decodeUtf8(snapshot, 'check after snapshot'), structure)
      if (outline.status === 'non-compliant') missing.push('outline')
    }
  } else if (check !== null && check.outline !== undefined) {
    fail('INVALID_INPUT', 'check.outline: the profile declares no structure')
  }
  const majorOpen = Object.values(reviews).some((current) =>
    current.review.findings.some((finding) => finding.status === 'open' && finding.severity === 'major'),
  )
  const blockingChanges =
    check !== null && check.changes.some((change) => change.disposition === 'pending' || change.disposition === 'defect')
  let outcome = 'checked-no-major-findings'
  if (missing.length === 1 && missing[0] === 'outline') {
    outcome = 'blocked'
  } else if (missing.length > 0) {
    outcome = 'incomplete'
  } else if (majorOpen) {
    outcome = 'findings-present'
  } else if (ctx.brief.operation !== 'review' && (check.semanticStatus !== 'no-issue-found' || blockingChanges)) {
    outcome = 'findings-present'
  }
  const blocked =
    missing.length > 0 &&
    ctx.run.bodyHash !== null &&
    !existsSync(join(ctx.runAbs, 'snapshots', `${ctx.run.bodyHash}.md`))
  return { outcome, missing, blocked }
}

// ----------------------------------------------------------------------- link

export function linkCommand(ctx, shape) {
  ctx.run.model = shape.model
  ctx.run.usage = shape.usage
  ctx.run.vwa = shape.vwa
  saveRun(ctx)
  return { runPath: ctx.runRel, model: ctx.run.model, usage: ctx.run.usage, vwa: ctx.run.vwa }
}
