// Conformance protocol, execution closure and conformance evidence for the Lean
// backend (design sections 7 and 8). Producers and read-only auditors import the
// same validators, so both decide a verdict from identical rules.
import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import {
  ADAPTER, CORPUS, ID, PLATFORMS, assert, canonicalJson, compareCodepoint, fail, parseJsonTokens, projectRelativePath,
} from './lean-manifest.lib.mjs'
import { executionDigest, hashFile, posix, sha256 } from './lean-fingerprint.lib.mjs'
import {
  BACKEND, BUILD_ORDER, PHASES, REASON_CODES, SCHEMA_VERSION, validateProofEvidence,
  bridgeInputsFor, proofInputDigest, proofInputFiles, runnerDigest, runnerFiles, runnerPackage,
} from './lean-evidence.lib.mjs'
import { temporary } from './storage.lib.mjs'

export const CONFORMANCE_VERDICTS = Object.freeze(['passed', 'failed', 'blocked', 'incomplete', 'not-run'])
const MB = 1024 * 1024
const CORPUS_LIMIT = 20 * MB
const CORPUS_LINE_LIMIT = 64 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const HASH = /^[a-f0-9]{64}$/
const ERROR_CODE = /^[a-z][a-z0-9-]{0,63}$/
const EVIDENCE_FIELDS = ['schemaVersion', 'backend', 'modelId', 'runId', 'proofRunId', 'proofInputDigest', 'executionFiles', 'executionDigest', 'runnerDigest', 'toolchain', 'conformanceVerdict', 'reason', 'caseCount', 'matchedCount', 'firstMismatch', 'phases', 'startedAt', 'finishedAt']
// Version two adds exactly one field, `bridgeFiles` (design section 10).
const EVIDENCE_FIELDS_V2 = [...EVIDENCE_FIELDS, 'bridgeFiles']
const TOOLCHAIN_FIELDS = ['toolchain', 'platform', 'archiveSha256', 'contentDigest', 'version']
const PHASE_FIELDS = ['id', 'argv', 'exitCode', 'signal', 'timedOut', 'cancelled', 'overflowed', 'stdout', 'stderr', 'report']
const STREAM_FIELDS = ['path', 'bytes', 'sha256']
const MISMATCH_FIELDS = ['id', 'input', 'referenceResult', 'implementationResult']
const REPORT_FIELDS = ['schemaVersion', 'caseCount', 'matchedCount', 'cases']
const REPORT_CASE_FIELDS = ['id', 'referenceResult', 'implementationResult', 'matched']

const text = value => typeof value === 'string' && value.length > 0
const hash = value => typeof value === 'string' && HASH.test(value)
const natural = value => Number.isSafeInteger(value) && value >= 0
const time = value => {
  try { return typeof value === 'string' && new Date(value).toISOString() === value } catch { return false }
}
const safeRelative = value => text(value) && !value.startsWith('/') && !value.includes('\\') && value.split('/').every(segment => segment && segment !== '.' && segment !== '..')

function exact(value, fields, label) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  const keys = Object.keys(value).sort(compareCodepoint)
  const expected = [...fields].sort(compareCodepoint)
  assert(keys.length === expected.length && keys.every((key, index) => key === expected[index]), `${label} fields must be exactly ${fields.join(',')}`)
  return value
}

// ---------------------------------------------------------------------------
// Corpus (design section 7). UTF-8 JSON Lines, no blank lines, exactly
// `id`, `input`, `covers`; the raw token grammar decides duplicates and numeric
// spelling for every line.
// ---------------------------------------------------------------------------
export function parseCorpus(corpusText, manifest) {
  assert(typeof corpusText === 'string', 'corpus must be text')
  assert(Buffer.byteLength(corpusText, 'utf8') <= CORPUS_LIMIT, 'corpus exceeds 20 MiB')
  const lines = corpusText.split('\n')
  if (lines.at(-1) === '') lines.pop()
  assert(lines.length > 0, 'corpus must contain at least one case')
  assert(lines.length <= manifest.limits.maxCases, `corpus has ${lines.length} lines, over maxCases ${manifest.limits.maxCases}`)
  const declared = new Set(manifest.properties.map(({ id }) => id))
  const covered = new Set()
  const ids = new Set()
  const cases = []
  lines.forEach((line, index) => {
    const position = index + 1
    if (line.trim().length === 0) fail('config-invalid', `corpus line ${position} is blank`)
    assert(Buffer.byteLength(line, 'utf8') <= CORPUS_LINE_LIMIT, `corpus line ${position} exceeds 64 KiB`)
    let value
    try { value = parseJsonTokens(line) } catch (error) { fail('config-invalid', `corpus line ${position}: ${error.detail ?? 'invalid JSON'}`) }
    exact(value, ['id', 'input', 'covers'], `corpus line ${position}`)
    assert(typeof value.id === 'string' && ID.test(value.id), `corpus line ${position}: id must match the case-id grammar`)
    assert(!ids.has(value.id), `corpus line ${position}: duplicate case id ${value.id}`)
    ids.add(value.id)
    assert(Array.isArray(value.covers) && value.covers.length > 0, `corpus line ${position}: covers must be a nonempty array`)
    assert(value.covers.every(id => typeof id === 'string' && declared.has(id)), `corpus line ${position}: covers names an undeclared property`)
    assert(new Set(value.covers).size === value.covers.length, `corpus line ${position}: covers must be unique`)
    for (const id of value.covers) covered.add(id)
    cases.push({ id: value.id, input: value.input, covers: value.covers })
  })
  for (const id of declared) assert(covered.has(id), `declared property ${id} has no corpus case`)
  return cases
}

// The stdin protocol: one canonical `{ "id": ..., "input": ... }` line per case.
export const protocolInput = cases => cases.map(({ id, input }) => canonicalJson({ id, input }) + '\n').join('')

// ---------------------------------------------------------------------------
// Result protocol (design section 7): exactly one JSON line per input, in order,
// with exactly `id` and `result`; result is exactly `{"ok": ...}` or
// `{"error": {"code": ...}}`. Exception text is never compared.
// ---------------------------------------------------------------------------
export function parseResult(value, label) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label}: result must be an object`)
  const keys = Object.keys(value)
  if (keys.length === 1 && keys[0] === 'ok') return { ok: value.ok }
  if (keys.length === 1 && keys[0] === 'error') {
    exact(value.error, ['code'], `${label}: error`)
    assert(typeof value.error.code === 'string' && ERROR_CODE.test(value.error.code), `${label}: error code must match [a-z][a-z0-9-]{0,63}`)
    return { error: { code: value.error.code } }
  }
  return fail('protocol-invalid', `${label}: result must be exactly {"ok": ...} or {"error": {"code": ...}}`)
}

export function parseOutput(stream, cases, side) {
  if (typeof stream !== 'string') fail('protocol-invalid', `${side} produced no readable output`)
  const lines = stream.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length !== cases.length) fail('protocol-invalid', `${side} emitted ${lines.length} lines for ${cases.length} inputs`)
  return lines.map((line, index) => {
    const label = `${side} line ${index + 1}`
    if (line.length === 0) fail('protocol-invalid', `${label} is blank`)
    let value
    try { value = parseJsonTokens(line) } catch (error) { fail('protocol-invalid', `${label}: ${error.detail ?? 'invalid JSON'}`) }
    exact(value, ['id', 'result'], label)
    if (value.id !== cases[index].id) fail('protocol-invalid', `${label}: expected id ${cases[index].id}, got ${JSON.stringify(value.id)}`)
    return parseResult(value.result, label)
  })
}

// Canonical comparison of parsed values: object keys sorted by code point, array
// order and scalars preserved (design section 7).
export function compareOutputs(reference, implementation, cases) {
  const entries = cases.map((entry, index) => ({
    id: entry.id,
    referenceResult: reference[index],
    implementationResult: implementation[index],
    matched: canonicalJson(reference[index]) === canonicalJson(implementation[index]),
  }))
  return { schemaVersion: 1, caseCount: cases.length, matchedCount: entries.filter(({ matched }) => matched).length, cases: entries }
}

export function validateComparisonReport(report, cases, label = 'comparison report') {
  exact(report, REPORT_FIELDS, label)
  assert(report.schemaVersion === SCHEMA_VERSION, `${label} schemaVersion must be 1`)
  assert(natural(report.caseCount) && natural(report.matchedCount) && report.matchedCount <= report.caseCount, `${label} has invalid counts`)
  assert(report.caseCount === cases.length && Array.isArray(report.cases) && report.cases.length === cases.length, `${label} does not cover every corpus case`)
  report.cases.forEach((entry, index) => {
    exact(entry, REPORT_CASE_FIELDS, `${label} case`)
    assert(entry.id === cases[index].id, `${label} case ${index + 1} is out of corpus order`)
    assert(typeof entry.matched === 'boolean', `${label} case ${entry.id} has an invalid match flag`)
    const reference = parseResult(entry.referenceResult, `${label} case ${entry.id}: reference`)
    const implementation = parseResult(entry.implementationResult, `${label} case ${entry.id}: implementation`)
    assert(entry.matched === (canonicalJson(reference) === canonicalJson(implementation)), `${label} case ${entry.id} has an inconsistent match flag`)
  })
  assert(report.matchedCount === report.cases.filter(({ matched }) => matched).length, `${label} matchedCount is inconsistent`)
  return report
}

// The earliest corpus line whose results differ, or null (design section 7).
export function firstMismatchOf(report, cases) {
  const index = report.cases.findIndex(({ matched }) => !matched)
  if (index < 0) return null
  const entry = report.cases[index]
  return { id: entry.id, input: cases[index].input, referenceResult: entry.referenceResult, implementationResult: entry.implementationResult }
}

/**
 * Recompute the verdict from a stored, validated comparison report: passed only
 * when every case matched, otherwise failed on the earliest differing case.
 */
export function replayConformance(report, cases) {
  validateComparisonReport(report, cases)
  const firstMismatch = firstMismatchOf(report, cases)
  return { verdict: firstMismatch === null ? 'passed' : 'failed', firstMismatch, matchedCount: report.matchedCount, caseCount: report.caseCount }
}

// ---------------------------------------------------------------------------
// Execution closure (design section 8): corpus, adapter, every declared
// implementation/execution file, the Node identity and the proof input digest.
// Entries are project-relative (repository-root-relative).
// ---------------------------------------------------------------------------
// The Node identity is this runner's own executable plus its reported version, so
// the read-only auditor can recompute it without executing project code. A run
// audited by a different Node line is stale by design.
export const nodeIdentity = (execPath = process.execPath, version = process.version) => `${realpathSync(execPath)}|${version}`

export async function executionFilesFor(root, modelRelative, manifest, io = fs, bridgeEntries = []) {
  assert(manifest.conformance, 'the manifest declares no conformance contract')
  const declared = [...manifest.conformance.implementationFiles, ...manifest.conformance.executionFiles]
  for (const path of declared) projectRelativePath(path, 'declared execution input')
  const base = [`${modelRelative}/${ADAPTER}`, `${modelRelative}/${CORPUS}`, ...declared]
  // The opt-in bridge package is part of the execution closure before hashing.
  const extra = bridgeEntries.map(({ path }) => path)
  for (const path of extra) { projectRelativePath(path, 'bridge execution input'); assert(!base.includes(path), 'duplicate execution input path') }
  const wanted = [...base, ...extra]
  const paths = [...new Set(wanted)].sort(compareCodepoint)
  assert(paths.length === wanted.length, 'duplicate execution input path')
  const entries = []
  for (const path of paths) {
    let stat
    try { stat = await io.stat(join(root, path)) } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') fail('missing-input', `declared execution input is missing: ${path}`)
      throw error
    }
    assert(stat.isFile(), `declared execution input is not a regular file: ${path}`)
    entries.push({ path, sha256: await hashFile(join(root, path)) })
  }
  return entries
}

export const executionDigestOf = (entries, node, digest) => executionDigest(entries, node, digest)

// ---------------------------------------------------------------------------
// Current proof prerequisites (design sections 7 and 8): a fresh, verified run
// is required before the reference can be rebuilt.
// ---------------------------------------------------------------------------
export async function readCurrentProof(root, modelDir, modelRelative, manifest, io = fs) {
  const read = async (name, code, message) => {
    try { return await io.readFile(join(modelDir, name)) } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') fail(code, message)
      throw error
    }
  }
  const pointerBytes = await read('current-run.json', 'missing-input', `missing proof prerequisites: ${modelRelative}/current-run.json does not exist`)
  let pointer
  try { pointer = parseJsonTokens(new TextDecoder('utf-8', { fatal: true }).decode(pointerBytes)) } catch (error) { fail('artifact-changed', `current-run.json is invalid: ${error.detail ?? 'not canonical JSON'}`) }
  exact(pointer, ['schemaVersion', 'runId', 'inputDigest', 'evidenceSha256'], 'current-run.json')
  assert(pointer.schemaVersion === SCHEMA_VERSION && typeof pointer.runId === 'string' && UUID.test(pointer.runId) && hash(pointer.inputDigest) && hash(pointer.evidenceSha256), 'current-run.json is invalid')
  const bytes = await read('evidence.json', 'missing-input', `missing proof prerequisites: ${modelRelative}/evidence.json does not exist`)
  if (sha256(bytes) !== pointer.evidenceSha256) fail('artifact-changed', 'published proof evidence does not match its pointer hash')
  let evidence
  try { evidence = parseJsonTokens(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch (error) { fail('artifact-changed', `proof evidence is invalid: ${error.detail ?? 'not canonical JSON'}`) }
  validateProofEvidence(evidence, manifest)
  if (evidence.runId !== pointer.runId || evidence.inputDigest !== pointer.inputDigest) fail('artifact-changed', 'published proof evidence does not match its pointer identity')
  if (evidence.proofVerdict !== 'verified') fail('config-invalid', `missing proof prerequisites: the current proof verdict is ${evidence.proofVerdict}`)
  // Freshness: the proof inputs on disk, plus the recorded bridge package, must
  // still hash to the recorded digest (design section 10).
  let current = null
  try {
    const base = await proofInputFiles(modelDir)
    const bridge = await bridgeInputsFor(root, evidence)
    current = proofInputDigest(bridge ? [...base, ...bridge.entries] : base)
  } catch { current = null }
  if (current !== evidence.inputDigest) fail('input-changed', 'missing proof prerequisites: proof inputs changed since the recorded run')
  return { evidence, evidenceSha256: pointer.evidenceSha256 }
}

export async function runnerIdentityOf(skillDir) {
  const files = await runnerFiles(skillDir)
  return { files, digest: runnerDigest(files), package: await runnerPackage() }
}

// ---------------------------------------------------------------------------
// Conformance evidence (design section 8).
// ---------------------------------------------------------------------------
export const reportPath = (modelId, runId) => posix(join('.formal-design', 'lean', modelId, runId, 'compare', 'comparison-report.json'))

export function validateConformanceEvidence(evidence, manifest) {
  const version = evidence?.schemaVersion
  exact(evidence, version === 2 ? EVIDENCE_FIELDS_V2 : EVIDENCE_FIELDS, 'conformance evidence')
  assert(version === 1 || version === 2, 'unknown conformance evidence schema version')
  assert(evidence.backend === BACKEND, 'conformance evidence backend must be "lean"')
  assert(text(evidence.modelId) && evidence.modelId === manifest.modelId, 'conformance evidence modelId must equal the manifest modelId')
  assert(typeof evidence.runId === 'string' && UUID.test(evidence.runId), 'runId must be a fresh UUID')
  assert(typeof evidence.proofRunId === 'string' && UUID.test(evidence.proofRunId) && evidence.proofRunId !== evidence.runId, 'proofRunId must be a different fresh UUID')
  for (const field of ['proofInputDigest', 'executionDigest', 'runnerDigest']) assert(hash(evidence[field]), `invalid ${field}`)
  assert(Array.isArray(evidence.executionFiles) && evidence.executionFiles.length > 0, 'conformance evidence must enumerate the execution closure')
  const seen = new Set()
  let previous = null
  for (const entry of evidence.executionFiles) {
    exact(entry, ['path', 'sha256'], 'executionFiles entry')
    assert(safeRelative(entry.path) && hash(entry.sha256) && !seen.has(entry.path), 'invalid executionFiles entry')
    if (previous !== null) assert(compareCodepoint(previous, entry.path) < 0, 'executionFiles must be sorted and unique')
    previous = entry.path
    seen.add(entry.path)
  }
  if (version === 2) {
    assert(Array.isArray(evidence.bridgeFiles) && evidence.bridgeFiles.length > 0, 'version-two evidence must enumerate bridgeFiles')
    const bridgeSeen = new Set()
    let bridgeJson = false
    for (const entry of evidence.bridgeFiles) {
      exact(entry, ['path', 'sha256'], 'bridgeFiles entry')
      assert(safeRelative(entry.path) && !bridgeSeen.has(entry.path) && hash(entry.sha256), 'invalid bridgeFiles entry')
      bridgeSeen.add(entry.path)
      if (/^specs\/formal\/[a-z][a-z0-9-]{0,63}\/bridge\.json$/.test(entry.path)) bridgeJson = true
      // Bridge files join the execution closure before hashing.
      assert(evidence.executionFiles.some(input => input.path === entry.path && input.sha256 === entry.sha256), 'bridgeFiles must be part of executionFiles')
    }
    assert(bridgeJson, 'bridgeFiles must contain the bridge.json entry')
  }
  exact(evidence.toolchain, TOOLCHAIN_FIELDS, 'toolchain')
  assert(/^leanprover\/lean4:v[0-9]+\.[0-9]+\.[0-9]+$/.test(evidence.toolchain.toolchain) && PLATFORMS.includes(evidence.toolchain.platform) && hash(evidence.toolchain.archiveSha256) && hash(evidence.toolchain.contentDigest) && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(evidence.toolchain.version), 'invalid toolchain identity')
  assert(CONFORMANCE_VERDICTS.includes(evidence.conformanceVerdict), 'invalid conformanceVerdict')
  if (evidence.conformanceVerdict === 'passed') assert(evidence.reason === null, 'a passed run must not carry a reason')
  else {
    exact(evidence.reason, ['code', 'detail'], 'reason')
    assert(REASON_CODES.includes(evidence.reason.code), `reason code must be one of ${REASON_CODES.join(',')}`)
    assert(evidence.reason.detail !== null && typeof evidence.reason.detail === 'object' && !Array.isArray(evidence.reason.detail), 'reason detail must be an object')
  }
  assert(natural(evidence.caseCount) && natural(evidence.matchedCount) && evidence.matchedCount <= evidence.caseCount, 'invalid conformance counts')
  if (evidence.firstMismatch !== null) {
    exact(evidence.firstMismatch, MISMATCH_FIELDS, 'firstMismatch')
    assert(typeof evidence.firstMismatch.id === 'string' && ID.test(evidence.firstMismatch.id), 'firstMismatch id must match the case-id grammar')
    parseResult(evidence.firstMismatch.referenceResult, 'firstMismatch reference result')
    parseResult(evidence.firstMismatch.implementationResult, 'firstMismatch implementation result')
    assert(evidence.conformanceVerdict === 'failed', 'firstMismatch must be null unless the run failed')
  }
  assert(Array.isArray(evidence.phases), 'conformance evidence must record its phases')
  const ids = new Set()
  let order = -1
  for (const phase of evidence.phases) {
    exact(phase, PHASE_FIELDS, 'phase')
    assert(PHASES.includes(phase.id) && !ids.has(phase.id), 'unknown or duplicate phase identifier')
    assert(BUILD_ORDER.indexOf(phase.id) > order, 'phases must be recorded in build order')
    order = BUILD_ORDER.indexOf(phase.id)
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
      assert(phase.report.path === reportPath(evidence.modelId, evidence.runId) && natural(phase.report.bytes) && hash(phase.report.sha256), 'invalid phase report artefact')
    }
  }
  assert(time(evidence.startedAt) && time(evidence.finishedAt) && evidence.finishedAt >= evidence.startedAt, 'invalid timestamps')
  const compare = evidence.phases.find(phase => phase.id === 'compare')
  if (evidence.conformanceVerdict === 'passed') {
    assert(evidence.phases.length > 0 && evidence.phases.every(phase => phase.exitCode === 0 && !phase.timedOut && !phase.cancelled && !phase.overflowed), 'a passed run must complete every phase cleanly')
    assert(compare && compare.report !== null, 'a passed run must reference its comparison report')
    assert(evidence.caseCount > 0 && evidence.matchedCount === evidence.caseCount, 'a passed run must match every case')
  }
  if (evidence.conformanceVerdict === 'failed') {
    assert(evidence.reason !== null, 'a failed run must carry a reason')
    // A protocol failure uses `reason` rather than fabricated results; only a
    // real difference carries a recorded mismatch (design section 8).
    if (evidence.firstMismatch === null) assert(evidence.reason.code === 'protocol-invalid', 'a protocol failure must record that reason')
    else {
      assert(evidence.reason.code === 'output-invalid', 'a recorded mismatch must carry the difference reason')
      assert(compare && compare.report !== null && evidence.matchedCount < evidence.caseCount, 'a mismatch must reference the comparison report')
    }
  }
  if (evidence.conformanceVerdict === 'not-run') assert(evidence.phases.length === 0 && evidence.caseCount === 0 && evidence.matchedCount === 0 && evidence.firstMismatch === null, 'a not-run record has no results')
  return evidence
}

/**
 * Atomically publish conformance evidence next to the model, keyed to its proof
 * run. There is no pointer: the evidence binds its proof run directly.
 */
export async function publishConformance({ modelDir, runDir, evidence, io = fs }) {
  const bytes = Buffer.from(JSON.stringify(evidence) + '\n')
  const evidenceSha256 = createHash('sha256').update(bytes).digest('hex')
  const targets = [join(runDir, 'conformance-evidence.json'), join(modelDir, 'conformance-evidence.json')]
  const staged = []
  try {
    for (const target of targets) {
      const temp = temporary(target)
      let handle
      try {
        handle = await io.open(temp, 'wx')
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        if (handle) await handle.close().catch(() => {})
      }
      staged.push([temp, target])
    }
    for (const [temp, target] of staged) await io.rename(temp, target)
    return { evidenceSha256 }
  } finally {
    for (const [temp] of staged) await io.unlink(temp).catch(() => {})
  }
}
