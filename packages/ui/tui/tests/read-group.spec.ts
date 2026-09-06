import { describe, expect, it } from 'vitest'
import { Terminal as XtermTerminal } from '@xterm/headless'
import { type Terminal as PiTerminal } from '@dsh-cc/pi-tui'
import { buildRoot } from '@dsh-cc/tui/components/root.ts'
import {
  groupReadRows,
  READ_GROUP_LIST_MAX_CHARS,
  readGroupCacheKey,
  renderReadGroup,
} from '@dsh-cc/tui/components/read-group.ts'
import { TranscriptView } from '@dsh-cc/tui/components/transcript.ts'
import type { Driver } from '@dsh-cc/tui/state/driver-types.ts'
import { clearQueue, createInitialState, popQueued, toggleGlobalCollapse, upsertRow, type TuiState, type TranscriptRow } from '@dsh-cc/tui/store.ts'

/** Build a completed Read tool row targeting `filePath`. */
function readRow(callId: string, filePath: string, overrides: Partial<Extract<TranscriptRow, { kind: 'tool' }>> = {}): TranscriptRow {
  return {
    kind: 'tool',
    callId,
    name: 'Read',
    args: JSON.stringify({ file_path: filePath }),
    title: `Read ${filePath}`,
    running: false,
    ...overrides,
  }
}

/** Strip SGR sequences for structural assertions. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

/**
 * Minimal pi-tui Terminal that pipes write() calls into an @xterm/headless
 * Terminal so the test can assert on the rendered grid. Mirrors the fixture
 * in vt-renderer.spec.ts, kept local to avoid coupling to that shared file.
 */
class VirtualTerminal implements PiTerminal {
  private readonly xterm: XtermTerminal
  private inputHandler?: (data: string) => void
  private readonly resizeHandler = (): void => {}
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
}

/**
 * Minimal Driver fake: holds state and notifies subscribers; the overlay and
 * session methods are no-ops because this spec never exercises them.
 */
function fakeDriver(initial: TuiState = createInitialState()): Driver & { setState(next: TuiState): void } {
  let state = initial
  const listeners = new Set<(s: TuiState) => void>()
  const emit = (): void => { for (const l of listeners) l(state) }
  const noop = (): void => {}
  const asyncNoop = async (): Promise<void> => {}
  return {
    get state() { return state },
    get statusLine() { return 'test · status' },
    statusLineIn: () => 'test · status',
    get cwd() { return process.cwd() },
    get promptHistory() { return [] },
    get bashHistory() { return [] },
    subscribe(listener) {
      listeners.add(listener)
      listener(state)
      return () => { listeners.delete(listener) }
    },
    setDraft(draft) { state = { ...state, draft }; emit() },
    async submit(text) {
      const draft = text ?? state.draft
      if (draft.trim().length === 0) return
      state = { ...state, draft: '' }
      emit()
    },
    interrupt() { state = { ...state, busy: false }; emit() },
    cyclePermissionMode: async () => {},
    toggleThinking() { state = { ...state, thinkingExpanded: !state.thinkingExpanded }; emit() },
    toggleGlobalCollapse() { state = toggleGlobalCollapse(state); emit() },
    answerApproval() { state = { ...state, approval: undefined }; emit() },
    questionMove: noop,
    questionToggle: noop,
    questionPick: noop,
    questionType: noop,
    questionBackspace: noop,
    questionSubmit: noop,
    questionCancel: noop,
    openModelPicker: asyncNoop,
    modelPickerMove: noop,
    modelPickerSubmit: noop,
    modelPickerCancel: noop,
    openEffortPicker: asyncNoop,
    effortPickerMove: noop,
    effortPickerSubmit: asyncNoop,
    effortPickerCancel: noop,
    openPermissionPicker: asyncNoop,
    permissionPickerMove: noop,
    permissionPickerSubmit: asyncNoop,
    permissionPickerCancel: noop,
    openSessionSwitcher: asyncNoop,
    sessionSwitcherMove: noop,
    sessionSwitcherType: noop,
    sessionSwitcherBackspace: noop,
    sessionSwitcherToggleScope: noop,
    sessionSwitcherSubmit: asyncNoop,
    sessionSwitcherCancel: noop,
    toggleTodoPanel: noop,
    todoPanelMove: noop,
    todoPanelClose: noop,
    usagePanelClose: noop,
    showNotice: noop,
    markExitAttempt: noop,
    steerQueued() { state = clearQueue(state); emit() },
    recallQueued() {
      const popped = popQueued(state)
      if (popped.text === undefined) return undefined
      state = popped.state
      emit()
      return popped.text
    },
    switchSession: asyncNoop,
    async listSessions() { return [] },
    listCommands() { return [] },
    dispose: asyncNoop,
    setState(next) { state = next; emit() },
  }
}

/** Wait for the throttled async render to settle. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 60))
}

describe('groupReadRows', () => {
  it('merges two consecutive completed Read rows into one group', () => {
    const items = groupReadRows([readRow('1', 'a.ts'), readRow('2', 'b.ts')])
    expect(items).toEqual([
      { kind: 'readGroup', rows: [readRow('1', 'a.ts'), readRow('2', 'b.ts')] },
    ])
  })

  it('keeps a single completed Read row ungrouped', () => {
    const row = readRow('1', 'a.ts')
    const items = groupReadRows([row])
    expect(items).toEqual([{ kind: 'row', row }])
  })

  it('breaks the group on a running Read', () => {
    const done1 = readRow('1', 'a.ts')
    const running = readRow('2', 'b.ts', { running: true })
    const done2 = readRow('3', 'c.ts')
    const items = groupReadRows([done1, running, done2])
    expect(items).toEqual([
      { kind: 'row', row: done1 },
      { kind: 'row', row: running },
      { kind: 'row', row: done2 },
    ])
  })

  it('breaks the group on an errored Read', () => {
    const done1 = readRow('1', 'a.ts')
    const failed = readRow('2', 'b.ts', { error: true })
    const items = groupReadRows([done1, failed])
    expect(items).toEqual([
      { kind: 'row', row: done1 },
      { kind: 'row', row: failed },
    ])
  })

  it('breaks the group on a non-Read tool row', () => {
    const done1 = readRow('1', 'a.ts')
    const bash: TranscriptRow = {
      kind: 'tool',
      callId: '2',
      name: 'bash',
      args: '{"command":"ls"}',
      title: 'ls',
      running: false,
    }
    const done2 = readRow('3', 'b.ts')
    const items = groupReadRows([done1, bash, done2])
    expect(items).toEqual([
      { kind: 'row', row: done1 },
      { kind: 'row', row: bash },
      { kind: 'row', row: done2 },
    ])
  })

  it('breaks the group on any non-tool row', () => {
    const done1 = readRow('1', 'a.ts')
    const note: TranscriptRow = { kind: 'status', text: 'compacted' }
    const done2 = readRow('2', 'b.ts')
    const items = groupReadRows([done1, note, done2])
    expect(items).toEqual([
      { kind: 'row', row: done1 },
      { kind: 'row', row: note },
      { kind: 'row', row: done2 },
    ])
  })

  it('folds read_image rows into the same group', () => {
    const done1 = readRow('1', 'a.ts')
    const image = readRow('2', 'b.png', { name: 'read_image' })
    const items = groupReadRows([done1, image])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'readGroup' })
    expect((items[0] as { rows: readonly TranscriptRow[] }).rows).toHaveLength(2)
  })

  it('matches the tool name case-insensitively', () => {
    const items = groupReadRows([readRow('1', 'a.ts', { name: 'READ' }), readRow('2', 'b.ts')])
    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe('readGroup')
  })

  it('forms one group per segment across interleaved breaks', () => {
    const rows = [
      readRow('1', 'a.ts'),
      readRow('2', 'b.ts'),
      { kind: 'thinking', text: 'hmm' } as TranscriptRow,
      readRow('3', 'c.ts'),
      readRow('4', 'd.ts'),
      readRow('5', 'e.ts'),
    ]
    const items = groupReadRows(rows)
    expect(items.map(item => item.kind)).toEqual(['readGroup', 'row', 'readGroup'])
  })

  it('returns an empty sequence for empty input', () => {
    expect(groupReadRows([])).toEqual([])
  })
})

describe('renderReadGroup', () => {
  it('renders the head with the file count and comma-separated paths', () => {
    const line = renderReadGroup([readRow('1', 'a.ts'), readRow('2', 'b.ts')])
    expect(stripAnsi(line)).toBe('⏺ Read 2 files · a.ts, b.ts')
  })

  it('appends +M more when the path list exceeds the display cap', () => {
    const rows = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'].map((p, i) => readRow(String(i), p))
    const line = stripAnsi(renderReadGroup(rows))
    expect(line).toContain('Read 6 files')
    expect(line).toContain('a.ts, b.ts, c.ts, d.ts')
    expect(line).toContain('+2 more')
    expect(line).not.toContain('e.ts')
  })

  it('prefers file_path from the args JSON over the title', () => {
    const row: TranscriptRow = {
      kind: 'tool',
      callId: '1',
      name: 'Read',
      args: '{"file_path":"src/real.ts"}',
      title: 'Read src/real.ts (verbose presenter title)',
      running: false,
    }
    expect(stripAnsi(renderReadGroup([row, readRow('2', 'b.ts')]))).toContain('src/real.ts')
    expect(stripAnsi(renderReadGroup([row, readRow('2', 'b.ts')]))).not.toContain('verbose')
  })

  it('falls back to the path key when file_path is absent', () => {
    const row: TranscriptRow = {
      kind: 'tool',
      callId: '1',
      name: 'Read',
      args: '{"path":"fallback/second.ts"}',
      title: 'ignored',
      running: false,
    }
    expect(stripAnsi(renderReadGroup([row, readRow('2', 'b.ts')]))).toContain('fallback/second.ts')
  })

  it('falls back to the title when args are unparseable', () => {
    const row: TranscriptRow = {
      kind: 'tool',
      callId: '1',
      name: 'Read',
      args: 'not json',
      title: 'titled.ts',
      running: false,
    }
    expect(stripAnsi(renderReadGroup([row, readRow('2', 'b.ts')]))).toContain('titled.ts')
  })

  it('falls back to the bare tool name when title is empty', () => {
    const row: TranscriptRow = {
      kind: 'tool',
      callId: '1',
      name: 'read',
      args: '{}',
      title: '',
      running: false,
    }
    const line = stripAnsi(renderReadGroup([row, readRow('2', 'b.ts')]))
    expect(line).not.toContain('undefined')
    // The bare name keeps the slot visible instead of rendering nothing.
    expect(line).toMatch(/⏺ Read 2 files · read, b\.ts/)
  })

  it('truncates an overlong path list with an ellipsis', () => {
    const longPath = `/very/deep/dir/${'segment/'.repeat(8)}leaf.ts`
    const rows = [1, 2, 3, 4, 5, 6].map(i => readRow(String(i), `${longPath}-${i}`))
    const line = stripAnsi(renderReadGroup(rows))
    expect(line).toContain('…')
    // Head + capped list + ellipsis + "+M more" suffix is the largest the
    // line can ever get.
    expect(line.length).toBeLessThanOrEqual(
      '⏺ Read 6 files · '.length + READ_GROUP_LIST_MAX_CHARS + 1 + ' +2 more'.length,
    )
  })
})

describe('readGroupCacheKey', () => {
  it('depends on member callIds, not row references', () => {
    const a = readRow('1', 'a.ts')
    const b = readRow('2', 'b.ts')
    const rebuiltA = readRow('1', 'a.ts', { result: 'new content arrived' })
    expect(readGroupCacheKey([a, b])).toBe(readGroupCacheKey([rebuiltA, b]))
  })

  it('changes when group membership changes', () => {
    const a = readRow('1', 'a.ts')
    const b = readRow('2', 'b.ts')
    expect(readGroupCacheKey([a])).not.toBe(readGroupCacheKey([a, b]))
  })
})

describe('TranscriptView read grouping', () => {
  it('renders a read group as one line and drops the per-row Read lines', () => {
    const view = new TranscriptView()
    view.setRows([
      { kind: 'user', text: 'look around' },
      readRow('1', 'a.ts'),
      readRow('2', 'b.ts'),
      readRow('3', 'c.ts'),
    ])
    const joined = stripAnsi(view.render(200).join('\n'))
    expect(joined).toContain('⏺ Read 3 files · a.ts, b.ts, c.ts')
    expect(joined).not.toContain('Read a.ts')
    expect(joined).toContain('> look around')
  })

  it('reuses the group child when member rows are replaced with same-callId objects', () => {
    const view = new TranscriptView()
    view.setRows([readRow('1', 'a.ts'), readRow('2', 'b.ts')])
    const grouped = view.children[0]

    // Results land: same callIds, brand-new row objects (store upserts in place).
    view.setRows([
      readRow('1', 'a.ts', { result: 'file contents' }),
      readRow('2', 'b.ts', { result: 'more contents' }),
    ])
    expect(view.children[0]).toBe(grouped)
  })

  it('rebuilds the group child when membership changes', () => {
    const view = new TranscriptView()
    view.setRows([readRow('1', 'a.ts'), readRow('2', 'b.ts')])
    const grouped = view.children[0]

    view.setRows([readRow('1', 'a.ts'), readRow('2', 'b.ts'), readRow('3', 'c.ts')])
    expect(view.children[0]).not.toBe(grouped)
  })

  it('keeps the group child stable across collapse-flag flips and collapses lone read rows', () => {
    const view = new TranscriptView()
    view.setRows([readRow('1', 'a.ts'), readRow('2', 'b.ts')])
    const grouped = view.children[0]

    // Flip the collapse flags without replacing any row object: the grouped
    // summary line is flag-independent, so its cached child must be reused
    // (a flag flip must not strand the group cache as stale).
    view.setRows([readRow('1', 'a.ts'), readRow('2', 'b.ts')], { toolOutputExpanded: false })
    expect(view.children[0]).toBe(grouped)

    // A lone (ungrouped) read row renders through the normal tool renderer,
    // so the same flip must re-collapse it behind the summary line.
    const lone = new TranscriptView()
    lone.setRows([readRow('1', 'a.ts')])
    lone.setRows([readRow('1', 'a.ts')], { toolOutputExpanded: false })
    const joined = stripAnsi(lone.render(200).join('\n'))
    expect(joined).toContain('▸ output (1 lines — Ctrl+O to toggle)')
    expect(joined).not.toContain('⎿')
  })

  it('still renders a single completed Read row through the normal tool renderer', () => {
    const view = new TranscriptView()
    view.setRows([readRow('1', 'a.ts')])
    const joined = stripAnsi(view.render(200).join('\n'))
    expect(joined).toContain('Read a.ts ✓')
    expect(joined).not.toContain('files ·')
  })

  it('applies the line budget to raw rows before grouping', () => {
    const view = new TranscriptView()
    const rows: TranscriptRow[] = []
    // Enough single-line rows to exceed the budget; the last two are Reads.
    for (let i = 0; i < 1999; i++) {
      rows.push({ kind: 'user', text: `filler ${i}`.padEnd(12) })
    }
    rows.push(readRow('r1', 'a.ts'), readRow('r2', 'b.ts'))
    view.setRows(rows)

    const joined = stripAnsi(view.render(200).join('\n'))
    // Budget clip fired on the raw rows...
    expect(joined).toContain('earlier output hidden')
    // ...and grouping still applies to the surviving tail.
    expect(joined).toContain('⏺ Read 2 files · a.ts, b.ts')
  })
})

describe('read grouping in the terminal grid', () => {
  it('collapses consecutive completed reads into one summary line on screen', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = upsertRow(state, {
      kind: 'tool',
      callId: 'read-1',
      name: 'Read',
      args: '{"file_path":"src/a.ts"}',
      title: 'Read src/a.ts',
      running: false,
    })
    state = upsertRow(state, {
      kind: 'tool',
      callId: 'read-2',
      name: 'read_image',
      args: '{"file_path":"img/b.png"}',
      title: 'read_image img/b.png',
      running: false,
    })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const stripped = stripAnsi(vt.grid().join('\n'))
    // One collapsed summary line with the arg-extracted paths…
    expect(stripped).toContain('⏺ Read 2 files · src/a.ts, img/b.png')
    // …and no per-row Read trail lines.
    expect(stripped).not.toContain('Read src/a.ts ✓')

    root.tui.stop()
    root.destroy()
  })
})
