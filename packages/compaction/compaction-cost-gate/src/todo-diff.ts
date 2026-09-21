/**
 * Pure `todo_write` snapshot differ. Detection-side only: on any transition
 * of a todo to `completed` (against the previous snapshot) the boundary arms.
 * Identity is the todo's `content` string — the content hash — so rewrites,
 * reorders, and status-only churn are distinguished correctly.
 * @module @dsh-cc/compaction-cost-gate/todo-diff
 */

import type { TodoItem } from './types.ts'

/** Result of diffing one `todo_write` arguments array against the previous snapshot. */
export interface TodoDiff {
  /** True when at least one todo newly transitioned to completed. */
  readonly armed: boolean
  /** Content of the newly completed todos, in snapshot order. */
  readonly newlyCompleted: readonly string[]
  /** Cumulative completed count after applying this snapshot. */
  readonly completedSteps: number
  /** Non-completed todo count after applying this snapshot. */
  readonly pendingSteps: number
  /** The new content → status snapshot to store. */
  readonly snapshot: ReadonlyMap<string, string>
}

/**
 * Diff one new todos array against the previous snapshot.
 * @param prev - the stored content → status map (empty on cold start).
 * @param todos - the parsed `todos` array from the tool arguments.
 * @returns the arm decision, counts, and the snapshot to persist in state.
 */
export function diffTodos(
  prev: ReadonlyMap<string, string>,
  todos: readonly TodoItem[],
): TodoDiff {
  const snapshot = new Map<string, string>()
  for (const todo of todos) snapshot.set(todo.content, todo.status)
  const newlyCompleted: string[] = []
  for (const todo of todos) {
    if (todo.status === 'completed' && prev.get(todo.content) !== 'completed') {
      newlyCompleted.push(todo.content)
    }
  }
  let completedSteps = 0
  let pendingSteps = 0
  for (const status of snapshot.values()) {
    if (status === 'completed') completedSteps += 1
    else pendingSteps += 1
  }
  return {
    armed: newlyCompleted.length > 0,
    newlyCompleted,
    completedSteps,
    pendingSteps,
    snapshot,
  }
}
