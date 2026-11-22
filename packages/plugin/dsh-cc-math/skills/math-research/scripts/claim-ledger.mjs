import * as fs from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assert, atomicWrite, canonicalJson, ensureWritable, exists, fail, hashFile, parseFlags, readJson, runCli, sha256 } from './storage.lib.mjs'
import { validateRunManifest } from './run-manifest.lib.mjs'

// Claim ledger (design §6.3, §9.2–9.4): chain-hashed `claims.jsonl` carrying
// the claim states and the transition table. M0 shipped the core subset; M3
// extends it with `experiment-supported` and `revalidation-pending` and their
// edges WITHOUT weakening any earlier edge. Exactly one writer (the main
// conversation); every append rewrites the whole file atomically — no
// byte-append anywhere (§3.3).
//
// Chain hash: each entry's `hash` is
//   sha256( canonicalJson(entry-without-hash) + '\n' + prevHash )
// where canonicalJson has fixed (codepoint-sorted) field order, so any edit
// to any field of any entry breaks `--verify` (§6.3 "detects any field
// edit"). The genesis entry chains from 64 zeroes.
//
// Transitions REQUIRE typed verification records `{kind, verdict,
// bindingHashes?, evidence?}` produced by the verifier scripts (lean-run,
// sympy-run, fidelity gate, evaluator gate) plus evidence hashes that are
// re-checked at append time (path exists + sha256 matches). Unknown states and
// non-existent edges are rejected by explicit enumeration (exit 2).
//
// M3 specifics (§6.3):
//  * `any(non-terminal) → revalidation-pending` on an evaluator version
//    change; the entry records the `priorState`, and the return edge is
//    `revalidation-pending → prior-state` (pass) or `→ superseded` (fail).
//  * `experiment-supported → proven` is guarded EXACTLY like `open → proven`
//    — L2 pass + anchored/human-confirmed fidelity + no outstanding
//    full-isolation L1 counterexample. There is no weaker path, so a
//    model-assessed fidelity record is refused.

export const M0_STATES = Object.freeze(['open', 'proven', 'proven-of-formal-statement', 'falsified', 'superseded', 'fidelity-failed'])
export const M3_STATES = Object.freeze(['experiment-supported', 'revalidation-pending'])
export const CLAIM_STATES = Object.freeze([...M0_STATES.slice(0, 4), ...M3_STATES, ...M0_STATES.slice(4)])
export const TERMINAL_STATES = Object.freeze(['superseded', 'fidelity-failed'])
export const RECORD_KINDS = Object.freeze(['l2-pass', 'fidelity', 'counterexample', 'fidelity-correction', 'dispute', 'human-ruling', 'lean-negation', 'experiment', 'evaluator-change', 'revalidation'])
export const FIDELITY_GRADES = Object.freeze(['anchored', 'human-confirmed', 'model-assessed', 'disputed'])
// Records that carry an evaluator version hash (§6.2 item 3, §6.3).
const VERSIONED_KINDS = Object.freeze(['experiment', 'evaluator-change', 'revalidation'])
const GENESIS_PREV = '0'.repeat(64)
const CLAIM_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/
const HEX64 = /^[a-f0-9]{64}$/

export const ledgerPath = runDir => join(runDir, 'claims.jsonl')

// The full §6.3 transition table (M0 core + M3 rows): edge → required
// verification records. `→ proven` variants share the v4/v5 guard: an
// outstanding full-isolation L1 counterexample in the claim's history blocks
// promotion. `restoresPrior` edges carry the claim back to the state it held
// before the evaluator version changed.
const FIDELITY_SUPPORTING_PROOF = ['anchored', 'human-confirmed']
const EVALUATOR_VERSION_CHANGED = { evaluatorChange: true, requires: { 'evaluator-change': ['changed'] } }
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
  // --- M3 (§6.3) -----------------------------------------------------------
  'open→experiment-supported': { requires: { experiment: ['supported'] }, counterexampleGuard: false },
  // v4: no weaker path than open → proven — L2 + anchored/human-confirmed
  // fidelity + the same counterexample guard.
  'experiment-supported→proven': { requires: { 'l2-pass': ['pass'], fidelity: FIDELITY_SUPPORTING_PROOF }, counterexampleGuard: true },
  'experiment-supported→superseded': {
    requiresAny: [[{ kind: 'fidelity-correction', verdicts: ['confirmed'] }], [{ kind: 'revalidation', verdicts: ['failed'] }]],
    counterexampleGuard: false,
  },
  'experiment-supported→fidelity-failed': { requires: { dispute: ['confirmed'] }, counterexampleGuard: false },
  'experiment-supported→revalidation-pending': { ...EVALUATOR_VERSION_CHANGED, counterexampleGuard: false },
  'open→revalidation-pending': { ...EVALUATOR_VERSION_CHANGED, counterexampleGuard: false },
  'proven→revalidation-pending': { ...EVALUATOR_VERSION_CHANGED, counterexampleGuard: false },
  'proven-of-formal-statement→revalidation-pending': { ...EVALUATOR_VERSION_CHANGED, counterexampleGuard: false },
  'falsified→revalidation-pending': { ...EVALUATOR_VERSION_CHANGED, counterexampleGuard: false },
  // The round-trip: on a passed revalidation the claim returns to the state
  // it held before the version change; on a failed one it is superseded.
  'revalidation-pending→open': { requires: { revalidation: ['passed'] }, counterexampleGuard: false, restoresPrior: true },
  'revalidation-pending→proven': { requires: { revalidation: ['passed'] }, counterexampleGuard: true, restoresPrior: true },
  'revalidation-pending→proven-of-formal-statement': { requires: { revalidation: ['passed'] }, counterexampleGuard: false, restoresPrior: true },
  'revalidation-pending→experiment-supported': { requires: { revalidation: ['passed'] }, counterexampleGuard: false, restoresPrior: true },
  'revalidation-pending→falsified': { requires: { revalidation: ['passed'] }, counterexampleGuard: false, restoresPrior: true },
  'revalidation-pending→superseded': { requires: { revalidation: ['failed'] }, counterexampleGuard: false },
  'revalidation-pending→fidelity-failed': { requires: { dispute: ['confirmed'] }, counterexampleGuard: false },
})

export const edgeName = (from, to) => `${from}→${to}`

// ---------------------------------------------------------------------------
// Record and entry validation
// ---------------------------------------------------------------------------
function validateRecord(record, index) {
  const label = `records[${index}]`
  assert(record && typeof record === 'object' && !Array.isArray(record), `${label} must be an object`)
  const unknown = Object.keys(record).filter(key => !['kind', 'verdict', 'bindingHashes', 'isolation', 'mechanism', 'evidence', 'evaluatorVersion', 'snapshotRef'].includes(key))
  assert(unknown.length === 0, `${label} has unknown field(s): ${unknown.join(',')}`)
  assert(RECORD_KINDS.includes(record.kind), `${label}.kind must be one of ${RECORD_KINDS.join('|')}`)
  assert(typeof record.verdict === 'string' && record.verdict.length > 0, `${label}.verdict must be a non-empty string`)
  if (record.bindingHashes !== undefined) {
    assert(record.bindingHashes && typeof record.bindingHashes === 'object' && !Array.isArray(record.bindingHashes), `${label}.bindingHashes must be an object`)
    for (const [name, hex] of Object.entries(record.bindingHashes)) assert(typeof name === 'string' && HEX64.test(hex), `${label}.bindingHashes.${name} must be lowercase sha256 hex`)
  }
  if (record.isolation !== undefined) assert(['full', 'partial'].includes(record.isolation), `${label}.isolation must be full|partial`)
  if (record.mechanism !== undefined) assert(['computation', 'lean'].includes(record.mechanism), `${label}.mechanism must be computation|lean`)
  // §6.2 item 3: evaluator versions are hash-pinned into the records, and an
  // experiment record names the population snapshot its evidence came from.
  if (VERSIONED_KINDS.includes(record.kind)) {
    assert(HEX64.test(record.evaluatorVersion ?? ''), `${label}.evaluatorVersion must be the lowercase sha256 of the evaluator program`)
  }
  if (record.kind === 'experiment') {
    assert(typeof record.snapshotRef === 'string' && record.snapshotRef.trim().length > 0, `${label}.snapshotRef must name the population snapshot backing the evidence`)
  }
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
function assembleEntry({ seq, claimId, at, type, from, to, statementFaithful, records, priorState = null }, prevHash) {
  const base = { schemaVersion: 1, seq, claimId, at, type, from, to, statementFaithful, records, prevHash }
  // `priorState` exists only on the entry that parks a claim in
  // revalidation-pending: the hash covers it exactly when it is written.
  const preimage = priorState === null ? base : { ...base, priorState }
  const fixed = { ...preimage, hash: entryHash(preimage, prevHash) }
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
  const required = ['schemaVersion', 'seq', 'claimId', 'at', 'type', 'from', 'to', 'statementFaithful', 'records', 'prevHash', 'hash']
  const optional = ['priorState']
  const keys = Object.keys(entry).sort()
  const unknown = keys.filter(key => !required.includes(key) && !optional.includes(key))
  if (unknown.length > 0 || required.some(key => !keys.includes(key))) {
    fail('chain-invalid', `${label} must have exactly the fields ${required.join(',')} (+ optional ${optional.join(',')})`)
  }
  if (entry.schemaVersion !== 1 || entry.seq !== index || !CLAIM_ID.test(entry.claimId ?? '') || typeof entry.at !== 'string') fail('chain-invalid', `${label} has malformed identity fields`)
  if (!['genesis', 'transition'].includes(entry.type)) fail('chain-invalid', `${label} has unknown type`)
  if (!HEX64.test(entry.prevHash ?? '') || !HEX64.test(entry.hash ?? '')) fail('chain-invalid', `${label} has malformed hashes`)
  if (!(CLAIM_STATES.includes(entry.to))) fail('chain-invalid', `${label} targets a state outside the §6.3 table: ${entry.to}`)
  if (!(entry.from === null || CLAIM_STATES.includes(entry.from))) fail('chain-invalid', `${label} has a source state outside the §6.3 table`)
  if (!(Array.isArray(entry.records))) fail('chain-invalid', `${label} records must be an array`)
  if (entry.priorState !== undefined) {
    if (!CLAIM_STATES.includes(entry.priorState)) fail('chain-invalid', `${label} records an unknown priorState`)
    if (entry.to !== 'revalidation-pending') fail('chain-invalid', `${label} carries priorState outside a revalidation-pending entry`)
  }
}

/** Recompute the whole chain; any field edit is detected (§6.3). */
export function verifyChain(entries) {
  let prev = GENESIS_PREV
  const claims = new Map()
  const priorStates = new Map()
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
      const edge = TRANSITIONS[edgeName(entry.from, entry.to)]
      if (!edge) fail('chain-invalid', `entry ${index + 1} is not a §6.3-table edge`)
      // A revalidation round-trip may only return to the state it left.
      if (edge.restoresPrior && priorStates.get(entry.claimId) !== entry.to) {
        fail('chain-invalid', `entry ${index + 1} restores ${entry.to} but the claim left ${priorStates.get(entry.claimId) ?? 'nothing'}`)
      }
      claims.set(entry.claimId, entry.to)
    }
    if (entry.to === 'revalidation-pending') priorStates.set(entry.claimId, entry.priorState ?? entry.from)
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
  const { line, entry } = assembleEntry({ seq: entries.length, claimId: fields.claimId, at, ...fields.kind, records, priorState: fields.priorState ?? null }, prevHash)
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
  if (!edge) fail('illegal-transition', `${edgeName(from, to)} is not in the §6.3 transition table`)
  for (const [kind, verdicts] of Object.entries(edge.requires ?? {})) {
    const found = records.filter(record => record.kind === kind && verdicts.includes(record.verdict))
    if (!found.length) fail('missing-record', `${edgeName(from, to)} requires a ${kind} record with verdict ${verdicts.join('|')}`)
  }
  if (edge.requiresAny) {
    // Any ONE alternative suffices (e.g. supersede-by-correction OR
    // supersede-by-revalidation-failure); each alternative is all-of.
    const satisfied = edge.requiresAny.some(alternative => alternative.every(spec =>
      records.some(record => record.kind === spec.kind && spec.verdicts.includes(record.verdict))))
    if (!satisfied) {
      const described = edge.requiresAny.map(alternative => alternative.map(spec => `${spec.kind}:${spec.verdicts.join('|')}`).join('+')).join(' or ')
      fail('missing-record', `${edgeName(from, to)} requires ${described}`)
    }
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

/** The state a claim held before it entered revalidation-pending (§6.3). */
export function priorStateOf(entries, claimId) {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry.claimId === claimId && entry.to === 'revalidation-pending') return entry.priorState ?? entry.from ?? null
  }
  return null
}

export async function transition(runDir, claimId, to, records, { statementFaithful = null, io, now } = {}) {
  assert(CLAIM_ID.test(claimId ?? ''), 'claimId must match the claim-id grammar')
  assert(CLAIM_STATES.includes(to), `target state must be one of ${CLAIM_STATES.join('|')}`, 'illegal-transition')
  assert(Array.isArray(records), 'records must be an array')
  records.forEach(validateRecord) // shape validation precedes requirement checks
  if (statementFaithful !== null) assert(FIDELITY_GRADES.includes(statementFaithful), `statementFaithful must be one of ${FIDELITY_GRADES.join('|')}`)
  const entries = await loadLedger(runDir, { io })
  const from = currentState(entries, claimId)
  if (from === null) fail('config-invalid', `unknown claim ${claimId}`)
  if (TERMINAL_STATES.includes(from)) fail('illegal-transition', `${from} is terminal (§6.3: terminal states are never re-sources)`)
  const edge = TRANSITIONS[edgeName(from, to)]
  if (to === 'open') assert(from === 'revalidation-pending', 'only a revalidation round-trip returns a claim to open', 'illegal-transition')
  const manifest = await loadManifest(runDir)
  assertRequirements(from, to, records, manifest)
  if (edge.counterexampleGuard) counterexampleGuard(entries, claimId)
  if (edge.restoresPrior) {
    const prior = priorStateOf(entries, claimId)
    if (prior !== to) fail('illegal-transition', `revalidation round-trip must return ${claimId} to its prior state ${prior}, not ${to}`)
  }
  if (statementFaithful === null) {
    if (to === 'proven') statementFaithful = null
    if (to === 'proven-of-formal-statement') statementFaithful = 'model-assessed'
  }
  const priorState = to === 'revalidation-pending' ? from : null
  const entry = await appendEntry(runDir, { claimId, kind: { type: 'transition', from, to, statementFaithful }, priorState }, records, { io, now })
  return { subcommand: 'transition', claimId, from, to, seq: entry.seq, hash: entry.hash, ...(priorState === null ? {} : { priorState }) }
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
  'claim-ledger — chain-hashed claim records and §6.3 transitions (design §6.3, §9.2–9.4)',
  'usage: claim-ledger.mjs <subcommand> --run <dir> [options]',
  '  open --claim-id <id>',
  '  transition --claim-id <id> --to <state> --records <records.json> [--statement-faithful <grade>]',
  '  verify',
  '  status',
  `states: ${CLAIM_STATES.join(', ')} · terminal: ${TERMINAL_STATES.join(', ')}`,
  'records: [{kind, verdict, bindingHashes?, isolation?, mechanism?, evaluatorVersion?, snapshotRef?, evidence?: [{path, sha256}]}]',
  'M3: any non-terminal → revalidation-pending on an evaluator-change record; back to the prior state on revalidation:passed, → superseded on revalidation:failed',
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
