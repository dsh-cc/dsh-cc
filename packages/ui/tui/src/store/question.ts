/**
 * Ask-user-question reducers: focus/toggle/type navigation over QuestionView.
 * @module @dsh-cc/tui/store/question
 */
import type { QuestionView, TuiState } from './views.ts'

/** Park or clear an ask-user prompt. */
export function setQuestion(state: TuiState, question: QuestionView | undefined): TuiState {
  const { question: _dropped, ...rest } = state
  return question === undefined ? rest : { ...rest, question }
}

/** Focus a question row by index, clamped to [0, options.length]. */
export function focusQuestionOption(state: TuiState, index: number): TuiState {
  const question = state.question
  if (question === undefined) return state
  const focused = Math.max(0, Math.min(index, question.options.length))
  return setQuestion(state, { ...question, focused })
}

/** Move the question focus by one row (clamped; no wrap). */
export function moveQuestionFocus(state: TuiState, delta: -1 | 1): TuiState {
  const question = state.question
  if (question === undefined) return state
  return focusQuestionOption(state, question.focused + delta)
}

/**
 * Focus an option row and toggle its label in `selected` (multi-select).
 * Out-of-range indexes are a no-op returning the same state reference.
 */
export function toggleQuestionOption(state: TuiState, index: number): TuiState {
  const question = state.question
  if (question === undefined) return state
  const option = question.options[index]
  if (option === undefined) return state
  const selected = question.selected.includes(option.label)
    ? question.selected.filter(label => label !== option.label)
    : [...question.selected, option.label]
  return setQuestion(state, { ...question, focused: index, selected })
}

/** Append free text to the "Other" buffer and focus that row. */
export function typeQuestionText(state: TuiState, text: string): TuiState {
  const question = state.question
  if (question === undefined || text.length === 0) return state
  return setQuestion(state, {
    ...question,
    custom: question.custom + text,
    focused: question.options.length,
  })
}

/** Drop the last character of the "Other" buffer (keeps focus on that row). */
export function backspaceQuestionText(state: TuiState): TuiState {
  const question = state.question
  if (question === undefined || question.custom.length === 0) return state
  return setQuestion(state, {
    ...question,
    custom: question.custom.slice(0, -1),
    focused: question.options.length,
  })
}
