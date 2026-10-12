import { describe, expect, it } from 'vitest'
import { ArmingMachine, type RequestPair } from '../src/arming.ts'
import { observeLiveSelection } from '../src/runtime-state.ts'
import { BOOT_PAIR, makeRig, userOpening } from './rig.ts'

const BOOT: RequestPair = { provider: 'acme', model: 'sonnet-x' }
const OTHER: RequestPair = { provider: 'acme', model: 'opus-y' }

describe('arming state machine (§3.1 truth table)', () => {
  it('default OFF: never armed, arming when disabled does nothing', () => {
    const m = new ArmingMachine(() => false)
    m.arm()
    m.observeRequestModel(BOOT)
    expect(m.isArmed()).toBe(false)
    expect(m.disarmReason()).toBeUndefined()
    expect(m.getBootDefaultModel()).toBeUndefined()
  })

  it('enabled at mount: armed on first observed request, boot default captured via noteBootPair', () => {
    const m = new ArmingMachine(() => true)
    m.arm()
    expect(m.isArmed()).toBe(true)
    m.noteBootPair(BOOT)
    m.observeRequestModel(BOOT)
    expect(m.getBootDefaultModel()).toEqual(BOOT)
    expect(m.isArmed()).toBe(true)
  })

  it('noteBootPair is first-wins and unconditional (even while disabled)', () => {
    const m = new ArmingMachine(() => false)
    m.noteBootPair(BOOT)
    m.noteBootPair(OTHER)
    expect(m.getBootDefaultModel()).toEqual(BOOT)
    const m2 = new ArmingMachine(() => true)
    m2.noteBootPair(undefined)
    expect(m2.getBootDefaultModel()).toBeUndefined()
  })

  it('explicit /model disarm', () => {
    const m = new ArmingMachine(() => true)
    m.arm()
    m.noteBootPair(BOOT)
    m.observeRequestModel(BOOT)
    m.observeRequestModel(OTHER)
    expect(m.isArmed()).toBe(false)
    expect(m.disarmReason()).toBe('explicit-model-switch')
  })

  it('return-to-boot-default re-arms and clears the disarm reason', () => {
    const m = new ArmingMachine(() => true)
    m.arm()
    m.noteBootPair(BOOT)
    m.observeRequestModel(BOOT)
    m.observeRequestModel(OTHER)
    m.observeRequestModel(BOOT)
    expect(m.isArmed()).toBe(true)
    expect(m.disarmReason()).toBeUndefined()
  })

  it('re-arm corner: /model change, switch back to boot default while a judge call is notionally in flight — re-arm happens (stale-guard interaction is a later slice)', () => {
    const m = new ArmingMachine(() => true)
    m.arm()
    m.noteBootPair(BOOT)
    m.observeRequestModel(BOOT)
    m.observeRequestModel(OTHER) // /model change; in-flight verdict stale-guard is wiring's job
    m.observeRequestModel(BOOT) // back to boot default
    expect(m.isArmed()).toBe(true)
    expect(m.disarmReason()).toBeUndefined()
    expect(m.getBootDefaultModel()).toEqual(BOOT)
  })

  it('settings flip enabled→true at runtime: arms from the next genuine turn (hot reload)', () => {
    let enabled = false
    const m = new ArmingMachine(() => enabled)
    m.arm()
    m.noteBootPair(BOOT) // unconditional baseline, captured while disabled
    m.observeRequestModel(BOOT)
    expect(m.isArmed()).toBe(false)
    enabled = true
    m.observeRequestModel(BOOT) // next genuine turn after the flip
    expect(m.isArmed()).toBe(true)
    expect(m.getBootDefaultModel()).toEqual(BOOT)
  })

  it('hot-reload fall-through: a hot-enabled machine observing an OFF-boot pair disarms (round-5)', () => {
    let enabled = false
    const m = new ArmingMachine(() => enabled)
    m.arm()
    m.noteBootPair(BOOT)
    enabled = true
    m.observeRequestModel(OTHER)
    expect(m.isArmed()).toBe(false)
    expect(m.disarmReason()).toBe('explicit-model-switch')
    expect(m.getBootDefaultModel()).toEqual(BOOT) // baseline NOT clobbered
  })

  it('equality is exact provider+model match', () => {
    const m = new ArmingMachine(() => true)
    m.arm()
    m.noteBootPair(BOOT)
    m.observeRequestModel(BOOT)
    m.observeRequestModel({ provider: 'other', model: 'sonnet-x' })
    expect(m.isArmed()).toBe(false)
  })
})

/**
 * §7.3 arming-through-the-router: the truth table as the PR-1 listener shape
 * actually drives it. The pre-step observe (sanitizer publish → moa's first
 * pre-step listener) is simulated with `observeLiveSelection` — the sanctioned
 * path (§5.2 contract) — fired before the request listener, exactly as the
 * production pre-step ordering does.
 */
describe('arming through the router (effective-model-truth §7.3)', () => {
  const pairOfResolved = (resolved: unknown): { model?: string } => resolved as { model?: string }

  it('/model away under overlay disarms BEFORE classification (no wasted call) and the wire serves the new selection', async () => {
    const rig = makeRig({ enabled: true })
    await rig.seedCapture(1, [userOpening('build a small feature')])
    await rig.router.listener(rig.payload(1, 1), rig.next)
    expect(rig.classifyStates).toHaveLength(1) // turn 1 classified, overlay on
    // User /model away: the frozen new selection is observed at pre-step.
    const away = { provider: 'acme', model: 'opus-y' }
    observeLiveSelection(away)
    expect(rig.core.arming.isArmed()).toBe(false)
    await rig.seedCapture(2, [userOpening('another prompt')])
    rig.setHeaderPair(away)
    const resolved = await rig.router.listener(rig.payload(2, 1), rig.next)
    expect(rig.classifyStates).toHaveLength(1) // NO new classify — disarmed pre-decide
    expect(pairOfResolved(resolved).model).toBe(away.model) // wire serves the selection
  })

  it('/model back re-arms and the transition turn IS overlaid', async () => {
    const rig = makeRig({ enabled: true })
    await rig.seedCapture(1, [userOpening('first')])
    await rig.router.listener(rig.payload(1, 1), rig.next)
    const away = { provider: 'acme', model: 'opus-y' }
    observeLiveSelection(away)
    await rig.seedCapture(2, [userOpening('second')])
    await rig.router.listener(rig.payload(2, 1), rig.next)
    // Switch back to the boot default: re-arms (§3.1 row 4)…
    observeLiveSelection(BOOT_PAIR)
    expect(rig.core.arming.isArmed()).toBe(true)
    // …and the transition turn is classified AND overlaid.
    await rig.seedCapture(3, [userOpening('third')])
    const resolved = await rig.router.listener(rig.payload(3, 1), rig.next)
    expect(rig.classifyStates).toHaveLength(2)
    expect(pairOfResolved(resolved).model).toBe('tier-draft')
  })

  it('steady overlay never disarms (every step/turn observes the boot pair)', async () => {
    const rig = makeRig({ enabled: true })
    for (const turn of [1, 2, 3]) {
      await rig.seedCapture(turn, [userOpening(`turn ${turn}`)])
      await rig.router.listener(rig.payload(turn, 1), rig.next)
      expect(rig.core.arming.isArmed()).toBe(true)
      expect(rig.core.arming.getBootDefaultModel()).toEqual(BOOT_PAIR)
    }
    expect(rig.classifyStates).toHaveLength(3) // every turn still classified
  })

  it('disabled fast-bail still captures the boot baseline (ship-dark sessions that later enable)', async () => {
    const rig = makeRig({ enabled: false })
    await rig.seedCapture(1, [userOpening('hi')])
    await rig.router.listener(rig.payload(1, 1), rig.next)
    expect(rig.classifyStates).toHaveLength(0) // zero classification
    expect(rig.core.arming.isArmed()).toBe(false)
    expect(rig.core.arming.getBootDefaultModel()).toEqual(BOOT_PAIR) // baseline captured
  })

  it('both observes are subagent-guarded: a child request neither captures the baseline nor disarms', async () => {
    const rig = makeRig({ enabled: true })
    const child = { session: { header: { origin: 'subagent' }, requestHeader: () => ({ config: { provider: 'foreign', model: 'child-model' } }) }, inject: () => {} }
    await rig.seedCapture(1, [userOpening('root prompt')])
    await rig.router.listener({ agent: child as never, turn: 1, step: 1, signal: new AbortController().signal }, rig.next)
    expect(rig.core.arming.getBootDefaultModel()).toBeUndefined() // child pair NOT captured
    expect(rig.core.arming.isArmed()).toBe(true) // nothing disarmed
  })

  it('P-G: disabled start → /model → runtime enable shares ONE boot pair; the escape hatch still works', async () => {
    const rig = makeRig({ enabled: false })
    // Disabled phase: the fast-bail observes the boot pair unconditionally.
    await rig.seedCapture(1, [userOpening('while dark')])
    await rig.router.listener(rig.payload(1, 1), rig.next)
    expect(rig.core.arming.getBootDefaultModel()).toEqual(BOOT_PAIR)
    // The user /models away while moa is dark; then enables moa at runtime.
    const away = { provider: 'acme', model: 'opus-y' }
    rig.setHeaderPair(away)
    rig.settings.enabled = true
    await rig.seedCapture(2, [userOpening('after enable')])
    await rig.router.listener(rig.payload(2, 1), rig.next)
    // The hot-enabled machine observes the OFF-boot pair → stays disarmed
    // (explicit /model > moa, §6 precedence) — and the baseline is NOT clobbered.
    expect(rig.core.arming.isArmed()).toBe(false)
    expect(rig.core.arming.disarmReason()).toBe('explicit-model-switch')
    expect(rig.core.arming.getBootDefaultModel()).toEqual(BOOT_PAIR)
    expect(rig.classifyStates).toHaveLength(0)
    // Escape hatch is live: returning to the shared boot pair re-arms.
    rig.setHeaderPair(BOOT_PAIR)
    // Production ordering: the sanitizer's publish + moa's pre-step observe
    // re-arm BEFORE the request listener's decide.
    observeLiveSelection(BOOT_PAIR)
    await rig.seedCapture(3, [userOpening('back to boot')])
    const resolved = await rig.router.listener(rig.payload(3, 1), rig.next)
    expect(rig.core.arming.isArmed()).toBe(true)
    expect(pairOfResolved(resolved).model).toBe('tier-draft')
  })
})
