/**
 * Effective-model-truth in the harness-0.2.2 form (D3.2): the classification
 * input is the admitted UserMessage itself (§4.2 mapping, no claimed-capture
 * indirection); the durable `agent.model.select(...)` IS the step selection
 * the harness freezes at preStep, so the persona (written by the loop from
 * that frozen selection), the wire, and the assistant truth source CANNOT
 * disagree — the truth program's end state, with the assemble seam and the
 * request overlay both gone (static seam pin below).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { getTurnTier, resetRuntimeCore, spliceMoaRows } from '../src/runtime-state.ts'
import { tierRouteVariables } from '../src/router.ts'
import { apply, resetMoaCore } from '../src/index.ts'
import { BOOT_PAIR, makeRig, userOpening } from './rig.ts'

afterEach(() => {
  resetRuntimeCore()
})

describe('§4.2 Classify mapping: the admitted UserMessage is the classification input', () => {
  it('no admission, no classification — and the admitted opening text drives the classify verbatim', async () => {
    const rig = makeRig()
    // Claiming alone (no admission) never classifies.
    await rig.claim(1, [userOpening('never admitted')])
    expect(rig.classifyStates).toEqual([])
    // Admission classifies the exact admitted opening — no indirection.
    await rig.admit(userOpening('CURRENT TURN TEXT'))
    expect(rig.classifyStates).toEqual(['CURRENT TURN TEXT'])
  })

  it('FailOpenServe: a failed classify restores the user/base pair — persona and wire agree by construction', async () => {
    const rig = makeRig({ failFetch: new Error('timeout') })
    // A previous routed turn left its durable tier in force.
    rig.fetchError = undefined
    await rig.admit(userOpening('earlier routed turn'))
    expect(rig.agent.model.current()).toMatchObject({ model: 'tier-draft' })
    // Now the classify fails: the durable selection is restored to the
    // user/base pair, so the frozen selection (persona) and the wire serve
    // the SAME truthful pair (§4.2 FailOpenServe row).
    rig.fetchError = new Error('timeout')
    await rig.admit(userOpening('classify me'))
    expect(rig.agent.model.current()).toEqual(BOOT_PAIR)
    expect(getTurnTier()).toBeUndefined()
  })

  it('P-C mechanism-level parity: the bound tier is the tier the durable selection serves, via the shared tierRouteVariables pair', async () => {
    const rig = makeRig()
    const opening = userOpening('route me')
    await rig.admit(opening)
    await rig.claim(1, [opening])
    const stored = getTurnTier()
    expect(stored?.turn).toBe(1)
    const pair = tierRouteVariables(stored!.tier, { resolve: (alias) => (alias === 'draft' ? { provider: 'mock', model: 'tier-draft' } : undefined) })
    expect(pair).toEqual({ provider: 'mock', model: 'tier-draft' })
    // The durable selection (what the loop freezes per step) is exactly that pair.
    expect(rig.agent.model.current()).toEqual(pair)
  })

  it('P3a re-pin: one admission classifies exactly once; every step of the turn serves the same durable pair; no classify per step', async () => {
    const rig = makeRig()
    const opening = userOpening('one classify')
    await rig.admit(opening)
    // Three steps of the turn: the loop reads model.current() afresh at each
    // preStep — the SAME durable pair, no new classification anywhere.
    for (const step of [1, 2, 3]) {
      expect(rig.agent.model.current()?.model, `step ${step}`).toBe('tier-draft')
    }
    expect(rig.classifyStates).toHaveLength(1)
  })

  it('the queued status row carries the effective model id on its source (§5.4)', async () => {
    const rig = makeRig()
    const opening = userOpening('route me')
    await rig.admit(opening)
    await rig.claim(1, [opening])
    const messages = await rig.deliverRows()
    const row = messages.map((m) => m.source).find((s) => (s as { kind?: string }).kind === 'moa')
    expect(row).toMatchObject({ tier: 1, model: 'tier-draft', summary: 'moa: routed → draft (tier-draft)' })
  })
})

describe('§7.5 persona (retired seam — truthful by construction)', () => {
  it('the persona cannot disagree with the wire: both read the same frozen durable selection', async () => {
    const rig = makeRig()
    await rig.admit(userOpening('route me'))
    // The loop writes variables.provider/model FROM the frozen selection —
    // which admission routing already set to the tier pair. moa writes NO
    // persona variables (the assemble seam is gone).
    const frozen = rig.agent.model.current()
    expect(frozen).toMatchObject({ provider: 'mock', model: 'tier-draft' })
    // Effort is never written by moa anywhere on a bare ladder route.
    expect(frozen && 'reasoningEffort' in frozen && frozen.reasoningEffort !== undefined).toBe(false)
  })

  it('P-E lifecycle (D3.2 form): admission (durable select) → claim (bind queues the row) → pre-step splice → the step serves the frozen pair', async () => {
    const rig = makeRig()
    const opening = userOpening('lifecycle turn')
    // 1. admission: classification selects the tier into the durable selection.
    await rig.admit(opening)
    expect(rig.agent.model.current()?.model).toBe('tier-draft')
    // 2. claim: the admitted message binds to its real turn; the row queues.
    await rig.claim(1, [opening])
    // 3. pre-step: the row splices into the SAME step's decision.
    const messages = await rig.deliverRows()
    expect(messages.some((m) => (m.source as { kind?: string }).kind === 'moa')).toBe(true)
    // 4. the served pair is the frozen durable selection (persona == wire).
    expect(rig.agent.model.current()?.model).toBe('tier-draft')
  })
})

describe('§7.7 invariant + row hygiene', () => {
  it('every admitted turn is served with the routed pair on every step (assistant/message.source.model truth source)', async () => {
    const rig = makeRig()
    await rig.admit(userOpening('multi-step turn'))
    for (const step of [1, 2, 3]) {
      // What would be stamped on assistant/message.source.model (the frozen
      // per-step selection) is the routed pair on EVERY step of the turn.
      expect(rig.agent.model.current(), `step ${step}`).toMatchObject({ provider: 'mock', model: 'tier-draft' })
    }
  })

  it('an escalation retry turn serves the floor pair the judge selected durably (never re-classified)', async () => {
    const rig = makeRig()
    // The judge's escalation: select BEFORE the followup (emulated here —
    // judge.ts owns the real call), so the retry's freeze reads the floor.
    rig.agent.model.select({ provider: 'mock', model: 'tier-blueprint' })
    rig.core.arming.noteMoaSelection({ provider: 'mock', model: 'tier-blueprint' })
    const { escalationOpening } = await import('./rig.ts')
    await rig.claim(10, [escalationOpening('the answer was rejected', 5, 1, 2)])
    expect(rig.classifyStates).toHaveLength(0)
    expect(rig.agent.model.current()?.model).toBe('tier-blueprint')
    expect(getTurnTier()).toMatchObject({ turn: 10, tier: 2 })
  })

  it('a queued row advertising a tier that was not applied is cleared on an explicit /model write (row hygiene)', async () => {
    const rig = makeRig()
    const opening = userOpening('queue a row')
    await rig.admit(opening)
    await rig.claim(1, [opening])
    // The driver's /model write: the explicit signal clears pending moa rows
    // (a row advertising a tier the user just overrode is a lie).
    const { noteUserSelection } = await import('../src/runtime-state.ts')
    noteUserSelection({ provider: 'mock', model: 'custom-model' })
    expect(spliceMoaRows().filter((row) => row.text.includes('routed →'))).toHaveLength(0)
  })
})

describe('seam pin (static): the retired listeners stay retired', () => {
  it('apply() mounts no agent/request and no system-prompt/assemble listener', () => {
    resetMoaCore()
    resetRuntimeCore()
    const listeners: string[] = []
    const ctx = {
      on: (event: string) => { listeners.push(event); return () => {} },
      inject: () => {},
      get: () => undefined,
      logger: { warn: () => {} },
    }
    apply(ctx as never)
    expect(listeners).toContain('agent/inbox/claimed')
    expect(listeners).toContain('agent/pre-step')
    expect(listeners).toContain('agent/turn-stopping')
    expect(listeners).not.toContain('agent/request')
    expect(listeners).not.toContain('system-prompt/assemble')
  })
})
