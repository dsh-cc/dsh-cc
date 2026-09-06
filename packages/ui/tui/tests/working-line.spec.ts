import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkingLine } from '@dsh-cc/tui/components/working-line.ts'
import { formatElapsed, formatWorkingLine, VERBS, type TurnAnchor } from '@dsh-cc/tui/working-line.ts'

/** Identity styler — keeps the rendered text plain for string assertions. */
const identity = (text: string): string => text

/** Render the component at a fixed width and join the lines for matching. */
const rendered = (line: WorkingLine): string => line.render(80).join('')

function anchor(overrides: Partial<TurnAnchor> = {}): TurnAnchor {
  return { startedAt: 0, outputBase: undefined, verbIndex: 0, ...overrides }
}

describe('formatElapsed', () => {
  it('shows bare seconds under a minute', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(5_000)).toBe('5s')
    expect(formatElapsed(59_000)).toBe('59s')
  })

  it('shows minutes and seconds under an hour', () => {
    expect(formatElapsed(60_000)).toBe('1m 0s')
    expect(formatElapsed(263_000)).toBe('4m 23s')
    expect(formatElapsed(3_599_000)).toBe('59m 59s')
  })

  it('shows hours and minutes beyond an hour', () => {
    expect(formatElapsed(3_600_000)).toBe('1h 0m')
    expect(formatElapsed(3_900_000)).toBe('1h 5m')
  })

  it('clamps negative inputs to 0s (clock skew stays calm)', () => {
    expect(formatElapsed(-1)).toBe('0s')
    expect(formatElapsed(-60_000)).toBe('0s')
  })
})

describe('formatWorkingLine', () => {
  it('omits the token segment while the baseline is unseeded', () => {
    expect(formatWorkingLine(anchor(), 5_000, 5_000)).toBe('Thinking… (5s)')
  })

  it('omits the token segment while the delta is not positive', () => {
    // Zero delta — no `↓ 0 tokens` flicker at turn start.
    expect(formatWorkingLine(anchor({ verbIndex: 1, outputBase: 100 }), 100, 2_000)).toBe('Galloping… (2s)')
    // Negative delta (never expected, but must not render either).
    expect(formatWorkingLine(anchor({ verbIndex: 1, outputBase: 100 }), 50, 2_000)).toBe('Galloping… (2s)')
  })

  it('renders the output-token delta once positive', () => {
    expect(formatWorkingLine(anchor({ verbIndex: 1, outputBase: 100 }), 5_900, 263_000))
      .toBe('Galloping… (4m 23s · ↓ 5.8k tokens)')
  })

  it('counts elapsed from stepStartedAt when set (current step, not the whole turn)', () => {
    // Turn started at t0, the step clock reset at t0+5s, now is t0+7s → 2s.
    expect(formatWorkingLine(anchor({ stepStartedAt: 5_000 }), 0, 7_000)).toBe('Thinking… (2s)')
    // Without a step clock the elapsed time falls back to startedAt.
    expect(formatWorkingLine(anchor(), 0, 7_000)).toBe('Thinking… (7s)')
  })

  it('derives the verb deterministically from verbIndex', () => {
    const turn = anchor({ startedAt: 12_345, verbIndex: 12_345 % VERBS.length })
    const expected = `${VERBS[12_345 % VERBS.length]}… (0s)`
    expect(formatWorkingLine(turn, 0, 0)).toBe(expected)
    // The same anchor always yields the same line (snapshot-stable).
    expect(formatWorkingLine(turn, 0, 0)).toBe(formatWorkingLine({ ...turn }, 0, 0))
  })
})

describe('WorkingLine component', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not start on construction (idle = zero timers, zero lines)', () => {
    const line = new WorkingLine(identity, identity, () => 'forging', () => {})
    expect(vi.getTimerCount()).toBe(0)
    expect(rendered(line)).toBe('')
  })

  it('ticks the first frame synchronously on start, then advances with time', () => {
    const onDirty = vi.fn()
    const line = new WorkingLine(identity, identity, () => 'forging', onDirty)

    line.start()
    // First render shows frame 0 without waiting a tick interval.
    expect(rendered(line)).toContain('⠋ forging')
    expect(onDirty).toHaveBeenCalled()

    vi.advanceTimersByTime(80)
    expect(rendered(line)).toContain('⠙ forging')

    vi.advanceTimersByTime(80)
    expect(rendered(line)).toContain('⠹ forging')

    // After a full pass the frames wrap back to the start.
    vi.advanceTimersByTime(80 * 7)
    expect(rendered(line)).toContain('⠏ forging')
    vi.advanceTimersByTime(80)
    expect(rendered(line)).toContain('⠋ forging')

    line.stop()
  })

  it('start is idempotent — a double start leaves exactly one interval', () => {
    const line = new WorkingLine(identity, identity, () => 'forging', () => {})
    line.start()
    line.start()
    expect(vi.getTimerCount()).toBe(1)
    line.stop()
  })

  it('stop clears the interval and blanks the text (zero-height collapse)', () => {
    const onDirty = vi.fn()
    const line = new WorkingLine(identity, identity, () => 'forging', onDirty)
    line.start()
    expect(vi.getTimerCount()).toBe(1)
    expect(rendered(line)).not.toBe('')

    line.stop()
    expect(vi.getTimerCount()).toBe(0)
    // The text is explicitly blanked, and an empty Text renders zero lines.
    expect(rendered(line)).toBe('')
    expect(line.render(80)).toEqual([])
    expect(onDirty).toHaveBeenCalled()
  })

  it('keeps ticking but renders zero lines while the message is empty', () => {
    const line = new WorkingLine(identity, identity, () => '', () => {})
    line.start()
    expect(vi.getTimerCount()).toBe(1)
    expect(line.render(80)).toEqual([])

    // Frames keep advancing behind the blank text; nothing appears.
    vi.advanceTimersByTime(80)
    expect(line.render(80)).toEqual([])

    line.stop()
  })
})
