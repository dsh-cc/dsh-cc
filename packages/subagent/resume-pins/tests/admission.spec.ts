/**
 * Review P2 on #301: after `Promise.race([previous, aborted])` settles with the
 * predecessor, the signal was never rechecked, so a waiter cancelled in the
 * window between the predecessor's release and the waiter's resumption still
 * received a lease with `signal.aborted === true`. Every interleaving of the
 * abort relative to the release must either reject or return a live lease.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LIVE_CAPACITY_REFUSAL,
  MAX_LIVE_CONTINUABLE_CHILDREN as CAP,
  acquireAdmission,
  admissionQueueSize,
  admitContinuation,
  applyResumePinsPlugin,
  pendingContinuations,
  reserveContinuationSlot,
} from '../src/index.ts'

/** A signal whose abort the test fires at an exact microtask offset, recording its state at hand-over. */
function steppedSignal() {
  let listener: (() => void) | undefined
  const sig = {
    aborted: false,
    reason: undefined as unknown,
    atHandover: undefined as boolean | undefined,
    throwIfAborted() { if (this.aborted) throw this.reason },
    addEventListener(_type: string, fn: () => void) { listener = fn },
    // The queue detaches its listener immediately before returning the lease (or throwing).
    removeEventListener() { this.atHandover = this.aborted },
    abort() { this.aborted = true; this.reason = new Error('cancelled'); listener?.() },
  }
  return sig
}

describe('review P2: a cancelled waiter never receives a lease', () => {
  it('abort after the predecessor released, at every microtask offset: reject, or a lease handed over un-aborted', async () => {
    const handedOver: { hops: number; aborted: boolean }[] = []
    for (let hops = 0; hops < 12; hops++) {
      const holder = await acquireAdmission(`p2-${hops}`, new AbortController().signal)
      const signal = steppedSignal()
      const waiter = acquireAdmission(`p2-${hops}`, signal as unknown as AbortSignal).then(
        lease => lease,
        () => undefined,
      )
      holder()
      let chain: Promise<void> = Promise.resolve()
      for (let i = 0; i < hops; i++) chain = chain.then(() => undefined)
      void chain.then(() => signal.abort())
      const lease = await waiter
      if (lease !== undefined) {
        handedOver.push({ hops, aborted: signal.atHandover === true })
        lease()
      }
    }
    // Every lease that WAS handed over must have been handed over un-aborted.
    expect(handedOver.filter(h => h.aborted)).toEqual([])
    // Sanity: the sweep really covers both outcomes (early aborts reject, late ones win the lease).
    expect(handedOver.length).toBeGreaterThan(0)
    expect(handedOver.length).toBeLessThan(12)
    await Promise.resolve()
    await Promise.resolve()
    expect(admissionQueueSize()).toBe(0)
  })

  it('a cancelled waiter that rejected hands the turn on without wedging the queue', async () => {
    const holder = await acquireAdmission('p2-wedge', new AbortController().signal)
    const controller = new AbortController()
    const cancelled = acquireAdmission('p2-wedge', controller.signal)
    const next = acquireAdmission('p2-wedge', new AbortController().signal)
    holder()
    controller.abort()
    await cancelled.then(lease => lease(), () => undefined)
    const lease = await next
    lease()
  })
})

// ── Shared reservation: continuation slots are visible to every guard ───────

function services(running: Set<string>, listed: string[]) {
  const registry = { get: (id: unknown) => running.has(String(id)) ? { status: 'running' } : undefined }
  return {
    get: (name: string) => name === 'agents'
      ? registry
      : name === 'subagents' ? { listChildren: async () => listed.map(id => ({ id })) } : undefined,
  }
}
const ids = (n: number) => Array.from({ length: n }, (_, i) => `c-${i}`)

describe('admitContinuation (shared lease + reservation)', () => {
  it('admits below the cap and reserves the slot; the next admission at 24+1 is refused until release', async () => {
    const running = new Set(ids(CAP - 1))
    const svc = services(running, [...running, 'ended-a', 'ended-b'])
    const parent = { id: 'adm-1' }
    const first = await admitContinuation(svc, parent, 'ended-a', new AbortController().signal)
    expect(first.admitted).toBe(true)
    const second = await admitContinuation(svc, parent, 'ended-b', new AbortController().signal)
    expect(second).toEqual({ admitted: false, reason: LIVE_CAPACITY_REFUSAL })
    if (first.admitted) first.release()
    const third = await admitContinuation(svc, parent, 'ended-b', new AbortController().signal)
    expect(third.admitted).toBe(true)
    if (third.admitted) third.release()
  })

  it('two concurrent continuations at cap - 1: exactly one admitted, and the lease is free afterwards', async () => {
    const running = new Set(ids(CAP - 1))
    const svc = services(running, [...running, 'ended-a', 'ended-b'])
    const parent = { id: 'adm-2' }
    const results = await Promise.all([
      admitContinuation(svc, parent, 'ended-a', new AbortController().signal),
      admitContinuation(svc, parent, 'ended-b', new AbortController().signal),
    ])
    expect(results.filter(r => r.admitted)).toHaveLength(1)
    for (const r of results) if (r.admitted) r.release()
    await Promise.resolve()
    await Promise.resolve()
    expect(admissionQueueSize()).toBe(0)
  })

  it('a reservation whose child is already visibly running is not double counted', async () => {
    const running = new Set(ids(CAP - 1))
    const svc = services(running, [...running, 'ended-a', 'ended-b'])
    const parent = { id: 'adm-3' }
    const first = await admitContinuation(svc, parent, 'ended-a', new AbortController().signal)
    running.add('ended-a') // activation became visible; reservation not yet released
    expect(pendingContinuations('adm-3', id => running.has(id))).toBe(0)
    // 25 running now = at cap: refused by the live count itself, not by a phantom reservation.
    const second = await admitContinuation(svc, parent, 'ended-b', new AbortController().signal)
    expect(second.admitted).toBe(false)
    running.delete('c-0') // a slot frees: the stale reservation must not still block it
    const third = await admitContinuation(svc, parent, 'ended-b', new AbortController().signal)
    expect(third.admitted).toBe(true)
    if (first.admitted) first.release()
    if (third.admitted) third.release()
  })

  it('an aborted queued continuation rejects and does not wedge or reserve', async () => {
    const running = new Set(ids(2))
    const svc = services(running, [...running, 'ended-a'])
    const holder = await acquireAdmission('adm-4', new AbortController().signal)
    const controller = new AbortController()
    const queued = admitContinuation(svc, { id: 'adm-4' }, 'ended-a', controller.signal)
    controller.abort()
    await expect(queued).rejects.toBeDefined()
    holder()
    expect(pendingContinuations('adm-4', () => false)).toBe(0)
    const after = await admitContinuation(svc, { id: 'adm-4' }, 'ended-a', new AbortController().signal)
    expect(after.admitted).toBe(true)
    if (after.admitted) after.release()
  })

  it('the signal aborting after admission releases the reservation', async () => {
    const running = new Set(ids(CAP - 1))
    const svc = services(running, [...running, 'ended-a'])
    const controller = new AbortController()
    const got = await admitContinuation(svc, { id: 'adm-5' }, 'ended-a', controller.signal)
    expect(got.admitted).toBe(true)
    expect(pendingContinuations('adm-5', () => false)).toBe(1)
    controller.abort()
    expect(pendingContinuations('adm-5', () => false)).toBe(0)
  })

  it('a forgotten reservation expires by TTL (no starvation)', () => {
    vi.useFakeTimers()
    try {
      reserveContinuationSlot('adm-6', 'ended-a', 1000)
      expect(pendingContinuations('adm-6', () => false)).toBe(1)
      vi.advanceTimersByTime(1000)
      expect(pendingContinuations('adm-6', () => false)).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('degrades open (no lease, no reservation) without an attributable parent or listing seam', async () => {
    const svc = services(new Set(), [])
    await expect(admitContinuation(svc, undefined, 'x', new AbortController().signal)).resolves.toMatchObject({ admitted: true })
    await expect(admitContinuation({ get: () => undefined }, { id: 'adm-7' }, 'x', new AbortController().signal))
      .resolves.toMatchObject({ admitted: true })
    expect(pendingContinuations('adm-7', () => false)).toBe(0)
    expect(admissionQueueSize()).toBe(0)
  })
})

// ── Plugin wiring: the reservation's lifecycle across pre/post-execute ──────

describe('send_message gate holds the reservation only until the tool settles', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dsh-cc-admission-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  function wire(running: Set<string>, listed: string[]) {
    const handlers = new Map<string, (...args: never[]) => unknown>()
    const svc = services(running, listed)
    const ctx = {
      provide: () => {},
      get: (key: string) => key === 'ccReleaseMarkers' ? undefined : svc.get(key),
      agents: { get: () => undefined },
      on: (name: string, handler: never) => { handlers.set(name, handler); return () => {} },
      effect: () => {},
      logger: { warn: () => {} },
    }
    applyResumePinsPlugin(ctx as never, { pinsRoot: root })
    return {
      pre: handlers.get('tools/pre-execute') as unknown as (exec: unknown, next: () => Promise<unknown>) => Promise<{ kind?: string }>,
      post: handlers.get('tools/post-execute') as unknown as (exec: unknown, result: unknown, next: () => Promise<unknown>) => Promise<unknown>,
    }
  }
  const execOf = (parentId: string, target: string, signal = new AbortController().signal) =>
    ({ name: 'send_message', token: Symbol(target), arguments: { agent_id: target }, agent: { id: parentId }, signal })

  it('reserves on admit, blocks a second continuation at the cap, and frees on post-execute', async () => {
    const running = new Set(ids(CAP - 1))
    const { pre, post } = wire(running, [...running, 'ended-a', 'ended-b'])
    const a = execOf('gate-1', 'ended-a')
    await pre(a, async () => ({ kind: 'allow' }))
    expect(pendingContinuations('gate-1', () => false)).toBe(1)
    const refused = await pre(execOf('gate-1', 'ended-b'), async () => ({ kind: 'allow' }))
    expect(refused).toMatchObject({ kind: 'deny', reason: LIVE_CAPACITY_REFUSAL })
    await post(a, { content: [] }, async () => ({ kind: 'accept' }))
    expect(pendingContinuations('gate-1', () => false)).toBe(0)
  })

  it('a downstream deny or throw releases the reservation immediately', async () => {
    const running = new Set(ids(CAP - 1))
    const { pre } = wire(running, [...running, 'ended-a'])
    await pre(execOf('gate-2', 'ended-a'), async () => ({ kind: 'deny', reason: 'later gate said no' }))
    expect(pendingContinuations('gate-2', () => false)).toBe(0)
    await expect(pre(execOf('gate-2', 'ended-a'), async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(pendingContinuations('gate-2', () => false)).toBe(0)
    expect(admissionQueueSize()).toBe(0)
  })

  it('a queued continuation cancelled while waiting for the lease resolves as cancel', async () => {
    const running = new Set(ids(2))
    const { pre } = wire(running, [...running, 'ended-a'])
    const holder = await acquireAdmission('gate-3', new AbortController().signal)
    const controller = new AbortController()
    const queued = pre(execOf('gate-3', 'ended-a', controller.signal), async () => ({ kind: 'allow' }))
    controller.abort()
    await expect(queued).resolves.toEqual({ kind: 'cancel' })
    holder()
  })
})
