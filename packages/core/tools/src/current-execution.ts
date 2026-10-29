import { AsyncLocalStorage } from 'node:async_hooks'
import type { ToolExecution } from './tool-types.ts'

interface ActiveExecution {
  readonly execution: Readonly<ToolExecution>
  active: boolean
}

const executions = new WeakMap<ToolExecution, Readonly<ToolExecution>>()
const current = new AsyncLocalStorage<ActiveExecution>()
const identityFields = ['token', 'callId', 'rootCallId', 'name', 'arguments', 'agent', 'parent'] as const

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

/** Capture identity before any extensible policy or dispatch wrapper runs. */
export function rememberToolExecution(exec: ToolExecution): void {
  executions.set(exec, Object.freeze({
    token: exec.token,
    callId: exec.callId,
    rootCallId: exec.rootCallId,
    name: exec.name,
    arguments: exec.arguments,
    signal: exec.signal,
    ...exec.agent !== undefined ? { agent: exec.agent } : {},
    ...exec.parent !== undefined ? { parent: exec.parent } : {},
  }))
}

/** Fail closed if a wrapper changes identity or substitutes an accessor. */
export function executionForBody(exec: ToolExecution): Readonly<ToolExecution> {
  const snapshot = executions.get(exec)
  if (snapshot === undefined) throw new Error('tool execution identity was not created by this runtime')
  for (const field of identityFields) {
    const descriptor = Object.getOwnPropertyDescriptor(exec, field)
    const expected = Object.getOwnPropertyDescriptor(snapshot, field)
    if (expected === undefined && descriptor === undefined) continue
    if (expected !== undefined && descriptor !== undefined && 'value' in descriptor && descriptor.value === expected.value) continue
    throw new Error(`tool execution identity changed before dispatch: ${field}`)
  }
  return snapshot
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
