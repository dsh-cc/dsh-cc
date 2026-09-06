import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Terminal as XtermTerminal } from '@xterm/headless'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal as PiTerminal } from '@dsh-cc/pi-tui'
import { TUI_KEYBINDINGS } from '@dsh-cc/pi-tui'
import type { Driver } from '@dsh-cc/tui/state/driver-types.ts'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'
import { buildRoot } from '@dsh-cc/tui/components/root.ts'
import { createInitialState, setBusy, type TuiState } from '@dsh-cc/tui/store.ts'

/**
 * Root-level Ctrl+B contract (plan §3.4): while busy, Ctrl+B promotes EVERY
 * armed foreground subagent collect of the session (via the driver →
 * root-realm `ccCollectorRegistry`) and echoes one status line; busy with
 * nothing promotable is a consumed no-op (never Esc); idle Ctrl+B falls
 * through to the editor's `tui.editor.cursorLeft` binding, unchanged; the
 * `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` kill switch disarms the driver's
 * promotion path entirely.
 */

/** Minimal pi-tui Terminal implementation piping writes into @xterm/headless. */
class VirtualTerminal implements PiTerminal {
  private readonly xterm: XtermTerminal
  private inputHandler?: (data: string) => void

  constructor(cols = 80, rows = 24) {
    this.xterm = new XtermTerminal({ cols, rows, allowProposedApi: true })
  }

  start(onInput: (data: string) => void): void {
    this.inputHandler = onInput
  }

  stop(): void {}

  async drainInput(): Promise<void> {}

  write(data: string): void {
    this.xterm.write(data)
  }

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

  /** Feed raw input as if the user pressed a key. */
  sendInput(data: string): void {
    this.inputHandler?.(data)
  }
}

interface PromoteDriver extends Driver {
  readonly notices: string[]
  readonly interrupts: number
  promoteCalls: number
}

/** Ctrl+B raw byte (the legacy ctrl+letter encoding, no kitty protocol). */
const CTRL_B = '\x02'

function fakeDriver(options: {
  initial?: TuiState
  promoted?: number
} = {}): PromoteDriver {
  let state = options.initial ?? createInitialState()
  const listeners = new Set<(s: TuiState) => void>()
  const notify = (): void => {
    for (const l of listeners) l(state)
  }
  const notices: string[] = []
  let interruptCount = 0
  let promoteCount = 0
  const driver: Driver = {
    get state() { return state },
    get statusLine() { return 'test · status' },
    statusLineIn: () => 'test · status',
    get cwd() { return process.cwd() },
    get promptHistory() { return [] },
    get bashHistory() { return [] },
    subscribe(listener: (s: TuiState) => void) {
      listeners.add(listener)
      listener(state)
      return () => { listeners.delete(listener) }
    },
    setDraft(draft: string) {
      state = { ...state, draft }
      notify()
    },
    submit() { return Promise.resolve() },
    interrupt() {
      interruptCount += 1
    },
    promoteForegroundCollects() {
      promoteCount += 1
      return options.promoted ?? 0
    },
    cyclePermissionMode: async () => {},
    toggleThinking() {},
    toggleGlobalCollapse() {},
    answerApproval() {},
    questionMove() {},
    questionToggle() {},
    questionPick() {},
    questionType() {},
    questionBackspace() {},
    questionSubmit() {},
    questionCancel() {},
    modelPickerMove() {},
    modelPickerSubmit() {},
    modelPickerCancel() {},
    toggleTodoPanel() {},
    todoPanelMove() {},
    todoPanelClose() {},
    usagePanelClose() {},
    showNotice(text: string) {
      notices.push(text)
    },
    markExitAttempt() {},
    steerQueued() {},
    recallQueued() { return undefined },
    async openModelPicker() {},
    async openEffortPicker() {},
    effortPickerMove() {},
    async effortPickerSubmit() {},
    effortPickerCancel() {},
    async openPermissionPicker() {},
    permissionPickerMove() {},
    async permissionPickerSubmit() {},
    permissionPickerCancel() {},
    async openSessionSwitcher() {},
    sessionSwitcherMove() {},
    sessionSwitcherType() {},
    sessionSwitcherBackspace() {},
    sessionSwitcherToggleScope() {},
    async sessionSwitcherSubmit() {},
    sessionSwitcherCancel() {},
    async switchSession() {},
    async listSessions() { return [] },
    listCommands() { return [] },
    async dispose() {},
  }
  return {
    ...driver,
    notices,
    get interrupts() { return interruptCount },
    get promoteCalls() { return promoteCount },
  } as PromoteDriver
}

async function settle(ms = 60): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('Ctrl+B promotion (root keybinding)', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-promote-key-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('busy + armed collectors: promotes all and echoes one status line (never Esc)', async () => {
    const vt = new VirtualTerminal()
    const driver = fakeDriver({ initial: setBusy(createInitialState(), true), promoted: 2 })
    const root = buildRoot(driver, { terminal: vt })
    root.tui.start()
    vt.sendInput(CTRL_B)
    await settle()
    expect(driver.promoteCalls).toBe(1)
    expect(driver.notices).toEqual(['Moved 2 subagent(s) to background — /agents to inspect'])
    expect(driver.interrupts).toBe(0)
    root.tui.stop()
    root.destroy()
  })

  it('busy + nothing promotable: consumed no-op (no notice, no interrupt)', async () => {
    const vt = new VirtualTerminal()
    const driver = fakeDriver({ initial: setBusy(createInitialState(), true), promoted: 0 })
    const root = buildRoot(driver, { terminal: vt })
    root.tui.start()
    vt.sendInput(CTRL_B)
    await settle()
    expect(driver.promoteCalls).toBe(1)
    expect(driver.notices).toEqual([])
    expect(driver.interrupts).toBe(0)
    root.tui.stop()
    root.destroy()
  })

  it('repeated Ctrl+B is idempotent: the second press finds nothing promotable', async () => {
    const vt = new VirtualTerminal()
    const driver = fakeDriver({ initial: setBusy(createInitialState(), true), promoted: 1 })
    const root = buildRoot(driver, { terminal: vt })
    root.tui.start()
    vt.sendInput(CTRL_B)
    await settle()
    expect(driver.notices).toEqual(['Moved 1 subagent(s) to background — /agents to inspect'])
    // The registry emptied after the first promotion: the second press is a
    // consumed no-op (the fake models the drained registry).
    driver.promoteForegroundCollects = () => 0
    vt.sendInput(CTRL_B)
    await settle()
    expect(driver.notices).toEqual(['Moved 1 subagent(s) to background — /agents to inspect'])
    expect(driver.interrupts).toBe(0)
    root.tui.stop()
    root.destroy()
  })

  it('idle Ctrl+B is untouched: falls through to the editor (no promotion, no notice)', async () => {
    const vt = new VirtualTerminal()
    const driver = fakeDriver()
    const root = buildRoot(driver, { terminal: vt })
    root.tui.start()
    vt.sendInput(CTRL_B)
    await settle()
    expect(driver.promoteCalls).toBe(0)
    expect(driver.notices).toEqual([])
    expect(driver.interrupts).toBe(0)
    root.tui.stop()
    root.destroy()
  })

  it('does not regress the idle cursorLeft keybinding: ctrl+b stays a default of tui.editor.cursorLeft', () => {
    expect(TUI_KEYBINDINGS['tui.editor.cursorLeft'].defaultKeys).toContain('ctrl+b')
  })
})

describe('driver promotion gate (ccCollectorRegistry + env kill switch)', () => {
  let prevEnv: string | undefined

  beforeEach(() => {
    prevEnv = process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS
  })

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS
    else process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = prevEnv
  })

  function makeCtx(): { ctx: Record<string, unknown>; promoted: string[] } {
    const promoted: string[] = []
    const ctx: Record<string, unknown> = {
      get(key: string) {
        if (key === 'agentPresets') {
          return {
            defaultId: 'cc',
            resolve: async () => ({ id: 'cc' }),
            mount: async () => ({ id: 'cc' }),
          }
        }
        if (key === 'ccCollectorRegistry') {
          return {
            collectorsForSession: (parentSessionId: string) => [
              { childId: 'c-1', promote: () => { promoted.push(parentSessionId) } },
              { childId: 'c-2', promote: () => { promoted.push(parentSessionId) } },
            ],
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
    return { ctx, promoted }
  }

  it('promotes every armed collector of the CURRENT session', async () => {
    const { ctx, promoted } = makeCtx()
    const driver = await createDriver(ctx as never)
    expect(driver.promoteForegroundCollects?.()).toBe(2)
    expect(promoted).toEqual(['s-a', 's-a'])
    await driver.dispose()
  })

  it('env kill switch armed → Ctrl+B no-op (0, nothing promoted)', async () => {
    process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1'
    const { ctx, promoted } = makeCtx()
    const driver = await createDriver(ctx as never)
    expect(driver.promoteForegroundCollects?.()).toBe(0)
    expect(promoted).toEqual([])
    await driver.dispose()
  })

  it('no registry published → 0 (nothing promotable)', async () => {
    const { ctx, promoted } = makeCtx()
    delete (ctx as Record<string, unknown>).get// registry absent: get returns undefined
    ;(ctx as Record<string, unknown>).get = (key: string) => {
      if (key === 'agentPresets') {
        return {
          defaultId: 'cc',
          resolve: async () => ({ id: 'cc' }),
          mount: async () => ({ id: 'cc' }),
        }
      }
      return undefined
    }
    const driver = await createDriver(ctx as never)
    expect(driver.promoteForegroundCollects?.()).toBe(0)
    expect(promoted).toEqual([])
    await driver.dispose()
  })
})
