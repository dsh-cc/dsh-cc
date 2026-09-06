/**
 * The coordinator-mode system-prompt section: states the orchestration role, the
 * available delegation tools, and the result-return protocol a coordinator agent
 * runs under.
 *
 * @module @dsh-cc/coordinator/section
 */

/** Prompt order: within the tool-guidance band, before per-tool sections. */
export const COORDINATOR_SECTION_ORDER = 110

/**
 * The fixed orchestration guidance installed when coordinator mode is active.
 * It names the delegation surface a coordinator acts through and pins the
 * result-return protocol to the subagent report seam, so a coordinator never
 * mistakes direct code-editing for its job and knows how worker results come
 * back.
 */
export const COORDINATOR_SECTION_TEXT
  = 'Coordinator mode: you orchestrate workers instead of doing the work yourself. '
    + 'Delegate tasks with spawn_worker, redirect or extend one with send_to_worker, '
    + 'reach all of them with worker_broadcast, and review them with worker_tasks. '
    + 'Do not edit the workspace directly: assign that work to a worker. Each worker '
    + 'reports its result through the report tool, which lands back in your conversation '
    + 'as a waking message naming the worker; a worker that ends without reporting '
    + 'still notifies you so you can decide whether to resume it.'
