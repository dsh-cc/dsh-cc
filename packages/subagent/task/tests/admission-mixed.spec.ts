/**
 * Review P1 on #301: spawn and `send_message` continuation share the
 * per-parent admission lease (F-1). rc.5 deleted the shared capacity CHECK
 * (the harness pool is the only valve) but not the serialization: a spawn's
 * creation holds the lease, so a continuation racing it cannot interleave —
 * it wins admission only after the spawn's creation settles.
 */
import { describe, expect, it } from 'vitest'
import { admitContinuation } from '@dsh-cc/subagent-resume-pins'
import { startBackground, type SubagentsLike } from '../src/background-start.ts'

describe('spawn + continuation share one admission lease', () => {
  it.each(['resume', 'resident'] as const)('continuation (%s target) waits for the spawn creation to release the lease', async (kind) => {
    const gate: Array<() => void> = []
    let creations = 0
    const seam = {
      startActivation: async (spec: { childId?: string }) => {
        await new Promise<void>(resolve => { gate.push(resolve) })
        creations += 1
        return {
          childId: spec.childId ?? 'spawned-1',
          messageId: 'm',
          result: Promise.resolve({ stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        }
      },
      getProvider: () => ({ prepareContinuable: () => undefined }),
      list: () => [],
    } satisfies SubagentsLike
    const spawn = startBackground(seam, {
      label: 'x', prompt: [{ type: 'text', text: 'go' }], parent: { id: 'parent-m' } as never, signal: new AbortController().signal,
    })
    const flush = async (): Promise<void> => { for (let i = 0; i < 30; i++) await Promise.resolve() }
    await flush()
    expect(gate).toHaveLength(1) // spawn's creation is in flight, holding the lease

    let admitted = false
    const targetId = kind === 'resume' ? 'ended-1' : 'running-1'
    const continuation = admitContinuation(
      { get: () => undefined },
      { id: 'parent-m', session: { header: {} } },
      targetId,
      new AbortController().signal,
    ).then((admission) => {
      admitted = admission.admitted
      admission.release()
      return admission.admitted
    })
    await flush()
    // The spawn's creation still holds the per-parent lease: the continuation
    // must not have been admitted in the interleaving.
    expect(admitted).toBe(false)
    for (const g of gate.splice(0)) g()
    expect(await spawn).toMatchObject({ status: 'async_launched' })
    expect(await continuation).toBe(true)
    expect(creations).toBe(1)
  })
})
