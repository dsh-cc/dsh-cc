import { describe, expect, it } from 'vitest'
import { realpathSync } from 'node:fs'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { installLegacyCwdHydration } from '../src/hydration.ts'
import { tempDir, serviceRig } from './rig.ts'

/** Append a legacy `worktree/entered` event (the writer was retired). */
function appendEntered(agent: Agent, path: string): void {
  ;(agent.session.append as unknown as (type: string, payload: { path: string }) => void)('worktree/entered', { path })
}

/** Append the native durable change event. */
function appendNative(agent: Agent, cwd: string): void {
  ;(agent.session.append as unknown as (type: string, payload: { cwd: string }) => void)('working-directory/change', { cwd })
}

/** Count one event type in the session log. */
function count(agent: Agent, type: string): number {
  return (agent.session.snapshotEvents() as unknown as { type: string }[]).filter(event => event.type === type).length
}

/** Install the listener and let the child-plugin injection fiber activate. */
async function install(rig: Awaited<ReturnType<typeof serviceRig>>): Promise<void> {
  await installLegacyCwdHydration(rig.ctx)
}

/** Emit the serial creation event the hydration listener rides. */
async function created(rig: Awaited<ReturnType<typeof serviceRig>>, agent: Agent): Promise<void> {
  await (rig.ctx as unknown as { serial(name: string, payload: unknown): Promise<void> }).serial('agent/created', { agent })
}

describe('legacy cwd hydration', () => {
  it('migrates a legacy-only log into the service before a later listener runs', async () => {
    const rig = await serviceRig()
    await install(rig)
    const ws = tempDir()
    const target = tempDir('session-cwd-hydrated-')
    const session = rig.session(ws)
    const agent = rig.agent(session)
    appendEntered(agent, target)
    const observed: (string | null | undefined)[] = []
    rig.ctx.on('agent/created', () => { observed.push(rig.service.get(session)) })
    await created(rig, agent)
    expect(rig.service.get(session)).toBe(realpathSync(target))
    expect(count(agent, 'working-directory/change')).toBe(1)
    expect(observed).toEqual([realpathSync(target)])
  })

  it('never clobbers a newer native change', async () => {
    const rig = await serviceRig()
    await install(rig)
    const ws = tempDir()
    const session = rig.session(ws)
    const agent = rig.agent(session)
    appendEntered(agent, '/legacy/older')
    appendNative(agent, '/native/newer')
    await created(rig, agent)
    expect(rig.service.get(session)).toBe('/native/newer')
    expect(count(agent, 'working-directory/change')).toBe(1)
  })

  it('is a no-op on a second resume', async () => {
    const rig = await serviceRig()
    await install(rig)
    const ws = tempDir()
    const target = tempDir('session-cwd-resume-')
    const session = rig.session(ws)
    const agent = rig.agent(session)
    appendEntered(agent, target)
    await created(rig, agent)
    await created(rig, agent)
    expect(rig.service.get(session)).toBe(realpathSync(target))
    expect(count(agent, 'working-directory/change')).toBe(1)
  })

  it('warns without throwing when the legacy directory vanished', async () => {
    const rig = await serviceRig()
    await install(rig)
    const ws = tempDir()
    const session = rig.session(ws)
    const agent = rig.agent(session)
    appendEntered(agent, '/definitely/missing/session-cwd-dir')
    await expect(created(rig, agent)).resolves.toBeUndefined()
    expect(rig.service.get(session)).toBe(ws)
    expect(count(agent, 'working-directory/change')).toBe(0)
  })

  it('is a pure no-op for a new session without legacy events', async () => {
    const rig = await serviceRig()
    await install(rig)
    const ws = tempDir()
    const session = rig.session(ws)
    const agent = rig.agent(session)
    await created(rig, agent)
    expect(rig.service.get(session)).toBe(ws)
    expect(count(agent, 'working-directory/change')).toBe(0)
  })
})
