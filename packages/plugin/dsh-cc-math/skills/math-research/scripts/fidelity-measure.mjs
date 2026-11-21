import { realpathSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assert, atomicJson, fail, parseFlags, readJson, readUtf8, runCli } from './storage.lib.mjs'
import { ACCEPTED_GRADES, GRADES } from './fidelity-gate.mjs'

// Fidelity measurement protocol (design §4.3, r2 finding 18) — pure
// computation over recorded gate outputs plus human annotation labels.
//
// Unit = the immutable (NL statement, formal statement) pair. "Accepted" = the
// gate's grade is model-assessed or better, measured BEFORE any human
// escalation. The sample is reported over two separate denominators: natural
// outputs (`corrupted: false`) and blind seeded corruptions
// (`corrupted: true` — dropped hypothesis / weakened conclusion / swapped
// quantifier), so a corruption leaking through shows up as
// P(accepted | corrupted).
//
// Annotation rubric: {pairId, annotator, label: faithful|meaning-changed|
// unjudgeable}; the rubric-to-grade mapping is faithful ↔ model-assessed or
// better, meaning-changed ↔ should be disputed. Double annotation: when the
// annotators disagree the third human adjudication pass is recorded as a line
// with `adjudicated: true` — unadjudicated disagreement is incomplete data and
// is rejected (exit 2), never silently resolved. `unjudgeable` labels are
// excluded from BOTH conditional-rate denominators and reported as their own
// rate (v4).

export const ANNOTATION_LABELS = Object.freeze(['faithful', 'meaning-changed', 'unjudgeable'])
const ANNOTATION_FIELDS = ['pairId', 'annotator', 'label', 'adjudicated']
const PAIR_FIELDS = ['pairId', 'corrupted', 'grade', 'fidelity']

const isPlainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const rate = (numerator, denominator) => ({ numerator, denominator, rate: denominator === 0 ? null : numerator / denominator })
const accepted = grade => ACCEPTED_GRADES.includes(grade)

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------
export function validatePair(raw, index, baseDir) {
  const label = `pairs[${index}]`
  assert(isPlainObject(raw), `${label} must be an object`)
  const unknown = Object.keys(raw).filter(key => !PAIR_FIELDS.includes(key))
  assert(unknown.length === 0, `${label} has unknown field(s): ${unknown.join(',')}`)
  assert(typeof raw.pairId === 'string' && raw.pairId.length > 0, `${label}.pairId must be a non-empty string`)
  if (raw.corrupted !== undefined) assert(typeof raw.corrupted === 'boolean', `${label}.corrupted must be a boolean`)
  if (raw.grade !== undefined) assert(GRADES.includes(raw.grade), `${label}.grade must be one of ${GRADES.join('|')}`)
  return {
    pairId: raw.pairId,
    corrupted: raw.corrupted ?? null, // a referenced fidelity.json may supply it
    grade: raw.grade ?? null,
    fidelityPath: raw.fidelity ? resolve(baseDir ?? '.', raw.fidelity) : null,
  }
}

export function validateAnnotationLine(raw, index) {
  const label = `annotations line ${index + 1}`
  assert(isPlainObject(raw), `${label} must be a JSON object`)
  const unknown = Object.keys(raw).filter(key => !ANNOTATION_FIELDS.includes(key))
  assert(unknown.length === 0, `${label} has unknown field(s): ${unknown.join(',')}`)
  assert(typeof raw.pairId === 'string' && raw.pairId.length > 0, `${label}.pairId must be a non-empty string`)
  assert(typeof raw.annotator === 'string' && raw.annotator.length > 0, `${label}.annotator must be a non-empty string`)
  assert(ANNOTATION_LABELS.includes(raw.label), `${label}.label must be one of ${ANNOTATION_LABELS.join('|')}`)
  if (raw.adjudicated !== undefined) assert(typeof raw.adjudicated === 'boolean', `${label}.adjudicated must be a boolean`)
  return { pairId: raw.pairId, annotator: raw.annotator, label: raw.label, adjudicated: raw.adjudicated === true }
}

/**
 * Resolve one effective label per pair. Double annotation with disagreement
 * REQUIRES the third human adjudication pass (`adjudicated: true`); anything
 * else is incomplete protocol data and is rejected.
 */
export function resolveLabels(lines) {
  const byPair = new Map()
  for (const line of lines) {
    if (!byPair.has(line.pairId)) byPair.set(line.pairId, { adjudicated: [], votes: [] })
    const entry = byPair.get(line.pairId)
    if (line.adjudicated) entry.adjudicated.push(line)
    else entry.votes.push(line)
  }
  const labels = new Map()
  for (const [pairId, entry] of byPair) {
    const annotators = new Set([...entry.votes, ...entry.adjudicated].map(line => line.annotator))
    if (entry.adjudicated.length > 1) {
      const distinct = new Set(entry.adjudicated.map(line => line.label))
      if (distinct.size > 1) fail('config-invalid', `pair ${pairId} has conflicting adjudicated labels: ${[...distinct].join(' / ')}`)
    }
    const distinctVotes = new Set(entry.votes.map(line => line.label))
    let label
    let adjudicated = false
    if (entry.adjudicated.length > 0) {
      label = entry.adjudicated[0].label
      adjudicated = true
    } else if (distinctVotes.size === 1) {
      label = entry.votes[0].label
    } else {
      fail('config-invalid', `pair ${pairId} annotations disagree (${[...distinctVotes].join(' / ')}) and no third human adjudication is recorded (adjudicated: true)`)
    }
    labels.set(pairId, { label, annotators: annotators.size, adjudicated })
  }
  return labels
}

// ---------------------------------------------------------------------------
// The measurement itself (pure)
// ---------------------------------------------------------------------------
/**
 * @param {{pairs: Array<{pairId:string, corrupted:boolean|null, grade:string}>, annotations?: Array<{pairId,annotator,label,adjudicated}>|null}} input
 */
export function measureFidelity({ pairs, annotations = null }) {
  const labelled = annotations === null ? null : resolveLabels(annotations)
  const rows = pairs.map(pair => {
    const resolved = labelled?.get(pair.pairId) ?? null
    return {
      pairId: pair.pairId,
      corrupted: Boolean(pair.corrupted),
      grade: pair.grade,
      accepted: accepted(pair.grade),
      label: resolved?.label ?? null,
    }
  })

  const unjudgeable = rows.filter(row => row.label === 'unjudgeable')
  // `unjudgeable` pairs leave BOTH conditional-rate denominators (§4.3 v4) and
  // are reported as their own rate over the labelled sample.
  const measured = labelled === null
    ? rows
    : rows.filter(row => row.label !== null && row.label !== 'unjudgeable')
  const natural = measured.filter(row => !row.corrupted)
  const corrupted = measured.filter(row => row.corrupted)
  const acceptedRows = measured.filter(row => row.accepted)

  const confusion = {
    faithfulAccepted: measured.filter(row => row.label === 'faithful' && row.accepted).length,
    faithfulDisputed: measured.filter(row => row.label === 'faithful' && !row.accepted).length,
    meaningChangedAccepted: measured.filter(row => row.label === 'meaning-changed' && row.accepted).length,
    meaningChangedDisputed: measured.filter(row => row.label === 'meaning-changed' && !row.accepted).length,
  }
  const faithful = confusion.faithfulAccepted + confusion.faithfulDisputed
  const meaningChanged = confusion.meaningChangedAccepted + confusion.meaningChangedDisputed

  return {
    basis: labelled === null ? 'all-pairs' : 'annotations',
    pairs: {
      total: rows.length,
      natural: rows.filter(row => !row.corrupted).length,
      corrupted: rows.filter(row => row.corrupted).length,
      accepted: rows.filter(row => row.accepted).length,
      measured: measured.length,
      excludedUnjudgeable: unjudgeable.length,
      unlabeled: labelled === null ? 0 : rows.filter(row => row.label === null).length,
    },
    acceptance: {
      overall: rate(acceptedRows.length, measured.length),
      natural: rate(natural.filter(row => row.accepted).length, natural.length),
      // P(accepted | corrupted): the corrupted denominator is the whole point
      // of the seeded-corruption sample.
      corrupted: rate(corrupted.filter(row => row.accepted).length, corrupted.length),
    },
    conditional: {
      acceptedGivenCorrupted: rate(corrupted.filter(row => row.accepted).length, corrupted.length),
      corruptedGivenAccepted: rate(acceptedRows.filter(row => row.corrupted).length, acceptedRows.length),
    },
    unjudgeable: rate(unjudgeable.length, labelled === null ? 0 : rows.filter(row => row.label !== null).length),
    reliability: {
      confusion,
      falseAcceptRate: rate(confusion.meaningChangedAccepted, meaningChanged),
      falseRejectRate: rate(confusion.faithfulDisputed, faithful),
    },
    labels: {
      annotators: labelled === null ? 0 : new Set(annotations.map(line => line.annotator)).size,
      labelledPairs: labelled === null ? 0 : labelled.size,
      adjudicatedPairs: labelled === null ? 0 : [...labelled.values()].filter(entry => entry.adjudicated).length,
    },
  }
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------
async function loadPairs(options, { io = fs } = {}) {
  if (options.pairs) {
    const path = resolve(options.pairs)
    const manifest = await readJson(path, 'pairs.json')
    assert(isPlainObject(manifest), 'pairs.json must be a JSON object')
    assert(manifest.schemaVersion === 1, 'pairs.json schemaVersion must be 1')
    assert(Array.isArray(manifest.pairs), 'pairs.json pairs must be an array')
    const entries = manifest.pairs.map((raw, index) => validatePair(raw, index, dirname(path)))
    const pairs = []
    for (const entry of entries) {
      if (entry.fidelityPath === null) {
        assert(entry.grade !== null, `pair ${entry.pairId} needs a grade or a fidelity path`)
        pairs.push({ pairId: entry.pairId, corrupted: entry.corrupted ?? false, grade: entry.grade })
        continue
      }
      const record = await readJson(entry.fidelityPath, `fidelity.json for ${entry.pairId}`)
      assert(GRADES.includes(record?.grade), `${entry.fidelityPath} has no valid grade`)
      pairs.push({
        pairId: entry.pairId,
        corrupted: entry.corrupted ?? record.corrupted ?? false,
        grade: record.grade,
      })
    }
    return pairs
  }
  assert(options.gateDir, 'one of --pairs / --gate-dir is required')
  const gateDir = resolve(options.gateDir)
  const entries = await io.readdir(gateDir, { withFileTypes: true })
  const pairs = []
  for (const entry of entries.filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(gateDir, entry.name, 'fidelity.json')
    let record
    try { record = await readJson(path, `${entry.name}/fidelity.json`) }
    catch (e) { if (e.code === 'ENOENT') continue; throw e } // absent = not a problem dir; invalid JSON blocks
    assert(GRADES.includes(record?.grade), `${path} has no valid grade`)
    pairs.push({ pairId: record.pairId ?? entry.name, corrupted: record.corrupted ?? false, grade: record.grade })
  }
  return pairs
}

async function loadAnnotations(path) {
  const text = await readUtf8(resolve(path), 'annotations.jsonl')
  const lines = []
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue
    let parsed
    try { parsed = JSON.parse(line) }
    catch { fail('config-invalid', `annotations line ${index + 1} is not valid JSON`) }
    lines.push(validateAnnotationLine(parsed, index))
  }
  assert(lines.length > 0, 'annotations file is empty')
  return lines
}

export async function runMeasure(options, deps = {}) {
  const { io = fs, now = () => new Date().toISOString() } = deps
  const pairs = await loadPairs(options, { io })
  const annotations = options.annotations ? await loadAnnotations(options.annotations) : null
  const measured = measureFidelity({ pairs, annotations })
  const report = { schemaVersion: 1, command: 'fidelity-measure', status: 'ok', ...measured, measuredAt: now() }
  if (options.out) await atomicJson(resolve(options.out), report, io)
  return report
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const HELP = [
  'fidelity-measure — fidelity measurement protocol over recorded gate outputs (design §4.3)',
  'usage: fidelity-measure.mjs (--pairs <pairs.json> | --gate-dir <problems dir>) [--annotations <labels.jsonl>] [--out <report.json>]',
  '  --pairs        {schemaVersion:1, pairs:[{pairId, corrupted, grade | fidelity:<fidelity.json>}]}',
  '  --gate-dir     scan immediate subdirectories for fidelity.json (one problem dir each)',
  '  --annotations  jsonl {pairId, annotator, label: faithful|meaning-changed|unjudgeable, adjudicated?}',
  '                 conflicting votes require the third human pass recorded with adjudicated: true',
  '  reports acceptance per denominator (natural vs corrupted), P(accepted|corrupted), P(corrupted|accepted),',
  '  and the unjudgeable own-rate — unjudgeable pairs are excluded from both conditional denominators',
  'exit codes: 0 ok · 2 blocked (config-invalid: malformed pairs/annotations, unadjudicated disagreement) · single-line JSON on stdout',
].join('\n')

async function handle(argv, deps = {}) {
  const options = parseFlags(argv, ['pairs', 'gate-dir', 'annotations', 'out'])
  if (options.help) return 'help'
  if (options.pairs && options['gate-dir']) fail('config-invalid', '--pairs and --gate-dir are mutually exclusive')
  if (!options.pairs && !options['gate-dir']) fail('config-invalid', 'one of --pairs / --gate-dir is required')
  const report = await runMeasure({
    pairs: options.pairs ?? null,
    gateDir: options['gate-dir'] ?? null,
    annotations: options.annotations ?? null,
    out: options.out ?? null,
  }, deps)
  return { exitCode: 0, report }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  return runCli('fidelity-measure', HELP, argv, (args => handle(args, deps)))
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main()
