/**
 * Router mechanism tests (listener-level, fake rig; harness-0.2.2 D3.2
 * form): the entry-point admission seam classifies the admitted opening and
 * records the tier DURABLY via `agent.model.select(...)`; the claim bind
 * attaches the real turn (sticky `tierFor`, status row, side-car route
 * record); explicit /model signals disarm/re-arm (§6 precedence); retry
 * turns restore the escalation floor without any re-classification (F-3);
 * effort re-validation moved into the tier-ModelSelection computation.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonl } from '@dsh-cc/sidecar-io'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { validateArming } from '../src/router.ts'
import { getCapturedOpening, resetRuntimeCore, tierFor } from '../src/runtime-state.ts'
import { MOA_MODEL_CONTEXT_WINDOWS } from '../src/judge-route.ts'
import { BOOT_PAIR, escalationOpening, makeRig, noticeOpening, routes as tierRoutes, userOpening } from './rig.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  resetRuntimeCore()
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'moa-mech-'))
  dirs.push(dir)
  return dir
}

describe('moa router mechanism (D3.2 admission form)', () => {
  it('admission classifies once and records the tier durably; the claim bind attaches the real turn', async () => {
    const rig = makeRig({ ledger: join(tempDir(), 'routing.jsonl') })
    const opening = userOpening('CURRENT TURN TEXT')
    await rig.admit(opening)
    expect(rig.classifyStates).toEqual(['CURRENT TURN TEXT'])
    // The tier selection is the DURABLE selection now — every later step of
    // the turn (and the next, absent a FailOpenServe) reads the same pair
    // from model.current() (the P1 contract, durable form).
    expect(rig.agent.model.current()).toMatchObject({ provider: 'mock', model: 'tier-draft' })
    await rig.claim(1, [opening])
    expect(tierFor(1)).toBe(1)
  })

  it('admission is the only classification seam: the step count is irrelevant (groK r4 pin, admission form)', async () => {
    const rig = makeRig()
    // A turn's FIRST admission classifies…
    await rig.admit(userOpening('prompt of turn seven'))
    expect(rig.classifyStates).toHaveLength(1)
    // …and a NEW turn opening classifies exactly once as well — one System
    // One call per admitted batch turn, batch discipline owned by the entry
    // points (D3.2), never by step numbering.
    await rig.admit(userOpening('prompt of turn eight'))
    expect(rig.classifyStates).toHaveLength(2)
  })

  it('capture: the claimed batch [leading notice, user message] keeps the LAST claimed message as the opening capture', async () => {
    const rig = makeRig()
    await rig.claim(1, [noticeOpening('[queued] agent created'), userOpening('CURRENT TURN TEXT')])
    const opening = getCapturedOpening(1)
    expect(opening?.source).toMatchObject({ kind: 'user' })
    expect(opening?.content).toEqual([{ type: 'text', text: 'CURRENT TURN TEXT' }])
  })

  it('capture eviction: bounded FIFO keeps the latest 8 turns', async () => {
    const rig = makeRig()
    for (let turn = 1; turn <= 9; turn++) {
      await rig.claim(turn, [userOpening(`t${turn}`)])
    }
    expect(getCapturedOpening(1)).toBeUndefined()
    expect(getCapturedOpening(9)?.source).toMatchObject({ kind: 'user' })
  })

  it('status row on classify: queued at the claim bind and delivered by the pre-step listener as a moa notice message', async () => {
    const rig = makeRig({ effort: 'max' })
    rig.setResolveEfforts(async () => ['max'])
    const opening = userOpening('go')
    await rig.admit(opening)
    expect((await rig.deliverRows()).length).toBe(0) // not yet bound
    await rig.claim(1, [opening])
    const messages = await rig.deliverRows()
    expect(messages).toHaveLength(1)
    expect(messages[0]?.source).toMatchObject({ kind: 'moa', form: 'notice', summary: 'moa: routed → draft (tier-draft)' })
  })

  it('side-car route record: one {type:"route"} JSONL row per bound classification with the claimed turn id', async () => {
    const ledger = join(tempDir(), 'routing.jsonl')
    const rig = makeRig({ ledger })
    const opening = userOpening('go')
    // Nothing is written at admission time (the turn id is not yet known).
    await rig.admit(opening)
    expect(await readJsonl(ledger)).toEqual([])
    await rig.claim(7, [opening])
    const rows = await readJsonl<{ type: string; turnId: number; tier?: string; probabilities?: Record<string, number>; latencyMs: number; truncated: boolean }>(ledger)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: 'route', turnId: 7, tier: 'draft', truncated: false })
    expect(rows[0].probabilities).toEqual({ sketch: 0.05, draft: 0.7, blueprint: 0.15, masterplan: 0.1 })
    expect(typeof rows[0].latencyMs).toBe('number')
  })

  it('a fail-open classification still logs its route row (failure tag) at bind', async () => {
    const ledger = join(tempDir(), 'routing.jsonl')
    const rig = makeRig({ ledger, failFetch: new Error('gateway down') })
    const opening = userOpening('go')
    await rig.admit(opening)
    await rig.claim(3, [opening])
    const rows = await readJsonl<{ type: string; tier?: string; failure?: string }>(ledger)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: 'route', failure: 'error' })
    expect(rows[0].tier).toBeUndefined()
  })

  it('applied-index collapse (§3.3): a same-model argmax flip cannot change model, status label, or floor', async () => {
    const ladder = [
      { provider: 'mock', model: 'tier-sketch' },
      { provider: 'mock', model: 'tier-sketch' },
      { provider: 'mock', model: 'tier-blueprint' },
      { provider: 'mock', model: 'tier-masterplan' },
    ]
    const run = async (probabilities: Record<string, number>, dir: string) => {
      const ledger = join(dir, 'routing.jsonl')
      const rig = makeRig({ validation: { ok: true, ladder }, ledger, probabilities })
      const opening = userOpening('go')
      await rig.admit(opening)
      await rig.claim(1, [opening])
      const messages = await rig.deliverRows()
      const rows = await readJsonl<{ tier?: string; argmaxTier?: string }>(ledger)
      return {
        model: rig.agent.model.current()?.model,
        floor: tierFor(1),
        status: messages.map((m) => (m.source as { summary?: string }).summary).find((summary) => summary?.startsWith('moa: routed')),
        ledger: rows[0],
      }
    }
    // draft argmax (index 1) vs sketch argmax (index 0): both collapse to index 0.
    const draftArgmax = await run({ sketch: 0.05, draft: 0.7, blueprint: 0.15, masterplan: 0.1 }, tempDir())
    const sketchArgmax = await run({ sketch: 0.7, draft: 0.05, blueprint: 0.15, masterplan: 0.1 }, tempDir())
    for (const out of [draftArgmax, sketchArgmax]) {
      expect(out.model).toBe('tier-sketch')
      expect(out.floor).toBe(0)
      expect(out.status).toBe('moa: routed → sketch (tier-sketch)')
      expect(out.ledger.tier).toBe('sketch')
    }
    expect(draftArgmax.ledger.argmaxTier).toBe('draft') // raw argmax kept as ledger noise
    expect(sketchArgmax.ledger.argmaxTier).toBe('sketch')
  })

  it('R6: explicit /model → zero routing AND zero classify; back to boot re-arms', async () => {
    const rig = makeRig()
    // Turn 1 at the boot default: armed, classify, routed.
    await rig.admit(userOpening('first'))
    expect(rig.agent.model.current()).toMatchObject({ model: 'tier-draft' })
    // Explicit /model: the driver's write (durable select + signal).
    const custom = { provider: 'mock', model: 'custom-model' }
    rig.agent.model.select(custom)
    rig.core.arming.noteUserSelection(custom)
    await rig.admit(userOpening('second'))
    expect(rig.classifyStates).toHaveLength(1) // the switch turn does NOT classify
    expect(rig.agent.model.current()).toEqual(custom) // the user's pair stands
    // Back to the boot default: re-arms; the next admission classifies again.
    rig.agent.model.select({ ...BOOT_PAIR })
    rig.core.arming.noteUserSelection({ ...BOOT_PAIR })
    await rig.admit(userOpening('third'))
    expect(rig.classifyStates).toHaveLength(2)
    expect(rig.agent.model.current()).toMatchObject({ model: 'tier-draft' })
  })

  it('retry-turn contract: a moa-escalation claim restores the live floor for tierFor WITHOUT classifying; no router-side escalation row (§3.5)', async () => {
    const ledger = join(tempDir(), 'routing.jsonl')
    const rig = makeRig({ ledger })
    rig.core.bookkeeping.recordFloor(5, 2)
    await rig.claim(10, [noticeOpening('[queued] judge rejected'), escalationOpening('the first answer was rejected', 5, 1, 2)])
    expect(rig.classifyStates).toHaveLength(0) // NEVER re-classify a retry
    expect(tierFor(10)).toBe(2)
    expect(rig.warnings).toEqual([])
    expect(await readJsonl(ledger)).toEqual([]) // the floor path logs no route row
    // §3.5 conformance: NO queued status row — the typed followup the judge
    // woke IS the escalation row.
    expect((await rig.deliverRows()).length).toBe(0)
    // The retry's MODEL is durable (the judge selected it before the
    // followup); nothing in this path selects again.
    expect(rig.agent.model.selections).toHaveLength(0)
  })

  it('retry-turn contract (§6 adjudication): disarmed ⇒ the floor restore is gated off too', async () => {
    const rig = makeRig()
    rig.core.arming.noteBootPair({ ...BOOT_PAIR })
    rig.core.arming.noteUserSelection({ provider: 'mock', model: 'custom' })
    rig.core.bookkeeping.recordFloor(5, 2)
    await rig.claim(10, [escalationOpening('the first answer was rejected', 5, 1, 2)])
    expect(rig.classifyStates).toHaveLength(0)
    expect(tierFor(10)).toBeUndefined()
  })

  // F-3 (TLA `strict-crash-resume`): the in-memory bookkeeping is lost on
  // crash/resume, but the typed moa-escalation followup is durable in the
  // session log and carries {originSeq, fromTier, toTier}. A retry turn whose
  // bookkeeping entry is gone must restore the floor from that record, never
  // fall back to the launch-time selection.
  it('F-3: crash/resume between escalation dispatch and the retry turn — floor restored from the durable followup, never fail-open', async () => {
    const rig = makeRig() // fresh bookkeeping == the post-resume process: NO recordFloor / recordRetryUsed
    expect(rig.core.bookkeeping.floorFor(5)).toBeUndefined()
    await rig.claim(10, [escalationOpening('the first answer was rejected', 5, 1, 2)])
    expect(rig.classifyStates).toHaveLength(0) // still never re-classify a retry
    expect(tierFor(10)).toBe(2) // escalation floor (toTier 2), NOT the boot 0
    // The restored entry also counts the escalation that already happened,
    // so a resumed chain cannot silently exceed max-escalations.
    expect(rig.core.bookkeeping.stateFor(5)).toEqual({ tierFloor: 2, retriesUsed: 1 })
  })

  it('F-3: a restored floor never lowers a live floor already above the record', async () => {
    const rig = makeRig()
    rig.core.bookkeeping.recordFloor(5, 3)
    await rig.claim(10, [escalationOpening('rejected', 5, 1, 2)])
    expect(tierFor(10)).toBe(3)
    expect(rig.core.bookkeeping.floorFor(5)).toBe(3)
  })

  it('F-3: a malformed durable record (tier out of range) is refused loudly, not applied', async () => {
    const rig = makeRig()
    await rig.claim(10, [escalationOpening('rejected', 5, 1, 99)])
    expect(tierFor(10)).toBeUndefined()
    expect(rig.warnings.some((w) => w.includes('escalation floor'))).toBe(true)
  })

  it('disabled: zero classify, zero select, zero rows (§3.1 zero-overhead row)', async () => {
    const rig = makeRig({ enabled: false, ledger: join(tempDir(), 'routing.jsonl') })
    await rig.admit(userOpening('go'))
    await rig.claim(1, [userOpening('go')])
    expect(rig.classifyStates).toHaveLength(0)
    expect(rig.agent.model.selections).toHaveLength(0)
    expect((await rig.deliverRows()).length).toBe(0)
  })

  it('mount-time validation: judge-route window fail → unarmed (validateArming), warn-once shape', async () => {
    const warn: string[] = []
    const logger = { warn: (m: string) => warn.push(m) }
    const routes = () => tierRoutes() as never
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
    // A router built with a failed validation never classifies at admission.
    const rig = makeRig({ validation: { ok: false, reason: 'window' } })
    await rig.admit(userOpening('go'))
    expect(rig.classifyStates).toHaveLength(0)
    expect(rig.agent.model.selections).toHaveLength(0)
  })

  it('effort re-validation: unsupported carried effort degrades to a bare pair + notice row (applyModelSwitch semantics)', async () => {
    const rig = makeRig({ effort: 'max' })
    rig.setResolveEfforts(async () => ['low'])
    await rig.admit(userOpening('go'))
    // The tier model only advertises 'low' → the durable tier selection drops
    // the effort + queues the reset notice.
    expect(rig.agent.model.current()).toEqual({ provider: 'mock', model: 'tier-draft' })
    await rig.claim(1, [userOpening('go')])
    const messages = await rig.deliverRows()
    const summaries = messages.map((m) => (m.source as { summary?: string }).summary ?? '')
    expect(summaries.some((s) => s.includes('Effort "max" not supported by tier-draft'))).toBe(true)
    // Supported effort: kept on the durable selection.
    const rig2 = makeRig({ effort: 'max' })
    rig2.setResolveEfforts(async () => ['max'])
    await rig2.admit(userOpening('go'))
    expect(rig2.agent.model.current()).toEqual({ provider: 'mock', model: 'tier-draft', reasoningEffort: ReasoningEffortId('max') })
  })

  it('effort re-validation: the unsupported-effort notice is warn-once per (model, effort) pair', async () => {
    const rig = makeRig({ effort: 'max' })
    rig.setResolveEfforts(async () => ['low'])
    await rig.admit(userOpening('go'))
    await rig.claim(1, [userOpening('go')])
    const first = (await rig.deliverRows()).map((m) => (m.source as { summary?: string }).summary ?? '')
    expect(first.filter((s) => s.includes('Effort "max" not supported by tier-draft'))).toHaveLength(1)
    // A second routed turn on the same pair: degrades again (bare pair) but
    // queues NO repeat notice — per-turn repeats spammed every routed turn
    // (2026-10-11 dogfood). NOTE: the user's live effort is the options one
    // — the tier select dropped it, so the carried effort seen here is the
    // options 'max' again.
    await rig.admit(userOpening('go again'))
    await rig.claim(2, [userOpening('go again')])
    const second = (await rig.deliverRows()).map((m) => (m.source as { summary?: string }).summary ?? '')
    expect(second.filter((s) => s.includes('Effort "max" not supported by tier-draft'))).toHaveLength(0)
  })
})
