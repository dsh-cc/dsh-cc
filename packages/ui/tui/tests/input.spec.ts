import { describe, expect, it } from 'vitest'
import { handleComposerInput, type InputSink } from '@dsh-cc/tui/input.ts'
import {
  closeUsagePanel,
  createInitialState,
  openTodoPanel,
  openUsagePanel,
  setApproval,
  setBusy,
  setEffortPicker,
  setModelPicker,
  setPermissionPicker,
  setQuestion,
  setSessionSwitcher,
  setTodos,
  type CatalogEntryView,
  type EffortPickerView,
  type ModelPickerView,
  type PermissionPickerView,
  type QuestionView,
  type SessionEntryView,
  type SessionSwitcherView,
  type TuiState,
} from '@dsh-cc/tui/store.ts'

interface QuestionCalls {
  moved: number[]
  toggled: number
  picked: number[]
  typed: string[]
  backspaced: number
  submitted: number
  cancelled: number
}

interface ModelPickerCalls {
  moved: number[]
  submitted: number
  cancelled: number
}

interface EffortPickerCalls {
  moved: number[]
  submitted: number
  cancelled: number
}

interface PermissionPickerCalls {
  moved: number[]
  submitted: number
  cancelled: number
}

interface SessionSwitcherCalls {
  moved: number[]
  typed: string[]
  backspaced: number
  scopeToggled: number
  submitted: number
  cancelled: number
}

interface TodoPanelCalls {
  moved: number[]
  closed: number
  toggled: number
}

interface UsagePanelCalls {
  closed: number
}

function sink(initial: TuiState = createInitialState()): InputSink & {
  disposed: boolean
  interrupted: boolean
  cycled: boolean
  toggled: boolean
  questionCalls: QuestionCalls
  modelPickerCalls: ModelPickerCalls
  effortPickerCalls: EffortPickerCalls
  permissionPickerCalls: PermissionPickerCalls
  sessionSwitcherCalls: SessionSwitcherCalls
  todoPanelCalls: TodoPanelCalls
  usagePanelCalls: UsagePanelCalls
} {
  let state = initial
  const questionCalls: QuestionCalls = {
    moved: [],
    toggled: 0,
    picked: [],
    typed: [],
    backspaced: 0,
    submitted: 0,
    cancelled: 0,
  }
  const modelPickerCalls: ModelPickerCalls = {
    moved: [],
    submitted: 0,
    cancelled: 0,
  }
  const effortPickerCalls: EffortPickerCalls = {
    moved: [],
    submitted: 0,
    cancelled: 0,
  }
  const permissionPickerCalls: PermissionPickerCalls = {
    moved: [],
    submitted: 0,
    cancelled: 0,
  }
  const sessionSwitcherCalls: SessionSwitcherCalls = {
    moved: [],
    typed: [],
    backspaced: 0,
    scopeToggled: 0,
    submitted: 0,
    cancelled: 0,
  }
  const todoPanelCalls: TodoPanelCalls = {
    moved: [],
    closed: 0,
    toggled: 0,
  }
  const usagePanelCalls: UsagePanelCalls = {
    closed: 0,
  }
  return {
    disposed: false,
    interrupted: false,
    cycled: false,
    toggled: false,
    questionCalls,
    modelPickerCalls,
    effortPickerCalls,
    permissionPickerCalls,
    sessionSwitcherCalls,
    todoPanelCalls,
    usagePanelCalls,
    get state() {
      return state
    },
    interrupt() {
      this.interrupted = true
    },
    async cyclePermissionMode() {
      this.cycled = true
    },
    toggleThinking() {
      this.toggled = true
      state = { ...state, thinkingExpanded: !state.thinkingExpanded }
    },
    answerApproval() {},
    questionMove(delta) {
      questionCalls.moved.push(delta)
    },
    questionToggle() {
      questionCalls.toggled += 1
    },
    questionPick(index) {
      questionCalls.picked.push(index)
    },
    questionType(text) {
      questionCalls.typed.push(text)
    },
    questionBackspace() {
      questionCalls.backspaced += 1
    },
    questionSubmit() {
      questionCalls.submitted += 1
    },
    questionCancel() {
      questionCalls.cancelled += 1
    },
    modelPickerMove(delta) {
      modelPickerCalls.moved.push(delta)
    },
    modelPickerSubmit() {
      modelPickerCalls.submitted += 1
    },
    modelPickerCancel() {
      modelPickerCalls.cancelled += 1
    },
    effortPickerMove(delta) {
      effortPickerCalls.moved.push(delta)
    },
    effortPickerSubmit() {
      effortPickerCalls.submitted += 1
    },
    effortPickerCancel() {
      effortPickerCalls.cancelled += 1
    },
    permissionPickerMove(delta) {
      permissionPickerCalls.moved.push(delta)
    },
    permissionPickerSubmit() {
      permissionPickerCalls.submitted += 1
    },
    permissionPickerCancel() {
      permissionPickerCalls.cancelled += 1
    },
    sessionSwitcherMove(delta) {
      sessionSwitcherCalls.moved.push(delta)
    },
    sessionSwitcherType(text) {
      sessionSwitcherCalls.typed.push(text)
    },
    sessionSwitcherBackspace() {
      sessionSwitcherCalls.backspaced += 1
    },
    sessionSwitcherToggleScope() {
      sessionSwitcherCalls.scopeToggled += 1
    },
    async sessionSwitcherSubmit() {
      sessionSwitcherCalls.submitted += 1
    },
    sessionSwitcherCancel() {
      sessionSwitcherCalls.cancelled += 1
    },
    toggleTodoPanel() {
      todoPanelCalls.toggled += 1
    },
    todoPanelMove(delta) {
      todoPanelCalls.moved.push(delta)
    },
    todoPanelClose() {
      todoPanelCalls.closed += 1
    },
    usagePanelClose() {
      usagePanelCalls.closed += 1
    },
    async dispose() {
      this.disposed = true
    },
  }
}

function questionState(overrides: Partial<QuestionView> = {}): TuiState {
  return setQuestion(createInitialState(), {
    header: 'Pick',
    question: 'Which?',
    options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }],
    multiSelect: false,
    focused: 0,
    selected: [],
    custom: '',
    ...overrides,
  })
}

describe('handleComposerInput', () => {
  it('answers an approval overlay with once on 1 or y/Y', () => {
    const answers: string[] = []
    const driver = sink(setApproval(createInitialState(), { toolName: 'Bash' }))
    driver.answerApproval = kind => {
      answers.push(kind)
    }
    for (const key of ['1', 'y', 'Y']) {
      handleComposerInput(driver, key)
      expect(answers.at(-1)).toBe('once')
    }
    expect(answers).toHaveLength(3)
  })

  it('answers an approval overlay with reject on 2, n/N, or escape', () => {
    const answers: string[] = []
    const driver = sink(setApproval(createInitialState(), { toolName: 'Bash' }))
    driver.answerApproval = kind => {
      answers.push(kind)
    }
    for (const key of ['2', 'n', 'N', '\x1b']) {
      handleComposerInput(driver, key)
      expect(answers.at(-1)).toBe('reject')
    }
    expect(answers).toHaveLength(4)
  })

  it('answers an approval overlay with always on 3 or a/A', () => {
    const answers: string[] = []
    const driver = sink(setApproval(createInitialState(), { toolName: 'Bash' }))
    driver.answerApproval = kind => {
      answers.push(kind)
    }
    for (const key of ['3', 'a', 'A']) {
      handleComposerInput(driver, key)
      expect(answers.at(-1)).toBe('always')
    }
    expect(answers).toHaveLength(3)
  })

  it('answers an approval overlay with session on 4 or s/S', () => {
    const answers: string[] = []
    const driver = sink(setApproval(createInitialState(), { toolName: 'Bash' }))
    driver.answerApproval = kind => {
      answers.push(kind)
    }
    for (const key of ['4', 's', 'S']) {
      handleComposerInput(driver, key)
      expect(answers.at(-1)).toBe('session')
    }
    expect(answers).toHaveLength(3)
  })

  it('does not toggle thinking while an approval overlay is open (overlay wins)', () => {
    const driver = sink(setApproval(createInitialState(), { toolName: 'Bash' }))
    handleComposerInput(driver, '\x0f')
    expect(driver.toggled).toBe(false)
  })

  it('an approval overlay outranks an open question (input goes to the approval)', () => {
    const answers: string[] = []
    let state = setApproval(createInitialState(), { toolName: 'Bash' })
    state = setQuestion(state, {
      header: 'Pick',
      question: 'Which?',
      options: [{ label: 'a' }],
      multiSelect: false,
      focused: 0,
      selected: [],
      custom: '',
    })
    const driver = sink(state)
    driver.answerApproval = kind => {
      answers.push(kind)
    }
    handleComposerInput(driver, '1')
    expect(answers).toEqual(['once'])
    expect(driver.questionCalls.submitted).toBe(0)
    expect(driver.questionCalls.picked).toEqual([])
  })
})

describe('handleComposerInput question routing', () => {
  it('arrow up moves focus up (-1)', () => {
    const driver = sink(questionState({ focused: 2 }))
    const action = handleComposerInput(driver, '\x1b[A')
    expect(driver.questionCalls.moved).toEqual([-1])
    expect(action).toEqual({ kind: 'none' })
  })

  it('arrow down moves focus down (+1)', () => {
    const driver = sink(questionState())
    handleComposerInput(driver, '\x1b[B')
    expect(driver.questionCalls.moved).toEqual([1])
  })

  it('space toggles the focused option', () => {
    const driver = sink(questionState({ multiSelect: true }))
    handleComposerInput(driver, ' ')
    expect(driver.questionCalls.toggled).toBe(1)
  })

  it('enter submits', () => {
    const driver = sink(questionState())
    handleComposerInput(driver, '\r')
    expect(driver.questionCalls.submitted).toBe(1)
  })

  it('backspace edits the custom buffer', () => {
    const driver = sink(questionState())
    handleComposerInput(driver, '\x7f')
    expect(driver.questionCalls.backspaced).toBe(1)
  })

  it('escape cancels (dismisses with the first option)', () => {
    const driver = sink(questionState())
    handleComposerInput(driver, '\x1b')
    expect(driver.questionCalls.cancelled).toBe(1)
  })

  it('digits jump to (and pick/toggle) the numbered option', () => {
    const driver = sink(questionState())
    handleComposerInput(driver, '2')
    expect(driver.questionCalls.picked).toEqual([1])
  })

  it('printable characters type into the free-text buffer', () => {
    const driver = sink(questionState())
    handleComposerInput(driver, 'h')
    handleComposerInput(driver, 'i')
    expect(driver.questionCalls.typed).toEqual(['h', 'i'])
  })

  it('a digit beyond the option count is consumed and routed; the driver bounds-checks', () => {
    const driver = sink(questionState())
    const action = handleComposerInput(driver, '9')
    // Routed as pick(8) — the real driver ignores out-of-range indexes
    // (covered in driver-question.spec); the key is still consumed.
    expect(driver.questionCalls.picked).toEqual([8])
    expect(driver.questionCalls.typed).toEqual([])
    expect(action).toEqual({ kind: 'none' })
  })

  it('unknown sequences are consumed (never fall through to the editor)', () => {
    const driver = sink(questionState())
    // paste-like multi-char payload: not a key we understand, still consumed
    const action = handleComposerInput(driver, 'abc')
    expect(action).toEqual({ kind: 'none' })
    expect(driver.questionCalls.typed).toEqual([])
  })

  it('all question keys are consumed, not passed to the editor path', () => {
    const driver = sink(questionState())
    for (const key of ['\x1b[A', '\x1b[B', ' ', '\r', '\x7f', 'h', '2', '\x1b']) {
      expect(handleComposerInput(driver, key)).toEqual({ kind: 'none' })
    }
    expect(driver.questionCalls.moved).toEqual([-1, 1])
    expect(driver.questionCalls.toggled).toBe(1)
    expect(driver.questionCalls.submitted).toBe(1)
    expect(driver.questionCalls.backspaced).toBe(1)
    expect(driver.questionCalls.typed).toEqual(['h'])
    expect(driver.questionCalls.picked).toEqual([1])
    expect(driver.questionCalls.cancelled).toBe(1)
  })
})

const PICKER_ENTRIES: readonly CatalogEntryView[] = [
  { provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'Flash' },
  { provider: 'openai', id: 'gpt-5', name: 'GPT-5' },
]

function pickerState(overrides: Partial<ModelPickerView> = {}): TuiState {
  return setModelPicker(createInitialState(), {
    entries: PICKER_ENTRIES,
    focused: 0,
    ...overrides,
  })
}

describe('handleComposerInput model picker routing', () => {
  it('arrow up moves focus up (-1)', () => {
    const driver = sink(pickerState({ focused: 1 }))
    const action = handleComposerInput(driver, '\x1b[A')
    expect(driver.modelPickerCalls.moved).toEqual([-1])
    expect(action).toEqual({ kind: 'none' })
  })

  it('arrow down moves focus down (+1)', () => {
    const driver = sink(pickerState())
    handleComposerInput(driver, '\x1b[B')
    expect(driver.modelPickerCalls.moved).toEqual([1])
  })

  it('enter submits the focused entry', () => {
    const driver = sink(pickerState())
    handleComposerInput(driver, '\r')
    expect(driver.modelPickerCalls.submitted).toBe(1)
  })

  it('escape cancels the picker', () => {
    const driver = sink(pickerState())
    handleComposerInput(driver, '\x1b')
    expect(driver.modelPickerCalls.cancelled).toBe(1)
  })

  it('all other keys are consumed and never reach the editor (modal)', () => {
    const driver = sink(pickerState())
    for (const key of ['h', ' ', '2', '\x7f', 'abc']) {
      expect(handleComposerInput(driver, key)).toEqual({ kind: 'none' })
    }
    // Nothing routed to question handlers (no question open).
    expect(driver.questionCalls.moved).toEqual([])
    expect(driver.questionCalls.typed).toEqual([])
    // Nothing routed to global handlers.
    expect(driver.cycled).toBe(false)
    expect(driver.toggled).toBe(false)
    expect(driver.interrupted).toBe(false)
  })

  it('a question overlay outranks the model picker (precedence: approval > question > modelPicker)', () => {
    let state = setQuestion(createInitialState(), {
      header: 'Pick',
      question: 'Which?',
      options: [{ label: 'a' }],
      multiSelect: false,
      focused: 0,
      selected: [],
      custom: '',
    })
    state = setModelPicker(state, { entries: PICKER_ENTRIES, focused: 0 })
    const driver = sink(state)
    handleComposerInput(driver, '\r')
    expect(driver.questionCalls.submitted).toBe(1)
    expect(driver.modelPickerCalls.submitted).toBe(0)
  })

  it('does not toggle thinking while a model picker is open (overlay wins)', () => {
    const driver = sink(pickerState())
    handleComposerInput(driver, '\x0f')
    expect(driver.toggled).toBe(false)
  })

  it('does not interrupt on escape while a model picker is open (cancel wins)', () => {
    const driver = sink(setBusy(pickerState(), true))
    handleComposerInput(driver, '\x1b')
    expect(driver.interrupted).toBe(false)
    expect(driver.modelPickerCalls.cancelled).toBe(1)
  })
})

function effortPickerState(overrides: Partial<EffortPickerView> = {}): TuiState {
  return setEffortPicker(createInitialState(), {
    entries: ['minimal', 'high', 'default'],
    focused: 0,
    current: undefined,
    ...overrides,
  })
}

describe('handleComposerInput effort picker routing', () => {
  it('arrow up moves focus up (-1)', () => {
    const driver = sink(effortPickerState({ focused: 1 }))
    const action = handleComposerInput(driver, '\x1b[A')
    expect(driver.effortPickerCalls.moved).toEqual([-1])
    expect(action).toEqual({ kind: 'none' })
  })

  it('arrow down moves focus down (+1)', () => {
    const driver = sink(effortPickerState())
    handleComposerInput(driver, '\x1b[B')
    expect(driver.effortPickerCalls.moved).toEqual([1])
  })

  it('enter submits the focused entry', () => {
    const driver = sink(effortPickerState())
    handleComposerInput(driver, '\r')
    expect(driver.effortPickerCalls.submitted).toBe(1)
  })

  it('escape cancels the picker', () => {
    const driver = sink(effortPickerState())
    handleComposerInput(driver, '\x1b')
    expect(driver.effortPickerCalls.cancelled).toBe(1)
  })

  it('all other keys are consumed and never reach the editor (modal)', () => {
    const driver = sink(effortPickerState())
    for (const key of ['h', ' ', '2', '\x7f', 'abc']) {
      expect(handleComposerInput(driver, key)).toEqual({ kind: 'none' })
    }
    // Nothing routed to the effort picker handlers.
    expect(driver.effortPickerCalls.moved).toEqual([])
    expect(driver.effortPickerCalls.submitted).toBe(0)
    expect(driver.effortPickerCalls.cancelled).toBe(0)
    // Nothing routed to global handlers.
    expect(driver.cycled).toBe(false)
    expect(driver.toggled).toBe(false)
    expect(driver.interrupted).toBe(false)
  })

  it('a question overlay outranks the effort picker (precedence: approval > question > modelPicker > effortPicker)', () => {
    let state = setQuestion(createInitialState(), {
      header: 'Pick',
      question: 'Which?',
      options: [{ label: 'a' }],
      multiSelect: false,
      focused: 0,
      selected: [],
      custom: '',
    })
    state = setEffortPicker(state, { entries: ['minimal', 'default'], focused: 0, current: undefined })
    const driver = sink(state)
    handleComposerInput(driver, '\r')
    expect(driver.questionCalls.submitted).toBe(1)
    expect(driver.effortPickerCalls.submitted).toBe(0)
  })

  it('does not toggle thinking while an effort picker is open (overlay wins)', () => {
    const driver = sink(effortPickerState())
    handleComposerInput(driver, '\x0f')
    expect(driver.toggled).toBe(false)
  })

  it('does not interrupt on escape while an effort picker is open (cancel wins)', () => {
    const driver = sink(setBusy(effortPickerState(), true))
    handleComposerInput(driver, '\x1b')
    expect(driver.interrupted).toBe(false)
    expect(driver.effortPickerCalls.cancelled).toBe(1)
  })
})

const PERMISSION_ENTRIES: PermissionPickerView['entries'] = [
  { id: 'default', label: 'Default', detail: 'Follow rules' },
  { id: 'acceptEdits', label: 'Accept edits', detail: 'Auto-allow edits' },
  { id: 'plan', label: 'Plan', detail: 'Read-only' },
  { id: 'auto', label: 'Auto', detail: 'Auto-allow low-risk' },
  { id: 'bypassPermissions', label: 'Bypass permissions', detail: 'Skip prompts' },
]

function permissionPickerState(overrides: Partial<PermissionPickerView> = {}): TuiState {
  return setPermissionPicker(createInitialState(), {
    entries: PERMISSION_ENTRIES,
    focused: 0,
    current: 'default',
    ...overrides,
  })
}

describe('handleComposerInput permission picker routing', () => {
  it('arrow up moves focus up (-1)', () => {
    const driver = sink(permissionPickerState({ focused: 1 }))
    const action = handleComposerInput(driver, '\x1b[A')
    expect(driver.permissionPickerCalls.moved).toEqual([-1])
    expect(action).toEqual({ kind: 'none' })
  })

  it('arrow down moves focus down (+1)', () => {
    const driver = sink(permissionPickerState())
    handleComposerInput(driver, '\x1b[B')
    expect(driver.permissionPickerCalls.moved).toEqual([1])
  })

  it('enter submits the focused entry', () => {
    const driver = sink(permissionPickerState())
    handleComposerInput(driver, '\r')
    expect(driver.permissionPickerCalls.submitted).toBe(1)
  })

  it('escape cancels the picker', () => {
    const driver = sink(permissionPickerState())
    handleComposerInput(driver, '\x1b')
    expect(driver.permissionPickerCalls.cancelled).toBe(1)
  })

  it('all other keys are consumed and never reach the editor (modal)', () => {
    const driver = sink(permissionPickerState())
    for (const key of ['h', ' ', '2', '\x7f', 'abc']) {
      expect(handleComposerInput(driver, key)).toEqual({ kind: 'none' })
    }
    expect(driver.permissionPickerCalls.moved).toEqual([])
    expect(driver.permissionPickerCalls.submitted).toBe(0)
    expect(driver.permissionPickerCalls.cancelled).toBe(0)
    expect(driver.cycled).toBe(false)
    expect(driver.toggled).toBe(false)
    expect(driver.interrupted).toBe(false)
  })

  it('shift+tab is swallowed while the picker is open (no cycle behind the overlay)', () => {
    const driver = sink(permissionPickerState())
    handleComposerInput(driver, '\x1b[Z')
    expect(driver.cycled).toBe(false)
    expect(driver.permissionPickerCalls.moved).toEqual([])
    expect(driver.permissionPickerCalls.submitted).toBe(0)
    expect(driver.permissionPickerCalls.cancelled).toBe(0)
  })

  it('an effort picker outranks the permission picker (precedence: modelPicker > effortPicker > permissionPicker)', () => {
    let state = setEffortPicker(createInitialState(), {
      entries: ['minimal', 'default'],
      focused: 0,
      current: undefined,
    })
    state = setPermissionPicker(state, {
      entries: PERMISSION_ENTRIES,
      focused: 0,
      current: 'default',
    })
    const driver = sink(state)
    handleComposerInput(driver, '\r')
    expect(driver.effortPickerCalls.submitted).toBe(1)
    expect(driver.permissionPickerCalls.submitted).toBe(0)
  })

  it('a permission picker outranks the session switcher', () => {
    let state = setPermissionPicker(createInitialState(), {
      entries: PERMISSION_ENTRIES,
      focused: 0,
      current: 'default',
    })
    state = setSessionSwitcher(state, {
      sessions: [{ id: 's-1', createdAt: 1 }],
      focused: 0,
      switching: false,
      currentId: 's-1',
      query: '',
      scope: 'cwd',
    })
    const driver = sink(state)
    handleComposerInput(driver, '\r')
    expect(driver.permissionPickerCalls.submitted).toBe(1)
    expect(driver.sessionSwitcherCalls.submitted).toBe(0)
  })

  it('does not toggle thinking while a permission picker is open (overlay wins)', () => {
    const driver = sink(permissionPickerState())
    handleComposerInput(driver, '\x0f')
    expect(driver.toggled).toBe(false)
  })

  it('does not interrupt on escape while a permission picker is open (cancel wins)', () => {
    const driver = sink(setBusy(permissionPickerState(), true))
    handleComposerInput(driver, '\x1b')
    expect(driver.interrupted).toBe(false)
    expect(driver.permissionPickerCalls.cancelled).toBe(1)
  })
})

describe('handleComposerInput global keys', () => {
  it('cycles permission mode on shift+tab', () => {
    const driver = sink()
    handleComposerInput(driver, '\x1b[Z')
    expect(driver.cycled).toBe(true)
  })

  it('interrupts on escape when busy', () => {
    const driver = sink(setBusy(createInitialState(), true))
    handleComposerInput(driver, '\x1b')
    expect(driver.interrupted).toBe(true)
  })

  it('treats ctrl+c as an exit', () => {
    const driver = sink()
    const action = handleComposerInput(driver, '\x03')
    expect(action).toEqual({ kind: 'quit' })
    expect(driver.disposed).toBe(true)
  })

  it('toggles thinking on ctrl+o and consumes the key', () => {
    const driver = sink()
    const action = handleComposerInput(driver, '\x0f') // ctrl+o
    expect(driver.toggled).toBe(true)
    expect(driver.state.thinkingExpanded).toBe(true)
    expect(action).toEqual({ kind: 'none' })
  })
})

const SESSION_ENTRIES: readonly SessionEntryView[] = [
  { id: 's-second', createdAt: 2000 },
  { id: 's-first', createdAt: 1000 },
]

function switcherState(overrides: Partial<SessionSwitcherView> = {}): TuiState {
  return setSessionSwitcher(createInitialState(), {
    sessions: SESSION_ENTRIES,
    focused: 0,
    switching: false,
    currentId: 's-first',
    query: '',
    scope: 'cwd',
    ...overrides,
  })
}

describe('handleComposerInput session switcher routing', () => {
  it('arrow up moves focus up (-1)', () => {
    const driver = sink(switcherState({ focused: 1 }))
    const action = handleComposerInput(driver, '\x1b[A')
    expect(driver.sessionSwitcherCalls.moved).toEqual([-1])
    expect(action).toEqual({ kind: 'none' })
  })

  it('arrow down moves focus down (+1)', () => {
    const driver = sink(switcherState())
    handleComposerInput(driver, '\x1b[B')
    expect(driver.sessionSwitcherCalls.moved).toEqual([1])
  })

  it('enter submits the focused session', () => {
    const driver = sink(switcherState())
    handleComposerInput(driver, '\r')
    expect(driver.sessionSwitcherCalls.submitted).toBe(1)
  })

  it('escape cancels the switcher (the two-stage clear-then-close lives in the driver)', () => {
    const driver = sink(switcherState())
    handleComposerInput(driver, '\x1b')
    expect(driver.sessionSwitcherCalls.cancelled).toBe(1)
  })

  it('tab toggles the scope', () => {
    const driver = sink(switcherState())
    const action = handleComposerInput(driver, '\t')
    expect(driver.sessionSwitcherCalls.scopeToggled).toBe(1)
    expect(action).toEqual({ kind: 'none' })
  })

  it('shift+tab is consumed but is NOT the scope toggle (plain tab only)', () => {
    const driver = sink(switcherState())
    handleComposerInput(driver, '\x1b[Z')
    expect(driver.sessionSwitcherCalls.scopeToggled).toBe(0)
  })

  it('backspace edits the query filter', () => {
    const driver = sink(switcherState())
    handleComposerInput(driver, '\x7f')
    expect(driver.sessionSwitcherCalls.backspaced).toBe(1)
  })

  it('printable characters type into the query filter', () => {
    const driver = sink(switcherState())
    handleComposerInput(driver, 'f')
    handleComposerInput(driver, 'i')
    expect(driver.sessionSwitcherCalls.typed).toEqual(['f', 'i'])
  })

  it('all other keys are consumed and never reach the editor (modal)', () => {
    const driver = sink(switcherState())
    for (const key of ['h', ' ', '2', '\x7f', 'abc']) {
      expect(handleComposerInput(driver, key)).toEqual({ kind: 'none' })
    }
    expect(driver.questionCalls.moved).toEqual([])
    expect(driver.questionCalls.typed).toEqual([])
    expect(driver.cycled).toBe(false)
    expect(driver.toggled).toBe(false)
    expect(driver.interrupted).toBe(false)
  })

  it('while switching, all keys are consumed without action', () => {
    const driver = sink(switcherState({ switching: true }))
    for (const key of ['\x1b[A', '\x1b[B', '\r', '\x1b', 'h']) {
      expect(handleComposerInput(driver, key)).toEqual({ kind: 'none' })
    }
    expect(driver.sessionSwitcherCalls.moved).toEqual([])
    expect(driver.sessionSwitcherCalls.submitted).toBe(0)
    expect(driver.sessionSwitcherCalls.cancelled).toBe(0)
  })

  it('a model picker outranks the session switcher (precedence: approval > question > modelPicker > sessionSwitcher)', () => {
    let state = setModelPicker(createInitialState(), { entries: PICKER_ENTRIES, focused: 0 })
    state = setSessionSwitcher(state, {
      sessions: SESSION_ENTRIES,
      focused: 0,
      switching: false,
      currentId: 's-first',
      query: '',
      scope: 'cwd',
    })
    const driver = sink(state)
    handleComposerInput(driver, '\r')
    expect(driver.modelPickerCalls.submitted).toBe(1)
    expect(driver.sessionSwitcherCalls.submitted).toBe(0)
  })

  it('does not interrupt on escape while a session switcher is open (cancel wins)', () => {
    const driver = sink(setBusy(switcherState(), true))
    handleComposerInput(driver, '\x1b')
    expect(driver.interrupted).toBe(false)
    expect(driver.sessionSwitcherCalls.cancelled).toBe(1)
  })
})

function todoPanelState(): TuiState {
  return openTodoPanel(setTodos(createInitialState(), [
    { content: 'a', status: 'pending' },
    { content: 'b', status: 'pending' },
  ]))
}

describe('handleComposerInput todo panel routing', () => {
  it('arrow up routes todoPanelMove(-1) while the panel is open', () => {
    const driver = sink(todoPanelState())
    const action = handleComposerInput(driver, '\x1b[A')
    expect(driver.todoPanelCalls.moved).toEqual([-1])
    expect(action).toEqual({ kind: 'none' })
  })

  it('arrow down routes todoPanelMove(+1) while the panel is open', () => {
    const driver = sink(todoPanelState())
    handleComposerInput(driver, '\x1b[B')
    expect(driver.todoPanelCalls.moved).toEqual([1])
  })

  it('escape closes the panel', () => {
    const driver = sink(todoPanelState())
    handleComposerInput(driver, '\x1b')
    expect(driver.todoPanelCalls.closed).toBe(1)
  })

  it('ctrl+t on the global path toggles the panel open', () => {
    const driver = sink()
    const action = handleComposerInput(driver, '\x14') // ctrl+t
    expect(driver.todoPanelCalls.toggled).toBe(1)
    expect(action).toEqual({ kind: 'none' })
  })

  it('ctrl+t while the panel is open routes into the panel (close), not the toggle path', () => {
    const driver = sink(todoPanelState())
    handleComposerInput(driver, '\x14')
    expect(driver.todoPanelCalls.closed).toBe(1)
    expect(driver.todoPanelCalls.toggled).toBe(0)
  })

  it('all other keys are consumed and never reach the editor (modal)', () => {
    const driver = sink(todoPanelState())
    for (const key of ['h', ' ', '2', '\x7f', 'abc', '\x0f', '\x1b[Z']) {
      expect(handleComposerInput(driver, key)).toEqual({ kind: 'none' })
    }
    expect(driver.cycled).toBe(false)
    expect(driver.toggled).toBe(false)
    expect(driver.interrupted).toBe(false)
  })

  it('does not interrupt on escape while the panel is open and the agent is busy (close wins)', () => {
    const driver = sink(setBusy(todoPanelState(), true))
    handleComposerInput(driver, '\x1b')
    expect(driver.interrupted).toBe(false)
    expect(driver.todoPanelCalls.closed).toBe(1)
  })

  it('a session switcher outranks the todo panel (overlay precedence)', () => {
    let state = todoPanelState()
    state = setSessionSwitcher(state, {
      sessions: SESSION_ENTRIES,
      focused: 0,
      switching: false,
      currentId: 's-first',
      query: '',
      scope: 'cwd',
    })
    const driver = sink(state)
    handleComposerInput(driver, '\r')
    expect(driver.sessionSwitcherCalls.submitted).toBe(1)
    expect(driver.todoPanelCalls.closed).toBe(0)
  })
})

describe('usage panel routing', () => {
  function usagePanelState(): TuiState {
    return openUsagePanel(createInitialState())
  }

  it('esc closes the usage panel while it is open', () => {
    const driver = sink(usagePanelState())
    const action = handleComposerInput(driver, '\x1b')
    expect(driver.usagePanelCalls.closed).toBe(1)
    expect(action).toEqual({ kind: 'none' })
  })

  it('the usage panel is modal: every other key is consumed without action', () => {
    const driver = sink(usagePanelState())
    for (const key of ['h', ' ', '2', '\x7f', '\x1b[A', '\x1b[B', '\x1b[Z', '\x14']) {
      expect(handleComposerInput(driver, key)).toEqual({ kind: 'none' })
    }
    // No navigation, no toggle side effects — Esc (tested above) is the only
    // action the panel recognizes.
    expect(driver.usagePanelCalls.closed).toBe(0)
    expect(driver.todoPanelCalls.toggled).toBe(0)
    expect(driver.cycled).toBe(false)
    expect(driver.toggled).toBe(false)
    expect(driver.interrupted).toBe(false)
  })

  it('does not interrupt on escape while the panel is open and the agent is busy (close wins)', () => {
    const driver = sink(setBusy(usagePanelState(), true))
    handleComposerInput(driver, '\x1b')
    expect(driver.interrupted).toBe(false)
    expect(driver.usagePanelCalls.closed).toBe(1)
  })

  it('esc with the usage panel closed falls through to the generic escape path', () => {
    const driver = sink(setBusy(createInitialState(), true))
    handleComposerInput(driver, '\x1b')
    expect(driver.interrupted).toBe(true)
    expect(driver.usagePanelCalls.closed).toBe(0)
  })

  it('closeUsagePanel drops the field entirely (store round-trip)', () => {
    const state = closeUsagePanel(usagePanelState())
    expect(state.usagePanel).toBeUndefined()
  })
})
