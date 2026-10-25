/**
 * `record` command: validate model-produced artifacts, inject script-owned
 * hashes, archive immutable artifacts, and derive the phase (plan §5, §6, §7.5).
 */

import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  validateCheck,
  validateContext,
  validatePlan,
  validateProposal,
  validateResearch,
  validateReview,
} from './contracts.lib.mjs'
import { checkSpans, compareBodies, validateCoverage } from './preservation.lib.mjs'
import { scanBlocks } from './markdown.lib.mjs'
import { atomicWrite, fail, jsonBytes, sha256 } from './files.lib.mjs'
import {
  addArtifact,
  advancePhase,
  currentCheck,
  currentReviews,
  loadArtifact,
  projection,
  readSnapshotText,
  saveRun,
  validateOrFail,
} from './state.lib.mjs'

const INJECTED_HASH_FIELDS = ['bodyHash', 'planHash', 'beforeHash', 'afterHash']
const ARTIFACT_DIRECTORIES = { review: 'reviews', proposal: 'proposals', check: 'checks' }

export function recordCommand(ctx, input) {
  const artifact = input.artifact
  const kind = artifact.kind
  if (typeof kind !== 'string' || !['research', 'plan', 'context', 'review', 'proposal', 'check'].includes(kind)) {
    fail('INVALID_INPUT', 'artifact.kind: expected research, plan, context, review, proposal, or check')
  }
  for (const field of INJECTED_HASH_FIELDS) {
    if (Object.hasOwn(artifact, field)) {
      fail('INVALID_INPUT', `artifact.${field}: hash fields are supplied by the script, not the model`)
    }
  }
  checkExpectedHashes(ctx, input)
  if (kind === 'plan') return recordPlan(ctx, artifact)
  if (kind === 'research') return recordResearch(ctx, artifact)
  if (kind === 'context') return recordContext(ctx, artifact)
  if (kind === 'review') return recordReview(ctx, artifact)
  if (kind === 'proposal') return recordProposal(ctx, artifact)
  return recordCheck(ctx, artifact)
}

function checkExpectedHashes(ctx, input) {
  if (input.expectedBodyHash !== ctx.run.bodyHash) {
    fail('STALE_BODY', 'body changed since the expected hash was read', {
      expectedBodyHash: input.expectedBodyHash,
      bodyHash: ctx.run.bodyHash,
    })
  }
  if (input.expectedPlanHash !== ctx.run.planHash) {
    fail('STALE_PLAN', 'plan changed since the expected hash was read', {
      expectedPlanHash: input.expectedPlanHash,
      planHash: ctx.run.planHash,
    })
  }
}

// --------------------------------------------------------------- immutables

function storeImmutable(ctx, directory, id, value) {
  const rel = `${ctx.runRel}/${directory}/${id}.json`
  const abs = join(ctx.runAbs, directory, `${id}.json`)
  const bytes = jsonBytes(value)
  if (existsSync(abs)) {
    if (!readFileSync(abs).equals(bytes)) {
      fail('INVALID_INPUT', `${directory}/${id}.json already exists with different content; artifacts are immutable`)
    }
    return { path: rel, hash: sha256(bytes), existed: true }
  }
  atomicWrite(abs, bytes)
  return { path: rel, hash: sha256(bytes), existed: false }
}

/** Archive plan/research/context under versions/<sha>.json and mirror the projection. */
function storeVersioned(ctx, kind, value) {
  const bytes = jsonBytes(value)
  const hash = sha256(bytes)
  const versionRel = `${ctx.runRel}/versions/${hash}.json`
  const versionAbs = join(ctx.runAbs, 'versions', `${hash}.json`)
  if (existsSync(versionAbs)) {
    if (!readFileSync(versionAbs).equals(bytes)) fail('IO_ERROR', 'versioned artifact does not match its content hash')
  } else {
    atomicWrite(versionAbs, bytes)
  }
  const projectionRel = `${ctx.runRel}/${kind}.json`
  atomicWrite(join(ctx.runAbs, `${kind}.json`), bytes)
  addArtifact(ctx.run, versionRel, hash, `${kind}-version`)
  addArtifact(ctx.run, projectionRel, hash, kind)
  return { path: projectionRel, versionPath: versionRel, hash }
}

function result(ctx, extra) {
  advancePhase(ctx)
  saveRun(ctx)
  return {
    runPath: ctx.runRel,
    phase: ctx.run.phase,
    outcome: ctx.run.outcome,
    structuralRound: ctx.run.structuralRound,
    languagePass: ctx.run.languagePass,
    languageIntentsUsed: ctx.run.languageIntentsUsed,
    semanticRepairUsed: ctx.run.semanticRepairUsed,
    ...extra,
  }
}

// -------------------------------------------------------------------- plan

function recordPlan(ctx, artifact) {
  if (ctx.brief.operation === 'edit') fail('INVALID_INPUT', 'plan: operation edit records no plan artifact')
  const plan = validateOrFail(validatePlan(artifact), 'plan')
  if (plan.runId !== ctx.run.runId) fail('INVALID_INPUT', 'plan.runId: does not match the run')
  const required = ctx.brief.requiredQuestions.map((q) => q.id).sort()
  if (ctx.brief.operation === 'write') {
    if (plan.descriptive) fail('INVALID_INPUT', 'plan.descriptive: a write plan is prescriptive')
    const listed = [...plan.questions].sort()
    if (listed.length !== required.length || listed.some((id, i) => id !== required[i])) {
      fail('INVALID_INPUT', 'plan.questions: must equal the brief required question ids for a write')
    }
    const covered = new Set(plan.sections.flatMap((section) => section.questionIds))
    for (const id of required) {
      if (!covered.has(id)) fail('INVALID_INPUT', `plan.sections: required question "${id}" is not covered`)
    }
  } else if (!plan.descriptive) {
    fail('INVALID_INPUT', 'plan.descriptive: a review plan is descriptive (reconstructed)')
  }
  for (const id of plan.questions) {
    if (!required.includes(id)) fail('INVALID_INPUT', `plan.questions: "${id}" is not a brief question`)
  }
  const stored = storeVersioned(ctx, 'plan', plan)
  ctx.run.planHash = stored.hash
  return result(ctx, { artifactPath: stored.path, artifactHash: stored.hash })
}

// ---------------------------------------------------------------- research

function recordResearch(ctx, artifact) {
  if (ctx.brief.operation === 'edit') fail('INVALID_INPUT', 'research: operation edit records no research artifact')
  const research = validateOrFail(validateResearch(artifact), 'research')
  if (research.runId !== ctx.run.runId) fail('INVALID_INPUT', 'research.runId: does not match the run')
  const stored = storeVersioned(ctx, 'research', research)
  return result(ctx, { artifactPath: stored.path, artifactHash: stored.hash })
}

// ----------------------------------------------------------------- context

function recordContext(ctx, artifact) {
  if (ctx.brief.operation === 'edit') fail('INVALID_INPUT', 'context: operation edit records no context artifact')
  const context = validateOrFail(validateContext({ ...artifact, planHash: ctx.run.planHash }), 'context')
  if (context.runId !== ctx.run.runId) fail('INVALID_INPUT', 'context.runId: does not match the run')
  if (context.planHash !== ctx.run.planHash) fail('STALE_PLAN', 'context: plan changed before the context was recorded')
  const plan = projection(ctx, 'plan')
  if (plan === null) fail('PREREQUISITE_MISSING', 'context: a recorded plan is required first')
  const planResult = validatePlan(plan)
  if (!planResult.ok) fail('INVALID_INPUT', 'plan projection: invalid')
  const sectionIds = new Set(planResult.value.sections.map((section) => section.id))
  for (const section of context.sections) {
    if (!sectionIds.has(section.sectionId)) {
      fail('INVALID_INPUT', `context.sections: "${section.sectionId}" is not a plan section`)
    }
  }
  const stored = storeVersioned(ctx, 'context', context)
  return result(ctx, {
    artifactPath: stored.path,
    artifactHash: stored.hash,
    complete: context.sections.length === sectionIds.size,
  })
}

// ------------------------------------------------------------------ review

function recordReview(ctx, artifact) {
  const stage = artifact.stage
  const planHash = ctx.run.planHash
  if (stage === 'semantics') {
    if (ctx.run.bodyHash === null) fail('PREREQUISITE_MISSING', 'review: no body snapshot is recorded')
    if (ctx.brief.operation === 'review') fail('INVALID_INPUT', 'review: review-only mode requires no semantic compare')
  }
  const candidate = {
    ...artifact,
    bodyHash: ctx.run.bodyHash,
    planHash,
    beforeHash: stage === 'semantics' ? ctx.run.acceptedBodyHash : null,
  }
  const review = validateOrFail(validateReview(candidate), 'review')
  if (review.runId !== ctx.run.runId) fail('INVALID_INPUT', 'review.runId: does not match the run')
  if (review.bodyHash !== ctx.run.bodyHash) fail('STALE_BODY', 'review.bodyHash: does not match the current body')
  if (review.planHash !== ctx.run.planHash) fail('STALE_PLAN', 'review.planHash: does not match the current plan')
  const text = readSnapshotText(ctx, review.bodyHash, 'review snapshot')
  verifyReviewSpans(review, text)
  const scan = scanBlocks(text)
  if (review.coverage === 'complete') {
    const scannerOutput = { blocks: scan.blocks, length: text.length }
    if (stage === 'semantics') scannerOutput.editedBlocks = editedBlockIndexes(ctx)
    const covered = validateCoverage(review, scannerOutput, stage)
    if (!covered.ok) fail(covered.code, covered.message, covered.details)
    if (stage === 'structure') {
      if (review.reverseOutline.length !== scan.blocks.length) {
        fail('INVALID_INPUT', 'review.reverseOutline: a complete structure review has one entry per prose block')
      }
    }
  } else {
    for (const range of review.coverageRanges) {
      if (range.end > text.length) fail('INVALID_INPUT', 'review.coverageRanges: a range ends outside the snapshot')
    }
  }
  const stored = storeImmutable(ctx, ARTIFACT_DIRECTORIES.review, review.id, review)
  addArtifact(ctx.run, stored.path, stored.hash, 'review')
  if (review.coverage === 'complete' && stage === 'structure') {
    // The body has passed every check required at the structure stage.
    ctx.run.acceptedBodyHash = review.bodyHash
  }
  return result(ctx, { artifactPath: stored.path, artifactHash: stored.hash, complete: review.coverage === 'complete' })
}

function verifyReviewSpans(review, text) {
  const spans = [
    ...review.findings.map((finding) => ({ start: finding.start, end: finding.end, quote: finding.quote })),
    ...review.reverseOutline.map((entry) => ({ start: entry.start, end: entry.end, quote: entry.quote })),
  ]
  const checked = checkSpans(text, spans.filter((span) => span.quote !== ''))
  if (!checked.ok) fail(checked.code, checked.message, checked.details)
}

/**
 * Edited prose blocks derived by replaying applied language/repair proposals
 * through the recorded application chain (plan §8.1). Spans carry into the
 * final body; blocks containing them become the required semantic coverage.
 */
export function editedBlockIndexes(ctx) {
  const applied = ctx.run.appliedProposals.filter(
    (entry) => entry.intent !== 'structure',
  )
  if (applied.length === 0) return []
  const tracked = []
  for (const entry of applied) {
    const proposalPath = `${ctx.runRel}/proposals/${entry.proposalId}.json`
    const raw = loadArtifact(ctx, { path: proposalPath }, 'proposal')
    if (raw === null) continue
    const edits = [...raw.edits].sort((a, b) => a.start - b.start)
    const shifted = tracked.map((interval) => ({
      start: shiftPoint(interval.start, edits),
      end: shiftPoint(interval.end, edits),
    }))
    const created = edits.map((edit) => ({ start: edit.start, end: edit.start + edit.after.length }))
    tracked.length = 0
    tracked.push(...shifted, ...created)
  }
  if (tracked.length === 0 || ctx.run.bodyHash === null) return []
  const finalText = readSnapshotText(ctx, ctx.run.bodyHash, 'final body snapshot')
  const blocks = scanBlocks(finalText).blocks
  const indexes = new Set()
  for (const interval of tracked) {
    for (const index of blocksForInterval(blocks, interval)) indexes.add(index)
  }
  return [...indexes].sort((a, b) => a - b)
}

function shiftPoint(point, edits) {
  let delta = 0
  for (const edit of edits) {
    if (edit.start >= point) break
    const consumed = Math.min(edit.end, point) - edit.start
    delta += edit.after.length - consumed
  }
  return point + delta
}

function blocksForInterval(blocks, interval) {
  const indexes = new Set()
  const start = interval.start
  const end = Math.max(interval.end, interval.start + 1)
  blocks.forEach((block, index) => {
    if (block.end > start && block.start < end) indexes.add(index)
  })
  if (indexes.size === 0) {
    // Insertions between blocks fall on the nearest following, else previous block.
    const next = blocks.findIndex((block) => block.start >= start)
    if (next !== -1) indexes.add(next)
    else if (blocks.length > 0) indexes.add(blocks.length - 1)
  }
  return indexes
}

// ---------------------------------------------------------------- proposal

function recordProposal(ctx, artifact) {
  const proposal = validateOrFail(validateProposal({ ...artifact, bodyHash: ctx.run.bodyHash }), 'proposal')
  if (proposal.runId !== ctx.run.runId) fail('INVALID_INPUT', 'proposal.runId: does not match the run')
  if (proposal.bodyHash !== ctx.run.bodyHash) fail('STALE_BODY', 'proposal.bodyHash: does not match the current body')
  const text = readSnapshotText(ctx, proposal.bodyHash, 'proposal base snapshot')
  const checked = checkSpans(
    text,
    proposal.edits.map((edit) => ({ start: edit.start, end: edit.end, quote: edit.before })),
  )
  if (!checked.ok) fail(checked.code, checked.message, checked.details)
  verifyFindingReferences(ctx, proposal)
  const stored = storeImmutable(ctx, ARTIFACT_DIRECTORIES.proposal, proposal.id, proposal)
  addArtifact(ctx.run, stored.path, stored.hash, 'proposal')
  return result(ctx, { artifactPath: stored.path, artifactHash: stored.hash })
}

function verifyFindingReferences(ctx, proposal) {
  const reviews = currentReviews(ctx)
  const stageForIntent = { structure: 'structure', clarity: 'language', concision: 'language', style: 'language' }
  const stage = stageForIntent[proposal.intent]
  if (stage !== undefined) {
    const current = reviews[stage]
    if (current === undefined) fail('PREREQUISITE_MISSING', `proposal: a current ${stage} review is required`)
    const open = new Set(current.review.findings.filter((f) => f.status === 'open').map((f) => f.id))
    for (const id of proposal.findingIds) {
      if (!open.has(id)) fail('INVALID_INPUT', `proposal.findingIds: "${id}" is not an open finding of the current ${stage} review`)
    }
    return
  }
  // semantic-repair: semantic findings or the current check's pending/defect changes.
  const semantic = reviews.semantics
  const check = currentCheck(ctx)
  const open = new Set(semantic === undefined ? [] : semantic.review.findings.filter((f) => f.status === 'open').map((f) => f.id))
  const checkHasDefect = check !== null && check.changes.some((change) => change.disposition !== 'expected')
  for (const id of proposal.findingIds) {
    if (!open.has(id)) {
      fail('INVALID_INPUT', `proposal.findingIds: "${id}" is not an open semantic finding or check defect`)
    }
  }
  if (proposal.findingIds.length === 0 && !checkHasDefect) {
    fail('PREREQUISITE_MISSING', 'proposal.findingIds: a semantic repair needs a semantic finding or a check defect')
  }
}

// ------------------------------------------------------------------- check

function recordCheck(ctx, artifact) {
  if (ctx.run.acceptedBodyHash === null || ctx.run.bodyHash === null) {
    fail('PREREQUISITE_MISSING', 'check: a body baseline and a final body snapshot are required')
  }
  const candidate = {
    ...artifact,
    beforeHash: ctx.run.acceptedBodyHash,
    afterHash: ctx.run.bodyHash,
  }
  const check = validateOrFail(validateCheck(candidate), 'check')
  if (check.runId !== ctx.run.runId) fail('INVALID_INPUT', 'check.runId: does not match the run')
  if (check.semanticStatus !== 'not-run' && check.semanticReviewId === null) {
    fail('INVALID_INPUT', 'check.semanticReviewId: required once a semantic status is recorded')
  }
  if (check.semanticStatus === 'not-run' && check.semanticReviewId !== null) {
    fail('INVALID_INPUT', 'check.semanticReviewId: must be null while semanticStatus is not-run')
  }
  if (check.semanticReviewId !== null) verifyCheckReview(ctx, check.semanticReviewId)
  const before = readSnapshotText(ctx, check.beforeHash, 'check before snapshot')
  const after = readSnapshotText(ctx, check.afterHash, 'check after snapshot')
  verifyMechanicalChanges(ctx, check, before, after)
  const mechanicalStatus = check.changes.length === 0 ? 'clean' : 'changed'
  if (check.mechanicalStatus !== mechanicalStatus) {
    fail('INVALID_INPUT', `check.mechanicalStatus: expected ${mechanicalStatus} for these changes`)
  }
  const stored = storeImmutable(ctx, ARTIFACT_DIRECTORIES.check, check.id, check)
  addArtifact(ctx.run, stored.path, stored.hash, 'check')
  const blocking = check.changes.some((change) => change.disposition === 'pending' || change.disposition === 'defect')
  if (check.semanticStatus === 'no-issue-found' && !blocking) {
    ctx.run.acceptedBodyHash = ctx.run.bodyHash
  }
  return result(ctx, { artifactPath: stored.path, artifactHash: stored.hash })
}

function verifyCheckReview(ctx, reviewId) {
  const entry = ctx.run.artifactPaths.find((item) => item.kind === 'review' && item.path.endsWith(`/reviews/${reviewId}.json`))
  if (entry === undefined) fail('PREREQUISITE_MISSING', 'check.semanticReviewId: unknown review')
  const raw = loadArtifact(ctx, entry, 'review')
  const result = validateReview(raw)
  if (!result.ok || result.value.stage !== 'semantics') {
    fail('INVALID_INPUT', 'check.semanticReviewId: expected a recorded semantics review')
  }
}

/** Recompute mechanical differences; reject altered or missing differences (§6). */
function verifyMechanicalChanges(ctx, check, before, after) {
  const expected = compareBodies(before, after, {
    protectedTerms: ctx.brief.protectedTerms,
    profileProtectedTerms: ctx.profileTerms ?? [],
  })
  const key = (change) => `${change.type}|${JSON.stringify(change.before)}|${JSON.stringify(change.after)}`
  const remaining = new Map()
  for (const change of expected) remaining.set(key(change), (remaining.get(key(change)) ?? 0) + 1)
  for (const change of check.changes) {
    const id = key(change)
    const count = remaining.get(id) ?? 0
    if (count === 0) {
      fail('INVALID_INPUT', `check.changes: ${change.type} change is altered or was not produced by the mechanical compare`)
    }
    if (count === 1) remaining.delete(id)
    else remaining.set(id, count - 1)
  }
  for (const id of remaining.keys()) {
    fail('INVALID_INPUT', `check.changes: missing mechanical difference ${id}`)
  }
}

