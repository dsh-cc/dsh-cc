import { describe, expect, it } from 'vitest'
import { handleComposerInput, routeWorktreeExitInput, type InputSink } from '@dsh-cc/tui/input.ts'
import { createInitialState, setWorktreeExit, type TuiState } from '@dsh-cc/tui/store.ts'

interface WorktreeExitCalls {
  moved: number[]
  submitted: number
  cancelled: number
}

function sink(initial: TuiState = createInitialState()): InputSink & { worktreeExitCalls: WorktreeExitCalls } {
  let state = initial
  const calls: WorktreeExitCalls = { moved: [], submitted: 0, cancelled: 0 }
  return {
    get state() {
      return state
    },
    interrupt() {},
    cyclePermissionMode() {},
    toggleThinking() {},
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
    effortPickerMove() {},
    effortPickerSubmit() {},
    effortPickerCancel() {},
    permissionPickerMove() {},
    permissionPickerSubmit() {},
    permissionPickerCancel() {},
    sessionSwitcherMove() {},
    sessionSwitcherType() {},
    sessionSwitcherBackspace() {},
    sessionSwitcherToggleScope() {},
    sessionSwitcherSubmit() {},
    sessionSwitcherCancel() {},
    toggleTodoPanel() {},
    todoPanelMove() {},
    todoPanelClose() {},
    usagePanelClose() {},
    worktreeExitMove(delta) {
      calls.moved.push(delta)
    },
    async worktreeExitSubmit() {
      calls.submitted += 1
    },
    worktreeExitCancel() {
      calls.cancelled += 1
    },
    async dispose() {},
    worktreeExitCalls: calls,
  }
}

function worktreeExitState(overrides: Partial<NonNullable<TuiState['worktreeExit']>> = {}): TuiState {
  return setWorktreeExit(createInitialState(), {
    repoRoot: '/repo',
    worktreePath: '/repo/.claude/worktrees/feat',
    branch: 'worktree-feat',
    managed: true,
    ownsBranch: true,
    focused: 0,
    busy: false,
    ...overrides,
  })
}

describe('routeWorktreeExitInput', () => {
  it('arrow up moves focus up (-1)', () => {
    const driver = sink(worktreeExitState({ focused: 1 }))
    routeWorktreeExitInput(driver, '\x1b[A')
    expect(driver.worktreeExitCalls.moved).toEqual([-1])
  })

  it('arrow down moves focus down (+1)', () => {
    const driver = sink(worktreeExitState())
    routeWorktreeExitInput(driver, '\x1b[B')
    expect(driver.worktreeExitCalls.moved).toEqual([1])
  })

  it('enter submits the focused option', () => {
    const driver = sink(worktreeExitState())
    routeWorktreeExitInput(driver, '\r')
    expect(driver.worktreeExitCalls.submitted).toBe(1)
  })

  it('escape cancels the overlay', () => {
    const driver = sink(worktreeExitState())
    routeWorktreeExitInput(driver, '\x1b')
    expect(driver.worktreeExitCalls.cancelled).toBe(1)
  })

  it('all other keys are consumed and never reach other handlers (modal)', () => {
    const driver = sink(worktreeExitState())
    for (const key of ['h', ' ', '2', '\x7f', 'abc']) {
      routeWorktreeExitInput(driver, key)
    }
    expect(driver.worktreeExitCalls.moved).toEqual([])
    expect(driver.worktreeExitCalls.submitted).toBe(0)
    expect(driver.worktreeExitCalls.cancelled).toBe(0)
  })
})

describe('handleComposerInput worktree-exit routing', () => {
  it('routes keys to the overlay while it is open (composer path)', () => {
    const driver = sink(worktreeExitState())
    handleComposerInput(driver, '\x1b[A')
    expect(driver.worktreeExitCalls.moved).toEqual([-1])
    handleComposerInput(driver, '\r')
    expect(driver.worktreeExitCalls.submitted).toBe(1)
    handleComposerInput(driver, '\x1b')
    expect(driver.worktreeExitCalls.cancelled).toBe(1)
  })

  it('reports a no-exit action while the overlay is open', () => {
    const driver = sink(worktreeExitState())
    expect(handleComposerInput(driver, '\r')).toEqual({ kind: 'none' })
  })

  it('does not toggle thinking while the overlay is open (overlay wins)', () => {
    const driver = sink(worktreeExitState())
    handleComposerInput(driver, '\x0f') // ctrl+o would toggleThinking
    // No global handler state toggled: the overlay branch returns first.
    expect(handleComposerInput(driver, '\x1b')).toEqual({ kind: 'none' })
  })
})
