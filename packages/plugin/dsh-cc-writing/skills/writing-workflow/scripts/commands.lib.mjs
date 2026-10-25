/**
 * CLI command entry points and dispatch (plan §6). Read-only status never
 * locks or writes; every mutating command runs under the per-run lock.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readBoolean, validateBrief, validateRun } from './contracts.lib.mjs'
import {
  EMPTY_HASH,
  atomicWrite,
  decodeUtf8,
  fail,
  readBytes,
  readJsonFile,
  readJsonIfExists,
  resolveWorkspacePath,
  sha256,
  withLock,
  writeJsonAtomic,
  writeSnapshot,
} from './files.lib.mjs'
import {
  addArtifact,
  contextComplete,
  currentCheck,
  currentReviews,
  derivePhase,
  loadContext,
  projectionMatches,
  runRelative,
  saveRun,
  validateOrFail,
} from './state.lib.mjs'
import { readInput, schemaCall } from './inputs.lib.mjs'
import { scanBlocks } from './markdown.lib.mjs'
import { recordCommand } from './record.lib.mjs'
import {
  applyCommand,
  compareCommand,
  finalizeCommand,
  linkCommand,
  restoreCommand,
} from './mutation.lib.mjs'

const RUN_SUBDIRECTORIES = ['versions', 'snapshots', 'reviews', 'proposals', 'checks', 'applications']

// ---------------------------------------------------------------------- init

function initCommand(root, input) {
  const shape = readInput(input, ['brief', 'replaceExisting'])
  const replaceExisting = schemaCall(() => readBoolean(shape.replaceExisting, 'replaceExisting'))
  const brief = validateOrFail(validateBrief(shape.brief), 'brief')
  const body = resolveWorkspacePath(root, brief.bodyPath, 'brief.bodyPath')
  const companion = resolveWorkspacePath(root, brief.companionPath, 'brief.companionPath')
  const runRel = `${companion.rel}/runs/${brief.runId}`
  const runAbs = join(companion.abs, 'runs', brief.runId)
  if (existsSync(runAbs)) fail('INVALID_INPUT', 'brief.runId: this run directory already exists (runId must be fresh)')
  const bodyExists = existsSync(body.abs)
  if (brief.operation === 'write') {
    if (bodyExists && !replaceExisting) {
      fail('INVALID_INPUT', 'brief.bodyPath: the body exists and replaceExisting is false', { bodyPath: body.rel })
    }
  } else if (!bodyExists) {
    fail('PREREQUISITE_MISSING', `brief.bodyPath: a ${brief.operation} requires an existing body`, { bodyPath: body.rel })
  }
  rejectConcurrentRun(companion.abs, brief)
  try {
    mkdirSync(runAbs, { recursive: true })
    for (const name of RUN_SUBDIRECTORIES) mkdirSync(join(runAbs, name), { recursive: true })
  } catch {
    fail('IO_ERROR', 'cannot create the run directory')
  }
  return withLock(runAbs, () => {
    const briefBytes = Buffer.from(`${JSON.stringify(brief, null, 2)}\n`, 'utf8')
    atomicWrite(join(runAbs, 'brief.json'), briefBytes)
    const briefHash = sha256(briefBytes)
    const createdAt = new Date().toISOString()
    let bodyHash = null
    let acceptedBodyHash = EMPTY_HASH
    if (bodyExists) {
      const bytes = readBytes(body.abs, 'body')
      decodeUtf8(bytes, 'brief.bodyPath')
      const snapshot = writeSnapshot(runAbs, runRel, bytes)
      bodyHash = snapshot.hash
      acceptedBodyHash = snapshot.hash
    }
    const run = {
      schemaVersion: 1,
      kind: 'run',
      runId: brief.runId,
      briefHash,
      phase: 'initialized',
      outcome: 'active',
      bodyHash,
      planHash: null,
      replaceExisting,
      structuralRound: 0,
      languagePass: 0,
      languageIntentsUsed: [],
      semanticRepairUsed: false,
      acceptedBodyHash,
      appliedProposals: [],
      artifactPaths: [],
      vwa: null,
      usage: null,
      createdAt,
      updatedAt: createdAt,
      model: null,
    }
    addArtifact(run, `${runRel}/brief.json`, briefHash, 'brief')
    if (bodyExists) addArtifact(run, `${runRel}/snapshots/${acceptedBodyHash}.md`, acceptedBodyHash, 'snapshot')
    const validated = validateOrFail(validateRun(run, { repairRounds: brief.repairRounds }), 'run.json')
    writeJsonAtomic(join(runAbs, 'run.json'), validated)
    return { runPath: runRel, runId: brief.runId, briefHash, bodyHash, phase: 'initialized', outcome: 'active' }
  })
}

/** init rejects a concurrent run for the same body (plan §6). */
function rejectConcurrentRun(companionAbs, brief) {
  const runsAbs = join(companionAbs, 'runs')
  if (!existsSync(runsAbs)) return
  for (const entry of readdirSync(runsAbs, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === brief.runId) continue
    const siblingAbs = join(runsAbs, entry.name)
    const siblingRun = readJsonIfExists(join(siblingAbs, 'run.json'), 'run.json')
    const siblingBrief = readJsonIfExists(join(siblingAbs, 'brief.json'), 'brief.json')
    if (siblingRun === null || siblingBrief === null) continue
    if (siblingRun.outcome !== 'active' && siblingRun.outcome !== 'blocked') continue
    if (siblingBrief.bodyPath !== brief.bodyPath) continue
    fail('LOCKED', 'another run is active for the same body', {
      reason: 'concurrent-run',
      runPath: `${siblingBrief.companionPath}/runs/${entry.name}`,
    })
  }
}

// ------------------------------------------------------------------ snapshot

function snapshotCommand(ctx) {
  const { abs: bodyAbs } = resolveWorkspacePath(ctx.root, ctx.brief.bodyPath, 'brief.bodyPath')
  const bytes = readBytes(bodyAbs, 'body')
  const text = decodeUtf8(bytes, 'brief.bodyPath')
  const snapshot = writeSnapshot(ctx.runAbs, ctx.runRel, bytes)
  ctx.run.bodyHash = snapshot.hash
  addArtifact(ctx.run, snapshot.path, snapshot.hash, 'snapshot')
  saveRun(ctx)
  return { runPath: ctx.runRel, hash: snapshot.hash, path: snapshot.path, blocks: scanBlocks(text).blocks }
}

// --------------------------------------------------------------------- status

function statusCommand(root, input) {
  const shape = readInput(input, ['runPath'])
  const { abs: runAbs, rel: runRel } = resolveWorkspacePath(root, shape.runPath, 'runPath')
  if (!existsSync(join(runAbs, 'run.json'))) fail('INVALID_INPUT', 'runPath: no run.json in that directory')
  const run = validateOrFail(
    validateRun(readJsonFile(join(runAbs, 'run.json'), 'run.json'), { repairRounds: 3 }),
    'run.json',
  )
  const briefBytes = existsSync(join(runAbs, 'brief.json')) ? readFileSync(join(runAbs, 'brief.json')) : null
  const briefResult = briefBytes === null ? null : validateBrief(JSON.parse(decodeUtf8(briefBytes, 'brief.json')))
  const brief = briefResult !== null && briefResult.ok ? briefResult.value : null
  const briefHash = briefBytes === null ? null : sha256(briefBytes)
  const staleBrief = briefHash !== run.briefHash
  const ctx = {
    root,
    runAbs,
    runRel,
    run,
    brief: brief ?? { bodyPath: '', profile: 'technical', repairRounds: 3 },
    briefHash,
    profile: null,
    profileTerms: [],
  }
  let currentBodyHash = null
  let staleBody = false
  if (brief !== null) {
    try {
      const { abs: bodyAbs } = resolveWorkspacePath(root, brief.bodyPath, 'brief.bodyPath')
      if (existsSync(bodyAbs)) currentBodyHash = sha256(readFileSync(bodyAbs))
    } catch {
      currentBodyHash = null
    }
    staleBody = currentBodyHash !== run.bodyHash
  }
  const stalePlan = brief !== null && run.planHash !== null && !projectionMatches(ctx, 'plan', run.planHash)
  const referenced = new Set(run.artifactPaths.map((entry) => entry.path))
  const staleArtifacts = []
  for (const entry of run.artifactPaths) {
    const abs = join(runAbs, runRelative(ctx, entry.path))
    if (!existsSync(abs)) {
      staleArtifacts.push({ path: entry.path, kind: entry.kind, reason: 'missing' })
      continue
    }
    if (sha256(readFileSync(abs)) !== entry.hash) {
      staleArtifacts.push({ path: entry.path, kind: entry.kind, reason: 'hash-mismatch' })
    }
  }
  const orphans = []
  for (const directory of RUN_SUBDIRECTORIES) {
    const abs = join(runAbs, directory)
    if (!existsSync(abs)) continue
    for (const file of readdirSync(abs)) {
      if (file.startsWith('.')) continue
      const rel = `${runRel}/${directory}/${file}`
      if (!referenced.has(rel)) orphans.push({ path: rel, kind: directory })
    }
  }
  const derived = brief === null || staleBrief ? null : derivePhase(ctx)
  const earliest = staleBrief ? 'brief' : stalePlan ? 'plan' : staleBody ? 'body' : staleArtifacts.length > 0 ? 'artifact' : null
  return {
    runPath: runRel,
    runId: run.runId,
    phase: run.phase,
    outcome: run.outcome,
    derivedPhase: derived,
    bodyHash: run.bodyHash,
    currentBodyHash,
    planHash: run.planHash,
    acceptedBodyHash: run.acceptedBodyHash,
    stale: { brief: staleBrief, body: staleBody, plan: stalePlan },
    staleArtifacts,
    orphanArtifacts: orphans,
    earliestInvalidatedPrerequisite: earliest,
    nextStage: staleBrief ? 'new-run' : nextRequiredStage(ctx, brief),
    structuralRound: run.structuralRound,
    languagePass: run.languagePass,
    languageIntentsUsed: run.languageIntentsUsed,
    semanticRepairUsed: run.semanticRepairUsed,
  }
}

function nextRequiredStage(ctx, brief) {
  const reviews = currentReviews(ctx)
  const check = currentCheck(ctx)
  if (brief.operation === 'write') {
    if (!projectionMatches(ctx, 'plan', ctx.run.planHash)) return 'plan'
    if (!contextComplete(ctx)) return 'context'
    if (reviews.structure === undefined) return 'structure-review'
    if (reviews.semantics === undefined || check === null) return 'semantic-review'
    return 'finalize'
  }
  if (brief.operation === 'edit') {
    if (reviews.language === undefined) return 'language-review'
    if (reviews.semantics === undefined || check === null) return 'semantic-review'
    return 'finalize'
  }
  if (reviews.structure === undefined) return 'structure-review'
  if (reviews.language === undefined) return 'language-review'
  return 'finalize'
}

// ------------------------------------------------------------------ dispatch

const INPUT_KEYS = {
  snapshot: { required: ['runPath'] },
  record: { required: ['runPath', 'artifact', 'expectedBodyHash', 'expectedPlanHash'] },
  apply: { required: ['runPath', 'proposalId', 'expectedBodyHash'] },
  compare: { required: ['runPath', 'beforeHash', 'afterHash'] },
  restore: { required: ['runPath', 'snapshotHash', 'expectedBodyHash'] },
  link: { required: ['runPath', 'model', 'usage', 'vwa'] },
  finalize: { required: ['runPath', 'expectedBodyHash'], optional: ['cancelled'] },
}

const MUTATING = {
  snapshot: snapshotCommand,
  record: (ctx, shape) => recordCommand(ctx, shape),
  apply: applyCommand,
  compare: compareCommand,
  restore: restoreCommand,
  link: linkCommand,
  finalize: finalizeCommand,
}

export const COMMANDS = ['init', 'snapshot', 'record', 'apply', 'compare', 'restore', 'status', 'finalize', 'link']

export function dispatch(command, root, input) {
  if (typeof command !== 'string' || !COMMANDS.includes(command)) {
    fail('INVALID_INPUT', `unknown command "${String(command)}"`)
  }
  if (command === 'init') return initCommand(root, input)
  if (command === 'status') return statusCommand(root, input)
  const keys = INPUT_KEYS[command]
  const shape = readInput(input, keys.required, keys.optional ?? [])
  const ctx = loadContext(root, shape.runPath)
  return withLock(ctx.runAbs, () => MUTATING[command](ctx, shape))
}
