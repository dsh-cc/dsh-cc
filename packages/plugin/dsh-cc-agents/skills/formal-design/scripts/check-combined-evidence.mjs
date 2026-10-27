// Read-only combined TLA+/Lean bridge auditor (design section 10). It validates
// the strict bridge schema and cases files, invokes both backend read-only
// auditors, verifies pinned bridge hashes from both evidence packages, and
// checks every bridge invariant and corpus case appears in successful current
// evidence. It never needs a Lean installation or a JVM and never executes
// project code: it reads files and recomputes hashes only.
import * as fs from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { auditEvidence } from './evidence.lib.mjs'
import { auditLeanEvidence } from './lean-check-evidence.mjs'
import { BRIDGE_PATH, cfgDeclares, derivedInvariant, loadBridge, moduleDeclares, validateBridgeContract } from './bridge.lib.mjs'
import { canonicalJson, parseJsonTokens, parseLeanManifest } from './lean-manifest.lib.mjs'
import { parseCorpus, validateComparisonReport } from './lean-conformance.lib.mjs'
import { hashFile } from './lean-fingerprint.lib.mjs'

function reject(code, detail = code) { throw Object.assign(new Error(detail), { code, detail }) }
function output(fields) {
  return {
    schemaVersion: 1, command: 'check-combined-evidence', status: 'invalid', reason: null,
    bridge: null, tlaModel: null, leanModel: null, acceptanceReady: false,
    tlc: null, lean: null, ...fields,
  }
}

function readSyntax(bytes, label) {
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { reject('schema-invalid', `${label} is not valid UTF-8`) }
  try { return parseJsonTokens(text) } catch (error) { reject('schema-invalid', `${label}: ${error.detail ?? 'invalid JSON'}`) }
}

async function readJson(root, relative, label) {
  let bytes
  try { bytes = await fs.readFile(join(root, relative)) } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') reject('missing-file', `${label} is missing: ${relative}`)
    throw error
  }
  return { value: readSyntax(bytes, label), bytes }
}

async function readUtf8(root, relative, label) {
  let bytes
  try { bytes = await fs.readFile(join(root, relative)) } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') reject('missing-file', `${label} is missing: ${relative}`)
    throw error
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { reject('schema-invalid', `${label} is not valid UTF-8`) }
}

// Model inputs are recorded model-relative; bridge package entries are
// project-relative.
const resolveInput = (root, model, path) => path.startsWith('specs/') ? join(root, path) : join(root, model, path)

// Read an enumerated input and require the digest the evidence recorded.
async function digested(root, model, entry) {
  const absolute = resolveInput(root, model, entry.path)
  let bytes
  try { bytes = await fs.readFile(absolute) } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') reject('stale/input', `recorded input is missing: ${entry.path}`)
    throw error
  }
  if (await hashFile(absolute) !== entry.sha256) reject('stale/input', `recorded input does not match its digest: ${entry.path}`)
  return bytes
}

async function loadEvidence(root, model, name) {
  const { value } = await readJson(root, `${model}/${name}`, `${model}/${name}`)
  return value
}

/** Run the full combined audit. Throws a coded rejection on any failure. */
export async function auditCombined(project, bridgeRelative) {
  if (typeof bridgeRelative !== 'string' || !BRIDGE_PATH.test(bridgeRelative)) reject('config-invalid', '--bridge must be specs/formal/<feature-id>/bridge.json')
  let root
  try { root = await fs.realpath(project); if (!(await fs.stat(root)).isDirectory()) throw new Error('not a directory') } catch (error) { reject('unsafe-path', `--project must be an existing directory: ${error?.message ?? error}`) }

  // 1. Strict bridge header and package enumeration.
  let loaded
  try { loaded = await loadBridge(root, bridgeRelative) } catch (error) { reject(error.code ?? 'config-invalid', error.detail ?? 'the bridge package is invalid') }
  const { bridge } = loaded

  // 2. Strict cases files against the selected Lean manifest and corpus.
  const manifest = parseLeanManifest(await readUtf8(root, `${bridge.leanModel}/checks.json`, 'Lean manifest'))
  const corpus = parseCorpus(await readUtf8(root, `${bridge.leanModel}/conformance/cases.jsonl`, 'Lean corpus'), manifest)
  const { rows } = await validateBridgeContract(root, loaded, { manifest, corpus })

  // 3. Both read-only backend auditors.
  const tlcAudit = await auditEvidence({ project: root, model: bridge.tlaModel, bridge: bridgeRelative })
  if (tlcAudit.status !== 'valid') reject('tlc-evidence-invalid', tlcAudit.reason)
  const leanAudit = await auditLeanEvidence({ project: root, model: bridge.leanModel, stage: 'acceptance', bridge: bridgeRelative })
  if (leanAudit.status !== 'valid') reject('lean-evidence-invalid', leanAudit.reason)

  const tlcEvidence = await loadEvidence(root, bridge.tlaModel, 'evidence.json')
  const proofEvidence = await loadEvidence(root, bridge.leanModel, 'evidence.json')
  const conformanceEvidence = await loadEvidence(root, bridge.leanModel, 'conformance-evidence.json')

  // 4. Reject mixed bridge versions and verify pinned bridge hashes from both
  // evidence packages (design section 10).
  const packages = [
    ['TLC evidence', tlcEvidence], ['Lean proof evidence', proofEvidence], ['Lean conformance evidence', conformanceEvidence],
  ]
  for (const [label, evidence] of packages) {
    if (evidence.schemaVersion !== 2 || !Array.isArray(evidence.bridgeFiles)) reject('mixed-bridge-versions', `${label} is not version-two bridge evidence`)
    if (canonicalJson(evidence.bridgeFiles) !== canonicalJson(loaded.entries)) reject('bridge-stale', `${label} does not record the current bridge package hashes`)
  }

  // 5. Successful current evidence for both backends.
  if (tlcEvidence.status !== 'verified') reject('tlc-not-verified', `the TLC run status is ${tlcEvidence.status}`)
  if (proofEvidence.proofVerdict !== 'verified') reject('lean-not-verified', `the Lean proofVerdict is ${proofEvidence.proofVerdict}`)
  if (conformanceEvidence.conformanceVerdict !== 'passed') reject('lean-not-accepted', `the Lean conformanceVerdict is ${conformanceEvidence.conformanceVerdict}`)

  // 6. Every derived TLA invariant must be a complete cfg identifier token in a
  // verified case and be declared in a digested module (design section 10).
  const modules = tlcEvidence.inputFiles.filter(entry => entry.path.endsWith('.tla'))
  const caseStatus = new Map(tlcEvidence.cases.map(entry => [entry.id, entry.status]))
  const cfgEntries = tlcEvidence.inputFiles.filter(input => /^cases\/[^/]+\.cfg$/.test(input.path))
  for (const row of bridge.operations) {
    const name = derivedInvariant(row.id)
    let cfgFound = false
    for (const entry of cfgEntries) {
      const caseId = entry.path.slice('cases/'.length, -'.cfg'.length)
      if (caseStatus.get(caseId) !== 'verified') continue
      const text = (await digested(root, bridge.tlaModel, entry)).toString('utf8')
      if (cfgDeclares(text, name)) { cfgFound = true; break }
    }
    if (!cfgFound) reject('bridge-invariant-missing', `${name} is not a configured invariant of any verified TLC case`)
    let declared = false
    for (const entry of modules) {
      const text = (await digested(root, bridge.tlaModel, entry)).toString('utf8')
      if (moduleDeclares(text, name)) { declared = true; break }
    }
    if (!declared) reject('bridge-invariant-missing', `${name} is not declared in a digested TLA module`)
  }

  // Conclusion: every bridge case row must appear in the hashed comparison
  // report with both the reference and implementation returning `expected`.
  const compare = conformanceEvidence.phases.find(phase => phase.id === 'compare')
  if (!compare?.report) reject('cache-report-missing', 'the conformance evidence has no hashed comparison report')
  const reportBytes = await fs.readFile(join(root, compare.report.path)).catch(() => reject('missing-file', 'the comparison report is missing'))
  if (reportBytes.length !== compare.report.bytes || await hashFile(join(root, compare.report.path)) !== compare.report.sha256) reject('hash-mismatch', 'the comparison report does not match its record')
  const report = validateComparisonReport(readSyntax(reportBytes, 'comparison report'), corpus)
  const byId = new Map(report.cases.map(entry => [entry.id, entry]))
  for (const row of rows) {
    const entry = byId.get(row.id)
    if (!entry) reject('bridge-case-missing', `the comparison report omits bridge case ${row.id}`)
    if (!entry.matched) reject('bridge-case-mismatch', `bridge case ${row.id} did not match`)
    if (canonicalJson(entry.referenceResult) !== canonicalJson(row.expected)) reject('bridge-case-mismatch', `bridge case ${row.id} reference result differs from expected`)
    if (canonicalJson(entry.implementationResult) !== canonicalJson(row.expected)) reject('bridge-case-mismatch', `bridge case ${row.id} implementation result differs from expected`)
  }

  return output({
    status: 'valid', reason: 'valid', bridge: bridge.featureId, tlaModel: bridge.tlaModel, leanModel: bridge.leanModel,
    acceptanceReady: true,
    tlc: { status: tlcEvidence.status, runId: tlcEvidence.runId, inputDigest: tlcEvidence.inputDigest },
    lean: {
      proofVerdict: proofEvidence.proofVerdict, conformanceVerdict: conformanceEvidence.conformanceVerdict,
      proofRunId: proofEvidence.runId, conformanceRunId: conformanceEvidence.runId, inputDigest: proofEvidence.inputDigest,
    },
  })
}

function parseSyntax(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true }
  const allowed = ['project', 'bridge']
  const options = {}
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    if (!flag.startsWith('--') || !allowed.includes(flag.slice(2)) || Object.hasOwn(options, flag.slice(2)) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw Object.assign(new Error('invalid, missing, unknown or duplicate argument'), { code: 'usage-invalid', detail: 'invalid, missing, unknown or duplicate argument' })
    }
    options[flag.slice(2)] = argv[i + 1]
  }
  if (!options.project || !options.bridge) throw Object.assign(new Error('--project and --bridge are required'), { code: 'usage-invalid', detail: '--project and --bridge are required' })
  return options
}

export async function main(argv = process.argv.slice(2)) {
  let options
  try { options = parseSyntax(argv) } catch (error) {
    process.stdout.write(JSON.stringify(output({ status: 'invalid', reason: error.code ?? 'usage-invalid' })) + '\n')
    return 2
  }
  if (options.help) {
    process.stdout.write('check-combined-evidence --project <root> --bridge specs/formal/<id>/bridge.json\n')
    return 0
  }
  try {
    const result = await auditCombined(options.project, options.bridge)
    process.stdout.write(JSON.stringify(result) + '\n')
    return 0
  } catch (error) {
    const reason = error.code === 'usage-invalid' ? 'usage-invalid' : error.code ?? 'io'
    process.stdout.write(JSON.stringify(output({ status: 'invalid', reason })) + '\n')
    return 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main()
