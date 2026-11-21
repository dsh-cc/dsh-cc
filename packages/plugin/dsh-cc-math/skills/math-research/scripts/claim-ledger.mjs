import * as fs from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assert, atomicWrite, canonicalJson, ensureWritable, exists, fail, hashFile, parseFlags, readJson, runCli, sha256 } from './storage.lib.mjs'
import { validateRunManifest } from './run-manifest.lib.mjs'

// Claim ledger (design §6.3, §9.2–9.4): chain-hashed `claims.jsonl` carrying
// the M0 core claim states and the M0-subset transition table. Exactly one
// writer (the main conversation); every append rewrites the whole file
// atomically — no byte-append anywhere (§3.3).
//
// Chain hash: each entry's `hash` is
//   sha256( canonicalJson(entry-without-hash) + '\n' + prevHash )
// where canonicalJson has fixed (codepoint-sorted) field order, so any edit
// to any field of any entry breaks `--verify` (§6.3 "detects any field
// edit"). The genesis entry chains from 64 zeroes.
//
// Transitions REQUIRE typed verification records `{kind, verdict,
// bindingHashes?, evidence?}` produced by the verifier scripts (lean-run,
// sympy-run, fidelity gate) plus evidence hashes that are re-checked at
// append time (path exists + sha256 matches). Unknown states and
// non-existent edges are rejected by explicit enumeration (exit 2) — the
// M3 states arrive with their milestone, never silently.

export const M0_STATES = Object.freeze(['open', 'proven', 'proven-of-formal-statement', 'falsified', 'superseded', 'fidelity-failed'])
export const TERMINAL_STATES = Object.freeze(['superseded', 'fidelity-failed'])
export const RECORD_KINDS = Object.freeze(['l2-pass', 'fidelity', 'counterexample', 'fidelity-correction', 'dispute', 'human-ruling', 'lean-negation'])
export const FIDELITY_GRADES = Object.freeze(['anchored', 'human-confirmed', 'model-assessed', 'disputed'])
const GENESIS_PREV = '0'.repeat(64)
const CLAIM_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/
const HEX64 = /^[a-f0-9]{64}$/

export const ledgerPath = runDir => join(runDir, 'claims.jsonl')

// The M0 transition table (§6.3 subset): edge → required verification
// records. `→ proven` variants share the v4/v5 guard: an outstanding
// full-isolation L1 counterexample in the claim's history blocks promotion.
const FIDELITY_SUPPORTING_PROOF = ['anchored', 'human-confirmed']
export const TRANSITIONS = Object.freeze({
  'open→proven': { requires: { 'l2-pass': ['pass'], fidelity: FIDELITY_SUPPORTING_PROOF }, counterexampleGuard: true },
  'open→proven-of-formal-statement': { requires: { 'l2-pass': ['pass'], fidelity: ['model-assessed'] }, counterexampleGuard: false },
  'open→falsified': { requires: {}, counterexampleGuard: false, falsifyEvidence: true },
  'proven-of-formal-statement→proven': { requires: { fidelity: FIDELITY_SUPPORTING_PROOF }, counterexampleGuard: true },
  'proven→superseded': { requires: { 'fidelity-correction': ['confirmed'] }, counterexampleGuard: false },
  'proven-of-formal-statement→superseded': { requires: { 'fidelity-correction': ['confirmed'] }, counterexampleGuard: false },
  'falsified→superseded': { requires: { 'fidelity-correction': ['confirmed'] }, counterexampleGuard: false },
  'open→fidelity-failed': { requires: { dispute: ['confirmed'] }, counterexampleGuard: false },
  'proven→fidelity-failed': { requires: { dispute: ['confirmed'] }, counterexampleGuard: false },
  'proven-of-formal-statement→fidelity-failed': { requires: { dispute: ['confirmed'] }, counterexampleGuard: false },
  'falsified→fidelity-failed': { requires: { dispute: ['confirmed'] }, counterexampleGuard: false },
})

export const edgeName = (from, to) => `${from}→${to}`

// ---------------------------------------------------------------------------
// Record and entry validation
// ---------------------------------------------------------------------------
function validateRecord(record, index) {
  const label = `records[${index}]`
  assert(record && typeof record === 'object' && !Array.isArray(record), `${label} must be an object`)
  const unknown = Object.keys(record).filter(key => !['kind', 'verdict', 'bindingHashes', 'isolation', 'mechanism', 'evidence'].includes(key))
  assert(unknown.length === 0, `${label} has unknown field(s): ${unknown.join(',')}`)
  assert(RECORD_KINDS.includes(record.kind), `${label}.kind must be one of ${RECORD_KINDS.join('|')}`)
  assert(typeof record.verdict === 'string' && record.verdict.length > 0, `${label}.verdict must be a non-empty string`)
  if (record.bindingHashes !== undefined) {
    assert(record.bindingHashes && typeof record.bindingHashes === 'object' && !Array.isArray(record.bindingHashes), `${label}.bindingHashes must be an object`)
    for (const [name, hex] of Object.entries(record.bindingHashes)) assert(typeof name === 'string' && HEX64.test(hex), `${label}.bindingHashes.${name} must be lowercase sha256 hex`)
  }
  if (record.isolation !== undefined) assert(['full', 'partial'].includes(record.isolation), `${label}.isolation must be full|partial`)
  if (record.mechanism !== undefined) assert(['computation', 'lean'].includes(record.mechanism), `${label}.mechanism must be computation|lean`)
  if (record.evidence !== undefined) {
    assert(Array.isArray(record.evidence), `${label}.evidence must be an array`)
    record.evidence.forEach((item, i) => {
      assert(item && typeof item.path === 'string' && HEX64.test(item.sha256 ?? ''), `${label}.evidence[${i}] needs {path, sha256}`)
    })
  }
}

async function checkEvidence(runDir, records, { io = fs } = {}) {
  for (const record of records) {
    for (const item of record.evidence ?? []) {
      const path = resolve(runDir, item.path)
      const actual = await hashFile(path).catch(e => { if (e.code === 'ENOENT') fail('missing-evidence', `evidence file ${item.path} does not exist`); throw e })
      assert(actual === item.sha256, `evidence ${item.path} sha256 mismatch: recorded ${item.sha256}, actual ${actual}`, 'evidence-mismatch')
    }
  }
}

// ---------------------------------------------------------------------------
// Chain reading and verification
// ---------------------------------------------------------------------------
export const entryPreimage = (entry, prevHash) => Buffer.concat([Buffer.from(canonicalJson(entry), 'utf8'), Buffer.from(`\n${prevHash}`, 'utf8')])
export const entryHash = (entry, prevHash) => sha256(entryPreimage(entry, prevHash))

/** Entries on disk carry `hash`; the preimage commits to everything else. */
function assembleEntry({ seq, claimId, at, type, from, to, statementFaithful, records }, prevHash) {
  const preimage = { schemaVersion: 1, seq, claimId, at, type, from, to, statementFaithful, records, prevHash }
  const fixed = { schemaVersion: 1, seq, claimId, at, type, from, to, statementFaithful, records, prevHash, hash: entryHash(preimage, prevHash) }
  return { line: JSON.stringify(fixed), entry: fixed }
}

export function parseLedgerText(text) {
  const entries = []
  const lines = text.split('\n').filter(line => line.trim().length > 0)
  for (const [index, line] of lines.entries()) {
    let entry
    try { entry = JSON.parse(line) }
    catch { fail('chain-invalid', `line ${index + 1} is not valid JSON`) }
    entries.push(entry)
  }
  return entries
}

export async function loadLedger(runDir, { io = fs } = {}) {
  const path = ledgerPath(runDir)
  try { return parseLedgerText(await io.readFile(path, 'utf8')) }
  catch (e) { if (e.code === 'ENOENT') return []; throw e }
}

function assertEntryShape(entry, index) {
  const label = `entry ${index + 1}`
  const expected = ['schemaVersion', 'seq', 'claimId', 'at', 'type', 'from', 'to', 'statementFaithful', 'records', 'prevHash', 'hash']
  const keys = Object.keys(entry).sort()
  if (JSON.stringify(keys) !== JSON.stringify([...expected].sort())) fail('chain-invalid', `${label} must have exactly the fields ${expected.join(',')}`)
  if (entry.schemaVersion !== 1 || entry.seq !== index || !CLAIM_ID.test(entry.claimId ?? '') || typeof entry.at !== 'string') fail('chain-invalid', `${label} has malformed identity fields`)
  if (!['genesis', 'transition'].includes(entry.type)) fail('chain-invalid', `${label} has unknown type`)
  if (!HEX64.test(entry.prevHash ?? '') || !HEX64.test(entry.hash ?? '')) fail('chain-invalid', `${label} has malformed hashes`)
  if (!(M0_STATES.includes(entry.to))) fail('chain-invalid', `${label} targets a non-M0 state ${entry.to}`)
  if (!(entry.from === null || M0_STATES.includes(entry.from))) fail('chain-invalid', `${label} has a non-M0 source state`)
  if (!(Array.isArray(entry.records))) fail('chain-invalid', `${label} records must be an array`)
}

/** Recompute the whole chain; any field edit is detected (§6.3). */
export function verifyChain(entries) {
  let prev = GENESIS_PREV
  const claims = new Map()
  for (const [index, entry] of entries.entries()) {
    assertEntryShape(entry, index)
    if (entry.prevHash !== prev) fail('chain-invalid', `entry ${index + 1} chain linkage broken`)
    const { hash: _hash, ...preimage } = entry
    if (entryHash(preimage, prev) !== entry.hash) fail('chain-invalid', `entry ${index + 1} hash mismatch: a field was edited`)
    // Replay the table: tampering with from/to that keeps hashes consistent
    // only happens through this code, so the replay enforces the same rules.
    if (entry.type === 'genesis') {
      if (entry.from !== null || entry.to !== 'open') fail('chain-invalid', `entry ${index + 1} genesis is malformed`)
      if (claims.has(entry.claimId)) fail('chain-invalid', `duplicate genesis for ${entry.claimId}`)
      claims.set(entry.claimId, entry.to)
    } else {
      if (!claims.has(entry.claimId)) fail('chain-invalid', `transition for unknown claim ${entry.claimId}`)
      if (claims.get(entry.claimId) !== entry.from) fail('chain-invalid', `entry ${index + 1} source state does not match the ledger`)
      if (!TRANSITIONS[edgeName(entry.from, entry.to)]) fail('chain-invalid', `entry ${index + 1} is not an M0-table edge`)
      claims.set(entry.claimId, entry.to)
    }
    prev = entry.hash
  }
  return { entries: entries.length, head: prev === GENESIS_PREV ? null : prev, claims: Object.fromEntries(claims) }
}

const currentState = (entries, claimId) => {
  let state = null
  for (const entry of entries) if (entry.claimId === claimId) state = entry.to
  return state
}

// ---------------------------------------------------------------------------
// Append paths
// ---------------------------------------------------------------------------
async function appendEntry(runDir, fields, records, { io = fs, now = () => new Date().toISOString() } = {}) {
  records.forEach(validateRecord)
  await checkEvidence(runDir, records, { io })
  const entries = await loadLedger(runDir, { io })
  verifyChain(entries) // never append onto a tampered chain
  const prevHash = entries.length ? entries.at(-1).hash : GENESIS_PREV
  const at = now()
  const { line, entry } = assembleEntry({ seq: entries.length, claimId: fields.claimId, at, ...fields.kind, records }, prevHash)
  await atomicWrite(ledgerPath(runDir), entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '') + line + '\n', io)
  return entry
}

export async function openClaim(runDir, claimId, { io, now } = {}) {
  assert(CLAIM_ID.test(claimId ?? ''), 'claimId must match the claim-id grammar')
  const entries = await loadLedger(runDir, { io })
  if (currentState(entries, claimId) !== null) fail('config-invalid', `claim ${claimId} already exists`)
  const entry = await appendEntry(runDir, { claimId, kind: { type: 'genesis', from: null, to: 'open', statementFaithful: null } }, [], { io, now })
  return { subcommand: 'open', claimId, state: 'open', seq: entry.seq, hash: entry.hash }
}

async function loadManifest(runDir) {
  const path = join(runDir, 'run-manifest.json')
  if (!(await exists(path))) return null
  const result = validateRunManifest(await readJson(path, 'run-manifest.json'))
  return result.ok ? result.value : null
}

/** v4/v5 guard: a recorded full-isolation counterexample blocks promotion to
 * `proven` — the conflict is represented explicitly, never auto-resolved. */
export function counterexampleGuard(entries, claimId) {
  for (const entry of entries) {
    if (entry.claimId !== claimId) continue
    for (const record of entry.records) {
      if (record.kind === 'counterexample' && record.verdict === 'confirmed' && (record.isolation ?? 'full') === 'full') {
        fail('counterexample-outstanding', `claim ${claimId} has an outstanding full-isolation counterexample; proven is blocked`)
      }
    }
  }
}

function assertRequirements(from, to, records, manifest) {
  const edge = TRANSITIONS[edgeName(from, to)]
  if (!edge) fail('illegal-transition', `${edgeName(from, to)} is not in the M0 transition table`)
  for (const [kind, verdicts] of Object.entries(edge.requires)) {
    const found = records.filter(record => record.kind === kind && verdicts.includes(record.verdict))
    if (!found.length) fail('missing-record', `${edgeName(from, to)} requires a ${kind} record with verdict ${verdicts.join('|')}`)
  }
  if (edge.falsifyEvidence) {
    // §6.3: falsification needs a counterexample (full isolation tier for
    // computational evidence) or a Lean proof of the negation.
    const leanNegation = records.some(record => record.kind === 'lean-negation' && record.verdict === 'pass')
    const counterexample = records.some(record => record.kind === 'counterexample' && record.verdict === 'confirmed' && (record.mechanism ?? 'computation') === 'computation' && record.isolation === 'full')
    if (!leanNegation && !counterexample) fail('missing-record', 'open→falsified requires a lean-negation pass record or a full-isolation confirmed counterexample record')
  }
  if (to === 'fidelity-failed' && manifest?.allowHumanFidelity) {
    // With human escalation enabled a dispute escalates instead; only an
    // adverse human ruling terminates as fidelity-failed (§3.3, §6.3).
    const ruling = records.some(record => record.kind === 'human-ruling' && record.verdict === 'not-faithful')
    if (!ruling) fail('missing-record', 'allowHumanFidelity=true: fidelity-failed requires a human-ruling record with verdict not-faithful (disputes escalate)')
  }
}

export async function transition(runDir, claimId, to, records, { statementFaithful = null, io, now } = {}) {
  assert(CLAIM_ID.test(claimId ?? ''), 'claimId must match the claim-id grammar')
  assert(M0_STATES.includes(to), `target state must be one of ${M0_STATES.join('|')}`, 'illegal-transition')
  assert(to !== 'open', 'no transition targets open', 'illegal-transition')
  assert(Array.isArray(records), 'records must be an array')
  records.forEach(validateRecord) // shape validation precedes requirement checks
  if (statementFaithful !== null) assert(FIDELITY_GRADES.includes(statementFaithful), `statementFaithful must be one of ${FIDELITY_GRADES.join('|')}`)
  const entries = await loadLedger(runDir, { io })
  const from = currentState(entries, claimId)
  if (from === null) fail('config-invalid', `unknown claim ${claimId}`)
  if (TERMINAL_STATES.includes(from)) fail('illegal-transition', `${from} is terminal (§6.3: terminal states are never re-sources)`)
  const edge = TRANSITIONS[edgeName(from, to)]
  const manifest = await loadManifest(runDir)
  assertRequirements(from, to, records, manifest)
  if (edge.counterexampleGuard) counterexampleGuard(entries, claimId)
  if (statementFaithful === null) {
    if (to === 'proven') statementFaithful = null
    if (to === 'proven-of-formal-statement') statementFaithful = 'model-assessed'
  }
  const entry = await appendEntry(runDir, { claimId, kind: { type: 'transition', from, to, statementFaithful } }, records, { io, now })
  return { subcommand: 'transition', claimId, from, to, seq: entry.seq, hash: entry.hash }
}

export async function verify(runDir, { io } = {}) {
  const result = verifyChain(await loadLedger(runDir, { io }))
  return { subcommand: 'verify', chainValid: true, ...result }
}

export async function status(runDir, { io } = {}) {
  const entries = await loadLedger(runDir, { io })
  const { claims } = verifyChain(entries)
  return { subcommand: 'status', entries: entries.length, claims }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const HELP = [
  'claim-ledger — chain-hashed claim records and M0 transitions (design §6.3, §9.2–9.4)',
  'usage: claim-ledger.mjs <subcommand> --run <dir> [options]',
  '  open --claim-id <id>',
  '  transition --claim-id <id> --to <state> --records <records.json> [--statement-faithful <grade>]',
  '  verify',
  '  status',
  `M0 states: ${M0_STATES.join(', ')} · terminal: ${TERMINAL_STATES.join(', ')}`,
  'records: [{kind, verdict, bindingHashes?, isolation?, mechanism?, evidence?: [{path, sha256}]}]',
  'exit codes: 0 ok · 2 blocked (config-invalid, illegal-transition, missing-record, chain-invalid, missing-evidence, evidence-mismatch, counterexample-outstanding) · single-line JSON on stdout',
].join('\n')

async function handle(argv) {
  const options = parseFlags(argv, ['run', 'claim-id', 'to', 'records', 'statement-faithful'], { required: ['run'] })
  if (options.help) return 'help'
  if (!options.subcommand) fail('config-invalid', 'a subcommand is required')
  await ensureWritable(options.run)
  let result
  switch (options.subcommand) {
    case 'open': {
      if (!options['claim-id']) fail('config-invalid', '--claim-id is required')
      result = await openClaim(options.run, options['claim-id'])
      break
    }
    case 'transition': {
      for (const key of ['claim-id', 'to', 'records']) if (!options[key]) fail('config-invalid', `--${key} is required`)
      const records = await readJson(options.records, 'records file')
      if (!Array.isArray(records)) fail('config-invalid', 'records file must contain a JSON array')
      result = await transition(options.run, options['claim-id'], options.to, records, { statementFaithful: options['statement-faithful'] ?? null })
      break
    }
    case 'verify': result = await verify(options.run); break
    case 'status': result = await status(options.run); break
    default: fail('config-invalid', `unknown subcommand ${options.subcommand}`)
  }
  return { exitCode: 0, report: { schemaVersion: 1, command: 'claim-ledger', status: 'ok', ...result } }
}

export async function main(argv = process.argv.slice(2)) {
  return runCli('claim-ledger', HELP, argv, handle)
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main()
