/**
 * Fidelity measurement protocol tests (design §4.3, r2 finding 18): acceptance
 * per denominator (natural vs blind seeded corruptions), BOTH conditional rates
 * P(accepted|corrupted) and P(corrupted|accepted), the unjudgeable own-rate with
 * unjudgeable pairs excluded from both conditional denominators, double
 * annotation with the third-human adjudication record, and the rubric mapping
 * (faithful ↔ model-assessed or better, meaning-changed ↔ disputed).
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { main, measureFidelity, resolveLabels, runMeasure } from '../skills/math-research/scripts/fidelity-measure.mjs'
import { cli, isoNow, workspaces } from './helpers.ts'

const roots = workspaces()
afterEach(() => roots.cleanup())

type Pair = { pairId: string; corrupted: boolean | null; grade: string }
type Label = { pairId: string; annotator: string; label: string; adjudicated?: boolean }

// 8 pairs: 4 natural, 4 blind seeded corruptions. Gate grades: 4 accepted.
const PAIRS: Pair[] = [
  { pairId: 'n1', corrupted: false, grade: 'anchored' },
  { pairId: 'n2', corrupted: false, grade: 'model-assessed' },
  { pairId: 'n3', corrupted: false, grade: 'disputed' },
  { pairId: 'n4', corrupted: false, grade: 'disputed' },
  { pairId: 'c1', corrupted: true, grade: 'model-assessed' },
  { pairId: 'c2', corrupted: true, grade: 'disputed' },
  { pairId: 'c3', corrupted: true, grade: 'disputed' },
  { pairId: 'c4', corrupted: true, grade: 'anchored' },
]

const labels = (): Label[] => [
  { pairId: 'n1', annotator: 'h1', label: 'faithful' },
  { pairId: 'n1', annotator: 'h2', label: 'faithful' },
  { pairId: 'n2', annotator: 'h1', label: 'faithful' },
  { pairId: 'n2', annotator: 'h2', label: 'faithful' },
  { pairId: 'n3', annotator: 'h1', label: 'meaning-changed' },
  { pairId: 'n3', annotator: 'h2', label: 'meaning-changed' },
  { pairId: 'n4', annotator: 'h1', label: 'unjudgeable' },
  { pairId: 'n4', annotator: 'h2', label: 'unjudgeable' },
  { pairId: 'c1', annotator: 'h1', label: 'meaning-changed' },
  { pairId: 'c1', annotator: 'h2', label: 'meaning-changed' },
  { pairId: 'c2', annotator: 'h1', label: 'meaning-changed' },
  { pairId: 'c2', annotator: 'h2', label: 'meaning-changed' },
  { pairId: 'c3', annotator: 'h1', label: 'faithful' },
  { pairId: 'c3', annotator: 'h2', label: 'faithful' },
  { pairId: 'c4', annotator: 'h1', label: 'faithful' },
  { pairId: 'c4', annotator: 'h2', label: 'faithful' },
]

describe('fidelity measure — conditional rates and denominators (§4.3)', () => {
  const measured = measureFidelity({ pairs: PAIRS, annotations: labels() })

  it('splits the denominators: natural vs corrupted acceptance', () => {
    expect(measured.basis).toBe('annotations')
    // n1,n2 accepted of n1,n2,n3 (n4 is unjudgeable and leaves the denominator)
    expect(measured.acceptance.natural).toEqual({ numerator: 2, denominator: 3, rate: 2 / 3 })
    // c1,c4 accepted of all four corruptions
    expect(measured.acceptance.corrupted).toEqual({ numerator: 2, denominator: 4, rate: 0.5 })
    expect(measured.acceptance.overall).toEqual({ numerator: 4, denominator: 7, rate: 4 / 7 })
  })

  it('reports both conditional rates', () => {
    expect(measured.conditional.acceptedGivenCorrupted).toEqual({ numerator: 2, denominator: 4, rate: 0.5 })
    // of the four accepted pairs (n1,n2,c1,c4), two were corruptions
    expect(measured.conditional.corruptedGivenAccepted).toEqual({ numerator: 2, denominator: 4, rate: 0.5 })
  })

  it('excludes unjudgeable pairs from BOTH denominators and reports its own rate', () => {
    expect(measured.pairs).toMatchObject({ total: 8, natural: 4, corrupted: 4, accepted: 4, measured: 7, excludedUnjudgeable: 1, unlabeled: 0 })
    expect(measured.unjudgeable).toEqual({ numerator: 1, denominator: 8, rate: 0.125 })
    // An unjudgeable pair never enters either conditional denominator...
    for (const conditional of [measured.conditional.acceptedGivenCorrupted, measured.conditional.corruptedGivenAccepted]) {
      expect(conditional.denominator).toBeLessThan(8)
    }
  })

  it('maps the rubric to the grade and reports the false-accept rate', () => {
    expect(measured.reliability.confusion).toEqual({
      faithfulAccepted: 3, faithfulDisputed: 1, meaningChangedAccepted: 1, meaningChangedDisputed: 2,
    })
    expect(measured.reliability.falseAcceptRate).toEqual({ numerator: 1, denominator: 3, rate: 1 / 3 })
    expect(measured.reliability.falseRejectRate).toEqual({ numerator: 1, denominator: 4, rate: 0.25 })
    expect(measured.labels).toEqual({ annotators: 2, labelledPairs: 8, adjudicatedPairs: 0 })
  })

  it('an accepted-but-unjudgeable pair is dropped from both denominators too', () => {
    const result = measureFidelity({
      pairs: [
        { pairId: 'u1', corrupted: true, grade: 'anchored' },
        { pairId: 'k1', corrupted: true, grade: 'disputed' },
        { pairId: 'nat', corrupted: false, grade: 'anchored' },
      ],
      annotations: [
        { pairId: 'u1', annotator: 'h1', label: 'unjudgeable' },
        { pairId: 'k1', annotator: 'h1', label: 'meaning-changed' },
        { pairId: 'nat', annotator: 'h1', label: 'faithful' },
      ],
    })
    expect(result.pairs).toMatchObject({ accepted: 2, measured: 2, excludedUnjudgeable: 1 })
    expect(result.conditional.corruptedGivenAccepted).toEqual({ numerator: 0, denominator: 1, rate: 0 })
    expect(result.conditional.acceptedGivenCorrupted).toEqual({ numerator: 0, denominator: 1, rate: 0 })
    expect(result.acceptance.natural.rate).toBe(1)
  })

  it('without annotations the basis is every pair (no label filtering)', () => {
    const result = measureFidelity({ pairs: PAIRS })
    expect(result.basis).toBe('all-pairs')
    expect(result.pairs).toMatchObject({ total: 8, accepted: 4, measured: 8, excludedUnjudgeable: 0, unlabeled: 0 })
    expect(result.acceptance.natural).toEqual({ numerator: 2, denominator: 4, rate: 0.5 })
    expect(result.unjudgeable).toEqual({ numerator: 0, denominator: 0, rate: null })
    expect(result.labels).toEqual({ annotators: 0, labelledPairs: 0, adjudicatedPairs: 0 })
  })

  it('empty denominators never produce NaN', () => {
    const result = measureFidelity({ pairs: [{ pairId: 'x', corrupted: true, grade: 'disputed' }] })
    expect(result.acceptance.natural).toEqual({ numerator: 0, denominator: 0, rate: null })
    expect(result.conditional.corruptedGivenAccepted).toEqual({ numerator: 0, denominator: 0, rate: null })
  })
})

describe('fidelity measure — double annotation and adjudication (§4.3)', () => {
  it('a disagreement without the third human pass is rejected, and the adjudicated line wins', () => {
    expect(() => resolveLabels([
      { pairId: 'p', annotator: 'h1', label: 'faithful', adjudicated: false },
      { pairId: 'p', annotator: 'h2', label: 'meaning-changed', adjudicated: false },
    ])).toThrow(/adjudication/)
    const resolved = resolveLabels([
      { pairId: 'p', annotator: 'h1', label: 'faithful', adjudicated: false },
      { pairId: 'p', annotator: 'h2', label: 'meaning-changed', adjudicated: false },
      { pairId: 'p', annotator: 'h3', label: 'meaning-changed', adjudicated: true },
    ])
    expect(resolved.get('p')).toEqual({ label: 'meaning-changed', annotators: 3, adjudicated: true })
    // Conflicting adjudications are rejected too — never silently resolved.
    expect(() => resolveLabels([
      { pairId: 'p', annotator: 'h1', label: 'faithful', adjudicated: false },
      { pairId: 'p', annotator: 'h2', label: 'faithful', adjudicated: true },
      { pairId: 'p', annotator: 'h3', label: 'meaning-changed', adjudicated: true },
    ])).toThrow(/conflicting adjudicated/)
  })

  it('annotations for pairs outside the sample do not disturb the rates', () => {
    const result = measureFidelity({
      pairs: [{ pairId: 'a', corrupted: true, grade: 'disputed' }],
      annotations: [
        { pairId: 'a', annotator: 'h1', label: 'meaning-changed' },
        { pairId: 'zz', annotator: 'h1', label: 'faithful' },
      ],
    })
    expect(result.pairs).toMatchObject({ total: 1, measured: 1 })
    expect(result.conditional.acceptedGivenCorrupted).toEqual({ numerator: 0, denominator: 1, rate: 0 })
    expect(result.labels.labelledPairs).toBe(2)
  })
})

describe('fidelity measure — CLI over recorded gate outputs (§4.3)', () => {
  async function gateOutputs(): Promise<string> {
    const problems = await roots.make('mrh-measure-problems-')
    const rows = [
      { id: 'n1', grade: 'anchored', corrupted: false },
      { id: 'n2', grade: 'disputed', corrupted: false },
      { id: 'c1', grade: 'model-assessed', corrupted: true },
      { id: 'c2', grade: 'disputed', corrupted: true },
    ]
    for (const row of rows) {
      await mkdir(join(problems, row.id), { recursive: true })
      await writeFile(join(problems, row.id, 'fidelity.json'), JSON.stringify({
        schemaVersion: 1, command: 'fidelity-gate', status: 'ok', pairId: row.id, corrupted: row.corrupted,
        grade: row.grade, disputeReason: row.grade === 'disputed' ? 'model-judgment' : null,
        pairEquivalence: null, checks: {}, decisionRow: 1, retry: {}, escalation: null, decidedAt: isoNow(),
      }))
    }
    return problems
  }

  it('scans a problems directory of fidelity.json outputs, printing single-line JSON', async () => {
    const problems = await gateOutputs()
    const annotations = join(problems, 'labels.jsonl')
    await writeFile(annotations, [
      { pairId: 'n1', annotator: 'h1', label: 'faithful' },
      { pairId: 'n2', annotator: 'h1', label: 'meaning-changed' },
      { pairId: 'c1', annotator: 'h1', label: 'meaning-changed' },
      { pairId: 'c2', annotator: 'h1', label: 'unjudgeable' },
    ].map(line => JSON.stringify(line)).join('\n') + '\n')
    const { exitCode, output } = await cli(main, ['--gate-dir', problems, '--annotations', annotations])
    expect(exitCode).toBe(0)
    expect(output).toMatchObject({ command: 'fidelity-measure', status: 'ok', basis: 'annotations' })
    expect((output.pairs as Record<string, number>)).toMatchObject({ total: 4, natural: 2, corrupted: 2, measured: 3, excludedUnjudgeable: 1 })
    expect((output.acceptance as Record<string, unknown>).natural).toEqual({ numerator: 1, denominator: 2, rate: 0.5 })
    expect((output.acceptance as Record<string, unknown>).corrupted).toEqual({ numerator: 1, denominator: 1, rate: 1 })
    expect((output.conditional as Record<string, unknown>).corruptedGivenAccepted).toEqual({ numerator: 1, denominator: 2, rate: 0.5 })
  })

  it('reads pairs from a manifest that points at fidelity.json files, plus --out', async () => {
    const dir = await roots.make('mrh-measure-pairs-')
    await mkdir(join(dir, 'p1'), { recursive: true })
    await writeFile(join(dir, 'p1', 'fidelity.json'), JSON.stringify({ schemaVersion: 1, grade: 'anchored', pairId: 'p1', corrupted: true }))
    const manifest = join(dir, 'pairs.json')
    await writeFile(manifest, JSON.stringify({ schemaVersion: 1, pairs: [{ pairId: 'p1', fidelity: 'p1/fidelity.json' }] }))
    const out = join(dir, 'report.json')
    const { exitCode, output } = await cli(main, ['--pairs', manifest, '--out', out])
    expect(exitCode).toBe(0)
    expect(output).toMatchObject({ basis: 'all-pairs', pairs: { total: 1, corrupted: 1, accepted: 1 } })
    const written = JSON.parse(await (await import('node:fs/promises')).readFile(out, 'utf8'))
    expect(written).toMatchObject({ command: 'fidelity-measure', acceptance: { corrupted: { rate: 1 } } })
  })

  it('malformed inputs are config-invalid (exit 2): bad pair fields, bad labels, unadjudicated disagreement', async () => {
    const bad = async (write: (dir: string) => Promise<string>) => {
      const dir = await roots.make('mrh-measure-bad-')
      const path = await write(dir)
      return cli(main, ['--pairs', path])
    }
    const badPair = await bad(async dir => {
      const path = join(dir, 'pairs.json')
      await writeFile(path, JSON.stringify({ schemaVersion: 1, pairs: [{ pairId: 'p1', grade: 'anchored', bogus: 1 }] }))
      return path
    })
    expect(badPair.exitCode).toBe(2)
    expect(badPair.output).toMatchObject({ status: 'blocked', reason: { code: 'config-invalid' } })

    const problems = await gateOutputs()
    const badLabels = join(problems, 'bad.jsonl')
    await writeFile(badLabels, JSON.stringify({ pairId: 'n1', annotator: 'h1', label: 'maybe' }) + '\n')
    const badLabel = await cli(main, ['--gate-dir', problems, '--annotations', badLabels])
    expect(badLabel.exitCode).toBe(2)

    const disagreeing = join(problems, 'disagree.jsonl')
    await writeFile(disagreeing, [
      { pairId: 'n1', annotator: 'h1', label: 'faithful' },
      { pairId: 'n1', annotator: 'h2', label: 'meaning-changed' },
    ].map(line => JSON.stringify(line)).join('\n') + '\n')
    const unadjudicated = await cli(main, ['--gate-dir', problems, '--annotations', disagreeing])
    expect(unadjudicated.exitCode).toBe(2)
    expect(unadjudicated.output).toMatchObject({ status: 'blocked', reason: { code: 'config-invalid' } })

    const noSource = await cli(main, [])
    expect(noSource.exitCode).toBe(2)
  })

  it('runMeasure accepts in-memory pairs and a missing grade is rejected', async () => {
    await expect(runMeasure({ pairs: null, gateDir: '/nonexistent-dir' })).rejects.toThrow()
    const dir = await roots.make('mrh-measure-grades-')
    const path = join(dir, 'pairs.json')
    await writeFile(path, JSON.stringify({ schemaVersion: 1, pairs: [{ pairId: 'p1' }] }))
    await expect(runMeasure({ pairs: path })).rejects.toMatchObject({ code: 'config-invalid' })
  })
})
