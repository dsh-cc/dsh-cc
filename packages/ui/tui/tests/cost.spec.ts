import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriver, formatCostReport } from '@dsh-cc/tui/harness/driver.ts'

/** Minimal ctx stub: a sessionProjections service with a tokenUsage state. */
function makeCostCtx(usage: unknown) {
  const ctx: Record<string, unknown> = {
    get(key: string) {
      if (key === 'agentPresets') {
        return {
          defaultId: 'cc',
          resolve: async () => ({ id: 'cc' }),
          mount: async () => ({ id: 'cc' }),
        }
      }
      if (key === 'sessionProjections') {
        return {
          onChanged: () => () => {},
          stateOf: (_session: unknown, key: string) => (key === 'tokenUsage' ? usage : undefined),
        }
      }
      return undefined
    },
    on: () => () => {},
    agents: {
      create: async () => ({
        agent: {
          options: {},
          session: { id: 's-a', header: {}, events: [] },
          id: 'a-1',
          status: 'idle',
          followup: vi.fn(),
          steer: vi.fn(),
          cancel: vi.fn(),
        },
        dispose: async () => {},
      }),
      resume: async () => {
        throw new Error('not needed')
      },
    },
  }
  return { ctx }
}

/** Last status row emitted to the transcript, if any. */
function lastStatus(driver: { state: { rows: readonly { kind: string; text?: string }[] } }): string | undefined {
  for (let i = driver.state.rows.length - 1; i >= 0; i -= 1) {
    const row = driver.state.rows[i]!
    if (row.kind === 'status') return row.text
  }
  return undefined
}

describe('formatCostReport', () => {
  it('formats totals with thousands separators and aligned columns', () => {
    const text = formatCostReport({
      input: 12_345,
      output: 1234,
      cacheRead: 5678,
      cacheWrite: 901,
    })
    expect(text).toBe(
      [
        'Token usage this session:',
        '  input    12,345',
        '  output    1,234',
        '  cache r   5,678',
        '  cache w     901',
        '  cache hit   32%',
        '  Pricing is not configured — costs are not computed.',
      ].join('\n'),
    )
  })

  it('omits cache lines when the cache totals are zero', () => {
    const text = formatCostReport({ input: 500, output: 40 })
    expect(text).toBe(
      [
        'Token usage this session:',
        '  input       500',
        '  output       40',
        '  Pricing is not configured — costs are not computed.',
      ].join('\n'),
    )
  })

  it('reports no usage when totals are absent', () => {
    expect(formatCostReport(undefined)).toBe('No token usage recorded yet.')
  })

  it('appends a cache-hit percent line when cacheRead is present', () => {
    const text = formatCostReport({ input: 750, output: 10, cacheRead: 250, cacheWrite: 0 })
    expect(text).toContain('  cache hit   25%')
  })

  it('clamps the cache-hit percent at 100%', () => {
    // >1 is unreachable with non-negative buckets; the clamp guards malformed data.
    const text = formatCostReport({ input: -300, output: 0, cacheRead: 400 })
    expect(text).toContain('  cache hit  100%')
  })

  it('omits the cache-hit line when cacheRead is absent or the denominator is zero', () => {
    expect(formatCostReport({ input: 500, output: 40 })).not.toContain('cache hit')
    expect(formatCostReport({ input: 0, output: 0, cacheRead: 0 })).not.toContain('cache hit')
  })
})

describe('/cost (driver.runLocal)', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-cost-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('emits the usage report as one status row from the tokenUsage projection', async () => {
    const usage = {
      totals: {
        uncachedInputTokens: 12_345,
        outputTokens: 1234,
        cacheReadTokens: 5678,
        cacheWriteTokens: 901,
      },
      last: null,
    }
    const { ctx } = makeCostCtx(usage)
    const driver = await createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })

    await driver.submit('/cost')
    expect(lastStatus(driver)).toContain('Token usage this session:')
    expect(lastStatus(driver)).toContain('input    12,345')
    expect(lastStatus(driver)).toContain('output    1,234')
    expect(lastStatus(driver)).toContain('cache r   5,678')
    expect(lastStatus(driver)).toContain('cache w     901')
    expect(lastStatus(driver)).toContain('Pricing is not configured')
  })

  it('omits cache lines when the cache totals are zero', async () => {
    const usage = {
      totals: { uncachedInputTokens: 500, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
      last: null,
    }
    const { ctx } = makeCostCtx(usage)
    const driver = await createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })

    await driver.submit('/cost')
    const text = lastStatus(driver)!
    expect(text).toContain('input')
    expect(text).not.toContain('cache r')
    expect(text).not.toContain('cache w')
  })

  it('prints the no-usage message when the projection has no totals', async () => {
    const { ctx } = makeCostCtx(undefined)
    const driver = await createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })

    await driver.submit('/cost')
    expect(lastStatus(driver)).toBe('No token usage recorded yet.')
  })
})
