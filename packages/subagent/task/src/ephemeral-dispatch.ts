/**
 * Ephemeral (read-only one-shot) dispatch: the §3.2 fail-fast copy constants
 * and the one-shot foreground dispatch used by `tool.ts`. Extracted verbatim
 * to keep that module under the file-size budget.
 *
 * @module @dsh-cc/subagent-task/ephemeral-dispatch
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { randomUUID } from 'node:crypto'
import { clearComposition, planComposition, type ChildComposition } from './composition-plan.ts'
import {
  acquireLiveCapacity,
  PROVIDER_SPAWN,
  capacityErrorRefusal,
  type ActivationLike,
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

/** The one-line Ctrl+B note carried on every ephemeral result (§3.2). */
export const EPHEMERAL_PROMOTION_NOTICE =
  '(ephemeral one-shot run: no durable child is created; Ctrl+B cannot promote this '
  + 'foreground wait — it is not in the promotion registry; Esc still aborts it)'

/** The one-line notice when a `background: true` pin was ignored for the lane (§3.2). */
export const EPHEMERAL_PIN_IGNORED_NOTICE =
  'the definition’s `background: true` pin was ignored: read-only ephemeral agents always run as a foreground one-shot'

/**
 * The §3.2 ephemeral (one-shot) foreground dispatch: admission lease, then a
 * one-shot `startActivation({ provider: spawn, delivery: 'caller' })` with the
 * request fold (agentOptions, maxDepth) and the `settle()` collector. The
 * activation is DISPOSED once its result settles (or on abort) — a one-shot
 * child stays resident for nothing and must not hold a pool slot. Slice-3
 * reaper seam: pass `ttlController` (armed at dispatch) and the start request
 * signal becomes `AbortSignal.any([exec.signal, ttlController.signal])` — the
 * caller keeps ownership of the timer; this function only threads the signal.
 */
export async function dispatchEphemeral(
  seam: SubagentsLike,
  folded: {
    label?: string
    prompt: readonly { type: 'text'; text: string }[]
    parent: Agent
    signal: AbortSignal
    maxDepth?: number
    agentOptions?: Record<string, string>
    /** rc.5 composition applied at `agent/created` (never sent to the seam). */
    composition?: ChildComposition
  },
  opts: {
    pinIgnored?: boolean
    ttlController?: AbortController
  } = {},
): Promise<{ text: string; status: 'completed' }> {
  // F-1: admission + creation under one per-parent lease (released once the
  // one-shot activation was accepted); the capacity DECISION is the harness
  // pool's (ACTIVATION_LIMIT_REACHED mapped to the D4 remedy copy).
  const lease = await acquireLiveCapacity(folded.parent, folded.signal)
  const { ttlController } = opts
  // Slice-3 seam: the reaper arms a per-run controller at dispatch; aborting
  // it must not cancel the turn signal (Task is concurrency-safe). The
  // activation signal covers pre-publication cancellation; the TTL kill
  // reaches execution through the dispose() in the finally below.
  const signal = ttlController !== undefined
    ? AbortSignal.any([folded.signal, ttlController.signal])
    : folded.signal
  // Ephemeral children are one-shot but still local activations; reserve an id
  // so the composition plan can be keyed before the agent is announced. A
  // provider without the continuable capability allocates its own id (external
  // execution), so composition is applied post-publication there instead.
  const local = (seam.getProvider(PROVIDER_SPAWN) as { prepareContinuable?: unknown } | undefined)?.prepareContinuable !== undefined
  const childId = local ? randomUUID() : undefined
  if (childId !== undefined && folded.composition !== undefined) planComposition(childId, folded.composition)
  let activation: ActivationLike
  try {
    activation = await seam.startActivation({
      provider: PROVIDER_SPAWN,
      label: folded.label ?? 'ephemeral',
      ...(childId !== undefined ? { childId } : {}),
      request: {
        prompt: folded.prompt,
        parent: folded.parent,
        ...(folded.agentOptions !== undefined ? { agentOptions: folded.agentOptions } : {}),
        ...(folded.maxDepth !== undefined ? { maxDepth: folded.maxDepth } : {}),
      },
      signal,
      delivery: 'caller',
    })
  } catch (error) {
    if (childId !== undefined) clearComposition(childId)
    const capacity = capacityErrorRefusal(error)
    if (capacity !== undefined) throw capacity
    throw error
  } finally {
    lease()
  }
  // Post-publication abort (TTL kill or caller cancel) must go through
  // dispose() — the activation signal covers pre-publication only.
  const onAbort = (): void => { void activation.dispose().catch(() => {}) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    let result
    try {
      result = await settle(activation)
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
  } finally {
    signal.removeEventListener('abort', onAbort)
    // Dispose policy (one-shot): release the resident slot on settle or abort.
    // Teardown failure must not replace a captured result.
    try {
      await activation.dispose()
    } catch {
      /* released on a best-effort basis; the TTL/abort path already surfaced */
    }
  }
}

/** Await an activation's terminal result and project it onto the tool output shape. */
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
