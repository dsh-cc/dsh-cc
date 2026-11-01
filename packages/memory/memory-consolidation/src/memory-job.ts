/**
 * The subagent spawn helper for memory forks (extraction and dream): starts
 * the one-shot subagent (never registered on the jobs seam — internal memory
 * work stays invisible to the model surface) and maps the settled outcome onto
 * the JobHooks contract.
 * @module @dsh-cc/memory-consolidation/memory-job
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import {
  MEMORY_WRITES_SCHEMA,
  validateMemoryWrites,
  writeMemoryFiles,
  ENTRYPOINT_NAME,
  MAX_ENTRYPOINT_LINES,
  MAX_ENTRYPOINT_BYTES,
  truncateEntrypointContent,
} from '@dsh-cc/memory'

/** Structural subset of the subagent seam used here. */
interface SubagentService {
  startActivation(spec: {
    provider: string
    label: string
    request: {
      prompt: readonly { type: 'text'; text: string }[]
      parent: Agent
      maxDepth?: number
      outputSchema?: Record<string, unknown>
    }
    signal: AbortSignal
    delivery: 'parent' | 'caller'
  }): Promise<{ result: Promise<SubagentResultLike>; dispose(): Promise<void> }>
}

/**
 * The settled shape of a one-shot subagent run. The promise rejects only on
 * infrastructure faults; child-level failures (including "outputSchema was
 * requested but never reported", which upstream downgrades to `error`) arrive
 * as a resolved value and MUST be inspected here.
 */
interface SubagentResultLike {
  readonly structured?: unknown
  readonly stopReason?: string
}

/** The job-done outcome: resolves only, per the JobHooks contract. */
export type JobOutcome = { status: 'completed' } | { status: 'killed' } | { status: 'failed'; detail: string }


/**
 * Over-limit measurement for the entrypoint, identical to the write-side gate
 * semantics (trim → split('\n') → count; byteLength of the trimmed content).
 * @param content - a reported `MEMORY.md` body.
 */
function entrypointOverLimit(content: string): boolean {
  const trimmed = content.trim()
  return trimmed.split('\n').length > MAX_ENTRYPOINT_LINES
    || Buffer.byteLength(trimmed, 'utf8') > MAX_ENTRYPOINT_BYTES
}

/**
 * Design §2.4 fallback: if the reported payload carries an over-limit
 * `MEMORY.md`, replace its content with the deterministic truncation output
 * (capped body + visible in-file warning banner) instead of failing the job.
 * Plain rejection would fail the dream, roll back the lock, and retry every
 * turn-end forever with zero durable output. Topic-file writes pass through
 * untouched; a compliant entrypoint is returned byte-identical. Takes the raw
 * structured payload (the entrypoint gate inside `validateMemoryWrites`
 * throws during validation, so the replacement must happen before it) and
 * returns a payload of the same shape; malformed payloads pass through and
 * are rejected by validation as usual.
 */
export function applyEntrypointFallback(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return payload
  const raw = (payload as { writes?: unknown }).writes
  if (!Array.isArray(raw)) return payload
  const writes: unknown[] = raw.map((entry) => {
    if (typeof entry !== 'object' || entry === null) return entry
    const { path, content } = entry as { path?: unknown; content?: unknown }
    if (path !== ENTRYPOINT_NAME || typeof content !== 'string' || !entrypointOverLimit(content)) {
      return entry
    }
    return { ...entry, content: truncateEntrypointContent(content).content }
  })
  return { ...(payload as object), writes }
}

/**
 * Start a memory-scoped forked subagent as a background job. The fork reports
 * its file set via `outputSchema`; on settlement the plugin validates the
 * batch and writes it host-side under a policy confined to `dir`. Resolves to
 * a control object with an abort hook and a settle promise (true only when
 * the reported writes were validated and persisted).
 */
export async function startMemoryJob(
  ctx: Context,
  agent: Agent,
  dir: string,
  provider: string,
  label: string,
  prompt: string,
): Promise<{ abort(reason?: string): void; settled: Promise<boolean>; done: Promise<JobOutcome> }> {
  const subagents = ctx.get('subagents') as SubagentService | undefined
  if (subagents === undefined) {
    return { abort: () => {}, settled: Promise.resolve(false), done: Promise.resolve({ status: 'failed', detail: 'subagents seam unavailable' }) }
  }
  const fs = ctx.get('fs') as FileSystem | undefined
  const controller = new AbortController()
  // rc.5: one-shot activation (delivery 'caller'). The read-only tool
  // restriction no longer rides the start request — the composition seam
  // applies it (plan C5). The controller signal now covers ONLY cancellation
  // before publication; execution-time abort goes through `dispose()`.
  const activation = await subagents.startActivation({
    provider,
    label,
    signal: controller.signal,
    request: {
      prompt: [{ type: 'text', text: prompt }],
      parent: agent,
      // Defense-in-depth recursion cap: the top-level listener already gates on
      // depth zero, so this fork's child never delegates. maxDepth is compared
      // against the CHILD's resolved depth (parent + 1); a top-level parent's
      // child resolves to 1 and passes, a grandchild to 2 is rejected.
      maxDepth: 1,
      outputSchema: MEMORY_WRITES_SCHEMA,
    },
    delivery: 'caller',
  })
  // Kill the running fork exactly once (idempotent upstream): on abort, on
  // settle, and on agent disposal. Teardown failures never surface.
  const kill = (): void => { void activation.dispose().catch(() => {}) }
  // Real job-done wiring: `done` maps the subagent outcome onto the JobHooks
  // contract (must never reject). Aborted → killed (rolls back the dream
  // lock); a non-completed stopReason, a missing/invalid payload, or a
  // write-back failure → failed with detail; a validated, persisted batch →
  // completed. All branches resolve.
  const done: Promise<JobOutcome> = activation.result.then(
    async (res): Promise<JobOutcome> => {
      if (controller.signal.aborted) return { status: 'killed' }
      if (res?.stopReason !== 'completed') {
        return { status: 'failed', detail: `memory fork ended with stopReason ${String(res?.stopReason)}` }
      }
      if (fs === undefined) {
        return { status: 'failed', detail: 'fs seam unavailable for memory write-back' }
      }
      try {
        const writes = validateMemoryWrites(applyEntrypointFallback(res.structured))
        await writeMemoryFiles(fs, dir, writes)
        return { status: 'completed' }
      } catch (err) {
        return { status: 'failed', detail: String(err) }
      }
    },
    (err): JobOutcome =>
      controller.signal.aborted ? { status: 'killed' } : { status: 'failed', detail: String(err) },
  )
  const settled = done.then(o => o.status === 'completed')
  // Per-agent disposal guarantee (replaces the old jobs-seam owner link):
  // aborting the agent's fiber aborts this fork and awaits its settle, and a
  // settled job detaches its own effect. Registered AFTER the dispatch (a
  // dispatch throw must not leak an effect), wrapped so a disposing scope —
  // which rejects new effects — is a no-op, never a new failure path.
  let dispose: (() => void) | undefined
  try {
    dispose = agent.ctx.effect(() => async () => {
      controller.abort('agent disposed')
      kill()
      await done.catch(() => {})
    }, 'memory-consolidation: cancel the fork on agent disposal')
  } catch { /* agent scope already disposing: the fork dies with it anyway */ }
  // One-shot dispose policy: a settled job never keeps the fork resident.
  void done.finally(() => { kill(); dispose?.() })
  return { abort: (reason?: string) => { controller.abort(reason); kill() }, settled, done }
}
