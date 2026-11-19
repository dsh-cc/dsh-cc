import { describe, expect, it, vi } from 'vitest'
import { visibleWidth } from '@dsh-cc/pi-tui'
import { MAX_BAND_LINES, TuiBands } from '@dsh-cc/tui/bands.ts'

describe('TuiBands registry', () => {
  it('lists bands by order, ties in registration order', () => {
    const bands = new TuiBands()
    bands.register({ id: 'b', render: () => 'second' })
    bands.register({ id: 'a', order: -1, render: () => 'first' })
    bands.register({ id: 'c', render: () => 'third' })
    expect(bands.lines(80).map(l => l.text)).toEqual(['first', 'second', 'third'])
  })

  it('hides a band that returns nothing, and shows at most MAX_BAND_LINES lines per band', () => {
    const bands = new TuiBands()
    bands.register({ id: 'empty', render: () => undefined })
    bands.register({ id: 'blank', render: () => ['', ''] })
    bands.register({ id: 'many', render: () => ['1', '2', '3', '4'] })
    expect(bands.lines(80).map(l => l.text)).toEqual(['1', '2'])
    expect(MAX_BAND_LINES).toBe(2)
  })

  it('cuts every line to the width and flattens newlines', () => {
    const bands = new TuiBands()
    bands.register({ id: 'long', tone: 'muted', render: () => 'x'.repeat(200) })
    bands.register({ id: 'nl', render: () => 'a\nb\r\nc' })
    const [long, nl] = bands.lines(20)
    expect(visibleWidth(long!.text)).toBeLessThanOrEqual(20)
    expect(long!.tone).toBe('muted')
    expect(nl!.text).toBe('a b c')
    expect(bands.lines(0)).toEqual([{ id: 'long', tone: 'muted', text: '' }, { id: 'nl', tone: undefined, text: '' }])
  })

  it('passes the width and the current session to render', () => {
    const bands = new TuiBands()
    bands.register({ id: 'w', render: ({ width, sessionId }) => `w=${width} s=${sessionId ?? '-'}` })
    expect(bands.lines(42)[0]!.text).toBe('w=42 s=-')
    expect(bands.lines(42, 'session-7')[0]!.text).toBe('w=42 s=session-7')
  })

  it('skips a throwing band and reports it once until it recovers', () => {
    const onError = vi.fn()
    const bands = new TuiBands(onError)
    let fail = true
    bands.register({ id: 'flaky', render: () => { if (fail) throw new Error('boom'); return 'ok' } })
    bands.register({ id: 'steady', render: () => 'steady' })
    expect(bands.lines(80).map(l => l.text)).toEqual(['steady'])
    expect(bands.lines(80).map(l => l.text)).toEqual(['steady'])
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith('flaky', expect.any(Error))
    fail = false
    expect(bands.lines(80).map(l => l.text)).toEqual(['ok', 'steady'])
    fail = true
    bands.lines(80)
    expect(onError).toHaveBeenCalledTimes(2)
  })

  it('refuses duplicate ids and bad definitions', () => {
    const bands = new TuiBands()
    bands.register({ id: 'x', render: () => 'x' })
    expect(() => bands.register({ id: 'x', render: () => 'y' })).toThrow(/already registered/)
    expect(() => bands.register({ id: '', render: () => 'y' })).toThrow(/non-empty id/)
    expect(() => bands.register({ id: 'y' } as never)).toThrow(/render function/)
  })

  it('notifies subscribers on register, refresh and dispose; dispose is idempotent', () => {
    const bands = new TuiBands()
    const listener = vi.fn()
    const unsubscribe = bands.subscribe(listener)
    const dispose = bands.register({ id: 'x', render: () => 'x' })
    bands.refresh()
    dispose()
    dispose()
    expect(listener).toHaveBeenCalledTimes(3)
    expect(bands.size).toBe(0)
    // The id is free again after dispose; a stale disposer does not remove the new band.
    bands.register({ id: 'x', render: () => 'again' })
    dispose()
    expect(bands.lines(80).map(l => l.text)).toEqual(['again'])
    unsubscribe()
    bands.refresh()
    expect(listener).toHaveBeenCalledTimes(4)
  })
})
