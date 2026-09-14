import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatExitTip, printExitTip } from '@dsh-cc/tui/exit-tip.ts'

describe('formatExitTip', () => {
  it('emits exactly two lines: session id, then resume command', () => {
    const lines = formatExitTip('tui-abc-123', 'dsh-cc')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('\x1b[2mSession saved: tui-abc-123\x1b[0m')
    expect(lines[1]).toBe(
      '\x1b[2mResume with:   dsh-cc --resume tui-abc-123    (or: dsh-cc -c for latest)\x1b[0m',
    )
  })

  it('closes every line with a reset SGR', () => {
    for (const line of formatExitTip('tui-x', 'dsh')) {
      expect(line.endsWith('\x1b[0m')).toBe(true)
    }
  })

  it('uses the given binName, never a hardcoded claude-style name', () => {
    const [, second] = formatExitTip('tui-x', 'dsh')
    expect(second).toContain('dsh --resume tui-x')
    expect(second).not.toContain('claude')
  })
})

describe('printExitTip', () => {
  let writes: string[]
  let writeSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    writes = []
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk))
      return true
    })
  })

  afterEach(() => {
    writeSpy.mockRestore()
    delete process.env.DSH_CC_DISABLE_EXIT_TIP
  })

  it('writes both lines to stdout', () => {
    printExitTip({ sessionId: 'tui-abc' })
    expect(writes).toHaveLength(2)
    expect(writes[0]).toContain('Session saved: tui-abc')
  })

  it('no-ops without a sessionId', () => {
    printExitTip({})
    expect(writes).toHaveLength(0)
  })

  it('no-ops when the kill switch env is set', () => {
    process.env.DSH_CC_DISABLE_EXIT_TIP = '1'
    printExitTip({ sessionId: 'tui-abc' })
    expect(writes).toHaveLength(0)
  })

  it('swallows an EPIPE throw from stdout so the exit code survives', () => {
    writeSpy.mockImplementation(() => {
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    })
    expect(() => printExitTip({ sessionId: 'tui-abc' })).not.toThrow()
  })

  it('derives the bin name from process.argv[1] and falls back to dsh-cc', () => {
    printExitTip({ sessionId: 'tui-abc' })
    expect(writes[1]).toContain(`${process.argv[1]?.split('/').pop() || 'dsh-cc'} --resume tui-abc`)
  })
})

describe('ordering (shutdown contract)', () => {
  it('the tip still prints after a throwing stopForExit', () => {
    const order: string[] = []
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      order.push(`write:${String(chunk).trim()}`)
      return true
    })
    // Mirrors plugin.ts shutdown(): stopForExit throws, tip still prints after.
    const fakeRoot = {
      stopForExit: () => {
        order.push('stopForExit')
        throw new Error('teardown boom')
      },
    }
    try {
      try {
        fakeRoot.stopForExit()
      } catch {
        // best-effort, same as shutdown()
      }
      printExitTip({ sessionId: 'tui-abc' })
    } finally {
      writeSpy.mockRestore()
    }
    expect(order.filter((e) => e === 'stopForExit')).toHaveLength(1)
    expect(order.some((e) => e.includes('Session saved: tui-abc'))).toBe(true)
    expect(order.indexOf('stopForExit')).toBeLessThan(order.findIndex((e) => e.includes('Session saved')))
  })
})
