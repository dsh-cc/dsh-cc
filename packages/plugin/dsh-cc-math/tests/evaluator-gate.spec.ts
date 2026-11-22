/**
 * Evaluator-gate behavioral tests (design §6.2 item 1–5, §6.1 population
 * snapshots and seeded selection):
 *
 *  - a trusted example the evaluator fails rejects the gate (exit 1) — the
 *    examples are pinned in the run manifest BEFORE the loop and their sha256
 *    is re-checked on disk, so a swapped example is refused outright;
 *  - a double-implementation disagreement rejects the gate;
 *  - the evaluator/checker version hashes are pinned into the gate record;
 *  - `selectParents` is a pure function of (population, K, rngState): the same
 *    inputs reproduce the same parents and the same next rngState;
 *  - population/gen-<n>.json round-trips with its rngState.
 *
 * Every subprocess is mocked — these tests never execute a real evaluator and
 * never touch the network.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  POPULATION_SCHEMA_VERSION, compareImplementations, evaluateGate, main, nextRngState, populationPath, readPopulation,
  selectParents, validatePopulation, writePopulation,
} from '../skills/math-research/scripts/evaluator-gate.mjs'
import { HEX, cli, isoNow, workspaces } from './helpers.ts'

const roots = workspaces()
afterEach(() => roots.cleanup())

const sha256Text = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

type Runner = (command: string, args: string[], options: { cwd: string; timeoutMs: number }) => Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut?: boolean; spawnError?: string }>

/** Mock runner: verdicts keyed by program basename, then by case basename. */
function mockRunner(verdicts: Record<string, Record<string, number>>): Runner {
  return async (command, args) => {
    const program = command.split('/').pop() ?? command
    const testCase = (args[0] ?? '').split('/').pop() ?? ''
    const byCase = verdicts[program] ?? {}
    const exitCode = byCase[testCase] ?? byCase['*'] ?? 0
    return { exitCode, stdout: `${program} ${testCase} → ${exitCode}\n`, stderr: '', timedOut: false }
  }
}

/** A run dir with the pinned trusted examples (§9.1 trustedExamples). */
async function makeRun({ examples = ['pos.json', 'neg.json'] as string[], skipPin = false } = {}) {
  const root = await roots.make('mrh-gate-')
  const exampleDir = join(root, 'examples')
  await mkdir(exampleDir, { recursive: true })
  const trusted = []
  for (const [index, name] of examples.entries()) {
    const body = `${JSON.stringify({ case: name, expected: index % 2 === 0 ? 'pass' : 'fail' })}\n`
    await writeFile(join(exampleDir, name), body)
    trusted.push({ problemId: `ex-${index + 1}`, source: `examples/${name}`, sha256: sha256Text(body) })
  }
  const manifest: Record<string, unknown> = { goal: 'gate test', createdAt: isoNow() }
  if (!skipPin && trusted.length > 0) manifest.trustedExamples = trusted
  await writeFile(join(root, 'run-manifest.json'), JSON.stringify(manifest) + '\n')
  const evaluator = join(root, 'evaluator.mjs')
  const checker = join(root, 'checker.mjs')
  await writeFile(evaluator, '// evaluator\n')
  await writeFile(checker, '// independent checker\n')
  return { root, evaluator, checker, exampleDir }
}

describe('evaluator gate (§6.2)', () => {
  it('passes when the evaluator clears every trusted example and both implementations agree', async () => {
    const run = await makeRun()
    const report = await evaluateGate({ evaluator: run.evaluator, checker: run.checker, runDir: run.root }, { run: mockRunner({}) })
    expect(report.decision).toBe('pass')
    expect(report.trustedExamples).toHaveLength(2)
    expect(report.trustedFailures).toEqual([])
    expect(report.doubleImplementation).toMatchObject({ cases: 2, agreements: 2, disagreements: [] })
    // §6.2 item 3: the version hashes are pinned into the record.
    expect(report.record).toMatchObject({ kind: 'evaluator-gate', verdict: 'pass' })
    expect(report.evaluator.version).toBe(sha256Text('// evaluator\n'))
    expect(report.checker.version).toBe(sha256Text('// independent checker\n'))
    expect(report.record.bindingHashes).toEqual({ evaluator: report.evaluator.version, checker: report.checker.version })
    // The correlated-mistake caveat is stated, never hidden.
    expect(report.caveat).toContain('weak evidence')
  })

  it('REJECTS a broken evaluator that fails a trusted example (exit 1)', async () => {
    const run = await makeRun()
    const runner = mockRunner({ 'evaluator.mjs': { 'pos.json': 1 }, 'checker.mjs': { 'pos.json': 1 } })
    const report = await evaluateGate({ evaluator: run.evaluator, checker: run.checker, runDir: run.root }, { run: runner })
    expect(report.decision).toBe('fail')
    expect(report.status).toBe('failed')
    expect(report.trustedFailures).toEqual(['ex-1'])
    expect(report.record).toMatchObject({ kind: 'evaluator-gate', verdict: 'fail' })
    const { exitCode, output } = await cli((argv, deps) => main(argv, deps as never), ['gate', '--run', run.root, '--evaluator', run.evaluator, '--checker', run.checker], { run: runner })
    expect(exitCode).toBe(1)
    expect(output).toMatchObject({ decision: 'fail', status: 'failed' })
  })

  it('REJECTS a double-implementation disagreement even when the evaluator passes every example', async () => {
    const run = await makeRun()
    // The evaluator passes both cases; the independent checker disagrees on one.
    const runner = mockRunner({ 'checker.mjs': { 'neg.json': 1 } })
    const report = await evaluateGate({ evaluator: run.evaluator, checker: run.checker, runDir: run.root }, { run: runner })
    expect(report.trustedFailures).toEqual([])
    expect(report.doubleImplementation.disagreements).toEqual([{ case: 'ex-2', reason: 'verdict-disagreement', evaluator: 'pass', checker: 'fail' }])
    expect(report.decision).toBe('fail')
    // A checker that never ran is a disagreement too.
    const silent = await evaluateGate({ evaluator: run.evaluator, checker: run.checker, runDir: run.root }, { run: mockRunner({}) })
    expect(silent.decision).toBe('pass')
    const missing = compareImplementations(
      [{ case: 'c-1', path: '/x/c-1.json', verdict: 'pass', exitCode: 0, timedOut: false, stdoutTail: '', stderrTail: '' }],
      [],
    )
    expect(missing.disagreements).toEqual([{ case: 'c-1', reason: 'checker-did-not-run', evaluator: 'pass', checker: null }])
  })

  it('a timeout and a swapped trusted example both fail closed', async () => {
    const run = await makeRun()
    const timingOut: Runner = async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true })
    expect((await evaluateGate({ evaluator: run.evaluator, checker: run.checker, runDir: run.root }, { run: timingOut })).decision).toBe('fail')
    // Tamper with a pinned example: the sha256 re-check refuses the run.
    await writeFile(join(run.root, 'examples', 'pos.json'), '{"swapped":true}\n')
    await expect(evaluateGate({ evaluator: run.evaluator, checker: run.checker, runDir: run.root }, { run: mockRunner({}) })).rejects.toMatchObject({ code: 'evidence-mismatch' })
  })

  it('refuses a run with no pinned examples, a missing program, or a checker that IS the evaluator', async () => {
    const empty = await makeRun({ examples: [], skipPin: true })
    await expect(evaluateGate({ evaluator: empty.evaluator, checker: empty.checker, runDir: empty.root }, { run: mockRunner({}) })).rejects.toMatchObject({ code: 'config-invalid' })
    const run = await makeRun()
    await expect(evaluateGate({ evaluator: join(run.root, 'nope.mjs'), checker: run.checker, runDir: run.root }, { run: mockRunner({}) })).rejects.toMatchObject({ code: 'missing-evidence' })
    await expect(evaluateGate({ evaluator: run.evaluator, checker: run.evaluator, runDir: run.root }, { run: mockRunner({}) })).rejects.toMatchObject({ code: 'config-invalid' })
  })
})

describe('population snapshots + seeded selection (§6.1)', () => {
  const population = {
    schemaVersion: POPULATION_SCHEMA_VERSION,
    rngState: 12345,
    individuals: [
      { id: 'i-1', program: 'p1', score: 0.9, evaluatorVersion: HEX('a'), parentIds: [] },
      { id: 'i-2', program: 'p2', score: 0.5, evaluatorVersion: HEX('a'), parentIds: ['i-1'] },
      { id: 'i-3', program: 'p3', score: 0.7, evaluatorVersion: HEX('a'), parentIds: ['i-1'] },
      { id: 'i-4', program: 'p4', score: 0.1, evaluatorVersion: HEX('a'), parentIds: [] },
      { id: 'i-5', program: 'p5', score: 0.3, evaluatorVersion: HEX('a'), parentIds: ['i-3'] },
    ],
  }

  it('selection is a pure function: top-K by score plus K seeded-random, reproducible', () => {
    const first = selectParents(population, 2, 12345)
    const second = selectParents(population, 2, 12345)
    expect(first).toEqual(second) // same inputs, same parents AND same next rngState
    expect(first.top).toEqual(['i-1', 'i-3'])
    expect(first.parents.slice(0, 2)).toEqual(['i-1', 'i-3'])
    expect(first.parents).toHaveLength(4)
    expect(new Set(first.parents).size).toBe(4) // drawn without replacement
    expect(first.random.every((id: string) => !first.top.includes(id))).toBe(true)
    expect(first.rngState).not.toBe(12345) // the stream advanced for resume
    // A different seed keeps the top-K and can change the random half.
    const other = selectParents(population, 2, 999)
    expect(other.top).toEqual(first.top)
    expect(other.rngState).not.toBe(first.rngState)
    // Ties break on id, never on insertion order.
    const tied = { schemaVersion: 1, rngState: 1, individuals: [
      { id: 'i-b', program: 'b', score: 0.5, evaluatorVersion: HEX('a'), parentIds: [] },
      { id: 'i-a', program: 'a', score: 0.5, evaluatorVersion: HEX('a'), parentIds: [] },
    ] }
    expect(selectParents(tied, 1, 1).top).toEqual(['i-a'])
    // K larger than the population draws everything, once.
    expect(selectParents(population, 9, 7).parents.sort()).toEqual(population.individuals.map(individual => individual.id).sort())
  })

  it('the rng stream is deterministic and never sticks at zero', () => {
    expect(nextRngState(1)).toBe(nextRngState(1))
    expect(nextRngState(1)).not.toBe(1)
    expect(nextRngState(0)).toBeGreaterThan(0)
    let state = 42
    const seen = new Set()
    for (let index = 0; index < 32; index++) {
      state = nextRngState(state)
      expect(state).toBeGreaterThan(0)
      expect(state).toBeLessThanOrEqual(0xFFFFFFFF)
      seen.add(state)
    }
    expect(seen.size).toBe(32) // no short cycle in the first 32 draws
  })

  it('population/gen-<n>.json round-trips with its rngState and is schema-strict', async () => {
    const root = await roots.make('mrh-pop-')
    await writePopulation(root, 0, population)
    const read = await readPopulation(root, 0)
    expect(read).toEqual(population)
    expect(populationPath(root, 0)).toBe(join(root, 'population', 'gen-0.json'))
    expect(() => validatePopulation({ ...population, injected: true })).toThrowError(/unknown field/)
    expect(() => validatePopulation({ ...population, rngState: -1 })).toThrowError(/uint32/)
    // Sorted output is stable JSON on one line (atomic write, no append).
    const cliRun = await cli(main, ['show', '--run', root, '--generation', '0'])
    expect(cliRun.exitCode).toBe(0)
    expect(cliRun.output).toMatchObject({ subcommand: 'show', generation: 0, rngState: 12345 })
    expect(cliRun.raw.trim().split('\n')).toHaveLength(1)
  })

  it('select reads the snapshot and advances exactly one seeded stream', async () => {
    const root = await roots.make('mrh-pop-select-')
    await writePopulation(root, 3, population)
    const first = await cli(main, ['select', '--run', root, '--generation', '3', '--k', '2'])
    const second = await cli(main, ['select', '--run', root, '--generation', '3', '--k', '2'])
    expect(first.exitCode).toBe(0)
    expect(first.output).toMatchObject({ subcommand: 'select', generation: 3, top: ['i-1', 'i-3'] })
    // The reported rngState is the ADVANCED stream, so a resume continues it.
    expect(first.output.rngState).toBe(selectParents(population, 2, 12345).rngState)
    expect(first.output.parents).toEqual(second.output.parents)
    // Re-running the same generation never mutates the snapshot's rngState.
    expect(selectParents(population, 2, (await readPopulation(root, 3)).rngState)).toEqual(selectParents(population, 2, 12345))
    const tooBig = await cli(main, ['select', '--run', root, '--generation', '3', '--k', '99'])
    expect(tooBig.exitCode).toBe(2)
  })
})
