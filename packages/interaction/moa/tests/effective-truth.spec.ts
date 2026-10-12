/**
 * Effective-model-truth PR-2 slice tests (§7.4 seam move, §7.5 persona,
 * §7.7 invariant): the assemble-seam classification against the
 * `agent/inbox/claimed` capture, truthful persona variables, the status row's
 * effective model id, clause-5 pendingRows clearing, and the P-E lifecycle.
 *
 * P-C note: NO routing mini-corpus replay rig exists in this repo (the §3.2
 * probe artifacts were session-local one-offs, deliberately not retained) —
 * the P-C parity claim is pinned at the MECHANISM level instead: the tier the
 * assemble seam classifies is exactly the tier the request listener applies,
 * and the persona pair is the SAME shared `tierRouteVariables` computation
 * `withTier` uses.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { resetRuntimeCore, getTurnTier, spliceMoaRows } from '../src/runtime-state.ts'
import { tierRouteVariables } from '../src/router.ts'
import { escalationOpening, makeRig, userOpening, type Rig } from './rig.ts'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'

afterEach(() => resetRuntimeCore())

/** One full PR-2 step: assemble (classify + persona) → request (overlay). */
async function fire(rig: Rig, turn: number, step = 1): Promise<{ provider?: string; model?: string; reasoningEffort?: unknown }> {
  await rig.assemble(turn)
  return (await rig.router.listener(rig.payload(turn, step), rig.next)) as {
    provider?: string
    model?: string
    reasoningEffort?: unknown
  }
}

describe('§7.4 seam move', () => {
  it('P-F capture visibility: the assemble seam classifies the opening captured by the claimed listener during the claim that precedes the assembly', async () => {
    // No classification may run without a capture (claim never happened).
    const noCapture = makeRig()
    await noCapture.assemble(99)
    expect(noCapture.classifyStates).toEqual([])
    // The capture map is process-global (reset by each makeRig) — seed the
    // real rig AFTER the negative case, then observe the classification.
    const rig = makeRig()
    await rig.seedCapture(1, [userOpening('CURRENT TURN TEXT')])
    await rig.assemble(1)
    expect(rig.classifyStates).toEqual(['CURRENT TURN TEXT'])
  })

  it('fail-open on classification timeout: persona states the selection AND the wire serves the selection', async () => {
    // The gateway times out / errors → tier undefined → the assemble seam
    // returns the harness variables untouched and clause 6 serves the same
    // pair — truthful both ways (§5.3).
    const rig = makeRig({ failFetch: new Error('timeout') })
    await rig.seedCapture(1, [userOpening('classify me')])
    const result = await fire(rig, 1, 1)
    expect(result.provider).toBe('mock')
    expect(result.model).toBe('mock')
    expect(getTurnTier()).toBeUndefined()
    expect(rig.injected).toHaveLength(0) // no row for a failed classify
  })

  it('P-C mechanism-level parity: the seam tier is the tier the wire applies, and the persona pair is the shared tierRouteVariables pair', async () => {
    const rig = makeRig()
    await rig.seedCapture(1, [userOpening('route me')])
    const applied = await fire(rig, 1, 1)
    const stored = getTurnTier()
    expect(stored?.turn).toBe(1)
    // The persona pair the seam wrote equals the shared pure helper for the
    // SAME tier...
    const pair = tierRouteVariables(stored!.tier, { resolve: (alias) => (alias === 'draft' ? { provider: 'mock', model: 'tier-draft' } : undefined) })
    expect(pair).toEqual({ provider: 'mock', model: 'tier-draft' })
    // ...and the wire applied exactly that pair.
    expect(applied.provider).toBe(pair!.provider)
    expect(applied.model).toBe(pair!.model)
  })

  it('P3a re-pin at the seam: N assemblies + M requests of one turn classify exactly once; classification never re-enters agent/request', async () => {
    const rig = makeRig()
    await rig.seedCapture(1, [userOpening('one classify')])
    await rig.assemble(1) // first assembly: classifies
    await rig.assemble(1) // diagnostic re-assembly: sticky
    await rig.assemble(1) // another assembly: sticky
    await rig.router.listener(rig.payload(1, 1), rig.next)
    await rig.router.listener(rig.payload(1, 2), rig.next)
    expect(rig.classifyStates).toHaveLength(1) // one classify, N steps served
    expect(getTurnTier()?.tier).toBe(1)
  })

  it('the queued status row carries the effective model id on its source (§5.4)', async () => {
    const rig = makeRig()
    await rig.seedCapture(1, [userOpening('route me')])
    await rig.assemble(1)
    const decision = (await rig.router.preStepListener({}, async () => ({ kind: 'continue', messages: [] }))) as {
      messages: { source?: { kind?: string; tier?: number; model?: string; summary?: string } }[]
    }
    const row = decision.messages.map((m) => m.source).find((s) => s?.kind === 'moa')
    expect(row).toMatchObject({ tier: 1, model: 'tier-draft', summary: 'moa: routed → draft (tier-draft)' })
  })
})

describe('§7.5 persona', () => {
  it('variables carry the tier pair only when the gate passes; off-boot selection leaves the harness variables', async () => {
    const rig = makeRig()
    await rig.seedCapture(1, [userOpening('on boot')])
    const assembled = await rig.assemble(1)
    expect(assembled?.variables).toMatchObject({ provider: 'mock', model: 'tier-draft' })

    // Gate fails (selection moved off the boot pair): variables untouched —
    // the persona states the selection, no classify (no wasted call).
    rig.setHeaderPair({ provider: 'mock', model: 'custom-model' })
    await rig.seedCapture(2, [userOpening('off boot')])
    const untouched = await rig.assemble(2)
    expect(untouched?.variables).toEqual({ provider: 'mock', model: 'custom-model' })
    expect(rig.classifyStates).toHaveLength(1)
  })

  it('the persona NEVER writes an effort field (§5.3 round-5)', async () => {
    const rig = makeRig()
    await rig.seedCapture(1, [userOpening('route me')])
    const assembled = (await rig.assemble(1)) as { variables?: Record<string, unknown> }
    expect(assembled.variables).toMatchObject({ provider: 'mock', model: 'tier-draft' })
    expect('reasoningEffort' in (assembled.variables ?? {})).toBe(false)
    expect(Object.keys(assembled.variables ?? []).every((k) => k === 'provider' || k === 'model')).toBe(true)
  })

  it('P-E lifecycle: claim → assemble (persona == pair the request will serve) → pre-step (row splice) → request (overlay)', async () => {
    const rig = makeRig()
    // 1. claim: the claimed-listener capture.
    await rig.seedCapture(1, [userOpening('lifecycle turn')])
    // 2. assemble: persona variables == the pair the request will serve.
    const assembled = (await rig.assemble(1)) as { variables?: { provider?: string; model?: string } }
    expect(assembled.variables).toEqual({ provider: 'mock', model: 'tier-draft' })
    // 3. pre-step: the row queued during assemble is spliced for delivery.
    const spliced = (await rig.router.preStepListener({}, async () => ({ kind: 'continue', messages: [] }))) as {
      messages?: { source?: { kind?: string } }[]
    }
    expect(spliced.messages?.some((m) => m.source?.kind === 'moa')).toBe(true)
    // 4. request: the overlay serves the SAME pair the persona stated.
    const applied = (await rig.router.listener(rig.payload(1, 1), rig.next)) as LlmCallConfig
    expect(applied.provider).toBe(assembled.variables!.provider)
    expect(applied.model).toBe(assembled.variables!.model)
  })
})

describe('§7.7 invariant + clause-5', () => {
  it('every classified turn is served with the applied overlay pair (assistant/message.source.model truth source)', async () => {
    const rig = makeRig()
    await rig.seedCapture(1, [userOpening('multi-step turn')])
    for (const step of [1, 2, 3]) {
      const applied = await fire(rig, 1, step)
      // What would be stamped on assistant/message.source.model (the resolved
      // wire pair) is the applied overlay pair on EVERY step of the turn.
      expect(applied.model).toBe('tier-draft')
      expect(applied.provider).toBe('mock')
    }
  })

  it('escalation retry turns also carry the floor pair on the wire', async () => {
    const rig = makeRig()
    rig.core.bookkeeping.recordFloor(5, 2)
    await rig.seedCapture(10, [escalationOpening('the answer was rejected', 5, 1, 2)])
    const applied = await fire(rig, 10, 1)
    expect(applied.model).toBe('tier-blueprint')
    expect(applied.provider).toBe('mock')
  })

  it('clause-5 skip clears pendingRows (a queued row advertising a tier that was not applied is a lie)', async () => {
    const rig = makeRig()
    await rig.seedCapture(1, [userOpening('queue a row')])
    await rig.assemble(1)
    // Disarm via the sanctioned observation path (an explicit /model away)
    // AND move the wire pair with it — the clause-4 observe must not re-arm.
    const { observeLiveSelection } = await import('../src/runtime-state.ts')
    rig.setHeaderPair({ provider: 'mock', model: 'custom-model' })
    observeLiveSelection({ provider: 'mock', model: 'custom-model' })
    const resolved = (await rig.router.listener(rig.payload(1, 1), rig.next)) as LlmCallConfig
    expect(resolved.model).toBe('custom-model') // unmodified (no overlay)
    expect(spliceMoaRows().filter((row) => row.text.includes('routed →'))).toHaveLength(0)
  })
})
