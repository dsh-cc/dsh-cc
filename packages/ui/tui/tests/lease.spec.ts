import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acquireTerminal,
  activeLease,
  resetTerminalForTests,
  TerminalLeaseError,
} from '@dsh-cc/tui/terminal/lease.ts'

afterEach(() => {
  resetTerminalForTests()
})

describe('acquireTerminal release sequence', () => {
  it('writes mouse/paste/cursor resets without leaving the alt screen by default', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write')
    const lease = acquireTerminal()
    writeSpy.mockClear()
    lease.release()
    const written = writeSpy.mock.calls.map(c => c[0]).join('')
    expect(written).toContain('\x1b[?1000l')
    expect(written).toContain('\x1b[?2004l')
    expect(written).toContain('\x1b[?25h')
    expect(written).not.toContain('\x1b[?1049l')
    writeSpy.mockRestore()
  })

  it('also leaves the alternate screen when fullscreen', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write')
    const lease = acquireTerminal({ fullscreen: true })
    writeSpy.mockClear()
    lease.release()
    const written = writeSpy.mock.calls.map(c => c[0]).join('')
    expect(written).toContain('\x1b[?1049l')
    writeSpy.mockRestore()
  })
})

describe('acquireTerminal lease lifecycle', () => {
  it('release is idempotent', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write')
    const lease = acquireTerminal()
    lease.release()
    const writesAfterRelease = writeSpy.mock.calls.length
    lease.release()
    expect(writeSpy.mock.calls.length).toBe(writesAfterRelease)
    writeSpy.mockRestore()
  })

  it('arms exit/SIGINT/SIGTERM handlers and removes them on release', () => {
    const on = vi.spyOn(process, 'on')
    const off = vi.spyOn(process, 'off')
    const lease = acquireTerminal()
    const armed = on.mock.calls.map(c => c[0])
    expect(armed).toEqual(expect.arrayContaining(['exit', 'SIGINT', 'SIGTERM']))
    lease.release()
    const removed = off.mock.calls.map(c => c[0])
    expect(removed).toEqual(expect.arrayContaining(['exit', 'SIGINT', 'SIGTERM']))
    on.mockRestore()
    off.mockRestore()
  })

  it('throws TerminalLeaseError on double acquire', () => {
    const first = acquireTerminal()
    expect(activeLease()).toBe(first)
    expect(() => acquireTerminal()).toThrow(TerminalLeaseError)
    expect(() => acquireTerminal()).toThrow(/already held/)
    first.release()
  })

  it('can re-acquire after release', () => {
    const first = acquireTerminal()
    first.release()
    const second = acquireTerminal()
    expect(second).not.toBe(first)
    expect(activeLease()).toBe(second)
    second.release()
  })
})

describe('acquireTerminal signal handling', () => {
  it('fires onSignal once with the signal name and releases', () => {
    const onSignal = vi.fn()
    const on = vi.spyOn(process, 'on')
    const off = vi.spyOn(process, 'off')
    const lease = acquireTerminal({ onSignal })
    const sigintCall = on.mock.calls.find(c => c[0] === 'SIGINT')
    expect(sigintCall).toBeDefined()
    const handler = sigintCall![1] as (signal: NodeJS.Signals) => void
    handler('SIGINT')
    expect(onSignal).toHaveBeenCalledTimes(1)
    expect(onSignal).toHaveBeenCalledWith('SIGINT')
    expect(activeLease()).toBeUndefined()
    const removed = off.mock.calls.map(c => c[0])
    expect(removed).toEqual(expect.arrayContaining(['exit', 'SIGINT', 'SIGTERM']))
    on.mockRestore()
    off.mockRestore()
    lease.release()
  })
})

describe('acquireTerminal raw mode', () => {
  type StdinLike = {
    isTTY?: boolean
    setRawMode?: (mode: boolean) => void
  }

  it('enables raw mode when stdin is a TTY and disables on release', () => {
    const stdin = process.stdin as unknown as StdinLike
    const wasTty = stdin.isTTY
    const hadSetRaw = typeof stdin.setRawMode === 'function'
    const originalSetRaw = stdin.setRawMode
    const setRawSpy = vi.fn<(mode: boolean) => void>()
    stdin.isTTY = true
    stdin.setRawMode = setRawSpy
    try {
      const lease = acquireTerminal()
      expect(setRawSpy).toHaveBeenCalledWith(true)
      lease.release()
      expect(setRawSpy).toHaveBeenCalledWith(false)
    } finally {
      if (wasTty === undefined) delete stdin.isTTY
      else stdin.isTTY = wasTty
      if (hadSetRaw && originalSetRaw !== undefined) stdin.setRawMode = originalSetRaw
      else delete stdin.setRawMode
    }
  })

  it('does not touch raw mode when stdin is not a TTY', () => {
    const stdin = process.stdin as unknown as StdinLike
    const wasTty = stdin.isTTY
    const hadSetRaw = typeof stdin.setRawMode === 'function'
    const originalSetRaw = stdin.setRawMode
    const setRawSpy = vi.fn<(mode: boolean) => void>()
    stdin.isTTY = false
    stdin.setRawMode = setRawSpy
    try {
      const lease = acquireTerminal()
      expect(setRawSpy).not.toHaveBeenCalled()
      lease.release()
      expect(setRawSpy).not.toHaveBeenCalled()
    } finally {
      if (wasTty === undefined) delete stdin.isTTY
      else stdin.isTTY = wasTty
      if (hadSetRaw && originalSetRaw !== undefined) stdin.setRawMode = originalSetRaw
      else delete stdin.setRawMode
    }
  })
})
