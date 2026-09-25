/**
 * Half-open recovery for the shared per-route breaker: after the cooldown an
 * open route admits exactly one probe; probe success closes the breaker, a
 * counted probe failure re-opens it and restarts the cooldown. Clock injected.
 */
import { describe, expect, it } from 'vitest'
import {
  BREAKER_FAILURE_TAGS,
  CLASSIFIER_BREAKER_COOLDOWN_MS,
  CLASSIFIER_BREAKER_THRESHOLD,
  RouteBreaker,
} from '../src/classifier-breaker.ts'

const ROUTE = 'orchestrix/llmbox_systemone/laya'
const COOLDOWN = 10_000

function breaker(cooldownMs: number | 'default' = COOLDOWN) {
  let now = 1_000_000
  const warns: string[] = []
  const audits: string[] = []
  const b = new RouteBreaker<null>({
    threshold: CLASSIFIER_BREAKER_THRESHOLD,
    failureTags: BREAKER_FAILURE_TAGS,
    label: 'test breaker',
    outcomeNote: 'degraded',
    warn: message => warns.push(message),
    auditBreakerOnce: (_ctx, routeKey) => audits.push(routeKey),
    ...(cooldownMs === 'default' ? {} : { cooldownMs }),
    now: () => now,
  })
  const tripOpen = () => {
    for (let i = 0; i < CLASSIFIER_BREAKER_THRESHOLD; i++) b.record('s1', ROUTE, 'error', null)
  }
  return { b, warns, audits, tripOpen, advance: (ms: number) => { now += ms } }
}

describe('RouteBreaker half-open recovery', () => {
  it('keeps the existing threshold and adds a 60s default cooldown', () => {
    expect(CLASSIFIER_BREAKER_THRESHOLD).toBe(3)
    expect(CLASSIFIER_BREAKER_COOLDOWN_MS).toBe(60_000)
    const { b, tripOpen, advance } = breaker('default')
    tripOpen()
    advance(CLASSIFIER_BREAKER_COOLDOWN_MS - 1)
    expect(b.isOpen(ROUTE)).toBe(true)
    advance(1)
    expect(b.isOpen(ROUTE)).toBe(false)
  })

  it('open → stays blocked during the cooldown → one probe → probe success closes', () => {
    const { b, tripOpen, advance, warns, audits } = breaker()
    tripOpen()
    expect(b.state(ROUTE)).toBe('open')
    expect(b.isOpen(ROUTE)).toBe(true)
    advance(COOLDOWN - 1)
    expect(b.isOpen(ROUTE)).toBe(true)
    advance(1)
    expect(b.isOpen(ROUTE)).toBe(false) // the single probe is admitted
    expect(b.state(ROUTE)).toBe('half-open')
    expect(b.isOpen(ROUTE)).toBe(true) // concurrent callers stay blocked
    b.record('s1', ROUTE, undefined, null) // probe succeeded
    expect(b.state(ROUTE)).toBe('closed')
    expect(b.isOpen(ROUTE)).toBe(false)
    expect(b.isOpen(ROUTE)).toBe(false)
    expect(warns).toHaveLength(1)
    expect(audits).toEqual([ROUTE])
  })

  it('probe failure re-opens and restarts the cooldown', () => {
    const { b, tripOpen, advance } = breaker()
    tripOpen()
    advance(COOLDOWN)
    expect(b.isOpen(ROUTE)).toBe(false) // probe
    b.record('s1', ROUTE, 'timeout', null) // probe failed
    expect(b.state(ROUTE)).toBe('open')
    expect(b.isOpen(ROUTE)).toBe(true)
    advance(COOLDOWN - 1)
    expect(b.isOpen(ROUTE)).toBe(true) // cooldown restarted at the probe failure
    advance(1)
    expect(b.isOpen(ROUTE)).toBe(false) // next probe
    b.record('s1', ROUTE, undefined, null)
    expect(b.state(ROUTE)).toBe('closed')
  })

  it('after closing, the route needs a full threshold of failures to re-open', () => {
    const { b, tripOpen, advance } = breaker()
    tripOpen()
    advance(COOLDOWN)
    b.isOpen(ROUTE)
    b.record('s1', ROUTE, undefined, null)
    b.record('s1', ROUTE, 'error', null)
    b.record('s1', ROUTE, 'error', null)
    expect(b.isOpen(ROUTE)).toBe(false)
    b.record('s1', ROUTE, 'error', null)
    expect(b.isOpen(ROUTE)).toBe(true)
  })

  it('a neutral probe outcome (cancelled) frees the probe slot without closing', () => {
    const { b, tripOpen, advance } = breaker()
    tripOpen()
    advance(COOLDOWN)
    expect(b.isOpen(ROUTE)).toBe(false)
    b.record('s1', ROUTE, 'cancelled', null)
    expect(b.state(ROUTE)).toBe('open')
    expect(b.isOpen(ROUTE)).toBe(false) // another probe may go
  })

  it('an abandoned probe (never recorded) is released after one more cooldown', () => {
    const { b, tripOpen, advance } = breaker()
    tripOpen()
    advance(COOLDOWN)
    expect(b.isOpen(ROUTE)).toBe(false)
    advance(COOLDOWN - 1)
    expect(b.isOpen(ROUTE)).toBe(true)
    advance(1)
    expect(b.isOpen(ROUTE)).toBe(false)
  })

  it('a route opened by session-log seeding recovers the same way; reset() clears everything', () => {
    const { b, advance } = breaker()
    const events = Array.from({ length: 3 }, () => ({ failure: 'error', provider: 'orchestrix', model: 'llmbox_systemone/laya' }))
    b.seed('s2', () => events, ROUTE, null)
    expect(b.isOpen(ROUTE)).toBe(true)
    advance(COOLDOWN)
    expect(b.isOpen(ROUTE)).toBe(false)
    b.reset()
    expect(b.state(ROUTE)).toBe('closed')
  })
})
