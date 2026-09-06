import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Terminal as XtermTerminal } from '@xterm/headless'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal as PiTerminal } from '@dsh-cc/pi-tui'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'
import { buildRoot } from '@dsh-cc/tui/components/root.ts'

/**
 * Zero-polling proof, whitelist edition: the HUD/todo strip/statusline are
 * fully event-driven. Spying on globalThis.setInterval while a real driver
 * (on a fake ctx) plus the full pi-tui root render through a virtual
 * terminal, every interval whose SOURCE FRAME lands in packages/ui/tui/src/**
 * is a violation — except components/working-line.ts, the single exempt file
 * (the live working line owns the one legitimate interval; any new exemption
 * must edit this test first, which is the review gate). After dispose, no
 * interval created by ANY module may dangle.
 */

/** Minimal pi-tui Terminal double piped into @xterm/headless (no timers). */
class VirtualTerminal implements PiTerminal {
  private readonly xterm: XtermTerminal

  constructor(cols = 80, rows = 24) {
    this.xterm = new XtermTerminal({ cols, rows, allowProposedApi: true })
  }

  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void { this.xterm.write(data) }
  get columns(): number { return 80 }
  get rows(): number { return 24 }
  get kittyProtocolActive(): boolean { return false }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

type IntervalId = ReturnType<typeof setInterval>

/** Fake ctx: sessionProjections feed drivable by hand, everything else absent. */
function makeCtx() {
  const listeners = new Set<(session: { id: string }, key: string, value: unknown, seq: number) => void>()
  const states: Record<string, Record<string, unknown>> = { 's-a': {} }
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
          onChanged(listener: (session: { id: string }, key: string, value: unknown, seq: number) => void) {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
          },
          stateOf(session: { id: string }, key: string) {
            return states[session.id]?.[key]
          },
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

/** Stack frames from our package carry this path (tsconfig path mapping). */
const OUR_SRC = /packages[/\\]ui[/\\]tui[/\\]src[/\\]/

/** The single interval exemption: the working line component's own tick loop. */
const WHITELIST = /packages[/\\]ui[/\\]tui[/\\]src[/\\]components[/\\]working-line\.ts/

/** This spec file hosts the setInterval spy itself — its frames must not win attribution. */
const SELF = /no-polling\.spec\.ts/

/**
 * Source-frame attribution: the first stack frame whose path lives inside the
 * monorepo `packages/` tree — skipping this spec file's own frames (the spy
 * wrapper sits above the true creator on every captured stack, so it must be
 * excluded or it would mask every origin). Callback frames are newer than
 * node:internal frames, so an interval booked from a timer/promise callback
 * inside tui/src still attributes correctly. `undefined` = no `packages/`
 * frame at all → external (anonymous/translated frames are never mistaken
 * for our code).
 */
function originOf(stack: string): string | undefined {
  for (const line of stack.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('at ')) continue
    // Frame location = the last token, unwrapped from its parentheses
    // (`at fn (path:1:2)` → `path:1:2`; bare ESM `at path:1:2` stays as-is).
    const last = trimmed.split(/\s+/).at(-1) ?? ''
    const location = last.replace(/^\(/, '').replace(/\)$/, '')
    if (SELF.test(location)) continue
    if (/packages[/\\]/.test(location)) return location
  }
  return undefined
}

describe('zero-polling driver + root', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-no-polling-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('creates no polling interval for the HUD and leaves no dangling timers after dispose', async () => {
    const created: Array<{ id: IntervalId; stack: string }> = []
    const cleared = new Set<IntervalId>()

    const realSetInterval = globalThis.setInterval.bind(globalThis)
    const intervalSpy = vi.spyOn(globalThis, 'setInterval')
    // No call site in this stack passes interval args beyond (handler, ms),
    // so the double keeps the two-arg shape.
    intervalSpy.mockImplementation(((handler: TimerHandler, timeout?: number) => {
      const id = realSetInterval(handler, timeout)
      created.push({ id, stack: new Error('interval origin').stack ?? '' })
      return id
    }) as unknown as typeof setInterval)

    const realClearInterval = globalThis.clearInterval.bind(globalThis)
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')
    clearSpy.mockImplementation(((id: IntervalId | undefined) => {
      if (id !== undefined) cleared.add(id)
      return realClearInterval(id)
    }) as typeof clearInterval)

    try {
      const { ctx, fire } = makeCtx()
      const driver = await createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })
      const root = buildRoot(driver, { terminal: new VirtualTerminal(), onQuit: () => {} })
      root.tui.start()

      // Drive the event-driven surfaces: projection feeds + a re-render emit.
      fire('tokenUsage', { totals: { uncachedInputTokens: 100, outputTokens: 20 }, last: null })
      fire('contextPressure', { contextWindow: 1000, pressureTokens: 250, surfaceTokens: 0, sampledSurfaceTokens: 0 })
      fire('todos', [{ content: 'prove zero polling', status: 'in_progress' }])
      driver.setDraft('typed while "polling" would have happened')
      // A plain prompt (NOT a slash command — the slash path never anchors a
      // turn, so the whitelist would go unexercised) drives the turn anchor:
      // the working line really starts and books its interval.
      await driver.submit('a plain prompt')
      // Let the throttled render + any latent async settle.
      await new Promise(resolve => setTimeout(resolve, 120))

      // The driver booted and the emits landed — the test is not vacuous.
      expect(driver.state.hud?.tokens).toEqual({ input: 100, output: 20 })
      expect(driver.state.todos).toEqual([{ content: 'prove zero polling', status: 'in_progress' }])

      // Tear down the full stack.
      root.tui.stop()
      root.destroy()
      await driver.dispose()
      await new Promise(resolve => setTimeout(resolve, 120))

      // 1) Source-frame attribution + single-file whitelist: a violation is
      //    an interval whose origin frame is inside tui/src and is NOT the
      //    exempt components/working-line.ts. Intervals created by pi-tui or
      //    anything else outside tui/src are fine — see assertion 2.
      const violations = created.filter(record => {
        const origin = originOf(record.stack)
        return origin !== undefined && OUR_SRC.test(origin) && !WHITELIST.test(origin)
      })
      expect(violations).toEqual([])

      // The whitelist is not vacuous: the plain-prompt submit anchored a
      // turn, the working line started, and its interval attributes to the
      // exempt file.
      const whitelisted = created.filter(record => {
        const origin = originOf(record.stack)
        return origin !== undefined && WHITELIST.test(origin)
      })
      expect(whitelisted.length).toBeGreaterThan(0)

      // 2) No dangling timers: every interval created by ANY module during
      //    the run (pi-tui and the whitelisted working line included) is
      //    cleared by dispose/destroy.
      const dangling = created.filter(record => !cleared.has(record.id))
      expect(dangling).toEqual([])
    } finally {
      intervalSpy.mockRestore()
      clearSpy.mockRestore()
      // Defensive: clear anything a failing assertion left behind.
      for (const record of created) {
        if (!cleared.has(record.id)) realClearInterval(record.id)
      }
    }
  })
})
