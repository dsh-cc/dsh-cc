import { describe, expect, it, vi } from 'vitest'
import { Terminal as XtermTerminal } from '@xterm/headless'
import {
  type Terminal as PiTerminal,
} from '@dsh-cc/pi-tui'
import { buildRoot } from '@dsh-cc/tui/components/root.ts'
import type { Driver } from '@dsh-cc/tui/state/driver-types.ts'
import {
  createInitialState,
  toggleGlobalCollapse,
  type TuiState,
} from '@dsh-cc/tui/store.ts'
import {
  applySessionEvent,
  type SessionEventLike,
  type ToolPresenters,
} from '@dsh-cc/tui/transcript.ts'

/**
 * Minimal pi-tui Terminal implementation that pipes write() calls into an
 * @xterm/headless Terminal so tests can assert on the rendered grid.
 * Mirrors the fixture in vt-renderer.spec.ts.
 */
class VirtualTerminal implements PiTerminal {
  private readonly xterm: XtermTerminal
  private _cols: number
  private _rows: number

  constructor(cols = 80, rows = 24) {
    this._cols = cols
    this._rows = rows
    this.xterm = new XtermTerminal({ cols, rows, allowProposedApi: true })
  }

  start(): void {}
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

  line(row: number): string {
    const base = this.xterm.buffer.active.baseY
    return this.xterm.buffer.active.getLine(base + row)?.translateToString(true) ?? ''
  }

  grid(): string[] {
    const lines: string[] = []
    for (let i = 0; i < this._rows; i++) lines.push(this.line(i))
    return lines
  }
}

/** Minimal Driver fake that serves a fixed state to subscribers. */
function fakeDriver(initial: TuiState): Driver {
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
    toggleThinking() {},
    toggleGlobalCollapse() { state = toggleGlobalCollapse(state) },
    answerApproval() {},
    questionMove() {},
    questionToggle() {},
    questionPick() {},
    questionType() {},
    questionBackspace() {},
    questionSubmit() {},
    questionCancel() {},
    listCommands() { return [] },
    async openModelPicker() {},
    modelPickerMove() {},
    modelPickerSubmit() {},
    modelPickerCancel() {},
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
    toggleTodoPanel() {},
    todoPanelMove() {},
    todoPanelClose() {},
    usagePanelClose() {},
    showNotice() {},
    markExitAttempt() {},
    steerQueued() {},
    recallQueued() { return undefined },
    async switchSession() {},
    async listSessions() { return [] },
    async dispose() {},
  }
}

/**
 * Poll a predicate until it holds or the timeout lapses. A fixed settle() can
 * outrace the throttled render on loaded CI runners (observed: a blank xterm
 * grid in presubmit while the same run passes locally) — polling turns that
 * race into a bounded wait without weakening the final assertions.
 */
async function settleUntil(predicate: () => boolean, timeoutMs = 2000, stepMs = 15): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return
    await new Promise(resolve => setTimeout(resolve, stepMs))
  }
}

describe('resume replay — folding a durable event log', () => {
  it('re-runs presenters on replay and produces finalized rows', () => {
    const presentCall = vi.fn((_name: string, _args: unknown) =>
      ({ card: 'terminal' as const, title: 'run: bash', cwd: '/tmp' }))
    const presentResult = vi.fn((_name: string, _args: unknown, _result: { content: unknown; isError: boolean; meta?: unknown }) =>
      ({ card: 'terminal' as const, output: 'ok-out', exitCode: 0 }))
    const presenters: ToolPresenters = { presentCall, presentResult }

    const events: SessionEventLike[] = [
      // Unknown seed bracket — fold must skip it without throwing.
      { type: 'session/start', data: {} },
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { content: [{ type: 'text', text: 'list files' }], source: { kind: 'user' } } },
      // Plugin-injected context landing mid-turn (CLAUDE.md instructions):
      // replay must NOT render it as if the user typed it.
      {
        type: 'user/message',
        data: {
          content: [{ type: 'text', text: '<system-reminder># Workspace instructions\nlong CLAUDE.md payload</system-reminder>' }],
          source: { kind: 'plugin', plugin: 'workspace-instructions', form: 'instructions' },
        },
      },
      { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Hello' } } },
      { type: 'assistant/message', data: { turn: 1, step: 1, message: {} } },
      { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } },
      { type: 'tool/result', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', text: 'file.txt' } },
      { type: 'turn/end', data: { turn: 1, reason: 'normal' } },
    ]

    let folded = createInitialState()
    for (const event of events) {
      folded = applySessionEvent(folded, event, presenters)
    }

    // Presenters re-ran on the stored args (pure by contract).
    expect(presentCall).toHaveBeenCalledWith('bash', { command: 'ls' })
    expect(presentResult).toHaveBeenCalledWith('bash', { command: 'ls' }, expect.objectContaining({ isError: false }))

    // Rows: user text, assistant text, finalized tool row.
    expect(folded.rows).toContainEqual({ kind: 'user', text: 'list files' })
    expect(folded.rows).toContainEqual({ kind: 'assistant', text: 'Hello' })
    expect(folded.rows).toContainEqual(expect.objectContaining({
      kind: 'tool',
      callId: 'c1',
      running: false,
      title: 'run: bash',
    }))
    expect(folded.busy).toBe(false)

    // The injected instructions event folds to nothing — no row carries its
    // content, so replay does not dump it as a user message.
    const leaked = folded.rows.filter(row => 'text' in row && row.text.includes('<system-reminder>'))
    expect(leaked).toEqual([])
  })

  it('renders the folded rows through TranscriptView into the terminal', async () => {
    const events: SessionEventLike[] = [
      { type: 'user/message', data: { content: [{ type: 'text', text: 'list files' }], source: { kind: 'user' } } },
      { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Hello' } } },
      {
        type: 'tool/call',
        data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
      },
      {
        type: 'tool/result',
        data: { turn: 1, step: 1, callId: 'c1', name: 'bash', text: 'file.txt' },
      },
    ]

    let folded = createInitialState()
    for (const event of events) {
      folded = applySessionEvent(folded, event)
    }

    const vt = new VirtualTerminal(80, 24)
    const driver = fakeDriver(folded)
    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settleUntil(() => vt.grid().join('\n').includes('list files'))

    const joined = vt.grid().join('\n')
    expect(joined).toContain('list files')
    expect(joined).toContain('Hello')
    expect(joined).toContain('bash')

    root.tui.stop()
    root.destroy()
  })
})
