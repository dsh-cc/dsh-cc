/**
 * Tests for the `ccContinuableDisposals` receipt registry (design §3.4.4):
 * delegation to the seam, parent-bound receipt retention, natural-settlement
 * expiry, the in-flight dispose memoization, teardown-failure retry honesty,
 * foreign/no-receipt refusals, and the unload clear.
 */
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  CcContinuableDisposals,
  type ContinuableActivationLike,
} from '../src/continuable-disposals.ts'

const PARENT = SessionId('parent-1')
const OTHER_PARENT = SessionId('parent-2')
const CHILD = SessionId('child-1')

/** A fake activation with externally-controllable result and dispose promises. */
function fakeActivation(childId: SessionId = CHILD): {
  activation: ContinuableActivationLike
  settleResult: (outcome?: 'reject') => void
  disposeCalls: number
  resolveDispose: () => void
  rejectDispose: (error: unknown) => void
} {
  let settleResult!: (outcome?: 'reject') => void
  const result = new Promise<unknown>((resolve, reject) => {
    settleResult = (outcome?: 'reject') => (outcome === 'reject' ? reject(new Error('child fault')) : resolve({ stopReason: 'completed' }))
  })
  // The service attaches a rejection branch for its cleanup; contained here.
  result.catch(() => {})
  let resolveDispose!: () => void
  let rejectDispose!: (error: unknown) => void
  const disposed = new Promise<void>((resolve, reject) => {
    resolveDispose = resolve
    rejectDispose = reject
  })
  disposed.catch(() => {})
  const state = {
    activation: {
      childId,
      result,
      dispose: () => {
        state.disposeCalls += 1
        return disposed
      },
    } as ContinuableActivationLike,
    settleResult,
    disposeCalls: 0,
    resolveDispose,
    rejectDispose,
  }
  return state
}

/** A fake subagents seam returning the queued activations in order. */
function fakeSeam(...activations: ContinuableActivationLike[]): {
  seam: { startActivation(spec: { parent: { id: unknown } }): Promise<ContinuableActivationLike> }
  specs: unknown[]
} {
  const queue = [...activations]
  const specs: unknown[] = []
  return {
    seam: {
      async startActivation(spec: { parent: { id: unknown } }): Promise<ContinuableActivationLike> {
        specs.push(spec)
        const next = queue.shift()
        if (next === undefined) throw new Error('no activation queued')
        return next
      },
    },
    specs,
  }
}

function spec(parentId: string = PARENT): { parent: { id: unknown }; provider: string } {
  return { parent: { id: parentId }, provider: 'spawn' }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('CcContinuableDisposals', () => {
  it('startTracked delegates to seam.startActivation with the verbatim spec and returns its activation', async () => {
    const fake = fakeActivation()
    const { seam, specs } = fakeSeam(fake.activation)
    const service = new CcContinuableDisposals()
    const started = await service.startTracked(seam, spec())
    expect(started).toBe(fake.activation)
    expect(specs).toHaveLength(1)
    expect(specs[0]).toEqual(spec())
  })

  it('tryDispose on an untracked child → {held:false, cause:no-receipt}, never throwing', async () => {
    const service = new CcContinuableDisposals()
    await expect(service.tryDispose(PARENT, CHILD)).resolves.toEqual({ held: false, cause: 'no-receipt' })
  })

  it('tryDispose on a receipt bound to another parent → {held:false, cause:foreign}, dispose never called', async () => {
    const fake = fakeActivation()
    const service = new CcContinuableDisposals()
    await service.startTracked(fakeSeam(fake.activation).seam, spec())
    await expect(service.tryDispose(OTHER_PARENT, CHILD)).resolves.toEqual({ held: false, cause: 'foreign' })
    expect(fake.disposeCalls).toBe(0)
  })

  it('tryDispose on the creating parent disposes the retained activation (receipt removed on fulfill)', async () => {
    const fake = fakeActivation()
    const service = new CcContinuableDisposals()
    await service.startTracked(fakeSeam(fake.activation).seam, spec())
    const attempt = await service.tryDispose(PARENT, CHILD)
    expect(attempt.held).toBe(true)
    if (!attempt.held) throw new Error('unreachable')
    expect(fake.disposeCalls).toBe(1)
    fake.resolveDispose()
    await expect(attempt.disposed).resolves.toBeUndefined()
    await flush()
    // Fulfilled dispose removed the entry.
    await expect(service.tryDispose(PARENT, CHILD)).resolves.toEqual({ held: false, cause: 'no-receipt' })
  })

  it('natural settlement drops the receipt — a later release attempt honestly reports no-receipt', async () => {
    const fake = fakeActivation()
    const service = new CcContinuableDisposals()
    await service.startTracked(fakeSeam(fake.activation).seam, spec())
    fake.settleResult()
    await flush()
    await expect(service.tryDispose(PARENT, CHILD)).resolves.toEqual({ held: false, cause: 'no-receipt' })
    expect(fake.disposeCalls).toBe(0)
  })

  it('natural settlement by result REJECTION also drops the receipt (no unhandled rejection)', async () => {
    const fake = fakeActivation()
    const service = new CcContinuableDisposals()
    await service.startTracked(fakeSeam(fake.activation).seam, spec())
    fake.settleResult('reject')
    await flush()
    await expect(service.tryDispose(PARENT, CHILD)).resolves.toEqual({ held: false, cause: 'no-receipt' })
  })

  it('restored-execution honesty: settle (receipt dropped) → a restored execution reports no-receipt', async () => {
    // The spawn's activation settles; send_message restores a NEW activation
    // this process holds no receipt for (no API can release it by id).
    const fake = fakeActivation()
    const service = new CcContinuableDisposals()
    await service.startTracked(fakeSeam(fake.activation).seam, spec())
    fake.settleResult()
    await flush()
    // The simulate-restored execution is never routed through startTracked.
    await expect(service.tryDispose(PARENT, CHILD)).resolves.toEqual({ held: false, cause: 'no-receipt' })
  })

  it('in-flight-dispose retry: a concurrent tryDispose returns the SAME memoized promise; dispose called once', async () => {
    const fake = fakeActivation()
    const service = new CcContinuableDisposals()
    await service.startTracked(fakeSeam(fake.activation).seam, spec())
    const first = await service.tryDispose(PARENT, CHILD)
    const second = await service.tryDispose(PARENT, CHILD)
    expect(first.held).toBe(true)
    expect(second.held).toBe(true)
    if (!first.held || !second.held) throw new Error('unreachable')
    expect(second.disposed).toBe(first.disposed)
    expect(fake.disposeCalls).toBe(1)
  })

  it('teardown-failure retry: the entry remains and every retry returns the same memoized rejecting promise', async () => {
    const fake = fakeActivation()
    const service = new CcContinuableDisposals()
    await service.startTracked(fakeSeam(fake.activation).seam, spec())
    const first = await service.tryDispose(PARENT, CHILD)
    if (!first.held) throw new Error('unreachable')
    const failure = new Error('teardown boom')
    fake.rejectDispose(failure)
    await expect(first.disposed).rejects.toBe(failure)
    await flush()
    const retry = await service.tryDispose(PARENT, CHILD)
    expect(retry.held).toBe(true)
    if (!retry.held) throw new Error('unreachable')
    expect(retry.disposed).toBe(first.disposed)
    await expect(retry.disposed).rejects.toBe(failure)
    expect(fake.disposeCalls).toBe(1)
  })

  it('natural settlement during an in-flight dispose is a NO-OP; disposal settlement owns the cleanup', async () => {
    const fake = fakeActivation()
    const service = new CcContinuableDisposals()
    await service.startTracked(fakeSeam(fake.activation).seam, spec())
    const attempt = await service.tryDispose(PARENT, CHILD)
    if (!attempt.held) throw new Error('unreachable')
    // The result settles before the close transaction propagates (harness
    // manager.ts ordering); the receipt must survive mid-dispose.
    fake.settleResult()
    await flush()
    const still = await service.tryDispose(PARENT, CHILD)
    expect(still.held).toBe(true)
    if (!still.held) throw new Error('unreachable')
    expect(still.disposed).toBe(attempt.disposed)
    // Fulfilling the dispose then removes the entry.
    fake.resolveDispose()
    await expect(attempt.disposed).resolves.toBeUndefined()
    await flush()
    await expect(service.tryDispose(PARENT, CHILD)).resolves.toEqual({ held: false, cause: 'no-receipt' })
  })

  it('identity guard: a stale activation settling never removes a replacement receipt for the same child id', async () => {
    const first = fakeActivation()
    const second = fakeActivation()
    const service = new CcContinuableDisposals()
    const { seam } = fakeSeam(first.activation, second.activation)
    await service.startTracked(seam, spec())
    // The child id is re-started (new execution) before the old result settles.
    await service.startTracked(seam, spec())
    first.settleResult()
    await flush()
    const attempt = await service.tryDispose(PARENT, CHILD)
    expect(attempt.held).toBe(true)
    if (!attempt.held) throw new Error('unreachable')
    // The receipt retained is the SECOND activation (dispose count on the first stays 0).
    expect(second.disposeCalls).toBe(1)
    expect(first.disposeCalls).toBe(0)
  })

  it('releasing a parent never touches a grandchild receipt (dispose does not cascade)', async () => {
    const parentActivation = fakeActivation(SessionId('parent-child'))
    const grandActivation = fakeActivation(SessionId('grandchild'))
    const service = new CcContinuableDisposals()
    const { seam } = fakeSeam(parentActivation.activation, grandActivation.activation)
    await service.startTracked(seam, spec(PARENT)) // parent-child under PARENT
    await service.startTracked(seam, { parent: { id: 'parent-child' }, provider: 'spawn' }) // grandchild under parent-child
    const attempt = await service.tryDispose(PARENT, SessionId('parent-child'))
    expect(attempt.held).toBe(true)
    expect(parentActivation.disposeCalls).toBe(1)
    expect(grandActivation.disposeCalls).toBe(0)
    // The grandchild receipt is fully retained: its own creating session can release it.
    const grand = await service.tryDispose(SessionId('parent-child'), SessionId('grandchild'))
    expect(grand.held).toBe(true)
    if (!grand.held) throw new Error('unreachable')
    expect(grandActivation.disposeCalls).toBe(1)
  })

  it('clear() (plugin unload) drops every receipt — later attempts report no-receipt', async () => {
    const fake = fakeActivation()
    const service = new CcContinuableDisposals()
    await service.startTracked(fakeSeam(fake.activation).seam, spec())
    service.clear()
    await expect(service.tryDispose(PARENT, CHILD)).resolves.toEqual({ held: false, cause: 'no-receipt' })
    expect(fake.disposeCalls).toBe(0)
  })
})
