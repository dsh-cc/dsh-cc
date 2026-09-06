import { describe, expect, it } from 'vitest'
import { Terminal as XtermTerminal } from '@xterm/headless'
import {
  TuiMainScreen,
  type Terminal as PiTerminal,
} from '@dsh-cc/pi-tui'
import { buildRoot } from '@dsh-cc/tui/components/root.ts'
import type { Driver } from '@dsh-cc/tui/state/driver-types.ts'
import {
  clearQueue,
  createInitialState,
  popQueued,
  upsertRow,
  type TuiState,
} from '@dsh-cc/tui/store.ts'

/**
 * Minimal pi-tui Terminal implementation that pipes write() calls into an
 * @xterm/headless Terminal so tests can assert on the rendered grid.
 * Mirrors the fixture in vt-renderer.spec.ts, extended with resize().
 */
class VirtualTerminal implements PiTerminal {
  private readonly xterm: XtermTerminal
  private resizeHandler?: () => void
  private _cols: number
  private _rows: number

  constructor(cols = 80, rows = 24) {
    this._cols = cols
    this._rows = rows
    this.xterm = new XtermTerminal({ cols, rows, allowProposedApi: true })
  }

  start(_onInput: (data: string) => void, onResize: () => void): void {
    this.resizeHandler = onResize
  }

  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void { this.xterm.write(data) }

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

  /** Read a grid row (trimmed). */
  line(row: number): string {
    const base = this.xterm.buffer.active.baseY
    return this.xterm.buffer.active.getLine(base + row)?.translateToString(true) ?? ''
  }

  /** Full visible grid as trimmed strings. */
  grid(): string[] {
    const lines: string[] = []
    for (let i = 0; i < this._rows; i++) lines.push(this.line(i))
    return lines
  }

  /** Simulate a terminal resize: update dimensions, resize xterm, fire the
   *  pi-tui onResize hook (which calls requestRender → doRender). */
  resize(cols: number, rows: number): void {
    this._cols = cols
    this._rows = rows
    this.xterm.resize(cols, rows)
    this.resizeHandler?.()
  }
}

/** Minimal Driver fake with a setState() for driving new state in. */
function fakeDriver(initial: TuiState = createInitialState()): Driver & { setState(next: TuiState): void } {
  let state = initial
  const listeners = new Set<(s: TuiState) => void>()
  return {
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
    setDraft() {},
    async submit() {},
    interrupt() {},
    cyclePermissionMode: async () => {},
    answerApproval() {},
    questionMove() {},
    questionToggle() {},
    questionPick() {},
    questionType() {},
    questionBackspace() {},
    questionSubmit() {},
    questionCancel() {},
    steerQueued() {
      state = clearQueue(state)
      for (const l of listeners) l(state)
    },
    recallQueued() {
      const popped = popQueued(state)
      if (popped.text === undefined) return undefined
      state = popped.state
      for (const l of listeners) l(state)
      return popped.text
    },
    listCommands() { return [] },
    async dispose() {},
    setState(next: TuiState) {
      state = next
      for (const l of listeners) l(state)
    },
  }
}

/** Wait for the throttled async render to settle. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 60))
}

describe('resize re-layout', () => {
  it('re-wraps the transcript at the new terminal width without truncating content', async () => {
    // A long assistant message that wraps at both 80 and 40 cols, ending in a
    // recognizable tail token so we can assert content re-flowed (not lost).
    const longText =
      'the quick brown fox jumps over the lazy dog '.repeat(5).trim() + ' TAILMARKER'
    // A long single-line tool body that also wraps at both widths.
    const longToolBody = 'x'.repeat(120)

    let state = createInitialState()
    state = upsertRow(state, { kind: 'assistant', text: longText })
    state = upsertRow(state, {
      kind: 'tool',
      callId: 't1',
      name: 'bash',
      args: '{"command":"ls -la"}',
      title: 'run: bash',
      body: longToolBody,
      running: false,
    })

    const vt = new VirtualTerminal(80, 24)
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    // --- Width 80 baseline ---
    const grid80 = vt.grid()
    const joined80 = grid80.join('\n')
    // The tail of the long text is visible at 80 cols.
    expect(joined80).toContain('TAILMARKER')
    // And the long tool body is present.
    expect(joined80).toContain('run: bash')
    // The long assistant text wraps to lines wider than 40 cols at width 80,
    // proving we actually started wide (not already narrow).
    expect(grid80.some(l => l.length > 40)).toBe(true)

    // --- Resize to 40 cols ---
    vt.resize(40, 24)
    await settle()

    const grid40 = vt.grid()
    const joined40 = grid40.join('\n')

    // Contract: no visible line exceeds the new width.
    for (const line of grid40) {
      expect(line.length).toBeLessThanOrEqual(40)
    }
    // Content re-flowed, not truncated: the tail is still in the viewport.
    expect(joined40).toContain('TAILMARKER')
    // The tool row survived the resize too.
    expect(joined40).toContain('run: bash')
    // And content actually narrowed (no line exceeds 40, yet text remains).
    expect(grid40.some(l => l.length > 0)).toBe(true)

    root.tui.stop()
    root.destroy()
  })
})
