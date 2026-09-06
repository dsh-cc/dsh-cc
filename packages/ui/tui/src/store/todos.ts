/**
 * Todo reducers: whole-list writes from the projection feed and the Ctrl+T
 * panel overlay.
 * @module @dsh-cc/tui/store/todos
 */
import type { TodoItemView, TodoPanelView, TuiState } from './views.ts'

/**
 * Replace the session todo list (whole-list last-wins from the projection
 * feed), or clear it when `todos` is undefined. Returns the same state
 * reference when the clear finds nothing to drop.
 */
export function setTodos(state: TuiState, todos: readonly TodoItemView[] | undefined): TuiState {
  if (todos === undefined) {
    if (state.todos === undefined) return state
    const { todos: _dropped, ...rest } = state
    return rest
  }
  return { ...state, todos }
}

/** Park or clear the Ctrl+T todo panel overlay. */
export function setTodoPanel(state: TuiState, panel: TodoPanelView | undefined): TuiState {
  if (panel === undefined) {
    if (state.todoPanel === undefined) return state
    const { todoPanel: _dropped, ...rest } = state
    return rest
  }
  return { ...state, todoPanel: panel }
}

/** Open the todo panel, focused on the first row (empty list included). */
export function openTodoPanel(state: TuiState): TuiState {
  return setTodoPanel(state, { focused: 0 })
}

/** Close the todo panel. */
export function closeTodoPanel(state: TuiState): TuiState {
  return setTodoPanel(state, undefined)
}

/**
 * Move the todo-panel focus by one row, clamped to [0, todos.length-1]
 * (no wrap). A no-op when the panel is closed or the todo list is empty or
 * absent — those return the same state reference.
 */
export function moveTodoPanelFocus(state: TuiState, delta: -1 | 1): TuiState {
  const panel = state.todoPanel
  const todos = state.todos
  if (panel === undefined || todos === undefined || todos.length === 0) return state
  const max = todos.length - 1
  const focused = Math.max(0, Math.min(panel.focused + delta, max))
  if (focused === panel.focused) return state
  return setTodoPanel(state, { focused })
}

/**
 * Condense `state.todos` for the one-line strip: total count, completed
 * count, and the first in-progress content (`active`, omitted when nothing
 * is running). Undefined when there are no todos to show.
 */
export function todoSummary(state: TuiState): { total: number; done: number; active?: string } | undefined {
  const todos = state.todos
  if (todos === undefined || todos.length === 0) return undefined
  let done = 0
  let active: string | undefined
  for (const todo of todos) {
    if (todo.status === 'completed') done += 1
    else if (todo.status === 'in_progress' && active === undefined) active = todo.content
  }
  return { total: todos.length, done, ...active === undefined ? {} : { active } }
}
