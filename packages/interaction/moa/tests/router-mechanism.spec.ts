/**
 * Router mechanism tests (listener-level, fake rig): turn-id trigger +
 * step reuse, §6 arming precedence (explicit /model → zero override,
 * re-arm on return to boot default), retry-turn routing contract
 * (moa-escalation opening → skip classify + live floor override, arming
 * still gates), last-element capture fixture, current-turn-text-not-history
 * pin, status row delivery, side-car route record, effort re-validation
 * degrade, and mount-time arming validation (window fail → unarmed).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonl } from '@dsh-cc/sidecar-io'
import { createRequestRouter, validateArming, type RouterDeps } from '../src/router.ts'
import { MOA_MODEL_CONTEXT_WINDOWS } from '../src/judge-route.ts'
import { escalationOpening, makeRig, noticeOpening, userOpening, type Rig } from './rig.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'moa-mech-'))
  dirs.push(dir)
  return dir
}

/** Fire the router listener with the rig's fake agent; return the resolved config. */
async function fire(rig: Rig, turn: number, step = 1): Promise<{ provider?: string; model?: string; reasoningEffort?: unknown }> {
  return (await rig.router.listener(rig.payload(turn, step), rig.next)) as {
    provider?: string
    model?: string
    reasoningEffort?: unknown
  }
}

describe('moa router mechanism', () => {
  it('turn-id trigger: classify once on the first request of a turn; later steps reuse the tier with NO second classify', async () => {
    const rig = makeRig({ ledger: join(tempDir(), 'routing.jsonl') })
    await rig.seedCapture(1, [userOpening('CURRENT TURN TEXT')])
    const first = await fire(rig, 1, 1)
    const second = await fire(rig, 1, 2)
    expect(rig.classifyStates).toEqual(['CURRENT TURN TEXT']) // exactly one classify
    expect(first.model).toBe('tier-draft')
    expect(second.model).toBe('tier-draft') // P1: same override on step 2
    expect(rig.router.tierFor(1)).toBe(1)
  })

  it('the classify trigger is the TURN-ID change, not step===0: the first dispatched request carries step 1', async () => {
    const rig = makeRig()
    await rig.seedCapture(7, [userOpening('prompt of turn seven')])
    // A request carrying step 1 on a NEW turn classifies.
    await fire(rig, 7, 1)
    expect(rig.classifyStates).toHaveLength(1)
    // A request carrying step 0 on the SAME turn does not re-classify...
    await fire(rig, 7, 0)
    expect(rig.classifyStates).toHaveLength(1)
    // ...but a NEW turn id does, even at step 1 (never step 0 → the grok r4
    // pin: a step===0 gate would never fire because phase step is stored 0
    // and dispatched as step+1).
    await rig.seedCapture(8, [userOpening('prompt of turn eight')])
    await fire(rig, 8, 1)
    expect(rig.classifyStates).toHaveLength(2)
  })

  it('capture: the claimed batch [leading notice, user message] exposes the LAST element; classify state is the CURRENT turn text, never history', async () => {
    const rig = makeRig()
    await rig.seedCapture(1, [noticeOpening('[queued] agent created'), userOpening('CURRENT TURN TEXT')])
    const opening = rig.capture.getCapturedOpening(1)
    expect(opening?.source).toMatchObject({ kind: 'user' })
    await fire(rig, 1, 1)
    expect(rig.classifyStates).toEqual(['CURRENT TURN TEXT'])
    expect(rig.classifyStates[0]).not.toContain('queued notice')
  })

  it('capture eviction: bounded FIFO keeps the latest 8 turns', async () => {
    const rig = makeRig()
    for (let turn = 1; turn <= 9; turn++) {
      await rig.seedCapture(turn, [userOpening(`t${turn}`)])
    }
    expect(rig.capture.getCapturedOpening(1)).toBeUndefined()
    expect(rig.capture.getCapturedOpening(9)?.source).toMatchObject({ kind: 'user' })
  })

  it('status row on classify: queued and delivered by the pre-step listener as a moa notice message', async () => {
    const rig = makeRig()
    await rig.seedCapture(1, [userOpening('go')])
    await fire(rig, 1, 1)
    expect(rig.injected).toEqual([]) // not yet delivered
    const decision = (await rig.router.preStepListener({}, async () => ({ kind: 'continue', messages: [] }))) as {
      messages: { source: { kind: string; form?: string; summary?: string } }[]
    }
    // Two queued rows: the classify status row + the effort reset notice
    // (the rig's fake next() carries reasoningEffort 'max' and no efforts
    // resolver → the carried effort degrades and queues its own notice).
    expect(decision.messages).toHaveLength(2)
    expect(decision.messages.some((m) => m.source.kind === 'moa' && (m.source as { summary?: string }).summary === 'moa: routed → draft')).toBe(true)
    expect(decision.messages.every((m) => m.source.kind === 'moa' && m.source.form === 'notice')).toBe(true)
  })

  it('side-car route record: one {type:"route"} JSONL row per classify (orchestrator substitution for the §7 session event)', async () => {
    const ledger = join(tempDir(), 'routing.jsonl')
    const rig = makeRig({ ledger })
    await rig.seedCapture(1, [userOpening('go')])
    await fire(rig, 1, 1)
    const rows = await readJsonl<{ type: string; turnId: number; tier?: string; probabilities?: Record<string, number>; latencyMs: number; truncated: boolean }>(ledger)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: 'route', turnId: 1, tier: 'draft', truncated: false })
    expect(rows[0].probabilities).toEqual({ sketch: 0.05, draft: 0.7, blueprint: 0.15, masterplan: 0.1 })
    expect(typeof rows[0].latencyMs).toBe('number')
  })

  it('R6: explicit /model this session → zero override (disarmed); /model back to boot default → re-armed', async () => {
    const rig = makeRig()
    // Turn 1 at the boot default: observe → armed, classify, override.
    await rig.seedCapture(1, [userOpening('first')])
    expect((await fire(rig, 1, 1)).model).toBe('tier-draft')
    // Turn 2 with an explicit /model pair: machine disarms → pass-through.
    rig.setHeaderPair({ provider: 'mock', model: 'custom-model' })
    await rig.seedCapture(2, [userOpening('second')])
    expect((await fire(rig, 2, 1)).model).toBe('mock') // zero override
    expect(rig.classifyStates).toHaveLength(1) // no classify while disarmed
    // Turn 3 back at the boot default: re-arms (§3.1 row 4).
    rig.setHeaderPair({ provider: 'mock', model: 'mock' })
    await rig.seedCapture(3, [userOpening('third')])
    expect((await fire(rig, 3, 1)).model).toBe('tier-draft')
    expect(rig.classifyStates).toHaveLength(2)
  })

  it('retry-turn routing contract: moa-escalation opening → skip classify + live floor override; disarmed → pass through', async () => {
    const ledger = join(tempDir(), 'routing.jsonl')
    const rig = makeRig({ ledger })
    rig.core.bookkeeping.recordFloor(5, 2)
    await rig.seedCapture(10, [noticeOpening('[queued] judge rejected'), escalationOpening('the first answer was rejected', 5, 1, 2)])
    const applied = await fire(rig, 10, 1)
    expect(rig.classifyStates).toHaveLength(0) // NEVER re-classify a retry
    expect(applied.model).toBe('tier-blueprint') // live floor, not classify
    expect(rig.warnings).toEqual([])
    const rows = await readJsonl<{ type: string }>(ledger)
    expect(rows).toHaveLength(0) // the floor path does not log a route row
    expect(rig.router.tierFor(10)).toBe(2)

    // §6 adjudication: an explicit /model (disarmed) passes through even for
    // moa-escalation openings — classify still skipped.
    const disarmed = makeRig()
    disarmed.core.arming.observeRequestModel({ provider: 'mock', model: 'mock' })
    disarmed.core.arming.observeRequestModel({ provider: 'mock', model: 'custom' }) // explicit /model
    disarmed.core.bookkeeping.recordFloor(5, 2)
    await disarmed.seedCapture(10, [escalationOpening('the first answer was rejected', 5, 1, 2)])
    expect((await fire(disarmed, 10, 1)).model).toBe('mock')
    expect(disarmed.classifyStates).toHaveLength(0)
  })

  it('disabled: the listener bails fast (§3.1 zero-overhead row), no classify, no override', async () => {
    const rig = makeRig({ enabled: false })
    await rig.seedCapture(1, [userOpening('go')])
    expect((await fire(rig, 1, 1)).model).toBe('mock')
    expect(rig.classifyStates).toHaveLength(0)
  })

  it('mount-time validation: judge-route window fail → unarmed (validateArming), warn-once shape', async () => {
    const warn: string[] = []
    const logger = { warn: (m: string) => warn.push(m) }
    const routes = () => ({ resolve: (alias: string) => ({ provider: 'mock', model: `tier-${alias}` }) }) as never
    // A laya judge route (1024 window) against a 4000-token classify budget
    // fails the §3.6 window check → the feature stays unarmed.
    const failing = validateArming({
      settings: { ...makeRig().settings, judgeRoute: { provider: 'llmbox_systemone', model: 'laya' } },
      routes: routes() as never,
      logger,
    })
    expect(failing.ok).toBe(false)
    expect(failing.reason).toContain('window')
    expect(warn).toEqual([]) // validation itself does not warn; apply owns the warn
    expect(MOA_MODEL_CONTEXT_WINDOWS.laya).toBe(1024)
    // Degenerate ladder → unarmed.
    const degenerate = validateArming({
      settings: makeRig().settings,
      routes: { resolve: () => ({ provider: 'mock', model: 'same' }) } as never,
      logger,
    })
    expect(degenerate.ok).toBe(false)
    expect(degenerate.reason).toContain('degenerate')
    // Missing routes service → unarmed.
    expect(validateArming({ settings: makeRig().settings, routes: undefined, logger }).ok).toBe(false)
    // A router built with a failed validation never classifies.
    const rig = makeRig({ validation: { ok: false, reason: 'window' } })
    await rig.seedCapture(1, [userOpening('go')])
    expect((await fire(rig, 1, 1)).model).toBe('mock')
    expect(rig.classifyStates).toHaveLength(0)
  })

  it('effort re-validation: unsupported carried effort degrades to a bare pair + notice row (applyModelSwitch semantics)', async () => {
    const efforts: string[][] = []
    const rig = makeRig()
    rig.setResolveEfforts(async () => {
      efforts.push(['low'])
      return ['low']
    })
    await rig.seedCapture(1, [userOpening('go')])
    // The rig's fake next() carries reasoningEffort 'max'; the new model only
    // advertises 'low' → bare pair + reset notice.
    const applied = await fire(rig, 1, 1)
    expect(applied).toEqual({ provider: 'mock', model: 'tier-draft' })
    expect(applied.reasoningEffort).toBeUndefined()
    const decision = (await rig.router.preStepListener({}, async () => ({ kind: 'continue', messages: [] }))) as {
      messages: { source: { kind: string } }[]
    }
    const texts = decision.messages.map((m) => m.source)
    expect(texts.some((s) => (s as { summary?: string }).summary?.includes('Effort "max" not supported by tier-draft'))).toBe(true)
    // Supported effort: kept on the override.
    const rig2 = makeRig()
    rig2.setResolveEfforts(async () => ['max'])
    await rig2.seedCapture(1, [userOpening('go')])
    const kept = await fire(rig2, 1, 1)
    expect(kept).toMatchObject({ model: 'tier-draft', reasoningEffort: 'max' })
  })
})
