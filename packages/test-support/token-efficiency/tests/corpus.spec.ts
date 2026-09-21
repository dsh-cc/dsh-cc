import { describe, expect, it } from 'vitest'
import { taskDescriptorSchema } from '../src/corpus'

const base = { id: 't1', kind: 'replay', fixture: 'fixtures/a.sanitized.jsonl' } as const

describe('taskDescriptorSchema', () => {
  it('accepts a minimal replay descriptor', () => {
    expect(taskDescriptorSchema.parse(base).id).toBe('t1')
  })

  it('accepts replay with tags', () => {
    expect(taskDescriptorSchema.parse({ ...base, tags: ['logs'] }).tags).toEqual(['logs'])
  })

  it('rejects replay missing fixture', () => {
    expect(() => taskDescriptorSchema.parse({ id: 't', kind: 'replay' })).toThrow(/fixture/)
  })

  it('rejects replay carrying oracle or counters', () => {
    expect(() => taskDescriptorSchema.parse({ ...base, oracle: { type: 'file-exists', path: 'x' } })).toThrow(/replay/)
    expect(() => taskDescriptorSchema.parse({ ...base, counters: { expect: { 'x': '>=1' } } })).toThrow(/replay/)
  })

  it('requires prompt for mock-script and live; replay-only fields rejected there', () => {
    expect(() => taskDescriptorSchema.parse({ id: 't', kind: 'live' })).toThrow(/prompt/)
    expect(() => taskDescriptorSchema.parse({ id: 't', kind: 'mock-script' })).toThrow(/prompt/)
    const live = { id: 't', kind: 'live', prompt: 'p', oracle: { type: 'file-exists', path: 'x' } }
    expect(taskDescriptorSchema.parse(live).kind).toBe('live')
    expect(() => taskDescriptorSchema.parse({ ...live, fixture: 'f.jsonl' })).toThrow(/fixture/)
    expect(() => taskDescriptorSchema.parse({ ...live, counters: { expect: { 'x': '>=1' } } })).toThrow(/mock-script/)
  })

  it('mock-script may carry counters with comparator strings', () => {
    const ms = { id: 't', kind: 'mock-script', prompt: 'p', counters: { expect: { 'reducer.applied': '>=1' } } }
    expect(taskDescriptorSchema.parse(ms).counters?.expect['reducer.applied']).toBe('>=1')
  })

  it('rejects counter values that are not comparator+int', () => {
    const ms = { id: 't', kind: 'mock-script', prompt: 'p', counters: { expect: { 'x': 'about 1' } } }
    expect(() => taskDescriptorSchema.parse(ms)).toThrow()
  })

  it('rejects unknown kind', () => {
    expect(() => taskDescriptorSchema.parse({ id: 't', kind: 'chaos', prompt: 'p' })).toThrow()
  })
})
