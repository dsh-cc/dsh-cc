// Tests for the read-only model-status ledger. Run with plain node (repo
// convention for scripts/*.test.mjs). The load-bearing assertions are the two
// contract claims: the ledger never writes, and it always exits 0 once it has
// reported (it is a status view, never a gate).
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { main, parseArgs, render, status } from './formal-design-status.mjs'

const temp = mkdtempSync(join(tmpdir(), 'formal-design-status-'))

function model(id, evidence) {
  const dir = join(temp, 'specs/tla', id)
  mkdirSync(join(dir, 'cases'), { recursive: true })
  writeFileSync(join(dir, 'checks.json'), '{"schemaVersion":1,"modelId":"' + id + '","module":"Model","cases":[]}')
  if (evidence !== undefined) writeFileSync(join(dir, 'evidence.json'), JSON.stringify(evidence))
}

model('with-evidence', { schemaVersion: 1, runId: 'run-1', inputDigest: 'digest-1', status: 'verified', verification: 'verified' })
model('stale-verdict', { schemaVersion: 1, runId: 'run-2', inputDigest: 'digest-2', status: 'counterexample' })
model('never-run')

// 1. parseArgs grammar: only --project/--json/--help, no stray values.
assert.deepEqual(parseArgs(['--project', '.', '--json']), { json: true, project: '.' })
assert.throws(() => parseArgs(['--project']), /unknown or incomplete argument/)
assert.throws(() => parseArgs(['--nope', 'x']), /unknown or incomplete argument/)

// 2. render is stable and always shows the four columns.
const table = render([
  { backend: 'tla', id: 'a', verdict: 'verified', freshness: 'fresh' },
  { backend: 'lean', id: 'b', verdict: null, freshness: 'no-evidence' },
])
assert.match(table, /^backend\s+model\s+verdict\s+freshness$/m)
assert.match(table, /^tla\s+a\s+verified\s+fresh$/m)
assert.match(table, /^lean\s+b\s+-\s+no-evidence$/m)

const rows = await status(temp)
const byId = new Map(rows.map(row => [row.id, row]))
assert.equal(rows.length, 3, 'one row per committed model directory')
assert.equal(byId.get('never-run').freshness, 'no-evidence', 'a model without evidence is reported, not skipped')
assert.equal(byId.get('with-evidence').runId, 'run-1', 'the recorded run id survives a stale verdict')
assert.equal(byId.get('stale-verdict').verdict, 'counterexample', 'the recorded verdict survives when the audit is not valid')

// 3. The ledger writes nothing: the tree is byte-identical before and after.
const snapshot = dir => readdirSync(dir, { recursive: true }).sort()
const before = snapshot(temp)
await status(temp)
assert.deepEqual(snapshot(temp), before, 'status() must not create, move or delete anything')

// 4. Exit code is always 0 once it reports: a red model must not fail the view.
const code = await main(['--project', temp, '--json'])
assert.equal(code, 0, 'the status ledger is not a gate')
assert.equal(await main(['--help']), 0)
assert.equal(await main(['--project']), 1, 'a malformed invocation still reports usage failure')

rmSync(temp, { recursive: true, force: true })
console.log('formal-design-status.test.mjs: ok')
