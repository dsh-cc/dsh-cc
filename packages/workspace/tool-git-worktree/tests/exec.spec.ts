/**
 * D3 coverage for `updateSessionCwd`: the harness `workingDirectory` service is
 * the single owner of the session cwd, so the writer is awaited, skips an
 * unresolvable service silently (test fakes), propagates a rejected `set`, and
 * passes the tool-call signal through.
 */
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@dsh-cc/tools'
import { updateSessionCwd } from '../src/exec.ts'

const signal = new AbortController().signal

/** Minimal exec face: only `agent` and `signal` are read by the writer. */
function execWith(agent: unknown): ToolRunContext {
  return { agent, signal } as unknown as ToolRunContext
}

/** Agent whose ctx hands back the given workingDirectory service. */
function agentWith(service: unknown): Agent {
  return {
    session: { header: { cwd: '/parent' } },
    ctx: { get: (name: string) => (name === 'workingDirectory' ? service : undefined) },
  } as unknown as Agent
}

describe('updateSessionCwd (D3)', () => {
  it('awaits service.set with the path and the tool-call signal', async () => {
    const calls: unknown[][] = []
    const service = { set: async (...args: unknown[]) => { calls.push(args); return '/wt' } }
    const agent = agentWith(service)
    await updateSessionCwd(execWith(agent), '/wt')
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe(agent)
    expect(calls[0]![1]).toBe('/wt')
    expect(calls[0]![2]).toBe(signal)
  })

  it('skips silently when the service is unresolvable (fake agent ctx throws)', async () => {
    const agent = { session: { header: { cwd: '/parent' } } } as unknown as Agent
    await expect(updateSessionCwd(execWith(agent), '/wt')).resolves.toBeUndefined()
  })

  it('skips silently when the service is absent', async () => {
    await expect(updateSessionCwd(execWith(agentWith(undefined)), '/wt')).resolves.toBeUndefined()
  })

  it('propagates a rejected set to the tool result', async () => {
    const service = { set: async () => { throw new Error('missing directory') } }
    await expect(updateSessionCwd(execWith(agentWith(service)), '/nope')).rejects.toThrow('missing directory')
  })

  it('no-ops without an agent', async () => {
    await expect(updateSessionCwd(execWith(undefined), '/wt')).resolves.toBeUndefined()
  })
})
