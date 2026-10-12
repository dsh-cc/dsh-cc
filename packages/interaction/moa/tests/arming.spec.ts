import { describe, expect, it } from 'vitest'
import { ArmingMachine, type RequestPair } from '../src/arming.ts'

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
