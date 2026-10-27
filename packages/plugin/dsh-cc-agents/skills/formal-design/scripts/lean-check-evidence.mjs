import { realpathSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { LEAN_SPEC_VERSION, canonicalJson, fail, parseJsonTokens, parseLeanManifest } from './lean-manifest.lib.mjs'
import { loadToolchain, readUtf8, sha256 } from './lean-fingerprint.lib.mjs'
import { validateInspectorReport, validateProofEvidence, proofInputDigest, proofInputFiles } from './lean-evidence.lib.mjs'
import {
  executionDigestOf, executionFilesFor, nodeIdentity, parseCorpus, replayConformance, validateConformanceEvidence, runnerIdentityOf,
} from './lean-conformance.lib.mjs'

const SKILL_DIR = fileURLToPath(new URL('..', import.meta.url))
const MODEL_PATH = /^specs\/lean\/([a-z][a-z0-9-]{0,63})$/
const STALE = new Set(['stale/input', 'stale/runner', 'stale/execution', 'stale/toolchain'])
const tidy = error => error.detail ?? error.message ?? 'audit failed'
const audit = (reason, message = null) => fail(reason, message ?? reason)

function readSyntax(text, label) {
  try { return parseJsonTokens(text) } catch (error) { throw Object.assign(new Error(`${label}: ${tidy(error)}`), { code: 'schema-invalid', detail: `${label}: ${tidy(error)}` }) }
}
async function readJson(root, path, label, reason = 'missing-file') {
  const absolute = join(root, path)
  let bytes
  try { bytes = await fs.readFile(absolute) } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') audit(reason, `${label} is missing: ${path}`)
    throw error
  }
  return { value: readSyntax(new TextDecoder('utf-8', { fatal: true }).decode(bytes), label), bytes, sha256: sha256(bytes) }
}
function expect(ok, reason, message) { if (!ok) audit(reason, message) }
const canonical = value => canonicalJson(value)

// Every recorded phase stream and report must exist and hash to its record
// (design section 8). Missing or tampered artifacts are integrity failures.
async function checkArtifacts(root, evidence, modelId) {
  for (const phase of evidence.phases) {
    for (const stream of ['stdout', 'stderr']) {
      const record = phase[stream]
      let bytes
      try { bytes = await fs.readFile(join(root, record.path)) } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') audit('missing-file', `phase ${phase.id} ${stream} artifact is missing: ${record.path}`)
        throw error
      }
      expect(bytes.length === record.bytes && sha256(bytes) === record.sha256, 'hash-mismatch', `phase ${phase.id} ${stream} artifact does not match its record`)
    }
    if (phase.report === null) continue
    let bytes
    try { bytes = await fs.readFile(join(root, phase.report.path)) } catch {
      audit('missing-file', `phase ${phase.id} report artifact is missing: ${phase.report.path}`)
    }
    expect(bytes.length === phase.report.bytes && sha256(bytes) === phase.report.sha256, 'hash-mismatch', `phase ${phase.id} report artifact does not match its record`)
  }
}

function checkToolchain(record, pin) {
  const platform = pin.platforms[record.platform]
  expect(record.toolchain === pin.toolchain && platform && platform.sha256 === record.archiveSha256 && record.version === LEAN_SPEC_VERSION,
    'stale/toolchain', 'the recorded toolchain identity does not match the pin')
}

function derivedProofVerdict(properties) {
  if (properties.some(({ verdict }) => verdict === 'rejected')) return 'rejected'
  if (properties.some(({ verdict }) => verdict === 'not-checked')) return 'incomplete'
  return 'verified'
}

/** Proof stage: strict schema, artifact hashes, run binding, verdict replay, freshness. */
export async function auditProof(root, model, modelId) {
  const modelDir = join(root, model)
  const manifest = parseLeanManifest(await readUtf8(join(modelDir, 'checks.json'), 'checks.json'))
  expect(manifest.modelId === modelId, 'schema-invalid', 'manifest modelId must equal the model directory name')
  const properties = manifest.properties
  expect(Array.isArray(properties), 'schema-invalid', 'manifest properties are missing')

  const pointer = (await readJson(root, `${model}/current-run.json`, 'current-run.json')).value
  expect(pointer !== null && typeof pointer === 'object' && !Array.isArray(pointer), 'schema-invalid', 'current-run.json must be an object')
  const fields = Object.keys(pointer).sort().join(',')
  expect(fields === 'evidenceSha256,inputDigest,runId,schemaVersion', 'schema-invalid', 'current-run.json fields are invalid')
  const evidenceFile = await readJson(root, `${model}/evidence.json`, 'evidence.json')
  expect(evidenceFile.sha256 === pointer.evidenceSha256, 'hash-mismatch', 'published proof evidence does not match its pointer hash')
  const evidence = validateProofEvidence(evidenceFile.value, manifest)
  expect(evidence.runId === pointer.runId && evidence.inputDigest === pointer.inputDigest, 'run-mismatch', 'proof evidence does not match its pointer identity')

  await checkArtifacts(root, evidence, modelId)

  // The inspector report is referenced from the inspector phase record and its
  // verdicts are replayed from stored metadata (design section 8).
  const inspector = evidence.phases.find(phase => phase.id === 'inspector')
  if (inspector?.report) {
    const report = readSyntax(new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(join(root, inspector.report.path))), 'inspector report')
    validateInspectorReport(report, manifest.properties)
    expect(report.toolchainVersion === evidence.toolchain.version, 'schema-invalid', 'the inspector report toolchain does not match the evidence')
    expect(canonical(report.properties) === canonical(evidence.properties), 'schema-invalid', 'the inspector report does not match the recorded property reports')
  } else {
    expect(evidence.proofVerdict !== 'verified', 'schema-invalid', 'a verified run must reference its inspector report')
  }
  expect(derivedProofVerdict(evidence.properties) === evidence.proofVerdict, 'schema-invalid', 'the recorded proof verdict is inconsistent with the property reports')

  // Freshness: the proof inputs on disk must still hash to the recorded digest.
  let current = null
  try { current = proofInputDigest(await proofInputFiles(modelDir)) } catch { current = null }
  expect(current === evidence.inputDigest, 'stale/input', 'proof inputs changed since the recorded run')
  const runner = await runnerIdentityOf(SKILL_DIR)
  expect(runner.digest === evidence.runnerDigest, 'stale/runner', 'runner artifacts changed since the recorded run')
  expect(canonical(runner.package) === canonical(evidence.runnerPackage), 'stale/runner', 'the runner package identity changed')
  checkToolchain(evidence.toolchain, await loadToolchain())
  return { evidence, pointer, manifest, modelDir }
}

/** Acceptance stage: proof audit plus the conformance package and its binding. */
export async function auditConformance(root, model, modelId, proof) {
  const { evidence, manifest, modelDir } = proof
  const file = await readJson(root, `${model}/conformance-evidence.json`, 'conformance-evidence.json', 'missing-conformance')
  const conformance = validateConformanceEvidence(file.value, manifest)
  // An independent new proof run makes old conformance evidence ineligible.
  expect(conformance.proofRunId === evidence.runId, 'binding-invalid', 'conformance evidence does not bind the current proof run')
  expect(conformance.proofInputDigest === evidence.inputDigest, 'binding-invalid', 'conformance evidence does not bind the current proof inputs')
  expect(canonical(conformance.toolchain) === canonical(evidence.toolchain), 'binding-invalid', 'conformance evidence does not bind the current toolchain')
  expect(conformance.runnerDigest === evidence.runnerDigest, 'binding-invalid', 'conformance evidence does not bind the current runner')

  await checkArtifacts(root, conformance, modelId)

  // Execution closure: declared files, corpus and adapter must still match, and
  // the recorded digest must recompute from them, the Node identity and the pin.
  const executionFiles = await executionFilesFor(root, model, manifest)
  expect(canonical(executionFiles) === canonical(conformance.executionFiles), 'stale/execution', 'the execution closure changed since the recorded run')
  const digest = executionDigestOf(executionFiles, nodeIdentity(), conformance.proofInputDigest)
  expect(digest === conformance.executionDigest, 'stale/execution', 'the recorded execution digest does not recompute')

  // Corpus coverage must match the persisted comparison report, and the verdict
  // is replayed from that report rather than taken on trust.
  const corpus = parseCorpus(await readUtf8(join(modelDir, manifest.conformance.corpus), 'corpus'), manifest)
  const compare = conformance.phases.find(phase => phase.id === 'compare')
  if (compare?.report) {
    const report = readSyntax(new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(join(root, compare.report.path))), 'comparison report')
    const replay = replayConformance(report, corpus)
    expect(replay.verdict === conformance.conformanceVerdict, 'schema-invalid', 'the replayed conformance verdict does not match the record')
    expect(replay.matchedCount === conformance.matchedCount && replay.caseCount === conformance.caseCount, 'schema-invalid', 'the comparison report counts do not match the record')
    expect(canonical(replay.firstMismatch) === canonical(conformance.firstMismatch), 'schema-invalid', 'the recorded first mismatch does not match the comparison report')
  } else {
    expect(conformance.conformanceVerdict !== 'passed' && conformance.firstMismatch === null, 'schema-invalid', 'a passed run must reference its comparison report')
    expect(conformance.caseCount === 0 || conformance.conformanceVerdict === 'not-run' || conformance.conformanceVerdict === 'blocked' || conformance.conformanceVerdict === 'incomplete' || conformance.conformanceVerdict === 'failed', 'schema-invalid', 'a run with results must reference its comparison report')
  }
  return { evidence: conformance, corpus }
}

/**
 * Read-only audit. Never needs a Lean installation and never executes project
 * code; it reads files and recomputes hashes only (design section 8).
 */
export async function auditLeanEvidence(options, { io = fs } = {}) {
  const stage = options.stage
  const base = (reason, fields = {}) => ({
    schemaVersion: 1, command: 'lean-check-evidence', stage: stage ?? null,
    status: reason === 'valid' ? 'valid' : 'invalid', reason,
    integrity: fields.integrity ?? (reason === 'valid' || STALE.has(reason) ? 'valid' : 'invalid'),
    fresh: fields.fresh ?? reason === 'valid',
    proofVerdict: fields.proofVerdict ?? null, conformanceVerdict: fields.conformanceVerdict ?? null,
    // Computed only for acceptance auditing (design section 8).
    acceptanceReady: stage === 'acceptance' ? fields.acceptanceReady ?? false : null,
    runId: fields.runId ?? null, inputDigest: fields.inputDigest ?? null,
  })
  if (stage !== 'proof' && stage !== 'acceptance') return base('usage-invalid', { integrity: 'invalid' })
  let modelId
  try {
    const root = await io.realpath(options.project)
    const match = typeof options.model === 'string' && MODEL_PATH.exec(options.model)
    expect(Boolean(match), 'unsafe-path', 'model must be specs/lean/<model-id>')
    modelId = match[1]
    const stat = await io.stat(join(root, options.model)).catch(() => null)
    expect(stat?.isDirectory() === true, 'unsafe-path', 'model must be an existing directory')
    const proof = await auditProof(root, options.model, modelId)
    if (stage === 'proof') {
      return base('valid', { proofVerdict: proof.evidence.proofVerdict, runId: proof.evidence.runId, inputDigest: proof.evidence.inputDigest })
    }
    const conformance = await auditConformance(root, options.model, modelId, proof)
    const ready = proof.evidence.proofVerdict === 'verified' && conformance.evidence.conformanceVerdict === 'passed'
    if (!ready) {
      return base(proof.evidence.proofVerdict === 'verified' ? 'conformance-not-passed' : 'not-verified', {
        integrity: 'valid', fresh: true, proofVerdict: proof.evidence.proofVerdict,
        conformanceVerdict: conformance.evidence.conformanceVerdict, acceptanceReady: false,
        runId: proof.evidence.runId, inputDigest: proof.evidence.inputDigest,
      })
    }
    return base('valid', {
      proofVerdict: proof.evidence.proofVerdict, conformanceVerdict: conformance.evidence.conformanceVerdict,
      acceptanceReady: true, runId: proof.evidence.runId, inputDigest: proof.evidence.inputDigest,
    })
  } catch (error) {
    const reason = error.code === 'config-invalid' ? 'schema-invalid' : error.code ?? 'io'
    return base(reason, { fresh: false })
  }
}

export function parseAuditSyntax(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true }
  const allowed = ['project', 'model', 'stage']
  const options = {}
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i].slice(2)
    if (!argv[i].startsWith('--') || !allowed.includes(flag) || Object.hasOwn(options, flag) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw Object.assign(new Error('invalid, missing, unknown or duplicate argument'), { detail: 'invalid, missing, unknown or duplicate argument' })
    }
    options[flag] = argv[i + 1]
  }
  if (!options.project || !options.model) throw Object.assign(new Error('--project and --model are required'), { detail: '--project and --model are required' })
  return options
}

export async function main(argv = process.argv.slice(2)) {
  let options
  try { options = parseAuditSyntax(argv) } catch (error) {
    process.stdout.write(JSON.stringify({ schemaVersion: 1, command: 'lean-check-evidence', stage: null, status: 'invalid', reason: 'usage-invalid', integrity: 'invalid', fresh: false, proofVerdict: null, conformanceVerdict: null, acceptanceReady: null, runId: null, inputDigest: null }) + '\n')
    return 2
  }
  if (options.help) {
    process.stdout.write('lean-check-evidence --project <root> --model specs/lean/<id> --stage proof|acceptance\n')
    return 0
  }
  const result = await auditLeanEvidence(options)
  process.stdout.write(JSON.stringify(result) + '\n')
  return result.status === 'valid' ? 0 : 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main()
