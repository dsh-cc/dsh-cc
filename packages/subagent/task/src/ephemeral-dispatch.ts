/**
 * Ephemeral (read-only one-shot) dispatch: the §3.2 fail-fast copy constants,
 * capacity refusal, and the one-shot foreground dispatch used by `tool.ts`.
 * Extracted verbatim to keep that module under the file-size budget.
 *
 * @module @dsh-cc/subagent-task/ephemeral-dispatch
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRestriction } from '@dsh-cc/claude-code-agents'
import {
  assertLiveCapacity,
  MAX_LIVE_CONTINUABLE_CHILDREN,
  PROVIDER_SPAWN,
  type SubagentsLike,
} from './background-start.ts'
import { EPHEMERAL_TTL_KILL_COPY } from './ephemeral-reaper.ts'

/**
 * Fail-fast copy: explicit `run_in_background: true` on an ephemeral
 * (read-only one-shot) definition (§3.2). Names the workflow tool for fan-out.
 */
export const EPHEMERAL_BACKGROUND_REJECT =
  'ephemeral (read-only one-shot) agents cannot run in the background: a one-shot run '
  + 'returns inline and leaves no durable child to wake from. For fan-out use the '
  + '`workflow` tool; or run this agent in the foreground (omit run_in_background).'

/**
 * Fail-fast copy: `isolation: worktree` + ephemeral (§3.2). A one-shot run has
 * no reserved childId to adopt/settle an isolated worktree against.
 */
export const EPHEMERAL_WORKTREE_REJECT =
  'ephemeral (read-only one-shot) agents cannot use `isolation: worktree`: a one-shot '
  + 'run has no durable child id to adopt and settle an isolated worktree against. Drop '
  + '`isolation: worktree` from the definition, or dispatch a continuable agent '
  + '(foreground or run_in_background) for isolated work.'

/**
 * Capacity refusal on the ephemeral branch (§3.2): distinguishes one-shot runs
 * from the continuable D4 literal (which stays byte-identical). One-shot
 * children free their slot on settle and are not release_agent-releasable.
 */
export function ephemeralCapacityRefusal(live: number): Error {
  return new Error(
    `ephemeral dispatch refused: ${live} ephemeral/one-shot runs in flight (limit `
    + `${MAX_LIVE_CONTINUABLE_CHILDREN}); one-shot children free their slot on settle — wait `
    + 'for one to finish. release_agent does not apply: one-shot children are not listable',
  )
}

/** The one-line Ctrl+B note carried on every ephemeral result (§3.2). */
export const EPHEMERAL_PROMOTION_NOTICE =
  '(ephemeral one-shot run: no durable child is created; Ctrl+B cannot promote this '
  + 'foreground wait — it is not in the promotion registry; Esc still aborts it)'

/** The one-line notice when a `background: true` pin was ignored for the lane (§3.2). */
export const EPHEMERAL_PIN_IGNORED_NOTICE =
  'the definition\u2019s `background: true` pin was ignored: read-only ephemeral agents always run as a foreground one-shot'

/**
 * The §3.2 ephemeral (one-shot) foreground dispatch: capacity-guard, then a
 * one-shot `seam.start(PROVIDER_SPAWN, …)` with the same request fold as
 * `collectForeground` (persona, toolFilter, agentOptions, maxDepth) and the
 * `settle()` collector. Slice-3 reaper seam: pass `ttlController` (armed at
 * dispatch) and the start request signal becomes
 * `AbortSignal.any([exec.signal, ttlController.signal])` — the caller keeps
 * ownership of the timer; this function only threads the signal.
 */
export async function dispatchEphemeral(
  seam: SubagentsLike,
  folded: {
    label?: string
    prompt: readonly { type: 'text'; text: string }[]
    parent: Agent
    signal: AbortSignal
    maxDepth?: number
    persona?: string
    agentOptions?: Record<string, string>
    toolFilter?: ToolRestriction
  },
  opts: {
    pinIgnored?: boolean
    ttlController?: AbortController
    refuseCapacity?: (live: number) => Error
  } = {},
): Promise<{ text: string; status: 'completed' }> {
  await assertLiveCapacity(seam, folded.parent, folded.signal, opts.refuseCapacity ?? ephemeralCapacityRefusal)
  // §3.1 ToolSearch strip: branch-local, post-sanitize (the sanitized filter
  // may have injected ToolSearch; a read-only child must not be able to
  // tool-search-load a deferred write-capable tool). preloadDeferredFilterTools
  // already ran BEFORE this strip at the dispatch site.
  const { ttlController } = opts
  const toolFilter = folded.toolFilter === undefined
    ? undefined
    // exactOptionalPropertyTypes: drop `allow` entirely when there is none.
    : {
      ...folded.toolFilter,
      ...(folded.toolFilter.allow === undefined
        ? {}
        : { allow: folded.toolFilter.allow.filter(name => name !== 'ToolSearch') }),
    }
  const request = {
    ...folded,
    ...(toolFilter !== undefined ? { toolFilter } : {}),
    // Slice-3 seam: the reaper arms a per-run controller at dispatch; aborting
    // it must not cancel the turn signal (Task is concurrency-safe).
    ...(ttlController !== undefined ? { signal: AbortSignal.any([folded.signal, ttlController.signal]) } : {}),
  }
  const run = await seam.start(PROVIDER_SPAWN, request)
  let result
  try {
    result = await settle(run)
  } catch (error) {
    // §3.4 foreground failure copy: a TTL kill of a foreground-waited child
    // surfaces with the pinned remedy text (settle throws on non-completed).
    if (ttlController?.signal.aborted === true) throw new Error(EPHEMERAL_TTL_KILL_COPY)
    throw error
  }
  const notes = [
    EPHEMERAL_PROMOTION_NOTICE,
    ...(opts.pinIgnored === true ? [EPHEMERAL_PIN_IGNORED_NOTICE] : []),
  ]
  return { ...result, text: `${result.text}\n${notes.join(' ')}` }
}

/** Await a run's terminal result and project it onto the tool output shape. */
export async function settle(run: { result: Promise<{ stopReason: string; output?: readonly { type: string; text?: string }[] }> }): Promise<{ text: string; status: 'completed' }> {
  let result
  try {
    result = await run.result
  } catch (error) {
    throw new Error(`subagent run failed: ${(error as Error).message}`)
  }
  if (result.stopReason !== 'completed') {
    throw new Error(`subagent run stopped with reason "${result.stopReason}"`)
  }
  const text = (result.output ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('')
  return { text, status: 'completed' as const }
}
