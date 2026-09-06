import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatModeLine, formatStatusLine, formatTokens } from '@dsh-cc/tui/statusline.ts'

describe('formatModeLine', () => {
  it('joins the mode and the shared key hints', () => {
    expect(formatModeLine('default')).toBe('default · shift+tab · /quit')
    expect(formatModeLine('acceptEdits')).toBe('acceptEdits · shift+tab · /quit')
    expect(formatModeLine('plan')).toBe('plan · shift+tab · /quit')
  })

  it('shares the hint tail with formatStatusLine so the formats cannot drift', () => {
    const line = formatStatusLine({
      cwd: '/tmp',
      sessionId: 'x',
      permissionMode: 'default',
      busy: false,
    })
    expect(line.endsWith(formatModeLine('default'))).toBe(true)
  })
})

describe('formatStatusLine', () => {
  it('joins cwd, short session id, mode, and model', () => {
    const cwd = join(homedir(), 'proj')
    expect(formatStatusLine({
      cwd,
      sessionId: 'tui-56b37bee-41fd-4feb-b270-5988abcd',
      permissionMode: 'acceptEdits',
      model: 'deepseek-v4-flash',
      busy: false,
    })).toBe('~/proj · tui-56b37bee · acceptEdits · deepseek-v4-flash · shift+tab · /quit')
  })

  it('shows a working marker while the agent is busy', () => {
    const line = formatStatusLine({
      cwd: '/tmp/work',
      sessionId: 'abc',
      permissionMode: 'default',
      busy: true,
    })
    expect(line).toContain('working')
    expect(line).toContain('default')
  })

  it('omits absent optional fields', () => {
    expect(formatStatusLine({
      cwd: '/tmp',
      sessionId: 'x',
      permissionMode: 'plan',
      busy: false,
    })).toBe('/tmp · x · plan · shift+tab · /quit')
  })

  it('renders the git branch bracketed right after cwd', () => {
    expect(formatStatusLine({
      cwd: '/tmp',
      sessionId: 'x',
      permissionMode: 'default',
      branch: 'feat/tui-profile',
      busy: false,
    })).toBe('/tmp [feat/tui-profile] · x · default · shift+tab · /quit')
  })

  it('renders effort as its own segment right after the model', () => {
    expect(formatStatusLine({
      cwd: '/tmp',
      sessionId: 'x',
      permissionMode: 'default',
      model: 'm1',
      effort: 'high',
      busy: false,
    })).toBe('/tmp · x · default · m1 · effort: high · shift+tab · /quit')
  })

  it('omits the effort segment when unset or empty', () => {
    expect(formatStatusLine({
      cwd: '/tmp',
      sessionId: 'x',
      permissionMode: 'default',
      model: 'm1',
      busy: false,
    })).toBe('/tmp · x · default · m1 · shift+tab · /quit')
    expect(formatStatusLine({
      cwd: '/tmp',
      sessionId: 'x',
      permissionMode: 'default',
      model: 'm1',
      effort: '',
      busy: false,
    })).toBe('/tmp · x · default · m1 · shift+tab · /quit')
  })

  it('renders context percent between model and tokens', () => {
    expect(formatStatusLine({
      cwd: '/tmp',
      sessionId: 'x',
      permissionMode: 'default',
      model: 'm1',
      contextPercent: 42,
      busy: false,
    })).toBe('/tmp · x · default · m1 · ctx 42% · shift+tab · /quit')
  })

  it('rounds a fractional context percent to an integer', () => {
    const line = formatStatusLine({
      cwd: '/tmp',
      sessionId: 'x',
      permissionMode: 'default',
      contextPercent: 41.5,
      busy: false,
    })
    expect(line).toContain('ctx 42%')
    expect(formatStatusLine({
      cwd: '/tmp',
      sessionId: 'x',
      permissionMode: 'default',
      contextPercent: 41.4,
      busy: false,
    })).toContain('ctx 41%')
  })

  it('appends the exact token detail when the context window is known', () => {
    expect(formatStatusLine({
      cwd: '/tmp',
      sessionId: 'x',
      permissionMode: 'default',
      contextPercent: 43,
      contextTokens: { used: 86_000, window: 200_000 },
      busy: false,
    })).toBe('/tmp · x · default · ctx 43% (86k/200k) · shift+tab · /quit')
  })

  it('keeps the bare percent when the context window is unknown', () => {
    const base = {
      cwd: '/tmp',
      sessionId: 'x',
      permissionMode: 'default',
      contextPercent: 43,
      busy: false,
    }
    // Raw tokens without a window: the parenthetical detail cannot be formed.
    expect(formatStatusLine({ ...base, contextTokens: { used: 86_000 } }))
      .toBe('/tmp · x · default · ctx 43% · shift+tab · /quit')
    // No raw tokens at all: unchanged either.
    expect(formatStatusLine(base)).toBe('/tmp · x · default · ctx 43% · shift+tab · /quit')
  })

  it('drops the parenthetical detail on narrow terminals but keeps the percent', () => {
    const input = {
      cwd: '/tmp',
      sessionId: 'x',
      permissionMode: 'default',
      contextPercent: 43,
      contextTokens: { used: 86_000, window: 200_000 },
      busy: false,
    }
    const full = formatStatusLine(input)
    const narrow = formatStatusLine(input, { width: 30 })
    expect(full).toBe('/tmp · x · default · ctx 43% (86k/200k) · shift+tab · /quit')
    expect(narrow).toBe('/tmp · x · default · ctx 43% · shift+tab · /quit')
    // No width hint: the detail survives.
    expect(formatStatusLine(input, {})).toBe(full)
    // Detail already absent: a narrow width changes nothing.
    expect(formatStatusLine({ ...input, contextTokens: undefined }, { width: 10 }))
      .toBe('/tmp · x · default · ctx 43% · shift+tab · /quit')
  })

  it('renders compact token totals with arrows', () => {
    expect(formatStatusLine({
      cwd: '/tmp',
      sessionId: 'x',
      permissionMode: 'default',
      tokens: { input: 12_349, output: 345 },
      busy: false,
    })).toBe('/tmp · x · default · ↑12.3k ↓345 tok · shift+tab · /quit')
  })

  it('renders the full v2 layout with every segment present', () => {
    const cwd = join(homedir(), 'proj')
    expect(formatStatusLine({
      cwd,
      sessionId: 'tui-56b37bee-41fd-4feb-b270-5988abcd',
      permissionMode: 'acceptEdits',
      model: 'deepseek-v4-flash',
      branch: 'main',
      contextPercent: 7,
      tokens: { input: 1000, output: 2500 },
      busy: true,
    })).toBe(
      '~/proj [main] · tui-56b37bee · acceptEdits · deepseek-v4-flash'
      + ' · ctx 7% · ↑1k ↓2.5k tok · working · shift+tab · /quit',
    )
  })
})

describe('formatTokens', () => {
  it('renders small counts exactly', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(7)).toBe('7')
    expect(formatTokens(999)).toBe('999')
  })

  it('renders thousands with one decimal below 100k and integers above', () => {
    expect(formatTokens(1000)).toBe('1k')
    expect(formatTokens(1234)).toBe('1.2k')
    expect(formatTokens(12_349)).toBe('12.3k')
    expect(formatTokens(99_999)).toBe('100k')
    expect(formatTokens(123_456)).toBe('123k')
  })

  it('renders millions compactly', () => {
    expect(formatTokens(1_234_567)).toBe('1.2m')
    expect(formatTokens(12_345_678)).toBe('12.3m')
    expect(formatTokens(123_456_789)).toBe('123m')
  })

  it('clamps invalid input to 0', () => {
    expect(formatTokens(-5)).toBe('0')
    expect(formatTokens(Number.NaN)).toBe('0')
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('0')
  })
})
