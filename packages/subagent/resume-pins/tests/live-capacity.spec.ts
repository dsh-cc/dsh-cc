/**
 * F-2 (live-capacity for continuation admission): continuing a settled child
 * through `send_message` admits a fresh resident activation, so the 25-cap that
 * guards the spawn lanes must guard continuations too. These tests pin the
 * counting predicate, the fail-open degradation and the gate wiring inside
 * `tools/execute`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LIVE_CAPACITY_REFUSAL,
  MAX_LIVE_CONTINUABLE_CHILDREN,
  applyResumePinsPlugin,
  continuationCapacityRefusal,
  countLiveChildren,
} from '../src/index.ts'

const runningIds = (n: number) => Array.from({ length: n }, (_, i) => `child-${i + 1}`)

function registryOf(running: string[], idle: string[] = []) {
  const status = new Map<string, string>()
  for (const id of running) status.set(id, 'running')
  for (const id of idle) status.set(id, 'idle')
  return { get: (id: unknown) => (status.has(String(id)) ? { status: status.get(String(id)) } : undefined) }
}

function servicesOf(opts: {
  live: number
  idle?: number
  listThrows?: boolean
  seamAbsent?: boolean
  registryAbsent?: boolean
}): { get: (name: string, strict?: boolean) => unknown } {
  const registry = registryOf(runningIds(opts.live), opts.idle === undefined ? [] : runningIds(opts.idle).map(i => `idle-${i}`))
  return {
    get: (name: string) => {
      if (name === 'subagents') {
        if (opts.seamAbsent === true) return {}
        return {
          listChildren: async () => {
            if (opts.listThrows === true) throw new Error('listChildren exploded')
            return [
              ...runningIds(opts.live).map(id => ({ id })),
              ...(opts.idle === undefined ? [] : runningIds(opts.idle).map(i => ({ id: `idle-${i}` }))),
            ]
          },
        }
      }
      if (name === 'agents') return opts.registryAbsent === true ? undefined : registry
      return undefined
    },
  }
}

const parent = { id: 'parent-1' }

describe('countLiveChildren', () => {
  it('counts only RUNNING children (idle rows hold no slot)', async () => {
    const services = servicesOf({ live: 3, idle: 2 })
    const live = await countLiveChildren(
      services.get('subagents') as never,
      services.get('agents') as never,
      parent.id,
    )
    expect(live).toBe(3)
  })

  it('is unobservable (undefined) without the listChildren seam', async () => {
    await expect(countLiveChildren({}, registryOf(runningIds(3)), parent.id)).resolves.toBeUndefined()
  })

  it('is unobservable when the listing throws', async () => {
    const services = servicesOf({ live: 3, listThrows: true })
    await expect(
      countLiveChildren(services.get('subagents') as never, services.get('agents') as never, parent.id),
    ).resolves.toBeUndefined()
  })

  it('counts zero when the activation registry is absent', async () => {
    const services = servicesOf({ live: 3, registryAbsent: true })
    await expect(
      countLiveChildren(services.get('subagents') as never, undefined, parent.id),
    ).resolves.toBe(0)
  })
})

describe('continuationCapacityRefusal', () => {
  it('admits one below the cap', async () => {
    const services = servicesOf({ live: MAX_LIVE_CONTINUABLE_CHILDREN - 1 })
    await expect(continuationCapacityRefusal(services, parent)).resolves.toBeUndefined()
  })

  it('refuses at the cap with the shared refusal literal', async () => {
    const services = servicesOf({ live: MAX_LIVE_CONTINUABLE_CHILDREN })
    await expect(continuationCapacityRefusal(services, parent)).resolves.toBe(LIVE_CAPACITY_REFUSAL)
  })

  it('degrades open when capacity is unobservable or unattributable', async () => {
    await expect(continuationCapacityRefusal(servicesOf({ live: 99, seamAbsent: true }), parent)).resolves.toBeUndefined()
    await expect(continuationCapacityRefusal(servicesOf({ live: 99, listThrows: true }), parent)).resolves.toBeUndefined()
    await expect(continuationCapacityRefusal(servicesOf({ live: 99 }), undefined)).resolves.toBeUndefined()
    await expect(continuationCapacityRefusal(servicesOf({ live: 99 }), {})).resolves.toBeUndefined()
  })
})

// ── Gate wiring (tools/execute) ────────────────────────────────────────

describe('send_message live-capacity gate', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dsh-cc-live-capacity-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function fakeCtx(opts: { live: number; liveTarget?: boolean; seamAbsent?: boolean }) {
    const preExecute: { handler: (exec: unknown, next: () => unknown) => unknown }[] = []
    const capacity = servicesOf({ live: opts.live, seamAbsent: opts.seamAbsent })
    const liveIds = new Set(runningIds(opts.live))
    const ctx = {
      provide: () => {},
      get: (key: string, strict?: boolean) => {
        if (key === 'ccReleaseMarkers') return undefined
        if (key === 'subagents' || key === 'agents') return capacity.get(key, strict)
        return undefined
      },
      agents: {
        get: (id: unknown) => (opts.liveTarget === true && liveIds.has(String(id)) ? { status: 'running' } : undefined),
      },
      on: (name: string, handler: never) => {
        if (name === 'tools/execute') preExecute.push({ handler })
        return () => {}
      },
      effect: () => {},
      logger: { warn: () => {} },
    }
    applyResumePinsPlugin(ctx as never, { pinsRoot: root })
    return preExecute[0]!.handler as (exec: unknown, next: () => Promise<string>) => Promise<unknown>
  }

  it('refuses a continuation at the cap before dispatch', async () => {
    const gate = fakeCtx({ live: MAX_LIVE_CONTINUABLE_CHILDREN })
    const next = vi.fn(async () => 'next-called')
    await expect(gate(
      { name: 'send_message', arguments: { agent_id: 'settled-child' }, agent: parent, signal: new AbortController().signal },
      next,
    )).rejects.toThrow(LIVE_CAPACITY_REFUSAL)
    expect(next).not.toHaveBeenCalled()
  })

  it('passes a same-epoch steer to a live agent (no new slot needed)', async () => {
    const gate = fakeCtx({ live: MAX_LIVE_CONTINUABLE_CHILDREN, liveTarget: true })
    const next = vi.fn(async () => 'next-called')
    await expect(
      gate(
        { name: 'send_message', arguments: { agent_id: 'child-1' }, agent: parent, signal: new AbortController().signal },
        next,
      ),
    ).resolves.toBe('next-called')
  })

  it('admits one below the cap', async () => {
    const gate = fakeCtx({ live: MAX_LIVE_CONTINUABLE_CHILDREN - 1 })
    const next = vi.fn(async () => 'next-called')
    await expect(
      gate(
        { name: 'send_message', arguments: { agent_id: 'settled-child' }, agent: parent, signal: new AbortController().signal },
        next,
      ),
    ).resolves.toBe('next-called')
  })

  it('degrades open when the capacity seam is absent', async () => {
    const gate = fakeCtx({ live: 0, seamAbsent: true })
    const next = vi.fn(async () => 'next-called')
    await expect(
      gate(
        { name: 'send_message', arguments: { agent_id: 'settled-child' }, agent: parent, signal: new AbortController().signal },
        next,
      ),
    ).resolves.toBe('next-called')
  })
})
