// Issue #380 regression spec: the roster (`agentPresets`) must be resolved
// per use, not captured at apply time. The loader mounts group siblings
// concurrently (`EntryGroup.update` → `Promise.all`) and strict `ctx.get`
// reads a LOADING sibling as `undefined`, so an eager apply-time read made
// the whole ACP lane die whenever the registry's async `Service.init` lost
// the import-order race. Session admission additionally waits for the
// loader tree to settle, so the per-use read observes the registry's final
// state. Companion of preset-composition.spec.ts (§5.2 of
// docs/plans/2026-10-09-acp-m2-own-plugin.md).
import { afterEach, describe, expect, it } from 'vitest'
import { makeBridgeHarness, textResponse, type BridgeHarness } from './harness.ts'

describe('preset roster resolution (issue #380)', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('apply tolerates an absent roster at mount time', async () => {
    // Today's eager capture throws during apply, which breaks the plugin
    // (and on the real lane, leaves the stock harness acp row answering).
    harness = await makeBridgeHarness({ script: [], roster: 'absent' })
    const { agentInfo } = await harness.client.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: 'dsh-cc-test', version: '0.0.0' },
    })
    expect(agentInfo?.name).toBe('dsh-cc')
  })

  it('the join resolves the roster lazily at session time', async () => {
    harness = await makeBridgeHarness({ script: [], roster: 'absent' })
    harness.provideRoster()
    const cwd = harness.persistenceRoot
    const { sessionId } = await harness.client.newSession({ cwd, mcpServers: [] })
    expect(sessionId).toBeTruthy()
    expect(harness.presetMounts).toEqual([{ presetId: 'cc' }])
  })

  it('a roster that never arrives fails session admission with the registry diagnostic on the wire', async () => {
    harness = await makeBridgeHarness({ script: [], roster: 'absent' })
    const cwd = harness.persistenceRoot
    // The resolver throws a RequestError, so the sentence survives the SDK's
    // generic-error masking (a plain Error would surface as bare /Internal error/).
    await expect(
      harness.client.newSession({ cwd, mcpServers: [] }),
    ).rejects.toThrow(/requires an agent-preset registry/)
  })

  it('session/new waits for the loader tree to settle before composing', async () => {
    harness = await makeBridgeHarness({ script: [], roster: 'absent', loaderGate: true })
    const gate = harness.loaderGate!
    const cwd = harness.persistenceRoot
    const pending = harness.client.newSession({ cwd, mcpServers: [] })
    // Barrier-entry handshake: the request is parked INSIDE the admission
    // gate, before any roster read — the registry is still absent here.
    await gate.entered
    await expect(
      Promise.race([Promise.resolve(pending).then(() => 'settled'), Promise.resolve('pending')]),
    ).resolves.toBe('pending')
    expect(harness.presetMounts).toEqual([])
    harness.provideRoster()
    gate.open()
    await pending
    expect(harness.presetMounts).toEqual([{ presetId: 'cc' }])
  })

  it('session/resume waits for the loader tree to settle before composing', async () => {
    harness = await makeBridgeHarness({ script: [], loaderGate: true })
    const gate = harness.loaderGate!
    const cwd = harness.persistenceRoot
    // The create passes the gate first (opened), so the resume below is the
    // admission under test.
    const create = harness.client.newSession({ cwd, mcpServers: [] })
    await gate.entered()
    gate.open()
    const { sessionId } = await create
    await harness.client.closeSession({ sessionId })
    const pending = harness.client.resumeSession({ sessionId, cwd })
    await gate.entered()
    gate.open()
    await pending
    expect(harness.presetMounts).toEqual([{ presetId: 'cc' }, { presetId: 'cc' }])
  })

  it('the roster is re-resolved per session (no caching of the first lookup)', async () => {
    harness = await makeBridgeHarness({ script: [], roster: 'absent' })
    harness.provideRoster(['cc'])
    const cwd = harness.persistenceRoot
    await harness.client.newSession({ cwd, mcpServers: [] })
    // A replacement that accepts nothing must be picked up by the NEXT
    // session join — a cached first lookup would keep succeeding here. The
    // join failure surfaces as the SDK's generic internal error (the §5.2
    // unknown-preset precedent in preset-composition.spec.ts).
    harness.provideRoster([])
    await expect(
      harness.client.newSession({ cwd, mcpServers: [] }),
    ).rejects.toThrow(/Internal error/)
    expect(harness.presetMounts).toEqual([{ presetId: 'cc' }])
  })

  it('a late roster still composes sessions while earlier failures stay failed (textResponse sanity)', async () => {
    // The join failure must not wedge the bridge: after a failed admission,
    // installing the roster lets the next session through.
    harness = await makeBridgeHarness({ script: [textResponse('ok')], roster: 'absent' })
    const cwd = harness.persistenceRoot
    await expect(
      harness.client.newSession({ cwd, mcpServers: [] }),
    ).rejects.toThrow(/requires an agent-preset registry/)
    harness.provideRoster()
    const { sessionId } = await harness.client.newSession({ cwd, mcpServers: [] })
    expect(sessionId).toBeTruthy()
    expect(harness.presetMounts).toEqual([{ presetId: 'cc' }])
  })
})
