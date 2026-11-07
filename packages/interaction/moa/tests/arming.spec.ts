import { describe, expect, it } from 'vitest'
import { ArmingMachine } from '../src/arming.ts'
import { moaTripwireViolations, observeLiveSelection } from '../src/runtime-state.ts'
import { BOOT_PAIR, escalationOpening, makeRig, noticeOpening, userOpening } from './rig.ts'

const BOOT = { provider: 'acme', model: 'sonnet-x' }
const OTHER = { provider: 'acme', model: 'opus-y' }

describe('arming state machine (§3.1 truth table; r3-final signal-driven)', () => {
  it('default OFF: never armed, arming when disabled does nothing', () => {
    const m = new ArmingMachine(() => false)
    m.arm()
    m.noteBootPair(BOOT)
    m.observeTripwire(BOOT)
    expect(m.isArmed()).toBe(false)
    expect(m.disarmReason()).toBeUndefined()
    // The baseline still captures while disabled (ship-dark sessions).
    expect(m.getBootDefaultModel()).toEqual(BOOT)
  })

  it('enabled at mount: armed at once; boot default captured via noteBootPair', () => {
    const m = new ArmingMachine(() => true)
    m.arm()
    expect(m.isArmed()).toBe(true)
    m.noteBootPair(BOOT)
    expect(m.getBootDefaultModel()).toEqual(BOOT)
    expect(m.isArmed()).toBe(true)
  })

  it('noteBootPair is first-wins and unconditional (even while disabled), and first-wins userBase', () => {
    const m = new ArmingMachine(() => false)
    m.noteBootPair(BOOT)
    m.noteBootPair(OTHER)
    expect(m.getBootDefaultModel()).toEqual(BOOT)
    expect(m.userBaseSelection()).toEqual({ provider: 'acme', model: 'sonnet-x' })
    const m2 = new ArmingMachine(() => true)
    m2.noteBootPair(undefined)
    expect(m2.getBootDefaultModel()).toBeUndefined()
    expect(m2.userBaseSelection()).toBeUndefined()
  })

  it('explicit /model disarm via noteUserSelection (never by observation)', () => {
    const m = new ArmingMachine(() => true)
    m.arm()
    m.noteBootPair(BOOT)
    // An off-boot OBSERVATION is tripwire-only: it never disarms.
    expect(m.observeTripwire(OTHER)).toMatch(/tripwire/)
    expect(m.isArmed()).toBe(true)
    // The explicit write signal disarms.
    m.noteUserSelection(OTHER)
    expect(m.isArmed()).toBe(false)
    expect(m.disarmReason()).toBe('explicit-model-switch')
    expect(m.userBaseSelection()).toEqual(OTHER)
  })

  it('return-to-boot-default re-arms and clears the disarm reason (ModelSwitchBack)', () => {
    const m = new ArmingMachine(() => true)
    m.arm()
    m.noteBootPair(BOOT)
    m.noteUserSelection(OTHER)
    m.noteUserSelection(BOOT)
    expect(m.isArmed()).toBe(true)
    expect(m.disarmReason()).toBeUndefined()
    expect(m.userBaseSelection()).toEqual(BOOT)
  })

  it('/effort on the boot route never disarms (effort is not the pair)', () => {
    const m = new ArmingMachine(() => true)
    m.arm()
    m.noteBootPair(BOOT)
    m.noteUserSelection({ ...BOOT, reasoningEffort: 'max' })
    expect(m.isArmed()).toBe(true)
    expect(m.userBaseSelection()).toEqual({ ...BOOT, reasoningEffort: 'max' })
  })

  it('an unknown boot pair: the first user write disarms (the write itself left the default)', () => {
    const m = new ArmingMachine(() => true)
    m.arm()
    m.noteUserSelection(OTHER)
    expect(m.isArmed()).toBe(false)
    expect(m.disarmReason()).toBe('explicit-model-switch')
  })

  it('noteMoaSelection never disarms and feeds the tripwire filter', () => {
    const m = new ArmingMachine(() => true)
    m.arm()
    m.noteBootPair(BOOT)
    m.noteMoaSelection(OTHER)
    expect(m.isArmed()).toBe(true)
    expect(m.lastMoaSelection()).toEqual(OTHER)
    // moa's own write reaching the observation path: no boot capture, no violation.
    expect(m.observeTripwire(OTHER)).toBeUndefined()
    expect(m.getBootDefaultModel()).toEqual(BOOT)
  })

  it('settings flip enabled→true at runtime: arms at the next arm() pass (hot reload)', () => {
    let enabled = false
    const m = new ArmingMachine(() => enabled)
    m.arm()
    m.noteBootPair(BOOT) // unconditional baseline, captured while disabled
    expect(m.isArmed()).toBe(false)
    enabled = true
    m.arm() // the tryArm retry pass (admission/pre-step/judge firing)
    expect(m.isArmed()).toBe(true)
    expect(m.getBootDefaultModel()).toEqual(BOOT)
  })

  it('a hot-enabled machine stays disarmed by a prior explicit signal (round-5)', () => {
    let enabled = false
    const m = new ArmingMachine(() => enabled)
    m.arm()
    m.noteBootPair(BOOT)
    m.noteUserSelection(OTHER) // explicit switch while disabled: recorded
    enabled = true
    m.arm()
    expect(m.isArmed()).toBe(false)
    expect(m.disarmReason()).toBe('explicit-model-switch')
    expect(m.getBootDefaultModel()).toEqual(BOOT) // baseline NOT clobbered
  })

  it('equality is exact provider+model match', () => {
    const m = new ArmingMachine(() => true)
    m.arm()
    m.noteBootPair(BOOT)
    m.noteUserSelection({ provider: 'other', model: 'sonnet-x' })
    expect(m.isArmed()).toBe(false)
  })
})

describe('arming machine — resume rehydration (D3.2 sidecar)', () => {
  it('route/escalate row ⇒ lastMoaSelection (armed)', () => {
    const m = new ArmingMachine(() => true)
    m.rehydrateFromSidecar({ kind: 'route', selection: OTHER })
    expect(m.isArmed()).toBe(true)
    expect(m.lastMoaSelection()).toEqual(OTHER)
    expect(m.disarmReason()).toBeUndefined()
  })

  it('user-select row with the boot pair known ⇒ ModelSwitchBack re-arm; otherwise disarmed', () => {
    const m = new ArmingMachine(() => true)
    m.noteBootPair(BOOT)
    m.rehydrateFromSidecar({ kind: 'user-select', selection: BOOT })
    expect(m.isArmed()).toBe(true)
    expect(m.userBaseSelection()).toEqual(BOOT)

    const away = new ArmingMachine(() => true)
    away.noteBootPair(BOOT)
    away.rehydrateFromSidecar({ kind: 'user-select', selection: OTHER })
    expect(away.isArmed()).toBe(false)
    expect(away.disarmReason()).toBe('explicit-model-switch')
  })

  it('user-select row with an UNKNOWN boot pair defers the re-arm check to the first capture', () => {
    const m = new ArmingMachine(() => true)
    m.rehydrateFromSidecar({ kind: 'user-select', selection: BOOT })
    expect(m.isArmed()).toBe(false)
    expect(m.disarmReason()).toBe('resume-unconfirmed')
    m.noteBootPair(BOOT) // the first genuine observation lands: pair == boot ⇒ re-arm
    expect(m.isArmed()).toBe(true)
    expect(m.disarmReason()).toBeUndefined()
  })

  it('missing/stale sidecar ⇒ conservative unarmed-until-boot-pair', () => {
    const m = new ArmingMachine(() => true)
    m.arm()
    m.rehydrateFromSidecar(undefined)
    expect(m.isArmed()).toBe(false)
    expect(m.disarmReason()).toBe('resume-unconfirmed')
    // Only an explicit boot-pair write re-arms.
    m.noteBootPair(BOOT)
    m.noteUserSelection(BOOT)
    expect(m.isArmed()).toBe(true)
  })
})

/**
 * §7.3 arming through the admission seam (D3.2 form): the truth table as the
 * entry-point router actually drives it — explicit noteUserSelection signals
 * (the driver's /model /effort writes) disarm/re-arm, classification selects
 * durably, and the FailOpenServe path restores the user/base pair on a miss.
 */
describe('arming through the admission seam (D3.2 §7.3)', () => {
  it('/model away disarms BEFORE classification (no wasted call); the selection is left alone', async () => {
    const rig = makeRig({ enabled: true })
    await rig.admit(userOpening('build a small feature'))
    expect(rig.classifyStates).toHaveLength(1)
    expect(rig.agent.model.current()).toMatchObject({ provider: 'mock', model: 'tier-draft' })
    // The driver's /model write: durable select + the explicit signal.
    const away = { provider: 'acme', model: 'opus-y' }
    rig.agent.model.select(away)
    rig.core.arming.noteUserSelection(away)
    expect(rig.core.arming.isArmed()).toBe(false)
    await rig.admit(userOpening('another prompt'))
    expect(rig.classifyStates).toHaveLength(1) // NO new classify
    expect(rig.agent.model.current()).toEqual(away) // the user's pair is served
  })

  it('/model back re-arms and the transition turn IS routed (ModelSwitchBack)', async () => {
    const rig = makeRig({ enabled: true })
    await rig.admit(userOpening('first'))
    expect(rig.agent.model.current()).toMatchObject({ model: 'tier-draft' })
    rig.agent.model.select({ provider: 'acme', model: 'opus-y' })
    rig.core.arming.noteUserSelection({ provider: 'acme', model: 'opus-y' })
    await rig.admit(userOpening('second'))
    expect(rig.classifyStates).toHaveLength(1)
    // Switch back to the boot default: re-arms…
    rig.agent.model.select({ ...BOOT_PAIR })
    rig.core.arming.noteUserSelection({ ...BOOT_PAIR })
    expect(rig.core.arming.isArmed()).toBe(true)
    // …and the transition turn is classified AND selected.
    await rig.admit(userOpening('third'))
    expect(rig.classifyStates).toHaveLength(2)
    expect(rig.agent.model.current()).toMatchObject({ model: 'tier-draft' })
  })

  it('steady routing never disarms (moa writes are filtered from the boot baseline)', async () => {
    const rig = makeRig({ enabled: true })
    for (const turn of [1, 2, 3]) {
      await rig.admit(userOpening(`turn ${turn}`))
      await rig.claim(turn, [userOpening(`turn ${turn}`)])
      expect(rig.core.arming.isArmed()).toBe(true)
      expect(rig.core.arming.getBootDefaultModel()).toEqual(BOOT_PAIR)
    }
    expect(rig.classifyStates).toHaveLength(3)
    // The boot baseline was captured from the PRE-ROUTE live selection (turn 1),
    // never from moa's own routed pair.
    expect(rig.core.arming.userBaseSelection()).toEqual(BOOT_PAIR)
  })

  it('disabled: zero classification, but the boot baseline still captures at admission', async () => {
    const rig = makeRig({ enabled: false })
    await rig.admit(userOpening('hi'))
    expect(rig.classifyStates).toHaveLength(0)
    expect(rig.core.arming.isArmed()).toBe(false)
    expect(rig.core.arming.getBootDefaultModel()).toEqual(BOOT_PAIR)
    expect(rig.agent.model.selections).toHaveLength(0) // no durable noise
  })

  it('a subagent admission never classifies, selects, or captures the baseline', async () => {
    const rig = makeRig({ enabled: true })
    const child = { ...rig.agent, session: { ...rig.agent.session, header: { origin: 'subagent' } } }
    await rig.router.routeBeforeAdmission(child as never, userOpening('child prompt'))
    expect(rig.classifyStates).toHaveLength(0)
    expect(rig.agent.model.selections).toHaveLength(0)
    expect(rig.core.arming.getBootDefaultModel()).toBeUndefined()
    expect(rig.core.arming.isArmed()).toBe(true)
  })

  it('non-user openings never classify (cc-workflow-completion, escalation, notices)', async () => {
    const rig = makeRig({ enabled: true })
    await rig.admit(noticeOpening('queued note'))
    await rig.admit(escalationOpening('retry', 1, 0, 1))
    await rig.admit({ ...userOpening('completion'), source: { kind: 'cc-workflow-completion' } as never })
    expect(rig.classifyStates).toHaveLength(0)
    expect(rig.agent.model.selections).toHaveLength(0)
    // The boot baseline still captured (unconditional), from the live pair.
    expect(rig.core.arming.getBootDefaultModel()).toEqual(BOOT_PAIR)
  })

  it('FailOpenServe on a miss restores the user/base pair (not the previous tier)', async () => {
    const rig = makeRig({ enabled: true })
    await rig.admit(userOpening('first'))
    expect(rig.agent.model.current()).toMatchObject({ model: 'tier-draft' })
    // Now the classify fails: the user/base pair (the boot pair) is re-selected.
    rig.fetchError = new Error('gateway down')
    await rig.admit(userOpening('second'))
    expect(rig.agent.model.current()).toEqual(BOOT_PAIR)
  })

  it('P-G: disabled start → /model → runtime enable shares ONE boot pair; the escape hatch still works', async () => {
    const rig = makeRig({ enabled: false })
    // Disabled phase: the admission observation captures the boot pair.
    await rig.admit(userOpening('while dark'))
    expect(rig.core.arming.getBootDefaultModel()).toEqual(BOOT_PAIR)
    // The user /models away while moa is dark; then enables moa at runtime.
    rig.core.arming.noteUserSelection({ provider: 'acme', model: 'opus-y' })
    rig.settings.enabled = true
    await rig.admit(userOpening('after enable'))
    // The prior explicit signal keeps it disarmed (explicit /model > moa, §6).
    expect(rig.core.arming.isArmed()).toBe(false)
    expect(rig.core.arming.getBootDefaultModel()).toEqual(BOOT_PAIR)
    expect(rig.classifyStates).toHaveLength(0)
    // Escape hatch: returning to the shared boot pair re-arms.
    rig.core.arming.noteUserSelection({ ...BOOT_PAIR })
    await rig.admit(userOpening('back to boot'))
    expect(rig.core.arming.isArmed()).toBe(true)
    expect(rig.agent.model.current()).toMatchObject({ model: 'tier-draft' })
  })

  it('the tripwire fires when an unnotified foreign pair reaches the pre-step observation, and only then', () => {
    const rig = makeRig({ enabled: true })
    rig.core.arming.noteBootPair(BOOT_PAIR)
    // boot pair: accounted.
    observeLiveSelection(BOOT_PAIR)
    // user-notified pair: accounted.
    rig.core.arming.noteUserSelection({ provider: 'acme', model: 'opus-y' })
    observeLiveSelection({ provider: 'acme', model: 'opus-y' })
    // moa's own write: accounted.
    rig.core.arming.noteMoaSelection({ provider: 'mock', model: 'tier-draft' })
    observeLiveSelection({ provider: 'mock', model: 'tier-draft' })
    expect(moaTripwireViolations()).toHaveLength(0)
    // A foreign pair with NO preceding noteUserSelection: the tripwire fires.
    observeLiveSelection({ provider: 'rogue', model: 'pair' })
    expect(moaTripwireViolations()).toHaveLength(1)
    expect(moaTripwireViolations()[0]).toMatch(/rogue\/pair/)
    // …and arming is untouched (observation is tripwire-only).
    expect(rig.core.arming.isArmed()).toBe(false) // disarmed by the noteUserSelection above
    expect(rig.core.arming.getBootDefaultModel()).toEqual(BOOT_PAIR)
  })
})
