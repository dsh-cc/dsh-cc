/**
 * Review P1 on #301: spawn and `send_message` continuation shared no lock, so
 * with 24 live children one spawn and one continuation could both pass their
 * independent capacity checks and reach 26. Deterministic interleaving: both
 * listings yield before answering and the spawn's creation is held on a gate.
 */
import { describe, expect, it } from 'vitest'
import { admitContinuation } from '@dsh-cc/subagent-resume-pins'
import { MAX_LIVE_CONTINUABLE_CHILDREN as CAP, startBackground, type SubagentsLike } from '../src/background-start.ts'

function world(initialRunning: number) {
  const running = new Set<string>(Array.from({ length: initialRunning }, (_, i) => `pre-${i}`))
  const ended = 'ended-1'
  const gates: Array<() => void> = []
  const registry = { get: (id: unknown) => running.has(String(id)) ? { status: 'running' } : undefined }
  const list = async () => {
    const snapshot = [...running, ended].map(id => ({ id }))
    await Promise.resolve()
    await Promise.resolve()
    return snapshot
  }
  const seam = {
    listChildren: list,
    startContinuable: async (spec: { childId?: string }) => {
      await new Promise<void>(resolve => { gates.push(resolve) })
      const childId = spec.childId ?? 'spawned-1'
      running.add(childId)
      return { childId, messageId: 'm' }
    },
    getProvider: () => ({ prepareContinuable: () => undefined }),
    list: () => [],
    start: async () => { throw new Error('unused') },
  } satisfies SubagentsLike
  const ctxGet = (name: string) => name === 'agents' ? registry : name === 'subagents' ? { listChildren: list } : undefined
  const parent = { id: 'parent-m', ctx: { get: ctxGet } }
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
  return { running, ended, seam, parent, services: { get: ctxGet }, flush, releaseAll: () => { for (const g of gates.splice(0)) g() } }
}

describe('review P1: spawn + continuation share one admission', () => {
  it('24 live, one spawn and one continuation concurrently: at most 25 live, exactly one admitted', async () => {
    const w = world(CAP - 1)
    const spawn = startBackground(w.seam, {
      label: 'x', prompt: [{ type: 'text', text: 'go' }], parent: w.parent as never, signal: new AbortController().signal,
    }).then(() => 'admitted' as const, () => 'refused' as const)
    let release: (() => void) | undefined
    const continuation = admitContinuation(w.services, w.parent, w.ended, new AbortController().signal).then(
      admission => {
        if (admission.admitted) release = admission.release
        return admission.admitted ? 'admitted' as const : 'refused' as const
      },
    )
    await w.flush()
    w.releaseAll()
    await w.flush()
    const outcomes = await Promise.all([spawn, continuation])
    // The admitted continuation activates the ended child only AFTER admission
    // (the tool body runs after the pre-execute gate) — the real-world ordering.
    if (outcomes[1] === 'admitted') w.running.add(w.ended)
    expect(outcomes.filter(o => o === 'admitted')).toHaveLength(1)
    release?.() // post-execute: the tool settled
    expect(w.running.size).toBeLessThanOrEqual(CAP)
  })
})
