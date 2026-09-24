import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_ALLOW_EXCEPTIONS,
  DEFAULT_ENVIRONMENT,
  DEFAULT_SOFT_DENY,
  expandSlot,
} from '../src/slots.ts'
import { createLlmClassifier, classificationKey, expandSoftDeny } from '../src/llm-classifier.ts'
import type { ToolExecution } from '@dsh-cc/tools'

describe('expandSlot', () => {
  it('a list without "$defaults" replaces the defaults entirely', () => {
    expect(expandSlot(['only-this'], ['d1', 'd2'])).toEqual(['only-this'])
  })

  it('"$defaults" alone yields exactly the defaults', () => {
    expect(expandSlot(['$defaults'], ['d1', 'd2'])).toEqual(['d1', 'd2'])
  })

  it('"$defaults" expands in place, position-preserving', () => {
    expect(expandSlot(['a', '$defaults', 'b'], ['d1', 'd2'])).toEqual(['a', 'd1', 'd2', 'b'])
  })

  it('multiple "$defaults" entries each expand; duplicates preserved as written', () => {
    expect(expandSlot(['$defaults', 'x', '$defaults'], ['d'])).toEqual(['d', 'x', 'd'])
    expect(expandSlot(['x', 'x'], ['d'])).toEqual(['x', 'x'])
  })

  it('expandSoftDeny keeps its export signature and semantics', () => {
    expect(expandSoftDeny(['c', '$defaults'])).toEqual(['c', ...DEFAULT_SOFT_DENY])
    expect(expandSoftDeny(['$defaults'])).toEqual(DEFAULT_SOFT_DENY)
  })
})

describe('slot defaults (S2)', () => {
  it('DEFAULT_ENVIRONMENT teaches the session-repo trust boundary', () => {
    expect(DEFAULT_ENVIRONMENT.join(' ')).toMatch(/git repository/)
    expect(DEFAULT_ENVIRONMENT.join(' ')).toMatch(/remotes/)
  })

  it('DEFAULT_ALLOW_EXCEPTIONS covers the three ratified exceptions', () => {
    const joined = DEFAULT_ALLOW_EXCEPTIONS.join('\n')
    expect(joined).toMatch(/packages already declared in the repo manifest/)
    expect(joined).toMatch(/their own provider/)
    expect(joined).toMatch(/session working branch/)
  })
})

function fakeExec(name: string, args: unknown): ToolExecution {
  return { signal: new AbortController().signal, callId: 'c1', name, arguments: args } as unknown as ToolExecution
}

type StreamOpts = { provider: string; model: string; system: string; prompt: string; maxTokens: number; signal?: AbortSignal }

function make(overrides: Partial<Parameters<typeof createLlmClassifier>[0]> = {}) {
  const calls: StreamOpts[] = []
  const deps = {
    stream: vi.fn(async (opts: StreamOpts) => {
      calls.push(opts)
      return '{"verdict":"allow","reason":"ok"}'
    }),
    hardDeny: ['h1'],
    softDeny: ['s1'],
    allowExceptions: ['a1'],
    environment: ['e1'],
    timeoutMs: 5_000,
    cacheMaxEntries: 256,
    ...overrides,
  }
  return createLlmClassifier(deps)
}

const ROUTE = { provider: 'prov', model: 'mod' }

describe('prompt composition (S2 slots)', () => {
  it('contains every configured entry of all three lists, in evaluation order', async () => {
    const calls: StreamOpts[] = []
    const cls = make({ stream: vi.fn(async (opts: StreamOpts) => { calls.push(opts); return '{"verdict":"allow","reason":"ok"}' }) })
    await cls.classify(fakeExec('Bash', { command: 'ls' }), { route: ROUTE })
    const system = calls[0]!.system
    const softAt = system.indexOf('- s1')
    const allowAt = system.indexOf('- a1')
    const envAt = system.indexOf('- e1')
    expect(softAt).toBeGreaterThanOrEqual(0)
    expect(allowAt).toBeGreaterThan(softAt)
    expect(envAt).toBeGreaterThan(allowAt)
  })

  it('S4: the hard-deny section leads the evaluation order (hard before soft before allow)', async () => {
    const calls: StreamOpts[] = []
    const cls = make({ stream: vi.fn(async (opts: StreamOpts) => { calls.push(opts); return '{"verdict":"allow","reason":"ok"}' }) })
    await cls.classify(fakeExec('Bash', { command: 'ls' }), { route: ROUTE })
    const system = calls[0]!.system
    const hardAt = system.indexOf('- h1')
    const softAt = system.indexOf('- s1')
    const allowAt = system.indexOf('- a1')
    expect(hardAt).toBeGreaterThanOrEqual(0)
    expect(softAt).toBeGreaterThan(hardAt)
    expect(allowAt).toBeGreaterThan(softAt)
    expect(system.toLowerCase()).toMatch(/never soften a hard-deny match/)
  })
})

describe('classificationKey slot busting', () => {
  it('busts on a soft_deny change', () => {
    expect(classificationKey('Bash', 'ls', ['a'], ['b'], ['c']))
      .not.toBe(classificationKey('Bash', 'ls', ['a2'], ['b'], ['c']))
  })

  it('busts on an allow-exceptions change', () => {
    expect(classificationKey('Bash', 'ls', ['a'], ['b'], ['c']))
      .not.toBe(classificationKey('Bash', 'ls', ['a'], ['b2'], ['c']))
  })

  it('busts on an environment change', () => {
    expect(classificationKey('Bash', 'ls', ['a'], ['b'], ['c']))
      .not.toBe(classificationKey('Bash', 'ls', ['a'], ['b'], ['c2']))
  })

  it('a changed allow list busts a real classifier instance cache', async () => {
    const calls: StreamOpts[] = []
    const stream = vi.fn(async (opts: StreamOpts) => {
      calls.push(opts)
      return '{"verdict":"allow","reason":"ok"}'
    })
    const deps = { stream, hardDeny: ['h'], softDeny: ['s'], allowExceptions: ['a'], environment: ['e'], timeoutMs: 5_000, cacheMaxEntries: 256 }
    const cls = createLlmClassifier(deps)
    await cls.classify(fakeExec('Bash', { command: 'ls' }), { route: ROUTE })
    await cls.classify(fakeExec('Bash', { command: 'ls' }), { route: ROUTE })
    expect(calls).toHaveLength(1)
    const cls2 = createLlmClassifier({ ...deps, allowExceptions: ['a2'] })
    await cls2.classify(fakeExec('Bash', { command: 'ls' }), { route: ROUTE })
    expect(calls).toHaveLength(2)
  })
})
