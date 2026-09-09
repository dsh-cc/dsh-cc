import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  jaccardAgreement,
  macroAverage,
  perQueryScore,
  validateFixtures,
  validateGolden,
} from '../eval/lib.ts'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const FIXTURES = join(PKG, 'eval', 'fixture-memory')
const GOLDEN = JSON.parse(readFileSync(join(PKG, 'eval', 'golden.json'), 'utf8')) as unknown

/** Every *.md file in fixture-memory except the MEMORY.md index. */
function fixtureFiles(): string[] {
  return readdirSync(FIXTURES).filter(f => f.endsWith('.md') && f !== 'MEMORY.md').sort()
}

describe('fixture validator (eval/fixture-memory)', () => {
  it('holds 25-30 topic files', () => {
    expect(fixtureFiles().length).toBeGreaterThanOrEqual(25)
    expect(fixtureFiles().length).toBeLessThanOrEqual(30)
  })

  it('passes the full validator', () => {
    expect(validateFixtures(FIXTURES)).toEqual([])
  })

  it('flags a fixture missing from MEMORY.md (injected-index overload)', () => {
    const files = fixtureFiles()
    // Index that lists every fixture EXCEPT the first one.
    const index = files.slice(1).map(f => `- ${f}: placeholder description`).join('\n')
    const problems = validateFixtures(FIXTURES, new Map([['MEMORY.md', index]]))
    expect(problems.join(' ')).toContain(files[0]!)
  })

  it('detects at least 3 distractor clusters from golden.json metadata', () => {
    const golden = GOLDEN as { clusters: { members: string[]; relevant: string[] }[] }
    const distractors = golden.clusters.filter(c => c.relevant.length < c.members.length)
    expect(distractors.length).toBeGreaterThanOrEqual(3)
  })
})

describe('golden schema validator', () => {
  it('passes the full validator', () => {
    expect(validateGolden(GOLDEN, fixtureFiles())).toEqual([])
  })

  it('rejects a wrong class count', () => {
    const bad = { ...GOLDEN, queries: [...(GOLDEN as { queries: unknown[] }).queries.slice(1)] }
    expect(validateGolden(bad, fixtureFiles()).join(' ')).toMatch(/10 per class|class/)
  })

  it('rejects required/tolerated referencing unknown fixtures', () => {
    const golden = GOLDEN as { queries: { query: string; required: string[]; tolerated: string[]; class: string }[] }
    const bad = structuredClone(golden)
    bad.queries[0]!.required = ['nope.md']
    expect(validateGolden(bad, fixtureFiles()).join(' ')).toMatch(/nope\.md/)
  })

  it('requires empty required for no-relevant queries', () => {
    const golden = GOLDEN as { queries: { required: string[]; class: string }[] }
    const bad = structuredClone(golden)
    const nr = bad.queries.find(q => q.class === 'no-relevant-memory')!
    nr.required = ['x.md']
    expect(validateGolden(bad, fixtureFiles()).join(' ')).toMatch(/no-relevant/)
  })
})

describe('metric math', () => {
  it('perQueryScore: perfect empty selection on an empty-required query', () => {
    expect(perQueryScore([], [], [])).toEqual({ precision: 1, recall: 1, f1: 1 })
  })

  it('perQueryScore: any selection on an empty-required query is a precision leak', () => {
    const s = perQueryScore(['a.md'], [], [])
    expect(s.precision).toBe(0)
    expect(s.recall).toBe(1)
  })

  it('perQueryScore: tolerated extras do not hurt precision, unlisted do', () => {
    const ok = perQueryScore(['req.md', 'tol.md'], ['req.md'], ['tol.md'])
    expect(ok.precision).toBe(1)
    const leak = perQueryScore(['req.md', 'other.md'], ['req.md'], ['tol.md'])
    expect(leak.precision).toBe(0.5)
    expect(leak.recall).toBe(1)
    expect(leak.f1).toBeCloseTo(2 / 3)
  })

  it('perQueryScore: empty selection on non-empty required is 0/0/0', () => {
    expect(perQueryScore([], ['req.md'], [])).toEqual({ precision: 0, recall: 0, f1: 0 })
  })

  it('perQueryScore: partial recall', () => {
    const s = perQueryScore(['a.md'], ['a.md', 'b.md'], [])
    expect(s).toEqual({ precision: 1, recall: 0.5, f1: 2 / 3 })
  })

  it('macroAverage averages per-query scores', () => {
    const avg = macroAverage([
      { precision: 1, recall: 1, f1: 1 },
      { precision: 0.5, recall: 0.5, f1: 0.5 },
    ])
    expect(avg.f1).toBeCloseTo(0.75)
  })

  it('macroAverage of nothing is 0 (no divide-by-zero)', () => {
    expect(macroAverage([]).f1).toBe(0)
  })

  it('jaccardAgreement: identical selections agree 1, disjoint 0, both empty 1', () => {
    expect(jaccardAgreement(['a', 'b'], ['a', 'b'])).toBe(1)
    expect(jaccardAgreement(['a'], ['b'])).toBe(0)
    expect(jaccardAgreement([], [])).toBe(1)
    expect(jaccardAgreement(['a', 'b'], ['b'])).toBeCloseTo(1 / 2)
  })
})

// Guard: fixture dir must actually exist (guards a moved eval/ tree).
describe('fixture tree sanity', () => {
  it('fixture-memory and MEMORY.md exist', () => {
    expect(existsSync(join(FIXTURES, 'MEMORY.md'))).toBe(true)
  })
})
