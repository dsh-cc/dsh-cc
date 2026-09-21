import { describe, expect, it } from 'vitest'
import {
  applyActorContract,
  matchesAnyModelPattern,
  matchesModelPattern,
} from '@dsh-cc/claude-code-agents'

const START = '<!-- actor-contract:start -->'
const END = '<!-- actor-contract:end -->'
const mark = (body: string): string => `${START}\n${body}\n${END}`

describe('matchesModelPattern', () => {
  it('matches case-insensitively on both sides', () => {
    expect(matchesModelPattern('glm-4.7', 'glm-*')).toBe(true)
    expect(matchesModelPattern('GLM-4.7', 'glm-*')).toBe(true)
    expect(matchesModelPattern('Glm-4.7', 'GLM-*')).toBe(true)
  })

  it('matches an exact literal without wildcards', () => {
    expect(matchesModelPattern('glm-4.7', 'glm-4.7')).toBe(true)
    expect(matchesModelPattern('glm-4.7', 'glm-4.8')).toBe(false)
  })

  it('treats regex metachars literally', () => {
    expect(matchesModelPattern('glm-4.7(legacy)', 'glm-4.7(legacy)')).toBe(true)
    expect(matchesModelPattern('glm-4x7(legacy)', 'glm-4.7(legacy)')).toBe(false)
  })

  it('anchors whole-string matching', () => {
    expect(matchesModelPattern('xglm-4.7', 'glm-*')).toBe(false)
    expect(matchesModelPattern('glm-4.7-x', 'glm-4.7')).toBe(false)
  })

  it('treats `*` as zero-or-more chars', () => {
    expect(matchesModelPattern('glm-4.7', '*')).toBe(true)
    expect(matchesModelPattern('', '*')).toBe(true)
    expect(matchesModelPattern('gpt-5', 'glm-*')).toBe(false)
    expect(matchesModelPattern('glm-', 'glm-*')).toBe(true)
  })
})

describe('matchesAnyModelPattern', () => {
  it('is true iff some value matches some pattern', () => {
    expect(matchesAnyModelPattern(['gpt-5', 'glm-4.7'], ['glm-*'])).toBe(true)
    expect(matchesAnyModelPattern(['gpt-5'], ['glm-*', 'gpt-*'])).toBe(true)
    expect(matchesAnyModelPattern(['gpt-5'], ['glm-*'])).toBe(false)
    expect(matchesAnyModelPattern([], ['glm-*'])).toBe(false)
    expect(matchesAnyModelPattern(['glm-4.7'], [])).toBe(false)
  })
})

describe('applyActorContract', () => {
  it('returns no-marker input byte-identical', () => {
    const persona = '# Agent\n\nBody text.\n'
    expect(applyActorContract(persona, ['glm-4.7'], ['glm-*'])).toBe(persona)
    expect(applyActorContract(persona, [], [])).toBe(persona)
  })

  it('removes markers always; keeps content iff a candidate matches a pattern', () => {
    const persona = `Top.\n\n${mark('## Actor contract\n\nBe literal.')}\n\nBottom.\n`
    const kept = `Top.\n\n## Actor contract\n\nBe literal.\n\nBottom.\n`
    expect(applyActorContract(persona, ['glm-4.7'], ['glm-*'])).toBe(kept)
    const stripped = 'Top.\n\nBottom.\n'
    expect(applyActorContract(persona, ['gpt-5'], ['glm-*'])).toBe(stripped)
    expect(applyActorContract(persona, [], ['glm-*'])).toBe(stripped)
    expect(applyActorContract(persona, ['glm-4.7'], [])).toBe(stripped)
  })

  it('is case-insensitive across candidates and patterns', () => {
    const persona = `${mark('hidden')}\n\nAfter.`
    expect(applyActorContract(persona, ['GLM-4.7'], ['glm-*'])).toContain('hidden')
    expect(applyActorContract(persona, ['glm-4.7'], ['GLM-*'])).toContain('hidden')
    expect(applyActorContract(persona, ['GPT-5'], ['glm-*'])).not.toContain('hidden')
  })

  it('opens the gate when any candidate matches any pattern', () => {
    const persona = `${mark('secret')}\n`
    expect(applyActorContract(persona, ['gpt-5', 'glm-4.7'], ['gpt-6', 'glm-*'])).toBe('secret\n')
  })

  it('handles an empty block between markers', () => {
    const persona = `A\n\n${START}\n${END}\n\nB\n`
    expect(applyActorContract(persona, ['glm-4.7'], ['glm-*'])).toBe('A\n\nB\n')
    expect(applyActorContract(persona, ['gpt-5'], ['glm-*'])).toBe('A\n\nB\n')
  })

  it('handles multiple independent blocks', () => {
    const persona = `${mark('first')}\nMiddle.\n${mark('second')}\nEnd.`
    expect(applyActorContract(persona, ['glm-4.7'], ['glm-*']))
      .toBe('first\nMiddle.\nsecond\nEnd.')
    expect(applyActorContract(persona, ['gpt-5'], ['glm-*']))
      .toBe('Middle.\nEnd.')
  })

  it('never leaves a run of 3+ newlines after excision', () => {
    const persona = `A\n\n\n\n${mark('gone')}\n\n\n\nB\n`
    const out = applyActorContract(persona, ['gpt-5'], ['glm-*'])
    expect(out).toBe('A\n\nB\n')
    expect(out).not.toMatch(/\n{3,}/)
  })

  it('handles blocks at the start and end of the persona', () => {
    const startPersona = `${mark('head')}\n\nTail.\n`
    expect(applyActorContract(startPersona, ['gpt-5'], ['glm-*'])).toBe('Tail.\n')
    expect(applyActorContract(startPersona, ['glm-4.7'], ['glm-*'])).toBe('head\n\nTail.\n')
    const endPersona = `Head.\n\n${mark('tail')}`
    expect(applyActorContract(endPersona, ['gpt-5'], ['glm-*'])).toBe('Head.\n')
    expect(applyActorContract(endPersona, ['glm-4.7'], ['glm-*'])).toBe('Head.\n\ntail')
  })

  it('treats an inline marker inside a sentence as literal text', () => {
    const persona = `Use ${START} inline as documented, then ${END} here.`
    expect(applyActorContract(persona, ['gpt-5'], ['glm-*'])).toBe(persona)
  })

  it('treats markers as whole lines only, allowing surrounding whitespace', () => {
    const persona = `  ${START}  \nkept\n\t${END}\n`
    expect(applyActorContract(persona, ['glm-4.7'], ['glm-*'])).toBe('kept\n')
  })

  it('strips a dangling start block (content runs to end-of-string)', () => {
    const persona = `Head.\n${START}\ngated content`
    expect(applyActorContract(persona, ['gpt-5'], ['glm-*'])).toBe('Head.\n')
    expect(applyActorContract(persona, ['glm-4.7'], ['glm-*'])).toBe('Head.\ngated content')
  })

  it('treats an orphan end marker as literal text', () => {
    const persona = `Head.\n${END}\nTail.`
    expect(applyActorContract(persona, ['gpt-5'], ['glm-*'])).toBe(persona)
  })
})
