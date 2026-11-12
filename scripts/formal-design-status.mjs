// Read-only model-status ledger (design record §"余项状态台账", decided
// 2026-10-26). It ENUMERATES specs/tla and specs/lean and reports each model's
// last recorded verdict and freshness. It never runs TLC or Lean, never writes a
// file, never takes a lock and never gates anything: every audit below is the
// existing read-only auditor, and the whole command is safe to run on a dirty
// or partially-provisioned tree.
//
// Scope decision (2026-10-26): this ledger exists because the missing thing was
// VISIBILITY, not another green light. It deliberately does not answer "were
// there enough models / were the right things modelled" - that stays with the
// review seats.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { auditEvidence } from '../packages/plugin/dsh-cc-agents/skills/formal-design/scripts/evidence.lib.mjs'
import { auditLeanEvidence } from '../packages/plugin/dsh-cc-agents/skills/formal-design/scripts/lean-check-evidence.mjs'

const TLA_ID = /^[a-z][a-z0-9-]{0,63}$/
const LEAN_ID = /^[a-z][a-z0-9-]{0,63}$/

function directories(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
  } catch {
    return []
  }
}

const isFile = path => { try { return statSync(path).isFile() } catch { return false } }

// Read a recorded artifact WITHOUT validating it: the ledger reports what was
// last written, and the audit below says whether it is still fresh. Losing the
// recorded verdict on a stale row would hide the most useful cell.
function recorded(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    return { present: true, status: value.status ?? null, verification: value.verification ?? null, proofVerdict: value.proofVerdict ?? null, conformanceVerdict: value.conformanceVerdict ?? null, runId: value.runId ?? null, inputDigest: value.inputDigest ?? value.proofInputDigest ?? null }
  } catch {
    return { present: false }
  }
}

// Every backend audit is best-effort: a missing/partial run artifact is a
// STATUS ("never run here"), not an error for this ledger.
async function safeAudit(audit, options) {
  try {
    return await audit(options)
  } catch (error) {
    return { status: 'invalid', reason: error?.code ?? 'io', fresh: false, verification: null, runId: null, inputDigest: null }
  }
}

const VERDICT_OF = result => result.verification ?? result.proofVerdict ?? result.conformanceVerdict ?? null

function freshness(result) {
  if (result.status === 'valid') return result.fresh ? 'fresh' : 'stale'
  return result.reason ?? 'unknown'
}

/** Enumerate and inspect every committed TLA model. */
export async function tlaRows(project) {
  const rows = []
  for (const id of directories(join(project, 'specs/tla'))) {
    if (!TLA_ID.test(id)) { rows.push({ backend: 'tla', id, verdict: null, freshness: 'invalid-directory-name', runId: null }); continue }
    const result = await safeAudit(auditEvidence, { project, model: `specs/tla/${id}` })
    const last = recorded(join(project, 'specs/tla', id, 'evidence.json'))
    rows.push({
      backend: 'tla',
      id,
      verdict: last.present ? (last.verification ?? last.status ?? 'unknown') : (VERDICT_OF(result) ?? null),
      freshness: last.present ? freshness(result) : 'no-evidence',
      runId: last.runId ?? result.runId ?? null,
      inputDigest: last.inputDigest ?? result.inputDigest ?? null,
    })
  }
  return rows
}

/** Enumerate and inspect every committed Lean model (proof + conformance). */
export async function leanRows(project) {
  const rows = []
  for (const id of directories(join(project, 'specs/lean'))) {
    if (!LEAN_ID.test(id)) { rows.push({ backend: 'lean', id, verdict: null, freshness: 'invalid-directory-name', runId: null }); continue }
    const result = await safeAudit(auditLeanEvidence, { project, model: `specs/lean/${id}`, stage: 'acceptance' })
    // Whether the manifest declares a conformance contract is a property of the
    // manifest, NOT of the local evidence: a model with no local artifacts must
    // not be labelled proof-only (that label would be a false finding).
    let declaresConformance = null
    try { declaresConformance = Boolean(JSON.parse(readFileSync(join(project, 'specs/lean', id, 'checks.json'), 'utf8')).conformance) } catch { declaresConformance = null }
    const proof = recorded(join(project, 'specs/lean', id, 'evidence.json'))
    const conformance = recorded(join(project, 'specs/lean', id, 'conformance-evidence.json'))
    const proofVerdict = proof.proofVerdict ?? (result.status === 'valid' ? result.proofVerdict : null)
    const conformanceVerdict = conformance.conformanceVerdict ?? (result.status === 'valid' ? result.conformanceVerdict : null)
    rows.push({
      backend: 'lean',
      id,
      // A Lean model's admissible state needs BOTH legs; report them joined so a
      // proof-only manifest is visibly not the same thing as an accepted one.
      verdict: proofVerdict == null ? null : `proof:${proofVerdict}/conformance:${conformanceVerdict ?? 'not-run'}`,
      freshness: proof.present ? freshness(result) : 'no-evidence',
      runId: proof.runId ?? result.runId ?? null,
      inputDigest: proof.inputDigest ?? result.inputDigest ?? null,
      note: declaresConformance === false ? 'manifest declares no conformance contract (this repo CI rejects it)' : undefined,
    })
  }
  return rows
}

/** Combined (bridge) packages, with their acceptance state. */
export function bridgeRows(project) {
  return directories(join(project, 'specs/formal')).map(id => {
    const json = join(project, 'specs/formal', id, 'bridge.json')
    const markdown = join(project, 'specs/formal', id, 'bridge.md')
    const missing = [json, markdown].filter(path => !isFile(path)).map(path => relative(project, path))
    return { backend: 'bridge', id, verdict: missing.length === 0 ? 'declared' : null, freshness: missing.length === 0 ? 'see backends' : `missing ${missing.join(', ')}`, runId: null }
  })
}

/** Human-readable table. Columns are stable so the output can be diffed. */
export function render(rows) {
  const header = ['backend', 'model', 'verdict', 'freshness']
  const body = rows.map(row => [row.backend, row.id, row.verdict ?? '-', row.note ? `${row.freshness} (${row.note})` : row.freshness])
  const widths = header.map((cell, i) => Math.max(cell.length, ...body.map(line => line[i].length)))
  const line = cells => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd()
  const out = [line(header), widths.map(width => '-'.repeat(width)).join('  ')]
  for (const cells of body) out.push(line(cells))
  return out.join('\n')
}

export async function status(project) {
  return [...(await tlaRows(project)), ...(await leanRows(project)), ...bridgeRows(project)]
}

export function parseArgs(argv) {
  const options = { json: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--json') { options.json = true; continue }
    if (flag === '--project' && argv[i + 1] && !argv[i + 1].startsWith('--')) { options.project = argv[++i]; continue }
    if (flag === '--help') { options.help = true; continue }
    throw Object.assign(new Error(`unknown or incomplete argument: ${flag}`), { code: 'usage-invalid' })
  }
  return options
}

export const USAGE = 'formal-design-status --project <root> [--json]'

export async function main(argv = process.argv.slice(2)) {
  let options
  try { options = parseArgs(argv) } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}\n`)
    return 1
  }
  if (options.help) { process.stdout.write(`${USAGE}\n`); return 0 }
  if (!options.project) { process.stderr.write(`--project is required\n${USAGE}\n`); return 1 }
  const rows = await status(options.project)
  if (options.json) process.stdout.write(`${JSON.stringify({ schemaVersion: 1, backend: 'status', rows }, null, 2)}\n`)
  else process.stdout.write(`${render(rows)}\n`)
  // This is a status view, never a gate: it always exits 0 once it has reported.
  return 0
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) process.exitCode = await main()
