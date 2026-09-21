import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { REDUCER_COMMAND_TOOLS, isReducerEligible, truncateView, reduceToolOutput } from '../src/reducer.ts'
import type { ToolExecution } from '@dsh-cc/tools'

function exec(name: string, args: unknown): ToolExecution {
  return { name, arguments: args, callId: 'c1', signal: new AbortController().signal } as unknown as ToolExecution
}

const estimate = (t: string): number => Math.ceil(t.length / 4)

describe('reducer eligibility (§3.2)', () => {
  it('command surface defaults to bash', () => {
    expect(REDUCER_COMMAND_TOOLS).toEqual(['bash'])
  })

  const enabled = resolveConfig({ 'reducer-enabled': true })

  it('accepts a bash tool whose command matches a default pattern', () => {
    expect(isReducerEligible(enabled, exec('bash', { command: 'pnpm vitest run' }))).toBe(true)
    expect(isReducerEligible(enabled, exec('bash', { command: 'cat package.json' }))).toBe(false)
  })

  it('rejects disabled flag, non-command tools, and non-string commands', () => {
    expect(isReducerEligible(resolveConfig(), exec('bash', { command: 'vitest' }))).toBe(false)
    expect(isReducerEligible(enabled, exec('grep', { command: 'vitest' }))).toBe(false)
    expect(isReducerEligible(enabled, exec('bash', { command: 42 }))).toBe(false)
    expect(isReducerEligible(enabled, exec('bash', {}))).toBe(false)
    expect(isReducerEligible(enabled, exec('bash', undefined))).toBe(false)
  })

  it('route-null shape and the route decline decision belong to the caller; commands are only eligibility', () => {
    // make\b also matches cmake — accepted over-trigger (§3.2).
    expect(isReducerEligible(enabled, exec('bash', { command: 'cmake --build .' }))).toBe(true)
  })
})

describe('head/tail truncation (§3.3)', () => {
  it('keeps the first ~20% and the tail when over the input cap', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line-${String(i).padStart(3, '0')}`)
    const text = lines.join('\n')
    // Cap the view to roughly 12 tokens worth of the ~7-token text… use a
    // per-line estimate so the cap bites: estimate counts ~1 token per 4 chars.
    const view = truncateView(text, 30, (t) => Math.ceil(t.length / 4))
    expect(view).toContain('line-000')
    expect(view).toContain('line-099')
    expect(view.split('\n').length).toBeLessThan(100)
  })

  it('returns the text untouched when under the cap', () => {
    expect(truncateView('short', 30_000, estimate)).toBe('short')
  })
})

describe('fail-soft (§3.7)', () => {
  it('any internal throw degrades to passthrough instead of escaping', async () => {
    const brokenCtx = { get: () => { throw new Error('boom') }, logger: { debug: vi.fn() } }
    const ledgerRow = vi.fn()
    const outcome = await reduceToolOutput({
      ctx: brokenCtx as never,
      cfg: resolveConfig({ 'reducer-enabled': true }),
      exec: exec('bash', { command: 'vitest run' }),
      originalText: 'x'.repeat(9000),
      tokensBefore: 9000,
      isError: false,
      estimate,
      projectKey: 'proj',
      mode: 'on',
      put: vi.fn(),
      ledgerRow,
    })
    expect(outcome).toBeUndefined()
  })
})
