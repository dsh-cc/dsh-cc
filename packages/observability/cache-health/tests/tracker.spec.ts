import { describe, expect, it } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { canonicalJson, excerpt, PrefixTracker } from '@dsh-cc/cache-health/tracker'

/** Build GenerateOptions with the given system prompt and messages. */
function options(system: string, messages: string[], tools?: unknown[]): GenerateOptions {
  return {
    provider: 'deepseek',
    model: 'deepseek-chat',
    messages: messages.map(text => ({ role: 'user', content: text })) as GenerateOptions['messages'],
    system,
    ...(tools !== undefined ? { tools } : {}),
  } as GenerateOptions
}

/** Counting hash wrapper to verify the early-exit behavior. */
function countingHash(): { hash: (text: string) => string; calls: () => number } {
  let count = 0
  return {
    hash: (text) => {
      count += 1
      // cheap deterministic stand-in for sha256 in this unit
      return String(text.length)
    },
    calls: () => count,
  }
}

describe('canonicalJson', () => {
  it('sorts object keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined, c2: 3 } })).toBe('{"a":{"c2":3,"d":2},"b":1}')
  })
  it('keeps array order and is deterministic', () => {
    const value = [{ x: 1, y: [1, 2] }, 's', null, true]
    expect(canonicalJson(value)).toBe(canonicalJson(structuredClone(value)))
  })
  it('hashes unicode payloads stably', () => {
    const tracker = new PrefixTracker()
    const a = tracker.observe('s1', options('你好 🌍', ['данные']))
    const b = tracker.observe('s1', options('你好 🌍', ['данные']))
    expect(b.prefixChanged).toBe(false)
    expect(b.stableSegments).toBe(a.stableSegments)
  })
})

describe('PrefixTracker segment diff', () => {
  it('first call reports full stable segments and no drift', () => {
    const tracker = new PrefixTracker()
    const observation = tracker.observe('s1', options('sys', ['m1', 'm2']))
    expect(observation).toMatchObject({ stableSegments: 4, prefixChanged: false, stablePrefixTokensEst: expect.any(Number) })
    expect(observation.driftSegmentIndex).toBeUndefined()
  })

  it('identical lists are fully stable', () => {
    const tracker = new PrefixTracker()
    tracker.observe('s1', options('sys', ['m1', 'm2']))
    const second = tracker.observe('s1', options('sys', ['m1', 'm2']))
    expect(second).toMatchObject({ stableSegments: 4, prefixChanged: false })
  })

  it('detects a mutated FIRST (system) segment at index 0', () => {
    const tracker = new PrefixTracker()
    tracker.observe('s1', options('sys-a', ['m1']))
    const second = tracker.observe('s1', options('sys-b', ['m1']))
    expect(second.prefixChanged).toBe(true)
    expect(second.driftSegmentIndex).toBe(0)
    expect(second.driftExcerpt).toContain('sys-b')
  })

  it('detects tools-only change at index 1', () => {
    const tracker = new PrefixTracker()
    tracker.observe('s1', options('sys', ['m1'], [{ name: 'a' }]))
    const second = tracker.observe('s1', options('sys', ['m1'], [{ name: 'b' }]))
    expect(second.prefixChanged).toBe(true)
    expect(second.driftSegmentIndex).toBe(1)
  })

  it('detects insertion at the message front (index 2) while system/tools stay stable', () => {
    const tracker = new PrefixTracker()
    tracker.observe('s1', options('sys', ['m1', 'm2']))
    const second = tracker.observe('s1', options('sys', ['new', 'm1', 'm2']))
    expect(second.prefixChanged).toBe(true)
    expect(second.driftSegmentIndex).toBe(2)
  })

  it('tail appends do not bust the prefix', () => {
    const tracker = new PrefixTracker()
    tracker.observe('s1', options('sys', ['m1']))
    const second = tracker.observe('s1', options('sys', ['m1', 'm2']))
    expect(second.prefixChanged).toBe(false)
  })

  it('removing a front message is a drift at index 2', () => {
    const tracker = new PrefixTracker()
    tracker.observe('s1', options('sys', ['m1', 'm2']))
    const second = tracker.observe('s1', options('sys', ['m2']))
    expect(second.prefixChanged).toBe(true)
    expect(second.driftSegmentIndex).toBe(2)
  })

  it('tracks sessions independently', () => {
    const tracker = new PrefixTracker()
    tracker.observe('a', options('sys-a', ['m1']))
    const b = tracker.observe('b', options('sys-b', ['m1']))
    expect(b.prefixChanged).toBe(false)
    expect(b.stableSegments).toBe(3)
  })

  it('exits early: segments after the first difference are not hashed', () => {
    const counting = countingHash()
    const tracker = new PrefixTracker(counting.hash)
    // 5 segments; after drift at index 0 nothing further should be hashed.
    tracker.observe('s1', options('sys', ['m1', 'm2', 'm3']))
    const before = counting.calls()
    const second = tracker.observe('s1', options('OTHER', ['m1', 'm2', 'm3']))
    expect(second.prefixChanged).toBe(true)
    expect(second.driftSegmentIndex).toBe(0)
    expect(counting.calls()).toBe(before + 1)
  })
})

describe('excerpt redaction and truncation', () => {
  it('redacts api keys, bearer tokens, and opaque runs >= 32 chars', () => {
    const text = JSON.stringify({ key: 'sk-1234567890abcdef', auth: 'Bearer abc.token', blob: 'a'.repeat(40) })
    const out = excerpt(text)
    expect(out).not.toContain('sk-1234567890')
    expect(out).not.toContain('abc.token')
    expect(out).toContain('[redacted]')
  })

  it('collapses whitespace and truncates to 80 chars', () => {
    const out = excerpt(JSON.stringify({ text: 'a  b\n\t c' }) + ' x'.repeat(60))
    expect(out).not.toMatch(/\s{2,}/)
    expect(out.length).toBeLessThanOrEqual(80)
  })
})
