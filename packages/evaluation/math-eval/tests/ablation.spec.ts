import { describe, expect, it } from 'vitest'
import { ABLATION_CONFIGS, attributionContrasts, getConfig } from '../src/ablation.js'
import { CONFIG_KEYS, type AblationConfig } from '../src/types.js'

// Ablation matrix (docs/plans/2026-11-21-mathematical-research-harness.md §8.3):
// nine configs, one declared budget exception (F1 attempts=1), four isolated
// attribution contrasts. These pin the table as data — nothing here runs models.
const MECHANISMS = ['prompt', 'bashLean', 'retrieval', 'feedback', 'search', 'experience'] as const

describe('ablation matrix', () => {
  it('declares exactly the nine design configs in table order', () => {
    expect(ABLATION_CONFIGS.map((config) => config.key)).toEqual([...CONFIG_KEYS])
    expect(ABLATION_CONFIGS).toHaveLength(9)
  })

  it('matches the §8.3 table row for row', () => {
    const expected: Record<string, AblationConfig> = {
      A: getConfig('A'),
      B: getConfig('B'),
      C: getConfig('C'),
      D: getConfig('D'),
      E: getConfig('E'),
      H: getConfig('H'),
      F: getConfig('F'),
      F1: getConfig('F1'),
      G: getConfig('G'),
    }
    const table: Record<string, boolean[]> = {
      // prompt, bash+lean, retrieval, feedback, search, experience
      A: [false, false, false, false, false, false],
      B: [true, false, false, false, false, false],
      C: [true, true, false, false, false, false],
      D: [true, true, true, false, false, false],
      E: [true, true, false, true, false, false],
      H: [true, true, true, true, false, false],
      F: [true, true, true, true, true, false],
      F1: [true, true, true, true, true, false],
      G: [true, true, true, true, true, true],
    }
    for (const [key, flags] of Object.entries(table)) {
      const config = expected[key] as AblationConfig
      expect(MECHANISMS.map((mechanism) => config[mechanism])).toEqual(flags)
    }
  })

  it('gives F and F1 search=true, and only F1 an attempts override', () => {
    expect(getConfig('F').search).toBe(true)
    expect(getConfig('F1').search).toBe(true)
    expect(getConfig('F1').attemptsOverride).toBe(1)
    for (const config of ABLATION_CONFIGS) {
      if (config.key === 'F1') continue
      expect(config.attemptsOverride).toBeUndefined()
    }
    // F1 differs from F in the attempt cap only.
    const { key: _f1Key, label: _f1Label, attemptsOverride: _f1Override, ...f1Rest } = getConfig('F1')
    const { key: _fKey, label: _fLabel, ...fRest } = getConfig('F')
    expect(f1Rest).toEqual(fRest)
  })

  it('returns the four attribution contrasts from the design, as data', () => {
    const contrasts = attributionContrasts()
    expect(contrasts.map((contrast) => [contrast.from, contrast.to, contrast.isolates])).toEqual([
      ['C', 'D', 'retrieval'],
      ['C', 'E', 'feedback'],
      ['H', 'F', 'search'],
      ['F', 'G', 'experience'],
    ])
    expect(contrasts.map((contrast) => contrast.id)).toEqual(['C->D', 'C->E', 'H->F', 'F->G'])
    // H→F is claimed inclusive of its extra sampling (§8.3), not as a clean
    // mechanism-only delta.
    expect(contrasts.find((contrast) => contrast.id === 'H->F')?.claim).toContain('inclusive')
  })

  it('each contrast changes exactly the mechanism it isolates', () => {
    for (const contrast of attributionContrasts()) {
      const from = getConfig(contrast.from)
      const to = getConfig(contrast.to)
      const changed = MECHANISMS.filter((mechanism) => from[mechanism] !== to[mechanism])
      expect(changed).toEqual([contrast.isolates])
    }
  })

  it('returns detached copies so callers cannot mutate the pinned matrix', () => {
    const config = getConfig('G')
    config.prompt = false
    config.experience = false
    expect(getConfig('G').prompt).toBe(true)
    expect(getConfig('G').experience).toBe(true)

    const contrasts = attributionContrasts()
    contrasts[0]!.isolates = 'experience'
    expect(attributionContrasts()[0]!.isolates).toBe('retrieval')
  })

  it('throws on an unknown config key', () => {
    expect(() => getConfig('Z' as never)).toThrow(/unknown ablation config key/)
  })
})
