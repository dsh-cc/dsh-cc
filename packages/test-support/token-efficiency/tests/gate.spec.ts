import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadBaseline, loadGate } from '../src/gate'
import { compareTask, runChecks } from '../src/gate'
import type { MetricVector } from '../src/metrics.ts'
import type { TaskDescriptor } from '../src/corpus'

const replayVector = (over: Partial<MetricVector> = {}): MetricVector => ({
  task: 't1',
  tokens: { input: 100, output: 10, cacheRead: 5, cacheWrite: 0, total: 110 },
  counters: { 'ccr.compressions': 2 },
  ...over,
})

const replayTask: TaskDescriptor = { id: 't1', kind: 'replay', fixture: 'fixtures/t1.jsonl' }

const mockVector = (over: Partial<MetricVector> = {}): MetricVector => ({
  task: 'm1',
  capability: { ok: true },
  tokens: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, total: 55 },
  counters: { 'reducer.applied': 1 },
  ...over,
})

const mockTask: TaskDescriptor = {
  id: 'm1',
  kind: 'mock-script',
  prompt: 'p',
  counters: { expect: { 'reducer.applied': '>=1' } },
}

const gate = { baseline: { ref: 'main@abc', vector: 'baseline.json' }, tolerance: { capability: 0 } }

describe('compareTask — replay tier', () => {
  it('passes definition-stable when vectors are field-equal', () => {
    const v = compareTask({ descriptor: replayTask, candidate: replayVector(), baseline: replayVector(), gate })
    expect(v).toMatchObject({ task: 't1', kind: 'replay', status: 'pass', detail: 'definition-stable' })
  })

  it('fails definition-changed on any token/counter diff with refresh message', () => {
    const v = compareTask({
      descriptor: replayTask,
      candidate: replayVector({ tokens: { input: 100, output: 11, cacheRead: 5, cacheWrite: 0, total: 111 } }),
      baseline: replayVector(),
      gate,
    })
    expect(v.status).toBe('fail')
    expect(v.detail).toBe('metric definitions changed or baseline stale: refresh the baseline in its own PR')
    expect(v.axisDiff).toMatchObject({ 'tokens.output': { before: 10, after: 11 } })
  })

  it('asserts capability is absent for replay vectors', () => {
    const v = compareTask({
      descriptor: replayTask,
      candidate: replayVector({ capability: { ok: true } }) as unknown as MetricVector,
      baseline: replayVector() as unknown as MetricVector,
      gate,
    })
    expect(v.status).toBe('fail')
  })

  it('fails replay with no baseline vector', () => {
    const v = compareTask({ descriptor: replayTask, candidate: replayVector(), gate })
    expect(v).toMatchObject({ status: 'fail', detail: 'no baseline vector for task t1' })
  })
})

describe('compareTask — mock tier', () => {
  it('fails capability regression when capability.ok is false', () => {
    const v = compareTask({
      descriptor: mockTask,
      candidate: mockVector({ capability: { ok: false } }),
      gate,
    })
    expect(v).toMatchObject({ status: 'fail', detail: 'capability regression' })
  })

  it('reports token diffs but passes when capability and counters hold', () => {
    const v = compareTask({
      descriptor: mockTask,
      candidate: mockVector({ tokens: { input: 999, output: 999, cacheRead: 999, cacheWrite: 999, total: 3996 } }),
      gate,
    })
    expect(v.status).toBe('pass')
    expect(v.axisDiff?.['tokens.input']).toEqual({ before: undefined, after: 999 })
  })

  it('evaluates counters.expect comparator matrix', () => {
    const mk = (expectVal: string, counters: Record<string, number>) =>
      compareTask({
        descriptor: { ...mockTask, counters: { expect: { 'reducer.applied': expectVal } } },
        candidate: mockVector({ counters }),
        gate,
      })
    expect(mk('>=1', { 'reducer.applied': 1 }).status).toBe('pass')
    expect(mk('>=2', { 'reducer.applied': 1 }).status).toBe('fail')
    expect(mk('=0', { 'reducer.applied': 0 }).status).toBe('pass')
    expect(mk('=0', { 'reducer.applied': 1 }).status).toBe('fail')
    expect(mk('>0', { 'reducer.applied': 1 }).status).toBe('pass')
    expect(mk('>1', { 'reducer.applied': 1 }).status).toBe('fail')
    expect(mk('<=3', { 'reducer.applied': 3 }).status).toBe('pass')
    expect(mk('<=3', { 'reducer.applied': 4 }).status).toBe('fail')
    expect(mk('<2', { 'reducer.applied': 1 }).status).toBe('pass')
    expect(mk('<1', { 'reducer.applied': 1 }).status).toBe('fail')
    const miss = mk('>=1', {})
    expect(miss.status).toBe('fail')
  })
})

describe('loadGate', () => {
  let dir = ''
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'gate-')) })

  it('accepts a valid gate with tolerance.capability=0', () => {
    const p = join(dir, 'gate.yaml')
    writeFileSync(p, 'baseline: { ref: "main@abc", vector: baseline.json }\ntolerance: { capability: 0 }\n')
    expect(loadGate(p, [replayTask]).tolerance.capability).toBe(0)
  })

  it('rejects non-zero tolerance.capability', () => {
    const p = join(dir, 'gate2.yaml')
    writeFileSync(p, 'baseline: { ref: "m", vector: b.json }\ntolerance: { capability: 3 }\n')
    expect(() => loadGate(p, [replayTask])).toThrow(/capability/)
  })

  it('rejects require-improvement-on with zero live tasks', () => {
    const p = join(dir, 'gate3.yaml')
    writeFileSync(p, 'baseline: { ref: "m", vector: b.json }\ntolerance: { capability: 0 }\nrequire-improvement-on: [tokens.total]\n')
    expect(() => loadGate(p, [replayTask])).toThrow(/require-improvement-on.*live/)
  })

  it('accepts require-improvement-on when a live task exists', () => {
    const live: TaskDescriptor = { id: 'l1', kind: 'live', prompt: 'p', oracle: { type: 'file-exists', path: 'x' } }
    const p = join(dir, 'gate4.yaml')
    writeFileSync(p, 'baseline: { ref: "m", vector: b.json }\ntolerance: { capability: 0 }\nrequire-improvement-on: [tokens.total]\n')
    expect(loadGate(p, [live])['require-improvement-on']).toEqual(['tokens.total'])
  })

  it('rejects malformed yaml/schema', () => {
    const p = join(dir, 'gate5.yaml')
    writeFileSync(p, 'baseline: [1, 2\n')
    expect(() => loadGate(p, [replayTask])).toThrow()
    const p2 = join(dir, 'gate6.yaml')
    writeFileSync(p2, 'tolerance: { capability: 0 }\n')
    expect(() => loadGate(p2, [replayTask])).toThrow(/baseline/)
  })
})

describe('loadBaseline', () => {
  it('validates the blob shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blob-'))
    const p = join(dir, 'b.json')
    writeFileSync(p, JSON.stringify({ ref: 'main@abc', vectors: { t1: replayVector() } }))
    expect(loadBaseline(p).vectors.t1.tokens.total).toBe(110)
    writeFileSync(p, '{ nope')
    expect(() => loadBaseline(p)).toThrow()
  })
})

describe('runChecks', () => {
  it('aggregates verdicts and ok flag', () => {
    const r = runChecks({
      corpus: [replayTask, mockTask],
      candidateVectors: { t1: replayVector(), m1: mockVector() },
      baseline: { ref: 'main@abc', vectors: { t1: replayVector() } },
      gate,
    })
    expect(r.verdicts).toHaveLength(2)
    expect(r.ok).toBe(true)
  })

  it('fails ok when a replay task lacks its baseline vector', () => {
    const r = runChecks({
      corpus: [replayTask],
      candidateVectors: { t1: replayVector() },
      baseline: { ref: 'main@abc', vectors: {} },
      gate,
    })
    expect(r.ok).toBe(false)
    expect(r.verdicts[0].detail).toMatch(/no baseline vector/)
  })

  it('ok=false when any verdict fails', () => {
    const r = runChecks({
      corpus: [mockTask],
      candidateVectors: { m1: mockVector({ capability: { ok: false } }) },
      gate,
    })
    expect(r.ok).toBe(false)
  })
})
