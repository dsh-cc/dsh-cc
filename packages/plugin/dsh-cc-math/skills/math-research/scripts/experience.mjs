import * as fs from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assert, atomicWrite, canonicalJson, ensureWritable, fail, mathRoot, parseFlags, readJson, runCli, sha256 } from './storage.lib.mjs'
import { openSearchDb } from './sqlite.lib.mjs'

// Verifier-gated proof-experience store (design §7.2, risk 7, §3.3):
//
//   .math/experience/
//     experience.jsonl   append-only, chain-hashed (same scheme as claims.jsonl)
//     .lock              single-writer lock, stale after 60s, fail-closed
//     index.sqlite       FTS5 retrieval index, rebuilt from the jsonl
//
// SUCCESS entries are verifier-gated: a record is admitted only with a
// `formal_proof_valid` typed verification record with verdict `pass`, i.e.
// a record produced by the L2 checker. Everything else is refused (exit 2) —
// an unverified "we proved it" is exactly the pollution risk §7.2 calls out.
// FAILURE entries carry {goalShape, failedApproach, errorClass} and are
// consulted before generation; they make no correctness claim.
//
// Chain hash (mirrors claim-ledger): entry.hash = sha256(canonicalJson(entry
// without hash) + '\n' + prevHash), genesis chaining from 64 zeroes, so any
// edit to any field of any entry breaks `--verify`.
//
// Ablation write-blocking (§8.3, risk 7): the training/test split is honoured
// at the store, not in prose. A run marks the store with
// `writeBlocked: true` in `.lock` (or passes `--write-blocked`, or sets
// MATH_EXPERIENCE_WRITE_BLOCKED=1); every test-split write is then refused.
// A writeBlocked lock never expires by age — only `unblock` clears it, because
// refusing a write is always the safe failure.

export const SUCCESS_FIELDS = Object.freeze(['goalShape', 'premises', 'tacticSkeleton', 'sourceProblem', 'verifiedAt', 'bindingHashes', 'verification'])
export const FAILURE_FIELDS = Object.freeze(['goalShape', 'failedApproach', 'errorClass'])
export const VERIFICATION_KIND = 'formal-proof-valid'
export const LOCK_STALE_MS = 60000
export const LOCK_FILE = '.lock'
const LEDGER_FILE = 'experience.jsonl'
const INDEX_FILE = 'index.sqlite'
const GENESIS_PREV = '0'.repeat(64)
const HEX64 = /^[a-f0-9]{64}$/

export const storePaths = store => ({
  root: resolve(store),
  ledger: join(store, LEDGER_FILE),
  lock: join(store, LOCK_FILE),
  index: join(store, INDEX_FILE),
})

const unknownFields = (value, allowed, label) => {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key))
  assert(unknown.length === 0, `${label} has unknown field(s): ${unknown.join(',')}`)
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------
function assertVerification(verification, label) {
  assert(verification && typeof verification === 'object' && !Array.isArray(verification), `${label} must be an object`, 'unverified-record')
  unknownFields(verification, ['kind', 'verdict', 'bindingHashes'], label)
  assert(verification.kind === VERIFICATION_KIND, `${label}.kind must be "${VERIFICATION_KIND}" — only the L2 checker's verdict admits experience (§7.2)`, 'unverified-record')
  assert(verification.verdict === 'pass', `${label}.verdict must be "pass"; a ${verification.verdict} verdict is not proof experience`, 'unverified-record')
  if (verification.bindingHashes !== undefined) {
    assert(verification.bindingHashes && typeof verification.bindingHashes === 'object' && !Array.isArray(verification.bindingHashes), `${label}.bindingHashes must be an object`)
    for (const [name, hex] of Object.entries(verification.bindingHashes)) assert(HEX64.test(hex ?? ''), `${label}.bindingHashes.${name} must be lowercase sha256 hex`)
  }
}

export function validateSuccessRecord(record) {
  assert(record && typeof record === 'object' && !Array.isArray(record), 'success record must be an object')
  unknownFields(record, SUCCESS_FIELDS, 'success record')
  assert(typeof record.goalShape === 'string' && record.goalShape.trim().length > 0, 'success record goalShape is required')
  assert(Array.isArray(record.premises) && record.premises.every(item => typeof item === 'string'), 'success record premises must be an array of strings')
  assert(typeof record.tacticSkeleton === 'string' && record.tacticSkeleton.trim().length > 0, 'success record tacticSkeleton is required')
  assert(typeof record.sourceProblem === 'string' && record.sourceProblem.trim().length > 0, 'success record sourceProblem is required')
  assert(typeof record.verifiedAt === 'string' && !Number.isNaN(Date.parse(record.verifiedAt)), 'success record verifiedAt must be an ISO timestamp')
  assert(record.bindingHashes && typeof record.bindingHashes === 'object' && !Array.isArray(record.bindingHashes) && Object.keys(record.bindingHashes).length > 0, 'success record bindingHashes must be a non-empty object')
  for (const [name, hex] of Object.entries(record.bindingHashes)) assert(HEX64.test(hex ?? ''), `success record bindingHashes.${name} must be lowercase sha256 hex`)
  assertVerification(record.verification, 'success record verification')
  return {
    goalShape: record.goalShape,
    premises: record.premises,
    tacticSkeleton: record.tacticSkeleton,
    sourceProblem: record.sourceProblem,
    verifiedAt: record.verifiedAt,
    bindingHashes: record.bindingHashes,
    verification: record.verification,
  }
}

export function validateFailureRecord(record) {
  assert(record && typeof record === 'object' && !Array.isArray(record), 'failure record must be an object')
  unknownFields(record, FAILURE_FIELDS, 'failure record')
  for (const field of FAILURE_FIELDS) assert(typeof record[field] === 'string' && record[field].trim().length > 0, `failure record ${field} must be a non-empty string`)
  return { goalShape: record.goalShape, failedApproach: record.failedApproach, errorClass: record.errorClass }
}

/** What the FTS5 body column indexes for one entry. */
export function searchBody(kind, record) {
  return kind === 'success'
    ? [record.premises.join(' '), record.tacticSkeleton].join('\n')
    : [record.failedApproach, record.errorClass].join('\n')
}

// ---------------------------------------------------------------------------
// Chain (append-only, canonical bytes, prev-hash linkage)
// ---------------------------------------------------------------------------
export const entryHash = (preimage, prevHash) => sha256(`${canonicalJson(preimage)}\n${prevHash}`)

export function parseLedger(text) {
  const entries = []
  for (const [index, line] of text.split('\n').filter(row => row.trim()).entries()) {
    try { entries.push(JSON.parse(line)) }
    catch { fail('chain-invalid', `line ${index + 1} is not valid JSON`) }
  }
  return entries
}

export async function loadLedger(path, { io = fs } = {}) {
  try { return parseLedger(await io.readFile(path, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}

export function verifyChain(entries) {
  let prev = GENESIS_PREV
  for (const [index, entry] of entries.entries()) {
    const label = `entry ${index + 1}`
    const required = ['schemaVersion', 'seq', 'kind', 'at', 'record', 'prevHash', 'hash']
    const keys = Object.keys(entry).sort()
    if (keys.length !== required.length || required.some(key => !keys.includes(key))) fail('chain-invalid', `${label} must have exactly the fields ${required.join(',')}`)
    if (entry.schemaVersion !== 1 || entry.seq !== index) fail('chain-invalid', `${label} has malformed identity fields`)
    if (!['success', 'failure'].includes(entry.kind)) fail('chain-invalid', `${label} has an unknown kind ${entry.kind}`)
    if (!HEX64.test(entry.prevHash ?? '') || !HEX64.test(entry.hash ?? '')) fail('chain-invalid', `${label} has malformed hashes`)
    if (entry.prevHash !== prev) fail('chain-invalid', `${label} chain linkage broken`)
    const { hash: _hash, ...preimage } = entry
    if (entryHash(preimage, prev) !== entry.hash) fail('chain-invalid', `${label} hash mismatch: a field was edited`)
    prev = entry.hash
  }
  return { entries: entries.length, head: prev === GENESIS_PREV ? null : prev }
}

// ---------------------------------------------------------------------------
// Lockfile discipline (§3.3): stale after 60s, fail-closed on conflict. A
// writeBlocked lock is deliberate and never expires — only `unblock` clears it.
// ---------------------------------------------------------------------------
export async function readLock(path, { io = fs } = {}) {
  try { return JSON.parse(await io.readFile(path, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return null; return null }
}

export async function acquireLock(paths, { io = fs, now = Date.now(), command = 'write', writeBlocked = false } = {}) {
  const existing = await readLock(paths.lock, { io })
  // A deliberate write-block never expires: refusing the write is the safe
  // failure, so only `unblock` clears it.
  assert(existing?.writeBlocked !== true, `experience store ${paths.root} is write-blocked by an ablation run (${existing?.reason ?? 'no reason recorded'}); test-split writes are refused until "experience.mjs unblock"`, 'write-blocked')
  if (existing) {
    const held = Date.parse(existing.at ?? '')
    const age = Number.isFinite(held) ? now - held : Number.POSITIVE_INFINITY
    if (age <= LOCK_STALE_MS) fail('experience-locked', `experience store ${paths.root} is locked by pid ${existing.pid ?? '?'} (${Math.max(0, Math.round(age))}ms old; stale after ${LOCK_STALE_MS}ms)`)
    // Stale: take the lock over.
    await io.unlink(paths.lock).catch(() => {})
  }
  const content = JSON.stringify({ pid: process.pid, at: new Date(now).toISOString(), command, writeBlocked }) + '\n'
  try {
    const handle = await io.open(paths.lock, 'wx')
    try { await handle.writeFile(content) } finally { await handle.close() }
  } catch (error) {
    if (error.code === 'EEXIST') fail('experience-locked', `experience store ${paths.root} was locked concurrently; retry after the holder releases it`)
    throw error
  }
  return { path: paths.lock, async release() { await io.unlink(paths.lock).catch(() => {}) } }
}

export async function writeBlocked(paths, { io = fs } = {}) {
  return (await readLock(paths.lock, { io }))?.writeBlocked === true
}

// ---------------------------------------------------------------------------
// Append + retrieval
// ---------------------------------------------------------------------------
async function appendEntry(paths, kind, record, { io = fs, now = () => new Date().toISOString() } = {}) {
  const entries = await loadLedger(paths.ledger, { io })
  verifyChain(entries) // never append onto a tampered chain
  const prevHash = entries.length ? entries.at(-1).hash : GENESIS_PREV
  const preimage = { schemaVersion: 1, seq: entries.length, kind, at: now(), record, prevHash }
  const entry = { ...preimage, hash: entryHash(preimage, prevHash) }
  const text = entries.map(item => JSON.stringify(item)).join('\n')
  await atomicWrite(paths.ledger, (entries.length ? `${text}\n` : '') + JSON.stringify(entry) + '\n', io)
  return entry
}

function indexDb(paths) {
  const db = openSearchDb(paths.index)
  db.exec('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)')
  db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS experience_fts USING fts5(seq UNINDEXED, kind UNINDEXED, goalShape, body)')
  return db
}

const indexHead = db => {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('head')
  return row?.value ?? null
}

/** Rebuild the FTS5 index whenever the chain head moved (idempotent). */
export function refreshIndex(paths, entries, { io: _io = fs } = {}) {
  const db = indexDb(paths)
  try {
    const { head } = verifyChain(entries)
    if (indexHead(db) === (head ?? '')) return { db, rebuilt: false }
    db.exec('DELETE FROM experience_fts')
    const insert = db.prepare('INSERT INTO experience_fts(seq, kind, goalShape, body) VALUES (?, ?, ?, ?)')
    for (const entry of entries) insert.run(entry.seq, entry.kind, entry.record.goalShape, searchBody(entry.kind, entry.record))
    db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('head', head ?? '')
    return { db, rebuilt: true }
  } catch (error) {
    db.close()
    throw error
  }
}

export function searchExperience(db, { query, kind = null, top = 20 }) {
  const params = [query]
  let sql = 'SELECT f.seq AS seq, f.kind AS kind, f.goalShape AS goalShape, bm25(experience_fts) AS rank FROM experience_fts f WHERE experience_fts MATCH ?'
  if (kind) { sql += ' AND f.kind = ?'; params.push(kind) }
  sql += ' ORDER BY rank, f.seq LIMIT ?'
  params.push(top)
  return db.prepare(sql).all(...params)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
async function assertWritable(paths, { writeBlockedFlag, env, io }) {
  if (writeBlockedFlag) fail('write-blocked', 'test-split writes are refused during an ablation run (§8.3); drop --write-blocked to write')
  if ((env ?? process.env).MATH_EXPERIENCE_WRITE_BLOCKED === '1') fail('write-blocked', 'MATH_EXPERIENCE_WRITE_BLOCKED=1: test-split writes are refused during an ablation run (§8.3)')
  await ensureWritable(paths.root, io)
}

export async function addSuccess(store, record, { io = fs, now, writeBlocked: blocked = false, env = process.env } = {}) {
  const paths = storePaths(store)
  await assertWritable(paths, { writeBlockedFlag: blocked, env, io })
  const cleaned = validateSuccessRecord(record)
  const lock = await acquireLock(paths, { io, command: 'add-success' })
  try {
    const entry = await appendEntry(paths, 'success', cleaned, { io, now })
    return { subcommand: 'add-success', seq: entry.seq, hash: entry.hash, goalShape: cleaned.goalShape, entries: entry.seq + 1 }
  } finally { await lock.release() }
}

export async function addFailure(store, record, { io = fs, now, writeBlocked: blocked = false, env = process.env } = {}) {
  const paths = storePaths(store)
  await assertWritable(paths, { writeBlockedFlag: blocked, env, io })
  const cleaned = validateFailureRecord(record)
  const lock = await acquireLock(paths, { io, command: 'add-failure' })
  try {
    const entry = await appendEntry(paths, 'failure', cleaned, { io, now })
    return { subcommand: 'add-failure', seq: entry.seq, hash: entry.hash, goalShape: cleaned.goalShape, entries: entry.seq + 1 }
  } finally { await lock.release() }
}

export async function query(store, { query: text, kind = null, top = 20 }, { io = fs } = {}) {
  const paths = storePaths(store)
  const entries = await loadLedger(paths.ledger, { io })
  if (entries.length === 0) return { subcommand: 'query', query: text, kind, results: [], index: 'empty-store' }
  const { db, rebuilt } = refreshIndex(paths, entries)
  try {
    let rows
    try { rows = searchExperience(db, { query: text, kind, top }) }
    catch (error) { fail('query-invalid', String(error.message ?? error)) }
    const results = rows.map(row => {
      const entry = entries[row.seq]
      return { seq: entry.seq, kind: entry.kind, goalShape: entry.record.goalShape, record: entry.record, rank: row.rank }
    })
    return { subcommand: 'query', query: text, kind, index: rebuilt ? 'rebuilt' : 'current', results }
  } finally { db.close() }
}

export async function verify(store, { io = fs } = {}) {
  const paths = storePaths(store)
  const entries = await loadLedger(paths.ledger, { io })
  const { head } = verifyChain(entries)
  return { subcommand: 'verify', chainValid: true, store: paths.root, entries: entries.length, head, success: entries.filter(entry => entry.kind === 'success').length, failure: entries.filter(entry => entry.kind === 'failure').length }
}

export async function status(store, { io = fs } = {}) {
  const paths = storePaths(store)
  const entries = await loadLedger(paths.ledger, { io })
  const lock = await readLock(paths.lock, { io })
  return { subcommand: 'status', store: paths.root, entries: entries.length, head: entries.length ? entries.at(-1).hash : null, lock: lock === null ? null : { pid: lock.pid ?? null, at: lock.at ?? null, writeBlocked: lock.writeBlocked === true } }
}

export async function block(store, { reason = 'ablation run', io = fs, now = () => new Date().toISOString() } = {}) {
  const paths = storePaths(store)
  await ensureWritable(paths.root, io)
  const holder = await readLock(paths.lock, { io })
  if (holder && holder.writeBlocked !== true) fail('experience-locked', `experience store ${paths.root} is locked by pid ${holder.pid ?? '?'}; unblock needs an idle store`)
  const content = JSON.stringify({ pid: process.pid, at: now(), command: 'block', writeBlocked: true, reason }) + '\n'
  await atomicWrite(paths.lock, content, io)
  return { subcommand: 'block', store: paths.root, writeBlocked: true, reason }
}

export async function unblock(store, { io = fs } = {}) {
  const paths = storePaths(store)
  const holder = await readLock(paths.lock, { io })
  if (!holder) return { subcommand: 'unblock', store: paths.root, writeBlocked: false, changed: false }
  assert(holder.writeBlocked === true, `experience store ${paths.root} is locked by pid ${holder.pid ?? '?'}; unblock only clears a write-block, not a live write lock`, 'experience-locked')
  await io.unlink(paths.lock)
  return { subcommand: 'unblock', store: paths.root, writeBlocked: false, changed: true }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const HELP = [
  'experience — verifier-gated proof-experience store (design §7.2)',
  'usage: experience.mjs <subcommand> --store <dir> [options]',
  '  add-success --record <record.json> [--write-blocked]   needs a {kind:"formal-proof-valid", verdict:"pass"} record',
  '  add-failure --record <record.json> [--write-blocked]   {goalShape, failedApproach, errorClass}',
  '  query --query "<goal shape>" [--top N] [--kind success|failure]   FTS5 retrieval',
  '  verify                                                 chain hash over experience.jsonl',
  '  status                                                 entries + lock state',
  '  block [--reason "<why>"]                               mark the store write-blocked (ablation, §8.3)',
  '  unblock                                                clear a write-block',
  'success record: {goalShape, premises[], tacticSkeleton, sourceProblem, verifiedAt, bindingHashes, verification}',
  'failure record: {goalShape, failedApproach, errorClass}',
  '--store defaults to $MATH_HOME/experience (else .math/experience in the project cwd)',
  'lock: .lock, stale after 60s, fail-closed on conflict; MATH_EXPERIENCE_WRITE_BLOCKED=1 also refuses writes',
  'exit codes: 0 ok · 2 blocked (config-invalid, unverified-record, write-blocked, experience-locked, chain-invalid, query-invalid) · single-line JSON on stdout',
].join('\n')

const integer = (value, label) => {
  const parsed = Number(value)
  assert(value !== undefined && Number.isInteger(parsed) && parsed > 0 && parsed <= 100, `${label} must be an integer in 1..100`)
  return parsed
}

async function handle(argv) {
  const options = parseFlags(
    argv,
    ['store', 'record', 'query', 'top', 'kind', 'write-blocked', 'reason'],
    { booleans: ['write-blocked'] },
  )
  if (options.help) return 'help'
  if (!options.subcommand) fail('config-invalid', 'a subcommand is required')
  const store = options.store ?? join(mathRoot(), 'experience')
  const wrap = result => ({ exitCode: 0, report: { schemaVersion: 1, command: 'experience', status: 'ok', ...result } })
  switch (options.subcommand) {
    case 'add-success': {
      if (!options.record) fail('config-invalid', '--record is required')
      const record = await readJson(resolve(options.record), 'success record').catch(error => {
        if (error.code === 'ENOENT') fail('config-invalid', `record file ${options.record} does not exist`)
        throw error
      })
      return wrap(await addSuccess(store, record, { writeBlocked: Boolean(options['write-blocked']) }))
    }
    case 'add-failure': {
      if (!options.record) fail('config-invalid', '--record is required')
      const record = await readJson(resolve(options.record), 'failure record').catch(error => {
        if (error.code === 'ENOENT') fail('config-invalid', `record file ${options.record} does not exist`)
        throw error
      })
      return wrap(await addFailure(store, record, { writeBlocked: Boolean(options['write-blocked']) }))
    }
    case 'query': {
      if (!options.query) fail('config-invalid', '--query is required')
      const kind = options.kind ?? null
      assert(kind === null || ['success', 'failure'].includes(kind), '--kind must be success|failure')
      const top = options.top === undefined ? 20 : integer(options.top, '--top')
      return wrap(await query(store, { query: options.query, kind, top }))
    }
    case 'verify': return wrap(await verify(store))
    case 'status': return wrap(await status(store))
    case 'block': return wrap(await block(store, { reason: options.reason ?? 'ablation run' }))
    case 'unblock': return wrap(await unblock(store))
    default: fail('config-invalid', `unknown subcommand ${options.subcommand}`)
  }
}

export async function main(argv = process.argv.slice(2)) {
  return runCli('experience', HELP, argv, handle)
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main()
