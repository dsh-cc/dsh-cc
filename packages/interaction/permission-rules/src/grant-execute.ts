/** Serialize validation and execution; inspect exact completed commit ranges. */
import type { ToolExecution, ToolExecutionResult } from '@dsh-cc/tools'
import type { TaskGrant } from './task-grant.ts'
import { commitRangeScopeViolations, isCommitCommand, snapshotCommitHead } from './grant-content-scope.ts'
const roots = new Map<string, Promise<void>>()
export async function serializeGrantExecution<T>(root: string, body: () => Promise<T>): Promise<T> {
  const previous = roots.get(root) ?? Promise.resolve()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const tail = previous.then(() => held)
  roots.set(root, tail)
  await previous
  try { return await body() } finally { release(); if (roots.get(root) === tail) roots.delete(root) }
}
export async function verifyGrantExecution(
  grant: TaskGrant, exec: ToolExecution, next: () => Promise<ToolExecutionResult>,
  revoke: () => void, waitBackground?: (jobId: string) => Promise<void>,
): Promise<ToolExecutionResult> {
  const command = String((exec.arguments as Record<string, unknown>).command)
  const commit = grant.contentScope === 'tracked-md-only' && isCommitCommand(command)
  const before = commit ? await snapshotCommitHead(grant.root) : null
  const result = await next()
  const value = (result as { value?: { kind?: string; jobId?: string } }).value
  if (value?.kind === 'background') {
    if (waitBackground === undefined || value.jobId === undefined) { revoke(); throw new Error('Task grant revoked: background completion cannot be verified') }
    await waitBackground(value.jobId)
  }
  if (commit) {
    try {
      const after = await snapshotCommitHead(grant.root)
      const violations = after === null ? ['commit HEAD cannot be resolved'] : await commitRangeScopeViolations(grant.root, before, after)
      if (violations.length > 0) throw new Error(violations.join('; '))
    } catch (error) {
      revoke()
      throw new Error(`Task grant revoked: ${String(error)}. A commit may already have happened; stop and report the failure.`)
    }
  }
  return result
}

import type { Context } from '@deepseek-ai/cordis'
import type { TaskGrants } from './task-grant-service.ts'

/** Wire final validation, job settlement and execution cleanup into the host. */
export function registerGrantExecution(ctx: Context, grants: TaskGrants): void {
    ctx.on('tools/execute', (exec, next) => grants.execute(exec, next, async (jobId) => {
      const jobs = (ctx as unknown as { get(name: string): unknown }).get('jobs') as unknown as { wait(id: string, ms: number, owner: unknown): Promise<{ status: string }> } | undefined
      if (jobs === undefined) throw new Error('Background job registry is unavailable')
      while (true) {
        const view = await jobs.wait(jobId, 1000, exec.agent?.session.id)
        if (view.status !== 'running' && view.status !== 'stopping') return
      }
    }))
    ctx.on('tools/result', (exec) => { grants.clearExecution(exec); return undefined })
}
