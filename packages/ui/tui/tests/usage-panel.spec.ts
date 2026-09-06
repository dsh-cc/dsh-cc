import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Container } from '@dsh-cc/pi-tui'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'
import { cacheHitPercent, createUsagePanelBox } from '@dsh-cc/tui/components/overlays.ts'
import {
  closeUsagePanel,
  createInitialState,
  openUsagePanel,
  setUsage,
  type UsageTotalsView,
  type UsageView,
} from '@dsh-cc/tui/store.ts'

/** Render a box to stripped lines so structural assertions see plain text. */
function boxLines(box: Container): string[] {
  return box.render(80).map(line => line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd())
}

function boxText(box: Container): string {
  return boxLines(box).join('\n')
}

const fullView: UsageView = {
  totals: { input: 12_345, output: 1_234, cacheRead: 5_678, cacheWrite: 901 },
  contextUsed: 86_000,
  contextWindow: 200_000,
  breakdown: { system: 1_200, tools: 3_400, messages: 81_400 },
}

describe('usage panel store helpers', () => {
  it('openUsagePanel parks the marker object', () => {
    const state = openUsagePanel(createInitialState())
    expect(state.usagePanel).toEqual({})
  })

  it('openUsagePanel is a same-reference no-op when already open', () => {
    const open = openUsagePanel(createInitialState())
    expect(openUsagePanel(open)).toBe(open)
  })

  it('closeUsagePanel drops the field entirely', () => {
    const closed = closeUsagePanel(openUsagePanel(createInitialState()))
    expect(closed.usagePanel).toBeUndefined()
    expect('usagePanel' in closed).toBe(false)
  })

  it('closeUsagePanel on a closed panel is a same-reference no-op', () => {
    const base = createInitialState()
    expect(closeUsagePanel(base)).toBe(base)
  })

  it('usage panel helpers never mutate the original state', () => {
    const base = createInitialState()
    const open = openUsagePanel(base)
    expect(base.usagePanel).toBeUndefined()
    expect(open.usagePanel).toEqual({})

    const closed = closeUsagePanel(open)
    expect(open.usagePanel).toEqual({})
    expect(closed.usagePanel).toBeUndefined()
  })

  it('setUsage replaces the snapshot wholesale', () => {
    const first = setUsage(createInitialState(), fullView)
    expect(first.usage).toEqual(fullView)
    const second = setUsage(first, { contextUsed: 5 })
    expect(second.usage).toEqual({ contextUsed: 5 })
  })

  it('setUsage(undefined) drops the field and is a same-reference no-op when absent', () => {
    const base = createInitialState()
    expect(setUsage(base, undefined)).toBe(base)
    const cleared = setUsage(setUsage(base, fullView), undefined)
    expect(cleared.usage).toBeUndefined()
    expect('usage' in cleared).toBe(false)
  })
})

describe('cacheHitPercent', () => {
  it('computes cacheRead / (input + cacheRead) as a rounded percent', () => {
    expect(cacheHitPercent({ input: 750, output: 10, cacheRead: 250 })).toBe(25)
    expect(cacheHitPercent({ input: 1, output: 0, cacheRead: 2 })).toBe(67)
  })

  it('is undefined when cacheRead is absent or the denominator is zero', () => {
    expect(cacheHitPercent({ input: 100, output: 5 })).toBeUndefined()
    const totals: UsageTotalsView = { input: 0, output: 0, cacheRead: 0 }
    expect(cacheHitPercent(totals)).toBeUndefined()
  })

  it('clamps the ratio at 100%', () => {
    // cacheRead/(input + cacheRead) cannot exceed 1 with non-negative buckets,
    // so the clamp only guards malformed data (negative input).
    expect(cacheHitPercent({ input: -300, output: 0, cacheRead: 400 })).toBe(100)
  })
})

describe('createUsagePanelBox', () => {
  it('renders the context bar, token totals, breakdown rows, and footer', () => {
    const lines = boxLines(createUsagePanelBox(fullView))
    expect(lines[0]).toBe('Usage')
    // Bar fills by the rounded occupancy ratio (43% of 10 cells → 4 full).
    expect(lines).toContain('████░░░░░░ 43% (86k/200k)')
    expect(lines).toContain('  input    12,345')
    expect(lines).toContain('  output    1,234')
    expect(lines).toContain('  cache r   5,678')
    expect(lines).toContain('  cache w     901')
    // 5,678 / (12,345 + 5,678) ≈ 31.5% → 32%.
    expect(lines).toContain('  hit  32%')
    expect(lines).toContain('  system     1,200')
    expect(lines).toContain('  tools      3,400')
    expect(lines).toContain('  messages  81,400')
    expect(lines).toContain('quota data unavailable · Esc close')
    expect(boxText(createUsagePanelBox(fullView))).not.toContain('n/a')
  })

  it('omits zero cache rows from the token table', () => {
    const lines = boxLines(createUsagePanelBox({
      ...fullView,
      totals: { input: 500, output: 40, cacheRead: 0, cacheWrite: 0 },
    }))
    expect(lines).toContain('  input   500')
    expect(lines).toContain('  output   40')
    expect(boxText(createUsagePanelBox({ ...fullView, totals: { input: 500, output: 40 } })))
      .not.toContain('cache')
  })

  it('clamps the bar and percent at 100%', () => {
    const lines = boxLines(createUsagePanelBox({
      ...fullView,
      contextUsed: 210_000,
      contextWindow: 200_000,
    }))
    expect(lines).toContain('██████████ 100% (210k/200k)')
  })

  it('shows the used count without a percent when the window is unknown', () => {
    const text = boxText(createUsagePanelBox({ ...fullView, contextWindow: undefined }))
    expect(text).toContain('86k tok · window n/a')
    // The *context* line claims no percent; the Tokens hit row still may.
    expect(boxLines(createUsagePanelBox({ ...fullView, contextWindow: undefined }))[1])
      .toBe('86k tok · window n/a')
    // The other sections still render their full data.
    expect(text).toContain('  input    12,345')
  })

  it('degrades every missing section to a dim n/a independently', () => {
    const lines = boxLines(createUsagePanelBox(undefined))
    expect(lines[0]).toBe('Usage')
    expect(lines.filter(line => line === 'n/a')).toHaveLength(3)
    expect(lines).toContain('quota data unavailable · Esc close')
  })

  it('degrades only the breakdown when its projection is missing', () => {
    const text = boxText(createUsagePanelBox({
      totals: { input: 500, output: 40 },
      contextUsed: 1_000,
      contextWindow: 2_000,
    }))
    expect(text).toContain('█████░░░░░ 50% (1k/2k)')
    expect(text).toContain('  input   500')
    expect(text).toContain('Breakdown')
    expect(text).toContain('n/a')
  })

  it('omits the hit row when cacheRead is absent', () => {
    const text = boxText(createUsagePanelBox({ totals: { input: 100, output: 5 } }))
    expect(text).not.toContain('  hit')
  })

  it('shows hit 0% when cacheRead is zero but the denominator is positive', () => {
    const lines = boxLines(createUsagePanelBox({
      totals: { input: 500, output: 40, cacheRead: 0, cacheWrite: 0 },
    }))
    expect(lines).toContain('  input   500')
    expect(lines).toContain('  hit  0%')
  })

  it('omits the hit row when input and cacheRead are both zero', () => {
    const text = boxText(createUsagePanelBox({
      totals: { input: 0, output: 40, cacheRead: 0, cacheWrite: 0 },
    }))
    expect(text).not.toContain('  hit')
  })

  it('clamps the hit percent at 100%', () => {
    // >1 is unreachable with non-negative buckets; the clamp guards malformed data.
    const lines = boxLines(createUsagePanelBox({
      totals: { input: -300, output: 0, cacheRead: 400 },
    }))
    expect(lines).toContain('  hit  100%')
  })
})

// --- driver: /usage opens the panel from the three projections --------------

type ProjectionListener = (session: { id: string }, key: string, value: unknown, seq: number) => void

/**
 * Minimal ctx stub with a drivable sessionProjections service: `stateOf`
 * reads a key→state map and `fire` pushes a change through the feed.
 */
function makeUsageCtx(states: Record<string, unknown> = {}) {
  const listeners = new Set<ProjectionListener>()
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
          onChanged(listener: ProjectionListener): () => void {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
          },
          stateOf: (_session: { id: string }, key: string) => states[key],
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
  const fire = (key: string, value: unknown): void => {
    for (const listener of listeners) listener({ id: 's-a' }, key, value, 0)
  }
  return { ctx, fire }
}

describe('/usage (driver)', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-usage-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('opens the panel seeded from the tokenUsage, contextPressure, and contextBreakdown projections', async () => {
    const { ctx } = makeUsageCtx({
      tokenUsage: {
        totals: {
          uncachedInputTokens: 12_345,
          outputTokens: 1_234,
          cacheReadTokens: 5_678,
          cacheWriteTokens: 901,
        },
        last: null,
      },
      contextPressure: {
        contextWindow: 200_000,
        pressureTokens: 85_000,
        surfaceTokens: 3_000,
        sampledSurfaceTokens: 2_000,
      },
      contextBreakdown: { system: 1_200, tools: 3_400, messages: 81_400 },
    })
    const driver = await createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })

    await driver.submit('/usage')
    expect(driver.state.usagePanel).toEqual({})
    expect(driver.state.usage).toEqual({
      totals: { input: 12_345, output: 1_234, cacheRead: 5_678, cacheWrite: 901 },
      contextUsed: 86_000,
      contextWindow: 200_000,
      breakdown: { system: 1_200, tools: 3_400, messages: 81_400 },
    })
  })

  it('degrades independently when projections are partial', async () => {
    const { ctx } = makeUsageCtx({
      contextPressure: { pressureTokens: 500 }, // no window
      contextBreakdown: { system: 'bogus' }, // malformed → section dropped
    })
    const driver = await createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })

    await driver.submit('/usage')
    expect(driver.state.usagePanel).toEqual({})
    expect(driver.state.usage).toEqual({ contextUsed: 500 })
  })

  it('opens with no usage snapshot when no projections are mounted', async () => {
    const { ctx } = makeUsageCtx()
    const driver = await createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })

    await driver.submit('/usage')
    expect(driver.state.usagePanel).toEqual({})
    expect(driver.state.usage).toBeUndefined()
  })

  it('refreshes the panel from projection change events while it is open', async () => {
    const { ctx, fire } = makeUsageCtx({})
    const driver = await createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })
    await driver.submit('/usage')

    fire('tokenUsage', { totals: { uncachedInputTokens: 100, outputTokens: 20 }, last: null })
    expect(driver.state.usage?.totals).toEqual({ input: 100, output: 20 })

    fire('contextPressure', { contextWindow: 1_000, pressureTokens: 250 })
    expect(driver.state.usage?.contextUsed).toBe(250)
    expect(driver.state.usage?.contextWindow).toBe(1_000)

    fire('contextBreakdown', { system: 10, tools: 40, messages: 200 })
    expect(driver.state.usage?.breakdown).toEqual({ system: 10, tools: 40, messages: 200 })
  })

  it('does not emit when a projection event carries the same usage values', async () => {
    const { ctx, fire } = makeUsageCtx({})
    const driver = await createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })
    fire('contextBreakdown', { system: 10, tools: 40, messages: 200 })
    const afterFirst = driver.state

    fire('contextBreakdown', { system: 10, tools: 40, messages: 200 })
    expect(driver.state).toBe(afterFirst)
  })

  it('usagePanelClose() closes the panel and keeps the snapshot', async () => {
    const { ctx } = makeUsageCtx({ contextBreakdown: { system: 1, tools: 2, messages: 3 } })
    const driver = await createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })
    await driver.submit('/usage')
    expect(driver.state.usagePanel).toEqual({})

    driver.usagePanelClose()
    expect(driver.state.usagePanel).toBeUndefined()
    expect(driver.state.usage).toBeDefined()
  })

  it('lists /usage in the command catalog', async () => {
    const { ctx } = makeUsageCtx()
    const driver = await createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })
    expect(driver.listCommands().some(command => command.name === 'usage')).toBe(true)
  })
})
