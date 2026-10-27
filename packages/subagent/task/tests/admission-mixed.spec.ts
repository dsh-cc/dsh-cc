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
  it.each(['spawn', 'continuation'] as const)('%s first: only one lane gets the last slot', async (first) => {
    const w = world(CAP - 1)
    const spawn = () => startBackground(w.seam, {
      label: 'x', prompt: [{ type: 'text', text: 'go' }], parent: w.parent as never, signal: new AbortController().signal,
    }).then(() => 'admitted', () => 'refused')
    const continuation = async () => {
      const admission = await admitContinuation(w.services, w.parent, w.ended, new AbortController().signal)
      if (!admission.admitted) return 'refused'
      try { w.running.add(w.ended); return 'admitted' } finally { admission.release() }
    }
    const outcomes = first === 'spawn' ? [spawn(), continuation()] : [continuation(), spawn()]
    await w.flush(); w.releaseAll(); await w.flush()
    expect((await Promise.all(outcomes)).filter(o => o === 'admitted')).toHaveLength(1)
    expect(w.running.size).toBe(CAP)
  })
})
