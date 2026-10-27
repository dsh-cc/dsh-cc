import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { digestEntries, hashFile, posix, sha256 } from './lean-fingerprint.lib.mjs'
import { PROOF_SOURCES, PLATFORMS, REASON_CODES as CONFIG_REASON_CODES, assert, compareCodepoint, fail } from './lean-manifest.lib.mjs'
import { runnerIdentity } from './fingerprint.lib.mjs'
import { probeLock, temporary } from './storage.lib.mjs'
import { BRIDGE_PATH, loadBridge } from './bridge.lib.mjs'

// Proof evidence contract (design section 8) for the Lean backend.
export const BACKEND = 'lean'
export const SCHEMA_VERSION = 1
// Closed phase identifier list (design section 8). The closed list has no
// separate `compile-driver` identifier, so the trusted driver's compilation is
// recorded as the `driver` phase: that identifier names the trusted driver.
export const PHASES = Object.freeze(['compile-model', 'compile-properties', 'compile-reference', 'compile-inspector', 'inspector', 'driver', 'adapter', 'compare'])
// Record order of the proof build: the trusted driver is compiled with the
// other modules (step 4) before the inspector runs (step 5).
export const BUILD_ORDER = Object.freeze(['compile-model', 'compile-properties', 'compile-reference', 'compile-inspector', 'driver', 'inspector', 'adapter', 'compare'])
// Closed reason-code list (design section 8).
export const REASON_CODES = Object.freeze([...CONFIG_REASON_CODES, 'lock-conflict', 'input-changed', 'artifact-changed', 'timeout', 'cancelled', 'signal', 'stream-overflow', 'output-invalid', 'protocol-invalid'])
export const PROOF_VERDICTS = Object.freeze(['verified', 'rejected', 'blocked', 'incomplete'])
export const PROPERTY_VERDICTS = Object.freeze(['verified', 'rejected', 'not-checked'])
export const RUNNER_PACKAGE = '@dsh-cc/plugin-dsh-cc-agents'
export const EMPTY_SHA256 = sha256(Buffer.alloc(0))
const HASH = /^[a-f0-9]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const PHASE_FIELDS = ['id', 'argv', 'exitCode', 'signal', 'timedOut', 'cancelled', 'overflowed', 'stdout', 'stderr', 'report']
const STREAM_FIELDS = ['path', 'bytes', 'sha256']
const PROPERTY_FIELDS = ['id', 'declaration', 'kind', 'statementType', 'theoremType', 'typesMatch', 'axioms', 'witness', 'verdict']
const WITNESS_FIELDS = ['declaration', 'kind', 'type', 'verdict']

const text = value => typeof value === 'string' && value.length > 0
const hash = value => typeof value === 'string' && HASH.test(value)
const natural = value => Number.isSafeInteger(value) && value >= 0
const time = value => {
  try { return typeof value === 'string' && new Date(value).toISOString() === value } catch { return false }
}
const safeRelative = value => text(value) && !isAbsolute(value) && !value.includes('\\') && value.split('/').every(segment => segment && segment !== '.' && segment !== '..')

function exact(value, fields, label) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  const keys = Object.keys(value).sort(compareCodepoint)
  const expected = [...fields].sort(compareCodepoint)
  assert(keys.length === expected.length && keys.every((key, index) => key === expected[index]), `${label} fields must be exactly ${fields.join(',')}`)
}

// ---------------------------------------------------------------------------
// Identity: proof inputs, runner files, runner package, digests.
// ---------------------------------------------------------------------------
// design section 8: the proof input enumeration is design.md, checks.json and
// the three Lean sources. Paths stay model-relative, matching the TLC evidence
// convention. `implementation.md` is an acceptance record outside the digest.
export const PROOF_INPUTS = Object.freeze(['design.md', 'checks.json', ...PROOF_SOURCES])

export async function proofInputFiles(modelDir) {
  const entries = []
  for (const path of PROOF_INPUTS) {
    let stat
    try { stat = await fs.stat(join(modelDir, path)) } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') fail('missing-input', `required input is missing: ${path}`)
      throw error
    }
    if (!stat.isFile()) fail('unsafe-path', `required input is not a regular file: ${path}`)
    entries.push({ path, sha256: await hashFile(join(modelDir, path)) })
  }
  return entries
}

export const proofInputDigest = entries => digestEntries(entries)

/**
 * Re-enumerate the bridge package recorded by version-two evidence with the same
 * regular-file and size checks the producer used (design section 10). Returns
 * null for version-one (TLA-only) evidence.
 */
export async function bridgeInputsFor(root, evidence) {
  if (evidence.schemaVersion !== 2) return null
  const entry = evidence.bridgeFiles.map(record => record.path).find(path => BRIDGE_PATH.test(path))
  if (!entry) fail('config-invalid', 'bridge evidence is missing its bridge.json entry')
  return await loadBridge(root, entry)
}

// design section 8: the runner digest enumerates the shipped Lean scripts,
// reports and pin from the skill directory.
const RUNNER_SUFFIX = ['.mjs']
export async function runnerFiles(skillDir) {
  const scripts = join(skillDir, 'scripts')
  const paths = []
  for (const name of (await fs.readdir(scripts)).sort(compareCodepoint)) {
    if (name.startsWith('lean-') && RUNNER_SUFFIX.some(suffix => name.endsWith(suffix))) paths.push(`scripts/${name}`)
  }
  if (await fs.stat(join(scripts, 'check-combined-evidence.mjs')).catch(() => null)) paths.push('scripts/check-combined-evidence.mjs')
  paths.push('lean/Inspector.lean', 'lean/Driver.lean', 'scripts/lean-toolchain.json')
  const unique = [...new Set(paths)].sort(compareCodepoint)
  const entries = []
  for (const path of unique) entries.push({ path, sha256: await hashFile(join(skillDir, path)) })
  return entries
}

export const runnerDigest = entries => digestEntries(entries)

// The plugin/package identity rules are the TLC runner's; reuse them instead of
// restating the two-file agreement check.
export async function runnerPackage() {
  return (await runnerIdentity()).runnerPackage
}

// ---------------------------------------------------------------------------
// Inspector report (design section 8).
// ---------------------------------------------------------------------------
export function validateInspectorReport(report, properties) {
  exact(report, ['schemaVersion', 'properties', 'toolchainVersion'], 'inspector report')
  assert(report.schemaVersion === 1 && text(report.toolchainVersion), 'invalid inspector report header')
  assert(Array.isArray(report.properties) && report.properties.length === properties.length, 'inspector report must cover every declared property')
  report.properties.forEach((entry, index) => {
    exact(entry, PROPERTY_FIELDS, 'inspector property')
    const declared = properties[index]
    assert(entry.id === declared.id && entry.declaration === declared.declaration, 'inspector property entry does not match the manifest order')
    assert(PROPERTY_VERDICTS.includes(entry.verdict), 'invalid inspector property verdict')
    assert(entry.kind === null || text(entry.kind), 'invalid declaration kind')
    assert(entry.statementType === null || text(entry.statementType), 'invalid statement type')
    assert(entry.theoremType === null || text(entry.theoremType), 'invalid theorem type')
    assert(entry.typesMatch === null || typeof entry.typesMatch === 'boolean', 'invalid typesMatch')
    // null exactly when a type is null, a boolean otherwise (design section 8).
    assert((entry.typesMatch === null) === (entry.statementType === null || entry.theoremType === null), 'typesMatch must be null exactly when a type is null')
    assert(entry.axioms === null || (Array.isArray(entry.axioms) && entry.axioms.every(text)), 'invalid axiom list')
    if (entry.witness !== null) {
      exact(entry.witness, WITNESS_FIELDS, 'inspector witness')
      assert(text(entry.witness.declaration) && (entry.witness.kind === null || text(entry.witness.kind)) && (entry.witness.type === null || text(entry.witness.type)) && ['verified', 'rejected'].includes(entry.witness.verdict), 'invalid witness report')
    }
    // A missing declaration is reported with `kind: null` and a non-verified
    // verdict, so a null kind can never support a verified property.
    if (entry.kind === null) assert(entry.verdict !== 'verified', 'a property without a declaration cannot be verified')
  })
  return report
}

// A failed run still publishes a report: the attempted properties keep their
// recorded outcome and every unchecked one is marked `not-checked` (design
// section 6, step 7).
export function incompleteInspectorReport(report, properties) {
  const seen = new Map()
  const items = Array.isArray(report?.properties) ? report.properties : []
  for (const entry of items) if (entry && typeof entry.id === 'string') seen.set(entry.id, entry)
  return {
    schemaVersion: 1,
    properties: properties.map(declared => {
      const entry = seen.get(declared.id)
      if (entry && PROPERTY_VERDICTS.includes(entry.verdict)) return entry
      return { id: declared.id, declaration: declared.declaration, kind: null, statementType: null, theoremType: null, typesMatch: null, axioms: null, witness: null, verdict: 'not-checked' }
    }),
    toolchainVersion: report?.toolchainVersion ?? null,
  }
}

// ---------------------------------------------------------------------------
// Proof evidence (design section 8).
// ---------------------------------------------------------------------------
const EVIDENCE_FIELDS = ['schemaVersion', 'backend', 'modelId', 'runId', 'inputFiles', 'inputDigest', 'runnerFiles', 'runnerDigest', 'runnerPackage', 'toolchain', 'proofVerdict', 'reason', 'properties', 'phases', 'startedAt', 'finishedAt']
// Version two adds exactly one field, `bridgeFiles` (design section 10).
const EVIDENCE_FIELDS_V2 = [...EVIDENCE_FIELDS, 'bridgeFiles']
const TOOLCHAIN_FIELDS = ['toolchain', 'platform', 'archiveSha256', 'contentDigest', 'version']

export function validateProofEvidence(evidence, manifest) {
  const version = evidence?.schemaVersion
  exact(evidence, version === 2 ? EVIDENCE_FIELDS_V2 : EVIDENCE_FIELDS, 'proof evidence')
  assert(version === 1 || version === 2, 'unknown proof evidence schema version')
  assert(evidence.backend === BACKEND, 'proof evidence backend must be "lean"')
  assert(text(evidence.modelId) && evidence.modelId === manifest.modelId, 'proof evidence modelId must equal the manifest modelId')
  assert(typeof evidence.runId === 'string' && UUID.test(evidence.runId), 'runId must be a fresh UUID')
  for (const field of ['inputDigest', 'runnerDigest']) assert(hash(evidence[field]), `invalid ${field}`)
  for (const field of ['inputFiles', 'runnerFiles']) {
    assert(Array.isArray(evidence[field]) && evidence[field].length > 0, `missing ${field}`)
    const seen = new Set()
    for (const entry of evidence[field]) {
      exact(entry, ['path', 'sha256'], `${field} entry`)
      assert(safeRelative(entry.path) && !seen.has(entry.path) && hash(entry.sha256), `invalid ${field} entry`)
      seen.add(entry.path)
    }
  }
  if (version === 2) {
    assert(Array.isArray(evidence.bridgeFiles) && evidence.bridgeFiles.length > 0, 'version-two evidence must enumerate bridgeFiles')
    const seen = new Set()
    let bridgeJson = false
    for (const entry of evidence.bridgeFiles) {
      exact(entry, ['path', 'sha256'], 'bridgeFiles entry')
      assert(safeRelative(entry.path) && !seen.has(entry.path) && hash(entry.sha256), 'invalid bridgeFiles entry')
      seen.add(entry.path)
      if (BRIDGE_PATH.test(entry.path)) bridgeJson = true
      // Bridge files join the proof input enumeration before hashing.
      assert(evidence.inputFiles.some(input => input.path === entry.path && input.sha256 === entry.sha256), 'bridgeFiles must be part of inputFiles')
    }
    assert(bridgeJson, 'bridgeFiles must contain the bridge.json entry')
  }
  assert(digestEntries(evidence.inputFiles) === evidence.inputDigest, 'inputDigest does not match inputFiles')
  assert(digestEntries(evidence.runnerFiles) === evidence.runnerDigest, 'runnerDigest does not match runnerFiles')
  exact(evidence.runnerPackage, ['name', 'version'], 'runnerPackage')
  assert(evidence.runnerPackage.name === RUNNER_PACKAGE && text(evidence.runnerPackage.version), 'invalid runner package')
  exact(evidence.toolchain, TOOLCHAIN_FIELDS, 'toolchain')
  assert(/^leanprover\/lean4:v[0-9]+\.[0-9]+\.[0-9]+$/.test(evidence.toolchain.toolchain) && PLATFORMS.includes(evidence.toolchain.platform) && hash(evidence.toolchain.archiveSha256) && hash(evidence.toolchain.contentDigest) && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(evidence.toolchain.version), 'invalid toolchain identity')
  assert(PROOF_VERDICTS.includes(evidence.proofVerdict), 'invalid proofVerdict')
  // `reason` is null only on success; otherwise a closed code plus a detail object.
  if (evidence.proofVerdict === 'verified') assert(evidence.reason === null, 'a verified run must not carry a reason')
  else {
    exact(evidence.reason, ['code', 'detail'], 'reason')
    assert(REASON_CODES.includes(evidence.reason.code), `reason code must be one of ${REASON_CODES.join(',')}`)
    assert(evidence.reason.detail !== null && typeof evidence.reason.detail === 'object' && !Array.isArray(evidence.reason.detail), 'reason detail must be an object')
  }
  assert(Array.isArray(evidence.properties) && evidence.properties.length === manifest.properties.length, 'proof evidence must report every declared property')
  validateInspectorReport({ schemaVersion: 1, toolchainVersion: evidence.toolchain.version, properties: evidence.properties }, manifest.properties)
  if (evidence.proofVerdict === 'verified') {
    assert(evidence.properties.every(property => property.verdict === 'verified'), 'a verified run must verify every property')
  } else if (evidence.proofVerdict === 'rejected') {
    assert(evidence.properties.some(property => property.verdict !== 'verified'), 'a rejected run must name the rejected property')
  }
  assert(Array.isArray(evidence.phases) && evidence.phases.length > 0, 'proof evidence must record its phases')
  const ids = new Set()
  let previous = -1
  for (const phase of evidence.phases) {
    exact(phase, PHASE_FIELDS, 'phase')
    assert(PHASES.includes(phase.id) && !ids.has(phase.id), 'unknown or duplicate phase identifier')
    assert(BUILD_ORDER.indexOf(phase.id) > previous, 'phases must be recorded in build order')
    previous = BUILD_ORDER.indexOf(phase.id)
    ids.add(phase.id)
    assert(Array.isArray(phase.argv) && phase.argv.length > 0 && phase.argv.every(text), 'invalid phase argv')
    assert((phase.exitCode === null || Number.isSafeInteger(phase.exitCode)) && (phase.signal === null || text(phase.signal)), 'invalid phase exit')
    assert(!(phase.exitCode !== null && phase.signal !== null), 'a phase has either an exit code or a signal')
    assert([phase.timedOut, phase.cancelled, phase.overflowed].every(flag => typeof flag === 'boolean'), 'invalid phase flags')
    assert(phase.exitCode !== null || phase.signal !== null || phase.timedOut || phase.cancelled || phase.overflowed, 'a phase without close metadata must record why it stopped')
    for (const stream of ['stdout', 'stderr']) {
      exact(phase[stream], STREAM_FIELDS, 'phase stream')
      assert(phase[stream].path === posix(join('.formal-design', 'lean', evidence.modelId, evidence.runId, phase.id, `${stream}.log`)), 'invalid phase stream path')
      assert(natural(phase[stream].bytes) && hash(phase[stream].sha256), 'invalid phase stream artefact')
    }
    if (phase.report !== null) {
      exact(phase.report, STREAM_FIELDS, 'phase report')
      assert(safeRelative(phase.report.path) && natural(phase.report.bytes) && hash(phase.report.sha256), 'invalid phase report artefact')
    }
  }
  assert(time(evidence.startedAt) && time(evidence.finishedAt) && evidence.finishedAt >= evidence.startedAt, 'invalid timestamps')
  if (evidence.proofVerdict === 'verified') {
    assert(evidence.phases.every(phase => phase.exitCode === 0 && !phase.timedOut && !phase.cancelled && !phase.overflowed), 'a verified run must complete every phase cleanly')
    assert(evidence.phases.some(phase => phase.id === 'inspector' && phase.report !== null), 'a verified run must reference its inspector report')
  }
  return evidence
}

// ---------------------------------------------------------------------------
// Publication and the current-run pointer.
// ---------------------------------------------------------------------------
async function stageBytes(path, bytes, io = fs) {
  const temp = temporary(path)
  let handle
  try {
    handle = await io.open(temp, 'wx')
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = null
    return temp
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await io.unlink(temp).catch(() => {})
    throw error
  }
}

/**
 * Atomically publish the evidence object and its current-run pointer. Returns the
 * SHA-256 of the exact published evidence bytes (design section 8).
 */
export async function publishProof({ modelDir, runDir, evidence, io = fs }) {
  const bytes = Buffer.from(JSON.stringify(evidence) + '\n')
  const evidenceSha256 = createHash('sha256').update(bytes).digest('hex')
  const pointer = { schemaVersion: 1, runId: evidence.runId, inputDigest: evidence.inputDigest, evidenceSha256 }
  const evidencePath = join(modelDir, 'evidence.json')
  const pointerPath = join(modelDir, 'current-run.json')
  const temps = []
  try {
    temps.push(await stageBytes(join(runDir, 'evidence.json'), bytes, io))
    temps.push(await stageBytes(evidencePath, bytes, io))
    temps.push(await stageBytes(pointerPath, Buffer.from(JSON.stringify(pointer) + '\n'), io))
    // Ordering: the run copy and the current evidence first, then the pointer
    // that makes them current.
    await io.rename(temps[1], evidencePath)
    temps[1] = null
    await io.rename(temps[2], pointerPath)
    temps[2] = null
    await io.rename(temps[0], join(runDir, 'evidence.json'))
    temps[0] = null
    return { evidenceSha256, pointer }
  } finally {
    for (const temp of temps) if (temp) await io.unlink(temp).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Per-model lock, with the TLC lock ownership rules (check.lib.mjs).
// ---------------------------------------------------------------------------
export const lockPathFor = (root, modelId) => join(root, '.formal-design/locks', `lean-${modelId}.lock`)

export async function acquireLock(path, runId, startedAt, { io = fs, kill = process.kill } = {}) {
  const bytes = JSON.stringify({ schemaVersion: 1, pid: process.pid, runId, startedAt }) + '\n'
  await io.mkdir(join(path, '..'), { recursive: true })
  let handle
  try { handle = await io.open(path, 'wx') } catch (error) {
    if (error.code !== 'EEXIST') fail('io', 'model lock creation failed')
    const probe = await probeLock(path, kill)
    fail('lock-conflict', probe.detail ?? 'model lock exists; inspect diagnostics and confirm ownership before manual removal')
  }
  let identity = null
  try {
    identity = await handle.stat()
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close().catch(() => {})
  }
  return { path, bytes, identity }
}

export async function releaseLock(lock, { io = fs } = {}) {
  if (!lock) return
  // Exclusive creation plus this run's unique runId in the recorded content is
  // ownership proof; a lock is never removed because of its age.
  let stat = null
  try { stat = await io.lstat(lock.path) } catch { /* identity capture failed */ }
  let current = null
  try { current = await io.readFile(lock.path, 'utf8') } catch { /* unreadable */ }
  const identityMatches = Boolean(lock.identity && stat && stat.dev === lock.identity.dev && stat.ino === lock.identity.ino)
  if (current === lock.bytes || (identityMatches && (current === '' || current === null))) await io.unlink(lock.path)
}
