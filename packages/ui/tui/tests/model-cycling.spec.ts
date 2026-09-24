import { describe, expect, it } from 'vitest'
import {
  createModelCyclingSection,
  nextCycleIndex,
  pickCycleTarget,
  startIndexOf,
  type CycleRoute,
} from '@dsh-cc/tui/model-cycling.ts'
import { handleComposerInput, type InputSink } from '@dsh-cc/tui/input.ts'
import { createInitialState, upsertRow } from '@dsh-cc/tui/store.ts'

/**
 * Plan C6 contract tests: the pure cycle index/walk rules (wrap-around,
 * index −1 → element 0 start rule, skip-with-toast on unresolvable or
 * unadvertised aliases, empty order inert) and the key-event → apply-call
 * sequence through handleComposerInput with a fake model seam.
 */

describe('nextCycleIndex', () => {
  it('wraps forward and backward', () => {
    expect(nextCycleIndex(3, 0, 1)).toBe(1)
    expect(nextCycleIndex(3, 2, 1)).toBe(0)
    expect(nextCycleIndex(3, 0, -1)).toBe(2)
  })

  it('lands index −1 + 1 on element 0 (the one start rule); backward follows pure mod', () => {
    expect(nextCycleIndex(3, -1, 1)).toBe(0)
    // One rule, no special cases: −1 ≡ length−1 (mod length), so backward
    // from −1 is the pure-mod predecessor of length−1.
    expect(nextCycleIndex(3, -1, -1)).toBe(1)
  })
})

describe('startIndexOf', () => {
  const resolve = (alias: string) =>
    alias === 'opus' ? { provider: 'a', model: 'opus-1' } : { provider: 'b', model: 'm' }

  it('finds the entry matching the live selection', () => {
    expect(startIndexOf(['sonnet', 'opus'], { provider: 'a', model: 'opus-1' }, resolve)).toBe(1)
  })

  it('returns −1 when the selection matches nothing (first forward step → element 0)', () => {
    expect(startIndexOf(['sonnet', 'opus'], { provider: 'z', model: 'z' }, resolve)).toBe(-1)
    expect(startIndexOf(['sonnet', 'opus'], undefined, resolve)).toBe(-1)
  })
})

describe('pickCycleTarget', () => {
  const order = ['one', 'two', 'three']
  const usable = (alias: string) =>
    alias === 'one' ? { provider: 'p', model: 'm1' }
      : alias === 'three' ? { provider: 'p', model: 'm3' }
      : undefined

  it('steps forward with wrap-around, recording skipped aliases', () => {
    const pick = pickCycleTarget(order, 0, 1, usable)
    expect(pick).toEqual({ index: 2, alias: 'three', route: { provider: 'p', model: 'm3' }, skipped: ['two'] })
  })

  it('steps backward and wraps', () => {
    const pick = pickCycleTarget(order, 2, -1, usable)
    expect(pick?.alias).toBe('one')
  })

  it('returns undefined when nothing in the order is usable', () => {
    expect(pickCycleTarget(order, 0, 1, () => undefined)).toBeUndefined()
  })

  it('is inert on an empty order', () => {
    expect(pickCycleTarget([], -1, 1, () => ({ provider: 'p', model: 'm' }))).toBeUndefined()
  })
})

/** Fake driver seam: real cycling logic, fake order/resolver/apply/catalog. */
function makeHarness(opts: {
  cycleOrder: string[]
  aliases: Record<string, CycleRoute | undefined>
  catalog: { provider: string; id: string }[]
  selection?: CycleRoute
}) {
  const applied: { provider: string; model: string }[] = []
  // A real TuiState so the toast rows flow through the status-row idiom; each
  // new distinct status text is recorded in order.
  const state = createInitialState()
  const rows: string[] = []
  const capture = (next: ReturnType<typeof createInitialState>): void => {
    const status = [...next.rows].reverse().find(row => row.kind === 'status')
    if (status !== undefined && status.text !== rows.at(-1)) rows.push(status.text)
  }
  const section = createModelCyclingSection({
    readCycleOrder: () => opts.cycleOrder,
    resolveAlias: (alias) => opts.aliases[alias],
    selection: { current: opts.selection },
    // Mirrors the real applyModelSwitch: writes the selection and emits the
    // status-row toast.
    applyModelSwitch: async (provider, model) => {
      applied.push({ provider, model })
      capture(upsertRow(state, { kind: 'status', text: `Model is now ${provider}/${model}.` }))
    },
    loadCatalog: async () => opts.catalog,
    emit: capture,
    state: () => state,
  })
  const driver = {
    state,
    cycleModel: (delta: -1 | 1) => section.cycleModel(delta),
  } as unknown as InputSink
  return { driver, applied, rows }
}

const settle = async (): Promise<void> => {
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
}

describe('cycleModel via handleComposerInput', () => {
  it('ctrl+p applies the first entry from the −1 start rule', async () => {
    const { driver, applied, rows } = makeHarness({
      cycleOrder: ['sonnet', 'opus'],
      aliases: { sonnet: { provider: 'a', model: 's1' }, opus: { provider: 'a', model: 'o1' } },
      catalog: [{ provider: 'a', id: 's1' }, { provider: 'a', id: 'o1' }],
    })
    expect(handleComposerInput(driver, '\x10')).toEqual({ kind: 'none' })
    await settle()
    expect(applied).toEqual([{ provider: 'a', model: 's1' }])
    expect(rows).toContain('Model is now a/s1.')
  })

  it('skips an unadvertised alias with a toast and lands on the next', async () => {
    const { driver, applied, rows } = makeHarness({
      cycleOrder: ['ghost', 'opus'],
      aliases: { ghost: { provider: 'a', model: 'gone' }, opus: { provider: 'a', model: 'o1' } },
      catalog: [{ provider: 'a', id: 'o1' }],
      selection: { provider: 'a', model: 's1' },
    })
    handleComposerInput(driver, '\x10')
    await settle()
    expect(applied).toEqual([{ provider: 'a', model: 'o1' }])
    expect(rows.some(text => text.includes('Skipped "ghost"'))).toBe(true)
  })

  it('falls through unchanged when the cycle order is empty', async () => {
    const { driver, applied, rows } = makeHarness({ cycleOrder: [], aliases: {}, catalog: [] })
    expect(handleComposerInput(driver, '\x10')).toEqual({ kind: 'none' })
    await settle()
    expect(applied).toEqual([])
    expect(rows).toEqual([])
  })
})
