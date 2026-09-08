import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Terminal as XtermTerminal } from '@xterm/headless'
import {
  TuiMainScreen,
  type Terminal as PiTerminal,
} from '@dsh-cc/pi-tui'
import { buildRoot } from '@dsh-cc/tui/components/root.ts'
import { renderRowText } from '@dsh-cc/tui/components/transcript.ts'
import { whaleBannerArt } from '@dsh-cc/tui/harness/boot-banner.ts'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'
import type { Driver } from '@dsh-cc/tui/state/driver-types.ts'
import {
  backspaceQuestionText,
  clearQueue,
  closeTodoPanel,
  createInitialState,
  enqueue,
  markExitAttempt,
  moveEffortPickerFocus,
  movePermissionPickerFocus,
  moveModelPickerFocus,
  moveQuestionFocus,
  moveTodoPanelFocus,
  openTodoPanel,
  popQueued,
  setApproval,
  setBusy,
  setEffortPicker,
  setPermissionPicker,
  setModelPicker,
  setNotice,
  setQuestion,
  setSessionSwitcher,
  setTodos,
  toggleGlobalCollapse,
  toggleQuestionOption,
  typeQuestionText,
  upsertRow,
  type CatalogEntryView,
  type SessionEntryView,
  type TuiState,
} from '@dsh-cc/tui/store.ts'

/**
 * Minimal pi-tui Terminal implementation that pipes write() calls into an
 * @xterm/headless Terminal so tests can assert on the rendered grid.
 */
class VirtualTerminal implements PiTerminal {
  private readonly xterm: XtermTerminal
  private inputHandler?: (data: string) => void
  private resizeHandler?: () => void
  private _cols: number
  private _rows: number

  constructor(cols = 80, rows = 24) {
    this._cols = cols
    this._rows = rows
    this.xterm = new XtermTerminal({ cols, rows, allowProposedApi: true })
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inputHandler = onInput
    this.resizeHandler = onResize
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
}

/**
 * Minimal Driver fake: holds state, notifies subscribers, and implements the
 * overlay-answer methods so the global input listener can dismiss prompts.
 */
function fakeDriver(
  initial: TuiState = createInitialState(),
  promptHistory: readonly string[] = [],
  bashHistory: readonly string[] = [],
): Driver & { setState(next: TuiState): void } {
  let state = initial
  const listeners = new Set<(s: TuiState) => void>()
  return {
    get state() { return state },
    get statusLine() { return 'test · status' },
    statusLineIn: () => 'test · status',
    get cwd() { return process.cwd() },
    get promptHistory() { return promptHistory },
    get bashHistory() { return bashHistory },
    subscribe(listener: (s: TuiState) => void) {
      listeners.add(listener)
      listener(state)
      return () => { listeners.delete(listener) }
    },
    setDraft(draft: string) {
      state = { ...state, draft }
      for (const l of listeners) l(state)
    },
    async submit(text?: string) {
      const draft = text ?? state.draft
      if (draft.trim().length === 0) return
      state = { ...state, draft: '' }
      for (const l of listeners) l(state)
    },
    interrupt() {
      state = setBusy(state, false)
      for (const l of listeners) l(state)
    },
    cyclePermissionMode: async () => {},
    toggleThinking() {
      state = { ...state, thinkingExpanded: !state.thinkingExpanded }
      for (const l of listeners) l(state)
    },
    toggleGlobalCollapse() {
      state = toggleGlobalCollapse(state)
      for (const l of listeners) l(state)
    },
    answerApproval(_kind: 'once' | 'always' | 'reject') {
      state = setApproval(state, undefined)
      for (const l of listeners) l(state)
    },
    questionMove(delta) {
      state = moveQuestionFocus(state, delta)
      for (const l of listeners) l(state)
    },
    questionToggle() {
      const q = state.question
      if (q === undefined) return
      if (q.focused >= q.options.length) {
        state = typeQuestionText(state, ' ')
      } else if (q.multiSelect) {
        state = toggleQuestionOption(state, q.focused)
      } else {
        state = setQuestion(state, undefined)
      }
      for (const l of listeners) l(state)
    },
    questionPick(index) {
      const q = state.question
      if (q === undefined || index < 0 || index >= q.options.length) return
      if (q.multiSelect) {
        state = toggleQuestionOption(state, index)
      } else {
        state = setQuestion(state, undefined)
      }
      for (const l of listeners) l(state)
    },
    questionType(text) {
      state = typeQuestionText(state, text)
      for (const l of listeners) l(state)
    },
    questionBackspace() {
      state = backspaceQuestionText(state)
      for (const l of listeners) l(state)
    },
    questionSubmit() {
      state = setQuestion(state, undefined)
      for (const l of listeners) l(state)
    },
    questionCancel() {
      state = setQuestion(state, undefined)
      for (const l of listeners) l(state)
    },
    modelPickerMove(delta) {
      state = moveModelPickerFocus(state, delta)
      for (const l of listeners) l(state)
    },
    modelPickerSubmit() {
      const picker = state.modelPicker
      if (picker === undefined) return
      const entry = picker.entries[picker.focused]
      state = setModelPicker(state, undefined)
      if (entry !== undefined) {
        state = upsertRow(state, {
          kind: 'status',
          text: `Model is now ${entry.provider}/${entry.id}.`,
        })
      }
      for (const l of listeners) l(state)
    },
    modelPickerCancel() {
      state = setModelPicker(state, undefined)
      for (const l of listeners) l(state)
    },
    async openEffortPicker() {},
    effortPickerMove(delta) {
      state = moveEffortPickerFocus(state, delta)
      for (const l of listeners) l(state)
    },
    async effortPickerSubmit() {
      const picker = state.effortPicker
      if (picker === undefined) return
      const entry = picker.entries[picker.focused]
      state = setEffortPicker(state, undefined)
      if (entry !== undefined) {
        state = upsertRow(state, {
          kind: 'status',
          text: `Effort is now ${entry}.`,
        })
      }
      for (const l of listeners) l(state)
    },
    effortPickerCancel() {
      state = setEffortPicker(state, undefined)
      for (const l of listeners) l(state)
    },
    async openPermissionPicker() {},
    permissionPickerMove(delta) {
      state = movePermissionPickerFocus(state, delta)
      for (const l of listeners) l(state)
    },
    async permissionPickerSubmit() {
      const picker = state.permissionPicker
      if (picker === undefined) return
      const entry = picker.entries[picker.focused]
      if (entry?.id === 'bypassPermissions' && picker.confirmingBypass !== true) {
        state = setPermissionPicker(state, { ...picker, confirmingBypass: true })
        for (const l of listeners) l(state)
        return
      }
      state = setPermissionPicker(state, undefined)
      if (entry !== undefined) {
        state = upsertRow(state, {
          kind: 'status',
          text: `Permission mode is now "${entry.id}".`,
        })
      }
      for (const l of listeners) l(state)
    },
    permissionPickerCancel() {
      const picker = state.permissionPicker
      if (picker?.confirmingBypass === true) {
        const { confirmingBypass: _dropped, ...rest } = picker
        state = setPermissionPicker(state, rest)
      } else {
        state = setPermissionPicker(state, undefined)
      }
      for (const l of listeners) l(state)
    },
    toggleTodoPanel() {
      state = state.todoPanel !== undefined ? closeTodoPanel(state) : openTodoPanel(state)
      for (const l of listeners) l(state)
    },
    todoPanelMove(delta) {
      state = moveTodoPanelFocus(state, delta)
      for (const l of listeners) l(state)
    },
    todoPanelClose() {
      state = closeTodoPanel(state)
      for (const l of listeners) l(state)
    },
    usagePanelClose() {},
    showNotice(text: string) {
      state = setNotice(state, text)
      for (const l of listeners) l(state)
    },
    markExitAttempt(now?: number) {
      state = markExitAttempt(state, now ?? Date.now())
      for (const l of listeners) l(state)
    },
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
    async openSessionSwitcher() {},
    sessionSwitcherMove() {},
    sessionSwitcherType() {},
    sessionSwitcherBackspace() {},
    sessionSwitcherToggleScope() {},
    async sessionSwitcherSubmit() {},
    sessionSwitcherCancel() {},
    async switchSession() {},
    async listSessions() { return [] },
    listCommands() {
      return [
        { name: 'quit', description: 'Exit the TUI session' },
        { name: 'tui-help', description: 'Show TUI keyboard and command help' },
      ]
    },
    async dispose() {},
    setState(next: TuiState) {
      state = next
      for (const l of listeners) l(state)
    },
  }
}

/** Strip SGR sequences for structural assertions. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

/** Wait for the throttled async render to settle. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 60))
}

describe('vt-renderer', () => {
  it('renders transcript rows in order', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = upsertRow(state, { kind: 'user', text: 'hello' })
    state = upsertRow(state, { kind: 'assistant', text: 'world' })
    state = upsertRow(state, { kind: 'status', text: 'done' })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const g = vt.grid()
    const joined = g.join('\n')
    expect(joined).toContain('dsh cc-mode')
    expect(joined).toContain('> hello')
    expect(joined).toContain('world')
    expect(joined).toContain('done')

    // Title comes before the first transcript row.
    const titleRow = g.findIndex(l => l.includes('dsh cc-mode'))
    const userRow = g.findIndex(l => l.includes('> hello'))
    expect(titleRow).toBeGreaterThanOrEqual(0)
    expect(userRow).toBeGreaterThan(titleRow)

    root.tui.stop()
    root.destroy()
  })

  it('approval box renders tool name, reason, capped command preview, and explicit choices', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = setApproval(state, {
      toolName: 'Bash',
      reason: 'destructive git operation',
      preview: {
        kind: 'command',
        command: 'set -e\necho one\necho two\necho three\necho four\necho five\necho six\necho seven\necho eight\necho nine',
      },
    })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const joined = vt.grid().join('\n')
    expect(joined).toContain('Approve Bash')
    expect(joined).toContain('destructive git operation')
    // First eight command lines render; the rest is cut with a … trailer.
    expect(joined).toContain('set -e')
    expect(joined).toContain('echo seven')
    expect(joined).toContain('…')
    expect(joined).not.toContain('echo eight')
    expect(joined).not.toContain('echo nine')
    // Explicit key → outcome mapping, including the always-allow option.
    expect(joined).toContain('1 once · 2 no · 3 always')

    root.tui.stop()
    root.destroy()
  })

  it('approval box renders a diff preview for file-edit tools', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = setApproval(state, {
      toolName: 'Edit',
      preview: {
        kind: 'diff',
        diffs: [{ path: 'src/a.ts', oldText: 'const a = 1\n', newText: 'const a = 2\n' }],
      },
    })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const joined = vt.grid().join('\n')
    expect(joined).toContain('Approve Edit')
    expect(joined).toContain('src/a.ts')
    expect(joined).toContain('- const a = 1')
    expect(joined).toContain('+ const a = 2')
    expect(joined).toContain('1 once · 2 no · 3 always')

    root.tui.stop()
    root.destroy()
  })

  it('approval box: 1 answers once, 2 answers reject, other keys never reach the editor', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = setApproval(state, { toolName: 'Bash', preview: { kind: 'command', command: 'rm -rf /tmp/x' } })
    const driver = fakeDriver(state)
    const answers: string[] = []
    const baseAnswer = driver.answerApproval.bind(driver)
    driver.answerApproval = (kind: 'once' | 'always' | 'reject') => {
      answers.push(kind)
      baseAnswer(kind)
    }

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    // A non-answer key is consumed by the overlay: the editor draft stays
    // untouched while the approval box is open.
    vt.sendInput('x')
    await settle()
    expect(root.editor.getText()).toBe('')

    vt.sendInput('1')
    await settle()
    expect(answers).toEqual(['once'])
    expect(vt.grid().join('\n')).not.toContain('Approve Bash')

    // Reopen and reject with 2.
    driver.setState(setApproval(driver.state, { toolName: 'Bash', preview: { kind: 'command', command: 'rm -rf /tmp/x' } }))
    await settle()
    vt.sendInput('2')
    await settle()
    expect(answers).toEqual(['once', 'reject'])
    expect(root.editor.getText()).toBe('')

    root.tui.stop()
    root.destroy()
  })

  it('approval box: 3 answers always and the allow-rule notice is echoed', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = setApproval(state, { toolName: 'Bash', preview: { kind: 'command', command: 'npm install foo' } })
    const driver = fakeDriver(state)
    const baseAnswer = driver.answerApproval.bind(driver)
    driver.answerApproval = (kind: 'once' | 'always' | 'reject') => {
      if (kind === 'always') driver.showNotice('Always allow: Bash(npm )')
      baseAnswer(kind)
    }

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    vt.sendInput('3')
    await settle()
    expect(vt.grid().join('\n')).toContain('Always allow: Bash(npm )')
    expect(vt.grid().join('\n')).not.toContain('Approve Bash')

    root.tui.stop()
    root.destroy()
  })

  it('queued approvals render the queue position and answering advances FIFO', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = setApproval(state, { toolName: 'Bash', preview: { kind: 'command', command: 'echo one' }, pendingCount: 1 })
    const driver = fakeDriver(state)
    // The driver owns the queue; answering the head promotes the next entry.
    const queue: { toolName: string; preview: { kind: 'command'; command: string } }[] = [
      { toolName: 'Bash', preview: { kind: 'command', command: 'echo one' } },
      { toolName: 'Write', preview: { kind: 'command', command: 'echo two' } },
    ]
    driver.answerApproval = () => {
      queue.shift()
      const head = queue[0]
      driver.setState(head === undefined
        ? setApproval(driver.state, undefined)
        : setApproval(driver.state, {
          ...head,
          ...queue.length <= 1 ? {} : { pendingCount: queue.length - 1 },
        }))
    }

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    // Head of two: the title carries the queue position.
    expect(vt.grid().join('\n')).toContain('Approval (1 of 2)')

    vt.sendInput('1')
    await settle()
    // The queued approval is promoted and is now a lone head.
    expect(vt.grid().join('\n')).toContain('Approve Write?')
    expect(vt.grid().join('\n')).not.toContain('1 of')

    vt.sendInput('2')
    await settle()
    expect(vt.grid().join('\n')).not.toContain('Approve')

    root.tui.stop()
    root.destroy()
  })

  it('keeps the composer visible when the transcript overflows the terminal', async () => {
    const vt = new VirtualTerminal(80, 10)
    let state = createInitialState()
    for (let i = 0; i < 20; i++) {
      state = upsertRow(state, { kind: 'assistant', text: `line ${i + 1}` })
    }
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const g = vt.grid()
    // The editor border (─) and the statusline must be in the visible
    // viewport — the frame-overflow regression would push them off-screen.
    const joined = g.join('\n')
    expect(joined).toContain('─')
    expect(joined).toContain('test · status')

    root.tui.stop()
    root.destroy()
  })

  it('renders a queued chip line for each pending steer above the composer', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = upsertRow(state, { kind: 'assistant', text: 'working' })
    state = setBusy(state, true)
    state = enqueue(state, 'fix the bug')
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const joined = vt.grid().join('\n')
    expect(joined).toContain('⏵ queued: fix the bug')

    root.tui.stop()
    root.destroy()
  })

  it('recalls the most recent queued entry into an empty editor on ↑', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = setBusy(state, true)
    state = enqueue(state, 'first idea')
    state = enqueue(state, 'second idea')
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()
    expect(stripAnsi(vt.grid().join('\n'))).toContain('⏵ queued: second idea')

    vt.sendInput('\x1b[A') // ↑ with an empty composer
    await settle()

    // The newest chip lands in the composer for editing and leaves the queue.
    expect(root.editor.getText()).toBe('second idea')
    expect(driver.state.queued).toEqual(['first idea'])
    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).not.toContain('⏵ queued: second idea')
    expect(stripped).toContain('⏵ queued: first idea')

    root.tui.stop()
    root.destroy()
  })

  it('a non-empty editor walks history on ↑ without touching the queue', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = enqueue(state, 'queued one')
    state = enqueue(state, 'queued two')
    const driver = fakeDriver(state, ['history entry'])

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    for (const ch of 'abc') vt.sendInput(ch)
    await settle()
    vt.sendInput('\x01') // ctrl+a — cursor to col 0 (the editor's history-browse precondition)
    await settle()
    vt.sendInput('\x1b[A') // ↑ with a non-empty composer falls through to the editor
    await settle()

    // History navigation replaced the draft; the outbox was not popped.
    expect(root.editor.getText()).toBe('history entry')
    expect(driver.state.queued).toEqual(['queued one', 'queued two'])

    root.tui.stop()
    root.destroy()
  })

  it('Ctrl+S injects the queued entries immediately and clears the chips', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = setBusy(state, true)
    state = enqueue(state, 'fix the bug')
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()
    expect(stripAnsi(vt.grid().join('\n'))).toContain('⏵ queued: fix the bug')

    vt.sendInput('\x13') // ctrl+s — queue-jump into the running turn
    await settle()

    expect(driver.state.queued).toEqual([])
    expect(stripAnsi(vt.grid().join('\n'))).not.toContain('⏵ queued:')

    root.tui.stop()
    root.destroy()
  })

  it('renders the todo strip with done/total and the active task above the composer', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = setTodos(state, [
      { content: 'first task', status: 'completed' },
      { content: 'write the tests', status: 'in_progress' },
      { content: 'ship it', status: 'pending' },
    ])
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('☐ 1/3 · write the tests')

    root.tui.stop()
    root.destroy()
  })

  it('omits the active segment when no todo is in progress', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = setTodos(state, [
      { content: 'done thing', status: 'completed' },
      { content: 'later thing', status: 'pending' },
    ])
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('☐ 1/2')
    expect(stripped).not.toContain('later thing')

    root.tui.stop()
    root.destroy()
  })

  it('caps a long active task at ~60 chars with an ellipsis', async () => {
    const vt = new VirtualTerminal(120, 24)
    const long = 'x'.repeat(100)
    let state = createInitialState()
    state = setTodos(state, [
      { content: long, status: 'in_progress' },
    ])
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const stripped = stripAnsi(vt.grid().join('\n'))
    const marker = stripped.indexOf('☐')
    expect(marker).toBeGreaterThanOrEqual(0)
    // The strip line stays short: the 100-char task must be truncated. The
    // grid pads rows to the terminal width, so measure the trimmed content.
    const stripLine = stripped.split('\n').find(l => l.includes('☐'))!
    expect(stripLine.trimEnd().length).toBeLessThan(80)
    expect(stripLine).toContain('…')

    root.tui.stop()
    root.destroy()
  })

  it('clears the todo strip when todos are cleared (collapses to zero height)', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = setTodos(state, [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'pending' },
      { content: 'c', status: 'pending' },
    ])
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const withStrip = stripAnsi(vt.grid().join('\n'))
    expect(withStrip).toContain('☐ 1/3')
    const nonEmptyBefore = withStrip.split('\n').filter(l => l.trim().length > 0).length

    driver.setState(setTodos(driver.state, undefined))
    await settle()

    const withoutStrip = stripAnsi(vt.grid().join('\n'))
    expect(withoutStrip).not.toContain('☐')
    // Exactly one line disappeared — the strip collapsed to zero height.
    const nonEmptyAfter = withoutStrip.split('\n').filter(l => l.trim().length > 0).length
    expect(nonEmptyBefore - nonEmptyAfter).toBe(1)

    root.tui.stop()
    root.destroy()
  })

  it('renders diff hunks beneath a tool row head when diffs are present', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = upsertRow(state, {
      kind: 'tool',
      callId: 'd1',
      name: 'Edit',
      args: '{}',
      title: 'Edit foo.ts',
      running: false,
      diffs: [{ path: 'foo.ts', oldText: 'old line\n', newText: 'new line\n' }],
    })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const joined = vt.grid().join('\n')
    // Head line with the title.
    expect(joined).toContain('Edit foo.ts')
    // Path header and hunk lines visible on screen.
    expect(joined).toContain('foo.ts')
    expect(stripAnsi(joined)).toContain('- old line')
    expect(stripAnsi(joined)).toContain('+ new line')

    root.tui.stop()
    root.destroy()
  })

  it('does not render a queue chip when the queue is empty', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = upsertRow(state, { kind: 'user', text: 'hi' })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const joined = vt.grid().join('\n')
    expect(joined).not.toContain('⏵ queued:')

    root.tui.stop()
    root.destroy()
  })

  it('renders a running tool row with a present-tense verb before the title', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = upsertRow(state, {
      kind: 'tool',
      callId: 'r1',
      name: 'bash',
      args: '{"command":"ls"}',
      title: 'bash',
      running: true,
    })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('Running')
    expect(stripped).toContain('bash')
    expect(stripped).toContain('…')

    root.tui.stop()
    root.destroy()
  })

  it('renders a completed tool row with a checkmark and no verb', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = upsertRow(state, {
      kind: 'tool',
      callId: 'd1',
      name: 'bash',
      args: '{}',
      title: 'ls -la',
      running: false,
      result: 'ok',
    })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('ls -la')
    expect(stripped).toContain('✓')
    expect(stripped).not.toContain('Running')

    root.tui.stop()
    root.destroy()
  })

  it('renders a thinking row collapsed to a one-line hint by default (body hidden)', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = upsertRow(state, { kind: 'thinking', text: 'let me reason\nabout this\nnow' })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('thinking (3 lines — Ctrl+O to toggle)')
    expect(stripped).toContain('▸')
    // Collapsed: the body text must NOT leak into the grid.
    expect(stripped).not.toContain('let me reason')

    root.tui.stop()
    root.destroy()
  })

  it('renders the thinking body with a ▾ marker when thinkingExpanded is true', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = upsertRow(state, { kind: 'thinking', text: 'let me reason\nabout this' })
    state = { ...state, thinkingExpanded: true }
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('▾')
    expect(stripped).toContain('let me reason')
    expect(stripped).not.toContain('Ctrl+O to toggle')

    root.tui.stop()
    root.destroy()
  })

  it('re-renders a thinking row on a flag flip despite unchanged row identity', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = upsertRow(state, { kind: 'thinking', text: 'secret reasoning' })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    let stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('thinking (1 lines — Ctrl+O to toggle)')
    expect(stripped).not.toContain('secret reasoning')

    // Flip the flag WITHOUT touching the rows array reference — the cached
    // thinking row must still rebuild so the body appears.
    driver.setState({ ...state, thinkingExpanded: true })
    await settle()

    stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('secret reasoning')
    expect(stripped).not.toContain('Ctrl+O to toggle')

    root.tui.stop()
    root.destroy()
  })

  it('toggles thinking on ctrl+o and re-renders the transcript', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = upsertRow(state, { kind: 'thinking', text: 'hidden thought' })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    let stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).not.toContain('hidden thought')

    vt.sendInput('\x0f') // ctrl+o
    await settle()

    stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('hidden thought')
    expect(driver.state.thinkingExpanded).toBe(true)

    root.tui.stop()
    root.destroy()
  })

  it('ctrl+o collapses tool output into a summary and a second press restores it', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = upsertRow(state, {
      kind: 'tool',
      callId: 't1',
      name: 'bash',
      args: '{}',
      title: 'ls -la',
      running: false,
      result: 'alpha output\nbeta output\ngamma output',
    })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    // Default: tool output expanded (first result line visible, no summary).
    let stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('alpha output')
    expect(stripped).not.toContain('▸ output')

    // Press 1: fresh state is mixed (thinking collapsed, tools expanded), so
    // everything expands — tool output is unaffected.
    vt.sendInput('\x0f') // ctrl+o
    await settle()
    stripped = stripAnsi(vt.grid().join('\n'))
    expect(driver.state.thinkingExpanded).toBe(true)
    expect(driver.state.toolOutputExpanded).toBe(true)
    expect(stripped).toContain('alpha output')

    // Press 2: everything was expanded, so everything collapses — the result
    // body disappears behind the dim summary line.
    vt.sendInput('\x0f') // ctrl+o
    await settle()
    stripped = stripAnsi(vt.grid().join('\n'))
    expect(driver.state.thinkingExpanded).toBe(false)
    expect(driver.state.toolOutputExpanded).toBe(false)
    expect(stripped).not.toContain('alpha output')
    expect(stripped).not.toContain('beta output')
    expect(stripped).toContain('▸ output (3 lines — Ctrl+O to toggle)')

    // Press 3: everything expands again — the result body returns.
    vt.sendInput('\x0f') // ctrl+o
    await settle()
    stripped = stripAnsi(vt.grid().join('\n'))
    expect(driver.state.toolOutputExpanded).toBe(true)
    expect(stripped).toContain('alpha output')
    expect(stripped).not.toContain('▸ output')

    root.tui.stop()
    root.destroy()
  })

  it('collapses a diff-card tool row on ctrl+o without leaving hunk lines behind', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = upsertRow(state, {
      kind: 'tool',
      callId: 'd1',
      name: 'Edit',
      args: '{}',
      title: 'Edit foo.ts',
      running: false,
      diffs: [{ path: 'foo.ts', oldText: 'old line\n', newText: 'new line\n' }],
    })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    // Press 1 expands everything (mixed start), press 2 collapses everything.
    vt.sendInput('\x0f') // ctrl+o — expand
    await settle()
    vt.sendInput('\x0f') // ctrl+o — collapse
    await settle()

    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).not.toContain('- old line')
    expect(stripped).not.toContain('+ new line')
    expect(stripped).toContain('Edit foo.ts')
    expect(stripped).toContain('▸ output (')
    expect(stripped).toContain('Ctrl+O to toggle')

    root.tui.stop()
    root.destroy()
  })

  it('surfaces slash-command autocomplete when the user types /t', async () => {
    const vt = new VirtualTerminal(80, 24)
    const driver = fakeDriver(createInitialState())

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    // Type "/t" — the editor auto-triggers autocomplete via
    // isInSlashCommandContext on the alphanumeric 't'.
    vt.sendInput('/')
    vt.sendInput('t')
    await settle()

    // The fakeDriver catalog exposes 'tui-help'; it must appear in the rendered
    // grid as a suggestion entry. Asserting the name (not the overlay layout)
    // keeps this resilient to SelectList presentation changes.
    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('tui-help')

    root.tui.stop()
    root.destroy()
  })

  it('seeds editor ↑/↓ history from driver.promptHistory (newest recalled first)', async () => {
    const vt = new VirtualTerminal(80, 24)
    const driver = fakeDriver(createInitialState(), ['older', 'newer'])

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    // Editor starts empty → ↑ recalls the most recent entry ('newer'), not
    // 'older' (addToHistory unshifts, so index 0 is the last seeded).
    vt.sendInput('\x1b[A') // arrow up
    await settle()

    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('newer')
    expect(stripped).not.toContain('older')

    root.tui.stop()
    root.destroy()
  })

  it('renders the question overlay with options, focus marker, Other row, and hint', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = setQuestion(state, {
      header: 'Decision',
      question: 'Which flavor?',
      options: [{ label: 'vanilla' }, { label: 'chocolate' }],
      multiSelect: false,
      focused: 0,
      selected: [],
      custom: '',
    })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('Which flavor?')
    expect(stripped).toContain('vanilla')
    expect(stripped).toContain('chocolate')
    // Focus marker sits on the focused (first) option.
    expect(stripped).toContain('❯ 1. vanilla')
    // Free-text escape hatch row is always present.
    expect(stripped).toContain('Other:')
    // Single-select footer hint.
    expect(stripped).toContain('enter select')
    expect(stripped).toContain('esc cancel')

    root.tui.stop()
    root.destroy()
  })

  it('renders a plan-review question with the Plan review title and plan markdown', async () => {
    const vt = new VirtualTerminal(80, 30)
    let state = createInitialState()
    state = setQuestion(state, {
      header: 'Decision',
      question: 'Approve this plan?',
      detail: '## The plan\n\n- refactor the store\n- add tests',
      options: [{ label: 'Ship it' }, { label: 'Keep iterating' }],
      multiSelect: false,
      intent: { kind: 'plan-review', approve: 'Ship it' },
      focused: 0,
      selected: [],
      custom: '',
    })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('Plan review')
    expect(stripped).toContain('Approve this plan?')
    // Plan markdown body renders (heading text + list items via Markdown).
    expect(stripped).toContain('The plan')
    expect(stripped).toContain('refactor the store')
    expect(stripped).toContain('add tests')
    // Options still follow the plan.
    expect(stripped).toContain('Ship it')

    root.tui.stop()
    root.destroy()
  })

  it('multi-select shows [ ] before unselected options and [x] after a space toggle', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = setQuestion(state, {
      header: 'Pick',
      question: 'Which areas?',
      options: [{ label: 'ui' }, { label: 'api' }],
      multiSelect: true,
      focused: 0,
      selected: [],
      custom: '',
    })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    let stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('❯ 1. [ ] ui')
    expect(stripped).toContain('2. [ ] api')
    expect(stripped).toContain('space toggle')

    // Space toggles the focused option ('ui') — [x] appears.
    vt.sendInput(' ')
    await settle()
    stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('1. [x] ui')
    expect(stripped).toContain('2. [ ] api')

    root.tui.stop()
    root.destroy()
  })

  it('typing while a question is open feeds the Other row, not the editor', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = setQuestion(state, {
      header: 'Pick',
      question: 'Name it',
      options: [{ label: 'alpha' }],
      multiSelect: false,
      focused: 0,
      selected: [],
      custom: '',
    })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    for (const ch of 'zed') vt.sendInput(ch)
    await settle()

    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('Other: zed')
    // The editor draft stays empty — printable keys never reached it.
    expect(driver.state.draft).toBe('')

    root.tui.stop()
    root.destroy()
  })

  it('renders the model picker with entries, focus marker, current marker, and footer', async () => {
    const vt = new VirtualTerminal(80, 24)
    const entries: CatalogEntryView[] = [
      { provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { provider: 'deepseek-official', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      { provider: 'openai', id: 'gpt-5', name: 'GPT-5' },
    ]
    let state = setModelPicker(createInitialState(), {
      entries,
      focused: 1,
      current: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('Select model')
    expect(stripped).toContain('deepseek-official/deepseek-v4-flash — DeepSeek V4 Flash')
    expect(stripped).toContain('deepseek-official/deepseek-v4-pro — DeepSeek V4 Pro')
    expect(stripped).toContain('openai/gpt-5 — GPT-5')
    // Focus marker sits on the focused (index 1) entry.
    expect(stripped).toContain('❯ deepseek-official/deepseek-v4-pro')
    // Current-model marker on the active route.
    expect(stripped).toMatch(/deepseek-v4-pro.*\*/)
    // Footer hint.
    expect(stripped).toContain('move')
    expect(stripped).toContain('enter select')
    expect(stripped).toContain('esc cancel')

    root.tui.stop()
    root.destroy()
  })

  it('never renders more rows than the visible-window cap for a long catalog', async () => {
    const vt = new VirtualTerminal(80, 24)
    // 25 entries — well past the cap.
    const entries: CatalogEntryView[] = Array.from({ length: 25 }, (_, i) => ({
      provider: 'p',
      id: `m${i + 1}`,
      name: `Model ${i + 1}`,
    }))
    let state = setModelPicker(createInitialState(), {
      entries,
      focused: 0,
    })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const stripped = stripAnsi(vt.grid().join('\n'))
    // The first and last catalog entries cannot both be visible when the
    // window caps at MODEL_PICKER_VISIBLE_ROWS (10).
    expect(stripped).toContain('p/m1 — Model 1')
    expect(stripped).not.toContain('p/m25 — Model 25')
    // Count rendered entry rows (lines containing "p/m") — must not exceed the cap.
    const entryLines = stripped.split('\n').filter(l => l.includes('p/m'))
    expect(entryLines.length).toBeLessThanOrEqual(10)

    root.tui.stop()
    root.destroy()
  })

  it('enter on the focused model picker entry selects it and emits the status row', async () => {
    const vt = new VirtualTerminal(80, 24)
    const entries: CatalogEntryView[] = [
      { provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'Flash' },
      { provider: 'openai', id: 'gpt-5', name: 'GPT-5' },
    ]
    let state = setModelPicker(createInitialState(), { entries, focused: 1 })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    vt.sendInput('\r')
    await settle()

    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('Model is now openai/gpt-5.')
    // Overlay dismissed.
    expect(stripped).not.toContain('Select model')

    root.tui.stop()
    root.destroy()
  })

  it('renders the effort picker with entries, focus marker, current marker, and footer', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = setEffortPicker(createInitialState(), {
      entries: ['minimal', 'high', 'default'],
      focused: 1,
      current: 'high',
    })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('Select effort')
    expect(stripped).toContain('minimal')
    // The trailing reserved entry is labeled with its provider-default role.
    expect(stripped).toContain('default (provider)')
    // Focus marker sits on the focused (index 1) entry.
    expect(stripped).toContain('❯ high')
    // Current-effort marker.
    expect(stripped).toMatch(/❯ high.*\*/)
    // Footer hint.
    expect(stripped).toContain('move')
    expect(stripped).toContain('enter select')
    expect(stripped).toContain('esc cancel')

    // Closed → not rendered.
    driver.setState(setEffortPicker(state, undefined))
    await settle()
    expect(stripAnsi(vt.grid().join('\n'))).not.toContain('Select effort')

    root.tui.stop()
    root.destroy()
  })

  it('arrow down on the mounted root moves the effort picker focus one row', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = setEffortPicker(createInitialState(), {
      entries: ['minimal', 'high', 'default'],
      focused: 0,
      current: undefined,
    })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    vt.sendInput('\x1b[B') // ↓
    await settle()
    expect(driver.state.effortPicker?.focused).toBe(1)

    vt.sendInput('\x1b') // esc closes
    await settle()
    expect(driver.state.effortPicker).toBeUndefined()

    root.tui.stop()
    root.destroy()
  })

  it('renders the permission picker with labels, focus marker, current marker, and footer', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = setPermissionPicker(createInitialState(), {
      entries: [
        { id: 'default', label: 'Default', detail: 'Follow rules' },
        { id: 'acceptEdits', label: 'Accept edits', detail: 'Auto-allow edits' },
        { id: 'plan', label: 'Plan', detail: 'Read-only' },
      ],
      focused: 1,
      current: 'acceptEdits',
    })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('Select permission mode')
    expect(stripped).toContain('Default')
    expect(stripped).toContain('Accept edits')
    expect(stripped).toContain('Plan')
    expect(stripped).toContain('❯ Accept edits')
    expect(stripped).toMatch(/❯ Accept edits.*\*/)
    expect(stripped).toContain('move')
    expect(stripped).toContain('enter select')
    expect(stripped).toContain('esc cancel')

    driver.setState(setPermissionPicker(state, undefined))
    await settle()
    expect(stripAnsi(vt.grid().join('\n'))).not.toContain('Select permission mode')

    root.tui.stop()
    root.destroy()
  })

  it('renders the bypass confirmation copy while confirmingBypass is set', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = setPermissionPicker(createInitialState(), {
      entries: [
        { id: 'default', label: 'Default', detail: 'Follow rules' },
        { id: 'bypassPermissions', label: 'Bypass permissions', detail: 'Skip prompts' },
      ],
      focused: 1,
      current: 'default',
      confirmingBypass: true,
    })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('Enable Bypass permissions?')
    expect(stripped).toContain('Bypass permissions skips approval prompts')
    expect(stripped).toContain('enter confirm')
    expect(stripped).toContain('esc back')
    expect(stripped).not.toContain('Select permission mode')

    root.tui.stop()
    root.destroy()
  })

  it('arrow down on the mounted root moves the permission picker focus one row', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = setPermissionPicker(createInitialState(), {
      entries: [
        { id: 'default', label: 'Default', detail: 'Follow rules' },
        { id: 'acceptEdits', label: 'Accept edits', detail: 'Auto-allow edits' },
        { id: 'plan', label: 'Plan', detail: 'Read-only' },
      ],
      focused: 0,
      current: 'default',
    })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    vt.sendInput('\x1b[B') // ↓
    await settle()
    expect(driver.state.permissionPicker?.focused).toBe(1)

    vt.sendInput('\x1b') // esc closes
    await settle()
    expect(driver.state.permissionPicker).toBeUndefined()

    root.tui.stop()
    root.destroy()
  })

  it('renders the session switcher with title, rows, current marker, and footer', async () => {
    const vt = new VirtualTerminal(80, 24)
    const sessions: SessionEntryView[] = [
      { id: 's-newest', createdAt: Date.now() - 60_000 },
      { id: 's-cur', cwd: '/tmp/proj', createdAt: Date.now() - 3_600_000 },
      { id: 's-old', createdAt: Date.now() - 86_400_000 },
    ]
    let state = setSessionSwitcher(createInitialState(), {
      sessions,
      focused: 1,
      switching: false,
      currentId: 's-cur',
      query: '',
      scope: 'cwd',
    })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('Resume session')
    // Short id (first 8 chars)
    expect(stripped).toContain('s-newest')
    expect(stripped).toContain('s-cur')
    expect(stripped).toContain('s-old')
    // Focus marker on index 1 (relative date sits between marker and id)
    expect(stripped).toContain('❯')
    expect(stripped).toMatch(/❯.*s-cur/)
    // Current-session marker (●)
    expect(stripped).toMatch(/s-cur.*●/)
    // Footer
    expect(stripped).toContain('move')
    expect(stripped).toContain('enter resume')
    expect(stripped).toContain('tab all projects')
    expect(stripped).toContain('type to filter')
    expect(stripped).toContain('esc close')

    root.tui.stop()
    root.destroy()
  })

  it('renders Switching… while a switch is in flight', async () => {
    const vt = new VirtualTerminal(80, 24)
    const sessions: SessionEntryView[] = [
      { id: 's-a', createdAt: Date.now() },
      { id: 's-b', createdAt: Date.now() - 1000 },
    ]
    let state = setSessionSwitcher(createInitialState(), {
      sessions,
      focused: 0,
      switching: true,
      currentId: 's-a',
      query: '',
      scope: 'cwd',
    })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('Switching')
    expect(stripped).not.toContain('enter switch')

    root.tui.stop()
    root.destroy()
  })

  it('renders an error status row with red SGR (not dim)', () => {
    const row = { kind: 'status' as const, text: '⚠ Turn failed: boom', error: true }
    const rendered = renderRowText(row)
    // Red SGR (\x1b[31m) wraps the text — error rows are never dim.
    expect(rendered).toContain('\x1b[31m')
    expect(rendered).not.toContain('\x1b[2m')
    expect(rendered).toContain('⚠ Turn failed: boom')
  })

  it('renders a plain status row dim with no red', () => {
    const row = { kind: 'status' as const, text: 'done' }
    const rendered = renderRowText(row)
    expect(rendered).toContain('\x1b[2m')
    expect(rendered).not.toContain('\x1b[31m')
  })

  it('renders a banner row verbatim (pre-styled, no theme wrap)', () => {
    const art = whaleBannerArt()
    const rendered = renderRowText({ kind: 'banner', text: art })
    expect(rendered).toBe(art)
  })

  it('hides tool output behind a dim summary when toolOutputExpanded is false', () => {
    const row = {
      kind: 'tool' as const,
      callId: 'c1',
      name: 'bash',
      args: '{}',
      title: 'ls -la',
      running: false,
      result: 'file one\nfile two\nfile three',
    }
    const rendered = renderRowText(row, { toolOutputExpanded: false })
    const stripped = rendered.replace(/\x1b\[[0-9;]*m/g, '')
    // Head line survives; the result body is dropped.
    expect(stripped).toContain('ls -la ✓')
    expect(stripped).not.toContain('file one')
    expect(stripped).toContain('▸ output (3 lines — Ctrl+O to toggle)')
  })

  it('collapses diff hunks to the summary line when toolOutputExpanded is false', () => {
    const row = {
      kind: 'tool' as const,
      callId: 'c2',
      name: 'Edit',
      args: '{}',
      title: 'Edit foo.ts',
      running: false,
      diffs: [{ path: 'foo.ts', oldText: 'old line\n', newText: 'new line\n' }],
    }
    const rendered = renderRowText(row, { toolOutputExpanded: false })
    const stripped = rendered.replace(/\x1b\[[0-9;]*m/g, '')
    expect(stripped).toContain('Edit foo.ts')
    expect(stripped).not.toContain('- old line')
    expect(stripped).not.toContain('+ new line')
    expect(stripped).toContain('▸ output (')
    expect(stripped).toContain('Ctrl+O to toggle')
  })

  it('omits the summary line for a collapsed tool row with no output at all', () => {
    const row = {
      kind: 'tool' as const,
      callId: 'c3',
      name: 'bash',
      args: '',
      title: 'noop',
      running: false,
    }
    const rendered = renderRowText(row, { toolOutputExpanded: false })
    expect(rendered).not.toContain('▸ output')
    expect(rendered).toContain('noop')
  })

  it('keeps tool output expanded by default (toolOutputExpanded defaults to true)', () => {
    const row = {
      kind: 'tool' as const,
      callId: 'c4',
      name: 'bash',
      args: '{}',
      title: 'ls -la',
      running: false,
      result: 'file one\nfile two',
    }
    // No options at all, and an options object without the flag — both must
    // keep the existing expanded rendering so old callers stay compatible.
    for (const options of [undefined, { thinkingExpanded: true }]) {
      const rendered = renderRowText(row, options)
      expect(rendered).toContain('file one')
      expect(rendered).not.toContain('▸ output')
    }
  })

  it('renders the collapsed thinking hint with toggle wording (not expand)', () => {
    const row = { kind: 'thinking' as const, text: 'a\nb\nc' }
    const rendered = renderRowText(row)
    const stripped = rendered.replace(/\x1b\[[0-9;]*m/g, '')
    expect(stripped).toContain('▸ thinking (3 lines — Ctrl+O to toggle)')
    expect(stripped).not.toContain('Ctrl+O to expand')
  })

  it('clears the editor text after submitting on Enter (regression — ff49148)', async () => {
    const vt = new VirtualTerminal(80, 24)
    const driver = fakeDriver()
    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    for (const ch of 'hi') vt.sendInput(ch)
    await settle()
    expect(root.editor.getText()).toBe('hi')

    vt.sendInput('\r')
    await settle()

    // The editor's own submitValue() clears its text. The ff49148 bypass
    // consumed \r before the editor, so the editor never cleared — this
    // guard catches that reintroduction.
    expect(root.editor.getText()).toBe('')

    root.tui.stop()
    root.destroy()
  })

  it('Ctrl+C (\\x03) when busy calls interrupt and does not quit', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = setBusy(createInitialState(), true)
    const driver = fakeDriver(state)
    let interrupted = 0
    driver.interrupt = () => { interrupted++ }
    let quitCalled = false
    const root = buildRoot(driver, { terminal: vt, onQuit: () => { quitCalled = true } })
    root.tui.start()
    await settle()

    vt.sendInput('\x03')
    await settle()

    expect(interrupted).toBe(1)
    expect(quitCalled).toBe(false)

    root.tui.stop()
    root.destroy()
  })

  it('a single idle Ctrl+C shows the exit hint and does not quit', async () => {
    const vt = new VirtualTerminal(80, 24)
    const driver = fakeDriver(createInitialState())
    let interrupted = 0
    driver.interrupt = () => { interrupted++ }
    let quitCalled = false
    const root = buildRoot(driver, { terminal: vt, onQuit: () => { quitCalled = true } })
    root.tui.start()
    await settle()

    vt.sendInput('\x03')
    await settle()

    // First press only anchors the double-press window and hints.
    expect(quitCalled).toBe(false)
    expect(interrupted).toBe(0)
    expect(driver.state.notice).toBe('Press Ctrl+C again to exit')
    expect(driver.state.lastExitAttemptAt).toBeDefined()
    expect(stripAnsi(vt.grid().join('\n'))).toContain('Press Ctrl+C again to exit')

    root.tui.stop()
    root.destroy()
  })

  it('a second Ctrl+C within the double-press window quits', async () => {
    const vt = new VirtualTerminal(80, 24)
    const driver = fakeDriver(createInitialState())
    let interrupted = 0
    driver.interrupt = () => { interrupted++ }
    let quitCalled = false
    const root = buildRoot(driver, { terminal: vt, onQuit: () => { quitCalled = true } })
    root.tui.start()
    await settle()

    vt.sendInput('\x03')
    await settle()
    vt.sendInput('\x03')
    await settle()

    expect(quitCalled).toBe(true)
    expect(interrupted).toBe(0)

    root.tui.stop()
    root.destroy()
  })

  it('an idle Ctrl+C after the double-press window expired hints again instead of quitting', async () => {
    const vt = new VirtualTerminal(80, 24)
    // Seed a stale exit attempt well outside the double-press window.
    const driver = fakeDriver(markExitAttempt(createInitialState(), Date.now() - 10_000))
    let quitCalled = false
    const root = buildRoot(driver, { terminal: vt, onQuit: () => { quitCalled = true } })
    root.tui.start()
    await settle()

    vt.sendInput('\x03')
    await settle()

    expect(quitCalled).toBe(false)
    expect(driver.state.notice).toBe('Press Ctrl+C again to exit')
    // The stale anchor was replaced with a fresh one.
    expect(driver.state.lastExitAttemptAt).toBeGreaterThan(Date.now() - 10_000)

    root.tui.stop()
    root.destroy()
  })

  it('opens the todo panel on ctrl+t with status icons, focus marker, and footer', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = setTodos(state, [
      { content: 'done thing', status: 'completed' },
      { content: 'active thing', status: 'in_progress' },
      { content: 'later thing', status: 'pending' },
    ])
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    vt.sendInput('\x14') // ctrl+t
    await settle()

    expect(driver.state.todoPanel).toEqual({ focused: 0 })
    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('Todos')
    expect(stripped).toContain('☑ done thing')
    expect(stripped).toContain('◐ active thing')
    expect(stripped).toContain('☐ later thing')
    // Focus marker sits on the first row.
    expect(stripped).toContain('❯ ☑ done thing')
    // Footer hint.
    expect(stripped).toContain('↑↓ navigate')
    expect(stripped).toContain('Esc close')
    // The one-line todo strip is unaffected while the panel is open.
    expect(stripped).toContain('☐ 1/3 · active thing')
    // Modal: printable keys are consumed by the panel, never the editor.
    vt.sendInput('x')
    await settle()
    expect(root.editor.getText()).toBe('')

    root.tui.stop()
    root.destroy()
  })

  it('closes the todo panel on a second ctrl+t (toggle)', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = setTodos(state, [{ content: 'only task', status: 'pending' }])
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    vt.sendInput('\x14') // ctrl+t — open
    await settle()
    expect(driver.state.todoPanel).toEqual({ focused: 0 })

    vt.sendInput('\x14') // ctrl+t — close
    await settle()
    expect(driver.state.todoPanel).toBeUndefined()
    expect(stripAnsi(vt.grid().join('\n'))).not.toContain('↑↓ navigate')

    root.tui.stop()
    root.destroy()
  })

  it('moves the todo panel focus with arrow keys (clamped, no wrap)', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = setTodos(state, [
      { content: 'first', status: 'pending' },
      { content: 'second', status: 'in_progress' },
      { content: 'third', status: 'pending' },
    ])
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    vt.sendInput('\x14') // ctrl+t — open
    await settle()
    vt.sendInput('\x1b[B') // arrow down
    await settle()
    expect(driver.state.todoPanel).toEqual({ focused: 1 })
    let stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('❯ ◐ second')
    expect(stripped).not.toContain('❯ ☐ first')

    vt.sendInput('\x1b[A') // arrow up
    await settle()
    expect(driver.state.todoPanel).toEqual({ focused: 0 })
    stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('❯ ☐ first')

    // Clamp at the top — does not wrap.
    vt.sendInput('\x1b[A')
    await settle()
    expect(driver.state.todoPanel).toEqual({ focused: 0 })

    root.tui.stop()
    root.destroy()
  })

  it('closes the todo panel on escape', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = setTodos(state, [{ content: 'a task', status: 'pending' }])
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    vt.sendInput('\x14') // ctrl+t — open
    await settle()
    expect(driver.state.todoPanel).toEqual({ focused: 0 })

    vt.sendInput('\x1b') // escape — close
    await settle()
    expect(driver.state.todoPanel).toBeUndefined()
    expect(stripAnsi(vt.grid().join('\n'))).not.toContain('↑↓ navigate')

    root.tui.stop()
    root.destroy()
  })

  it('shows a placeholder when the todo panel opens with no todos', async () => {
    const vt = new VirtualTerminal(80, 24)
    const driver = fakeDriver(createInitialState())

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    vt.sendInput('\x14') // ctrl+t — open
    await settle()

    expect(driver.state.todoPanel).toEqual({ focused: 0 })
    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('Todos')
    expect(stripped).toContain('No todos')

    root.tui.stop()
    root.destroy()
  })
})

/**
 * /usage panel over a real driver: the fakeDriver above cannot run local
 * slash commands, so these tests mount createDriver against a projections
 * stub and drive the panel through the actual submit path.
 */
describe('vt /usage panel (real driver)', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-vt-usage-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  function makeCtx(states: Record<string, unknown>) {
    return {
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
            onChanged: () => () => {},
            stateOf: (_session: unknown, key: string) => states[key],
          }
        }
        return undefined
      },
      on: () => () => {},
      agents: {
        create: async () => ({
          agent: {
            options: {},
            session: { id: 's-a', header: {}, events: [], snapshotEvents() { return this.events } },
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
  }

  async function makeUsageDriver(states: Record<string, unknown>) {
    return createDriver(makeCtx(states) as never, { cwd: '/w/proj', branchProbe: async () => undefined })
  }

  it('opens the usage panel via /usage with the context bar and token rows', async () => {
    const vt = new VirtualTerminal(80, 24)
    const driver = await makeUsageDriver({
      tokenUsage: {
        totals: { uncachedInputTokens: 12_345, outputTokens: 1_234, cacheReadTokens: 5_678, cacheWriteTokens: 901 },
        last: null,
      },
      contextPressure: {
        contextWindow: 200_000,
        pressureTokens: 85_000,
        surfaceTokens: 3_000,
        sampledSurfaceTokens: 2_000,
      },
      contextBreakdown: { system: 1_200, tools: 3_400, messages: 81_400 },
    })

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    await driver.submit('/usage')
    await settle()

    expect(driver.state.usagePanel).toEqual({})
    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('Usage')
    expect(stripped).toContain('████░░░░░░ 43% (86k/200k)')
    expect(stripped).toContain('12,345')
    expect(stripped).toContain('81,400')
    expect(stripped).toContain('quota data unavailable · Esc close')

    root.tui.stop()
    root.destroy()
    await driver.dispose()
  })

  it('closes the usage panel on escape', async () => {
    const vt = new VirtualTerminal(80, 24)
    const driver = await makeUsageDriver({})

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    await driver.submit('/usage')
    await settle()
    expect(driver.state.usagePanel).toEqual({})

    vt.sendInput('\x1b') // escape — close
    await settle()

    expect(driver.state.usagePanel).toBeUndefined()
    expect(stripAnsi(vt.grid().join('\n'))).not.toContain('quota data unavailable')

    root.tui.stop()
    root.destroy()
    await driver.dispose()
  })

  it('renders every section as n/a when the projections have no data', async () => {
    const vt = new VirtualTerminal(80, 24)
    const driver = await makeUsageDriver({})

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    await driver.submit('/usage')
    await settle()

    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('Usage')
    expect(stripped).toContain('n/a')
    expect(stripped).toContain('quota data unavailable · Esc close')

    root.tui.stop()
    root.destroy()
    await driver.dispose()
  })
})
describe('kitty release events', () => {
  function pickerState(): TuiState {
    let state = createInitialState()
    state = setModelPicker(state, {
      entries: [
        { provider: 'p', id: 'm1', name: 'Model One' },
        { provider: 'p', id: 'm2', name: 'Model Two' },
        { provider: 'p', id: 'm3', name: 'Model Three' },
      ],
      focused: 0,
    })
    return state
  }

  it('a kitty press+release pair moves the /model picker focus exactly one row', async () => {
    const vt = new VirtualTerminal(80, 24)
    const driver = fakeDriver(pickerState())

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    // Kitty flag 2 (report event types) delivers a release event after every
    // physical press. The release must not trigger a second move.
    vt.sendInput('\x1b[B') // press
    vt.sendInput('\x1b[1;1:3B') // release
    await settle()
    expect(driver.state.modelPicker?.focused).toBe(1)

    root.tui.stop()
    root.destroy()
  })

  it('kitty release does not dismiss the picker via escape', async () => {
    const vt = new VirtualTerminal(80, 24)
    const driver = fakeDriver(pickerState())

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    vt.sendInput('\x1b[1;1:3A') // release of ↑ alone — no press, no action
    await settle()
    expect(driver.state.modelPicker?.focused).toBe(0)
    expect(driver.state.modelPicker).toBeDefined()

    root.tui.stop()
    root.destroy()
  })

  it('kitty repeat events still autoscroll the picker', async () => {
    const vt = new VirtualTerminal(80, 24)
    const driver = fakeDriver(pickerState())

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    // Holding ↓: one press + one repeat must move two rows.
    vt.sendInput('\x1b[1;1:1B') // press (event type 1)
    vt.sendInput('\x1b[1;1:2B') // repeat (event type 2)
    await settle()
    expect(driver.state.modelPicker?.focused).toBe(2)

    root.tui.stop()
    root.destroy()
  })
})
