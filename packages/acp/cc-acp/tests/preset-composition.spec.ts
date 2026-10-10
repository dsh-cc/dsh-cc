// CC divergence tests: preset composition in create/resume setup (§5.2 of
// docs/plans/2026-10-09-acp-m2-own-plugin.md). The roster is a spy stub; the
// agentPreset projection is the real registry definition.
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

describe('ACP preset composition (§5.2)', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('create stamps the agentPreset header', async () => {
    harness = await makeBridgeHarness({ script: [] })
    const cwd = harness.persistenceRoot
    const { sessionId } = await harness.client.newSession({ cwd, mcpServers: [] })
    const header = (await harness.ctx.sessionPersistence.stat(SessionId(sessionId), {}))?.header
    expect((header as { agentPreset?: string } | undefined)?.agentPreset).toBe('cc')
  })

  it('create mounts the composition', async () => {
    harness = await makeBridgeHarness({ script: [] })
    const cwd = harness.persistenceRoot
    await harness.client.newSession({ cwd, mcpServers: [] })
    expect(harness.presetMounts).toEqual([{ presetId: 'cc' }])
  })

  it('resume mounts the recorded preset id', async () => {
    harness = await makeBridgeHarness({ script: [] })
    const cwd = harness.persistenceRoot
    const { sessionId } = await harness.client.newSession({ cwd, mcpServers: [] })
    await harness.client.closeSession({ sessionId })
    await harness.client.resumeSession({ sessionId, cwd })
    expect(harness.presetMounts).toEqual([{ presetId: 'cc' }, { presetId: 'cc' }])
  })

  it('a presetless session resumed stays presetless', async () => {
    harness = await makeBridgeHarness({ script: [] })
    // A session created outside the bridge (no agentPreset in its header) —
    // e.g. written by an older deployment before §5.2.
    const cwd = harness.persistenceRoot
    const handle = await harness.ctx.agents.create({ sessionId: SessionId('presetless'), meta: { cwd } })
    await harness.ctx.sessions.flush(handle.agent.session)
    // Resume requires the session not to be live; dispose the direct handle.
    await handle.dispose()
    await harness.client.resumeSession({ sessionId: 'presetless', cwd })
    expect(harness.presetMounts).toEqual([])
  })

  it('create with an unknown presetId fails session/new loudly', async () => {
    harness = await makeBridgeHarness({ script: [textResponse('ok')], config: { presetId: 'missing' } })
    await expect(
      harness.client.newSession({ cwd: harness.persistenceRoot, mcpServers: [] }),
    // The mount failure is a plain error (not AcpMcpConfigError), so the SDK
    // reports a generic internal error — the request still fails loudly.
    ).rejects.toThrow(/Internal error/)
    expect(harness.presetMounts).toEqual([])
  })
})
