/**
 * F-1 (TLA `strict-cap-toctou`): the spawn capacity check and the creation
 * call used to be two separate awaits with no lock, so N concurrent
 * admissions at `live = cap - 1` all passed the check and all created a
 * child. These tests drive that exact interleaving deterministically
 * (a listChildren that yields, a startContinuable held on a gate) and pin
 * the fix: check + occupy is one critical section per parent.
 */
import { describe, expect, it } from 'vitest'
import {
  LIVE_CAPACITY_REFUSAL,
  MAX_LIVE_CONTINUABLE_CHILDREN as CAP,
  startBackground,
  type BackgroundRequest,
  type SubagentsLike,
} from '../src/background-start.ts'

/** A fake world: `running` ids are what the agents registry reports as running. */
function world(initialRunning: number) {
  const running = new Set<string>(Array.from({ length: initialRunning }, (_, i) => `pre-${i}`))
  const created: string[] = []
  const gates: Array<() => void> = []
  let holdCreation = true
  const seam = {
    // Yields before answering: the snapshot is taken BEFORE any in-flight creation lands.
    listChildren: async () => {
      const snapshot = [...running].map(id => ({ id }))
      await Promise.resolve()
      await Promise.resolve()
      return snapshot
    },
    startContinuable: async (spec: { childId?: string }) => {
      if (holdCreation) await new Promise<void>(resolve => { gates.push(resolve) })
      const childId = spec.childId ?? `child-${created.length}`
      created.push(childId)
      running.add(childId) // a created child is a running activation
      return { childId, messageId: 'm' }
    },
    getProvider: () => ({ prepareContinuable: () => undefined }),
    list: () => [],
    start: async () => { throw new Error('unused') },
  } satisfies SubagentsLike
  const parentOf = (id: string) => ({
    id,
    ctx: { get: () => ({ get: (child: string) => running.has(child) ? { status: 'running' } : undefined }) },
  })
  const request = (parentId: string, signal = new AbortController().signal): BackgroundRequest => ({
    label: 'x',
    prompt: [{ type: 'text', text: 'go' }],
    parent: parentOf(parentId) as never,
    signal,
  })
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  return {
    seam, created, running, request, flush,
    open: () => { holdCreation = false; for (const g of gates.splice(0)) g() },
    releaseOne: () => gates.shift()?.(),
    pending: () => gates.length,
  }
}

describe('F-1: spawn admission is atomic per parent', () => {
  it('admits exactly one of N concurrent starts at cap - 1 (the rest get the capacity refusal)', async () => {
    const w = world(CAP - 1)
    const attempts = Array.from({ length: 3 }, () => startBackground(w.seam, w.request('parent-a')).then(
      () => 'admitted' as const,
      (error: Error) => error.message,
    ))
    await w.flush()
    // Drain creations one at a time until everything settled.
    for (let i = 0; i < 10; i++) { w.releaseOne(); await w.flush() }
    const outcomes = await Promise.all(attempts)
    expect(outcomes.filter(o => o === 'admitted')).toHaveLength(1)
    expect(outcomes.filter(o => o === LIVE_CAPACITY_REFUSAL)).toHaveLength(2)
    expect(w.created).toHaveLength(1)
    expect([...w.running]).toHaveLength(CAP)
  })

  it('does not serialize different parents against each other', async () => {
    const w = world(0)
    const a = startBackground(w.seam, w.request('parent-a'))
    const b = startBackground(w.seam, w.request('parent-b'))
    await w.flush()
    expect(w.pending()).toBe(2) // both creations in flight at once
    w.open()
    await Promise.all([a, b])
    expect(w.created).toHaveLength(2)
  })

  it('releases the slot when the creation fails, so a later admission proceeds', async () => {
    const w = world(CAP - 1)
    const failing = { ...w.seam, startContinuable: async () => { throw new Error('boom') } }
    await expect(startBackground(failing, w.request('parent-c'))).rejects.toThrow('boom')
    w.open()
    await expect(startBackground(w.seam, w.request('parent-c'))).resolves.toMatchObject({ status: 'async_launched' })
  })

  it('a waiter whose signal aborts while queued rejects without consuming a slot or wedging the queue', async () => {
    const w = world(0)
    const first = startBackground(w.seam, w.request('parent-d'))
    await w.flush()
    const controller = new AbortController()
    const queued = startBackground(w.seam, w.request('parent-d', controller.signal))
    controller.abort()
    await expect(queued).rejects.toThrow()
    w.open()
    await first
    await expect(startBackground(w.seam, w.request('parent-d'))).resolves.toMatchObject({ status: 'async_launched' })
    expect(w.created).toHaveLength(2)
  })
})
