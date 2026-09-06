import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Terminal as XtermTerminal } from '@xterm/headless'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal as PiTerminal } from '@dsh-cc/pi-tui'
import type { Driver } from '@dsh-cc/tui/state/driver-types.ts'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'
import { buildRoot } from '@dsh-cc/tui/components/root.ts'
import { createInitialState, setBusy, type TuiState } from '@dsh-cc/tui/store.ts'

/**
 * Root-level contract for the `!` bash mode: typing `!` on an empty composer
 * flips the editor border to the warning role, Esc exits the mode BEFORE the
 * generic busy-interrupt branch, ↑/↓ browse a bash-only history (never the
 * composer prompt stack), the composer is disabled while a command runs, and
 * a `!`-prefixed line reaches the driver verbatim (paste normalization is the
 * driver's submit-level check).
 */

/** Minimal pi-tui Terminal implementation piping writes into @xterm/headless. */
class VirtualTerminal implements PiTerminal {
  private readonly xterm: XtermTerminal
  private inputHandler?: (data: string) => void
  private readonly _cols: number
  private readonly _rows: number

  constructor(cols = 80, rows = 24) {
    this._cols = cols
    this._rows = rows
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

  get columns(): number { return this._cols }
  get rows(): number { return this._rows }
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

  /** Full visible grid as trimmed strings (SGR stripped by the cell model). */
  grid(): string[] {
    const lines: string[] = []
    for (let i = 0; i < this._rows; i++) {
      const base = this.xterm.buffer.active.baseY
      lines.push(this.xterm.buffer.active.getLine(base + i)?.translateToString(true) ?? '')
    }
    return lines
  }
}

interface BashDriver extends Driver {
  readonly submitted: string[]
  readonly interrupts: number
  releaseSubmit(): void
}

/**
 * Driver fake with a bash history, an interrupt spy, and a controllable
 * submit — with `holdSubmit` the returned promise stays pending until
 * {@link BashDriver.releaseSubmit}, simulating a long-running command.
 */
function fakeDriver(options: {
  initial?: TuiState
  bashHistory?: string[]
  promptHistory?: string[]
  holdSubmit?: boolean
} = {}): BashDriver {
  let state = options.initial ?? createInitialState()
  const listeners = new Set<(s: TuiState) => void>()
  const notify = (): void => {
    for (const l of listeners) l(state)
  }
  const submitted: string[] = []
  let interruptCount = 0
  let release: (() => void) | undefined
  const driver: Driver = {
    get state() { return state },
    get statusLine() { return 'test · status' },
    statusLineIn: () => 'test · status',
    get cwd() { return process.cwd() },
    get promptHistory() { return options.promptHistory ?? [] },
    get bashHistory() { return options.bashHistory ?? [] },
    subscribe(listener: (s: TuiState) => void) {
      listeners.add(listener)
      listener(state)
      return () => { listeners.delete(listener) }
    },
    setDraft(draft: string) {
      state = { ...state, draft }
      notify()
    },
    submit(text?: string) {
      submitted.push(text ?? state.draft)
      if (options.holdSubmit !== true) return Promise.resolve()
      return new Promise<void>(resolve => { release = resolve })
    },
    interrupt() {
      interruptCount += 1
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
    showNotice() {},
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
    submitted,
    get interrupts() { return interruptCount },
    releaseSubmit() {
      release?.()
      release = undefined
    },
  } as BashDriver
}

/** Wait for the throttled async render to settle. */
async function settle(ms = 80): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('`!` bash mode (root)', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-bash-mode-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('typing ! on an empty composer switches the border to the warning role', async () => {
    const vt = new VirtualTerminal()
    const driver = fakeDriver()
    const root = buildRoot(driver, {
      terminal: vt,
      theme: { accent: '45', warning: '44' },
    })
    root.tui.start()

    expect(root.editor.borderColor('x')).toBe('\x1b[45mx\x1b[0m')
    vt.sendInput('!')
    await settle()
    expect(root.editor.borderColor('x')).toBe('\x1b[44mx\x1b[0m')

    root.tui.stop()
    root.destroy()
  })

  it('backspacing the ! away restores the accent border', async () => {
    const vt = new VirtualTerminal()
    const driver = fakeDriver()
    const root = buildRoot(driver, {
      terminal: vt,
      theme: { accent: '45', warning: '44' },
    })
    root.tui.start()

    vt.sendInput('!')
    await settle()
    expect(root.editor.borderColor('x')).toBe('\x1b[44mx\x1b[0m')
    vt.sendInput('\x7f') // backspace
    await settle()
    expect(root.editor.borderColor('x')).toBe('\x1b[45mx\x1b[0m')

    root.tui.stop()
    root.destroy()
  })

  it('Esc in shell mode exits the mode and never reaches the busy interrupt (key order)', async () => {
    const vt = new VirtualTerminal()
    const driver = fakeDriver({ initial: setBusy(createInitialState(), true) })
    const root = buildRoot(driver, {
      terminal: vt,
      theme: { accent: '45', warning: '44' },
    })
    root.tui.start()

    vt.sendInput('!')
    await settle()
    expect(root.editor.borderColor('x')).toBe('\x1b[44mx\x1b[0m')

    vt.sendInput('\x1b') // escape
    await settle()

    expect(driver.interrupts).toBe(0)
    expect(root.editor.getText()).toBe('')
    expect(root.editor.borderColor('x')).toBe('\x1b[45mx\x1b[0m')

    root.tui.stop()
    root.destroy()
  })

  it('Esc while busy outside shell mode still interrupts the agent', async () => {
    const vt = new VirtualTerminal()
    const driver = fakeDriver({ initial: setBusy(createInitialState(), true) })
    const root = buildRoot(driver, { terminal: vt })
    root.tui.start()

    vt.sendInput('\x1b')
    await settle()
    expect(driver.interrupts).toBe(1)

    root.tui.stop()
    root.destroy()
  })

  it('↑/↓ browse the bash history in shell mode without touching the composer stack', async () => {
    const vt = new VirtualTerminal()
    const driver = fakeDriver({
      bashHistory: ['echo newest', 'echo older'],
      promptHistory: ['prompt-from-composer'],
    })
    const root = buildRoot(driver, { terminal: vt })
    root.tui.start()

    vt.sendInput('!')
    vt.sendInput('\x1b[A') // ↑ — most recent bash command, `!`-prefixed
    await settle()
    expect(root.editor.getText()).toBe('!echo newest')

    vt.sendInput('\x1b[A') // ↑ — older
    await settle()
    expect(root.editor.getText()).toBe('!echo older')
    vt.sendInput('\x1b[A') // ↑ — clamped at the oldest entry
    await settle()
    expect(root.editor.getText()).toBe('!echo older')

    vt.sendInput('\x1b[B') // ↓ — back toward the draft
    await settle()
    expect(root.editor.getText()).toBe('!echo newest')
    vt.sendInput('\x1b[B') // ↓ — past the newest restores the `!` draft
    await settle()
    expect(root.editor.getText()).toBe('!')

    // Exiting the mode leaves the composer prompt stack intact and usable.
    vt.sendInput('\x1b') // escape — leaves shell mode with an empty buffer
    vt.sendInput('\x1b[A') // ↑ — the editor's own history now
    await settle()
    expect(root.editor.getText()).toBe('prompt-from-composer')

    root.tui.stop()
    root.destroy()
  })

  it('hands a submitted shell line to the driver verbatim and keeps it out of the composer history', async () => {
    const vt = new VirtualTerminal()
    const driver = fakeDriver({
      bashHistory: [],
      promptHistory: ['prompt-from-composer'],
    })
    const root = buildRoot(driver, { terminal: vt })
    root.tui.start()

    for (const ch of '!ls -la') vt.sendInput(ch)
    vt.sendInput('\r')
    await settle()

    expect(driver.submitted).toEqual(['!ls -la'])

    // The shell line never joined the editor's prompt-recall stack: ↑ in
    // normal mode still surfaces the seed prompt, not `!ls -la`.
    vt.sendInput('\x1b[A')
    await settle()
    expect(root.editor.getText()).toBe('prompt-from-composer')

    root.tui.stop()
    root.destroy()
  })

  it('runs a pasted !line through the same submit path (normalization is submit-level)', async () => {
    const vt = new VirtualTerminal()
    const driver = fakeDriver()
    const root = buildRoot(driver, { terminal: vt })
    root.tui.start()

    // One input chunk — how a terminal paste arrives, bypassing the
    // single-character mode-entry path.
    vt.sendInput('!echo pasted')
    await settle()
    vt.sendInput('\r')
    await settle()

    expect(driver.submitted).toEqual(['!echo pasted'])
    root.tui.stop()
    root.destroy()
  })

  it('disables the composer while a bash command runs, then re-enables it', async () => {
    const vt = new VirtualTerminal()
    const driver = fakeDriver({ holdSubmit: true })
    const root = buildRoot(driver, { terminal: vt })
    root.tui.start()

    for (const ch of '!slow-command') vt.sendInput(ch)
    vt.sendInput('\r') // submit — the (held) "command" starts running
    await settle()

    // While the command is in flight every key is swallowed: the buffer
    // stays empty and the driver is not re-submitted.
    for (const ch of 'typed-while-running') vt.sendInput(ch)
    vt.sendInput('\r')
    await settle()
    expect(root.editor.getText()).toBe('')
    expect(driver.submitted).toEqual(['!slow-command'])

    driver.releaseSubmit()
    await settle()
    for (const ch of 'back') vt.sendInput(ch)
    await settle()
    expect(root.editor.getText()).toBe('back')

    root.tui.stop()
    root.destroy()
  })

  it('runs !echo end-to-end through a real driver into the grid', async () => {
    const agent = {
      options: {},
      session: { id: 's-vt', header: {}, events: [] },
      id: 'agent-s-vt',
      status: 'idle',
      followup: vi.fn(),
      steer: vi.fn(),
      cancel: vi.fn(),
    }
    const handle = { agent, dispose: async () => {} }
    const ctx: Record<string, unknown> = {
      get(key: string) {
        if (key === 'agentPresets') {
          return {
            defaultId: 'cc',
            resolve: async () => ({ id: 'cc' }),
            mount: async () => ({ id: 'cc' }),
          }
        }
        return undefined
      },
      on: () => () => {},
      agents: { create: async () => handle, resume: async () => handle },
    }
    const driver = await createDriver(ctx as never, {
      cwd: tempHome,
      branchProbe: async () => undefined,
    })
    const vt = new VirtualTerminal()
    const root = buildRoot(driver, { terminal: vt })
    root.tui.start()

    // Type `!echo hi` in shell mode and submit.
    for (const ch of '!echo hi') vt.sendInput(ch)
    vt.sendInput('\r')
    await settle(400)

    const grid = vt.grid().join('\n')
    expect(grid).toContain('$ echo hi')
    expect(grid).toContain('hi')
    expect(agent.followup).not.toHaveBeenCalled()

    root.tui.stop()
    root.destroy()
    await driver.dispose()
  })
})
