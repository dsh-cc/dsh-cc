/**
 * Execution-identity instrumentation for the public `tools/execute`
 * around-dispatch waterfall.
 *
 * Upstream's pipeline invokes tool bodies from a private `dispatchToolBody`, so
 * a batch-level wrapper around an executor's `execute()` cannot restore
 * per-call identity. The fork instead registers ONE `tools/execute` listener
 * (see `index.ts`) that enters this module's async-local context around the
 * delegated `next()` — i.e. exactly around the call's body dispatch
 * (`pipeline.ts` wraps `dispatchToolBody` in that waterfall), which contains
 * the body's own `approval/request` (where permission-rules grant-escalation
 * reads the identity) but NOT the `prepare()` guards (`tools/pre-execute`,
 * `checkGuards`), which run outside the wrap.
 *
 * The frozen snapshot is taken before any later-registered wrapper can run, so
 * a wrapper that replaces an identity field on the mutable dispatch object can
 * never change the identity host code observes.
 * @module @dsh-cc/tools/src/current-execution
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { ToolDispatchExecution, ToolExecution } from './contracts.ts'

interface ActiveExecution {
  readonly execution: Readonly<ToolExecution>
  active: boolean
}

const current = new AsyncLocalStorage<ActiveExecution>()

/**
 * The runtime-owned identity of the tool body active in this async chain.
 * Available only to host code; no model-facing tool is registered. The frozen
 * snapshot retains the original caller signal and deep-frozen arguments.
 * Detached continuations lose access when their originating body settles.
 * @internal
 */
export function currentToolExecution(): Readonly<ToolExecution> | undefined {
  const store = current.getStore()
  return store?.active ? store.execution : undefined
}

/** Capture the trusted identity from the dispatch object before any wrapper runs. */
export function rememberToolExecution(exec: ToolDispatchExecution | ToolExecution): Readonly<ToolExecution> {
  return Object.freeze({
    token: exec.token,
    callId: exec.callId,
    rootCallId: exec.rootCallId,
    name: exec.name,
    arguments: exec.arguments,
    signal: exec.signal,
    ...exec.agent !== undefined ? { agent: exec.agent } : {},
    ...exec.parent !== undefined ? { parent: exec.parent } : {},
  })
}

/** Enter only around the actual body; invalidate inherited async stores on exit. */
export function runWithToolExecution<T>(execution: Readonly<ToolExecution>, body: () => Promise<T>): Promise<T> {
  const store: ActiveExecution = { execution, active: true }
  return current.run(store, async () => {
    try {
      return await body()
    } finally {
      store.active = false
    }
  })
}

/**
 * The single `tools/execute` listener body: snapshot the call identity, then
 * delegate the dispatch inside the async-local context so a tool body (and any
 * approval it requests) can read it.
 * @param exec - the allowed call about to dispatch.
 * @param next - the delegated body dispatch.
 * @returns the delegated dispatch outcome.
 */
export function instrumentToolExecution<T>(
  exec: ToolDispatchExecution,
  next: () => Promise<T>,
): Promise<T> {
  return runWithToolExecution(rememberToolExecution(exec), next)
}
