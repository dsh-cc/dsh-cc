/**
 * Composition/interplay tests (design doc
 * docs/plans/2026-10-09-verify-before-retry.md §3.3 Act (a), §3.4, §5.4/§5.5):
 * the retry-attendant's pre-execute listener is registered with
 * `prepend: true`, and cordis prepend UNSHIFTS — the later-registered prepend
 * listener is OUTERMOST. These tests pin the waterfall ordering and the
 * escalation/guidance interplay against that discipline using a
 * registration-order-faithful mini-waterfall (same seam semantics the live
 * agent loop dispatches with; safety-loop.spec.ts is the full-rig precedent).
 *
 * @module
 */

import { describe, expect, it, vi } from 'vitest'
import { registerListeners } from '../src/wiring.ts'
import { bashExec, enable, promotedResult, tempHome } from './rig.ts'

type AnyListener = (...args: never[]) => unknown

/**
 * Capturing ctx whose `on` mimics cordis ordering: `prepend: true` unshifts
 * (later prepend = OUTERMOST), plain registration appends. Listeners can be
 * registered BEFORE `mount()` (append-order stubs) or AFTER (hooks-shaped
 * prepend outers) — exactly the layouts cordis produces at plugin load.
 */
function captureCtx(home: string, approval: unknown = {}) {
  const listeners = new Map<string, Array<{ fn: AnyListener; prepend: boolean }>>()
  const debug = vi.fn()
  const on = (name: string, fn: AnyListener, opts?: { prepend?: boolean }): void => {
    const list = listeners.get(name) ?? []
    if (opts?.prepend === true) list.unshift({ fn, prepend: true })
    else list.push({ fn, prepend: false })
    listeners.set(name, list)
  }
  const ctx = {
    logger: { debug, warn: vi.fn() },
    on,
    get: (key: string): unknown => (key === 'approval' ? approval : undefined),
    dshHomePath: (): string => home,
  }
  const mount = (): void => { registerListeners(ctx as never) }
  const fns = (name: string): AnyListener[] => (listeners.get(name) ?? []).map((entry) => entry.fn)
  /**
   * Dispatch `name` outermost-first, threading `next` to the following
   * listener; `terminal` supplies the innermost default decision.
   */
  const dispatch = async (name: string, args: unknown[], terminal: () => unknown): Promise<unknown> => {
    const list = fns(name)
    if (list.length === 0) return terminal()
    const call = (i: number): unknown =>
      i < list.length
        ? list[i]!(...([...args, async (): Promise<unknown> => call(i + 1)] as never[]))
        : terminal()
    return call(0)
  }
  return { debug, fns, on, mount, dispatch }
}

describe('retry-attendant interplay (§3.3 Act (a), §3.4)', () => {
  it('a permissive stub permission listener registered in APPEND order before the mount does not bypass the attendant ask', async () => {
    const home = tempHome()
    enable(home, { enabled: true, guidance: true, escalate: true })
    const m = captureCtx(home)
    // Stub appended FIRST (it was mounted before the plugin).
    const stub = vi.fn(async (): Promise<unknown> => ({ kind: 'allow' }))
    m.on('tools/pre-execute', stub as never)
    m.mount()
    // The attendant's prepend unshift must land OUTSIDE the stub.
    expect(m.fns('tools/pre-execute').length).toBe(2)
    expect(m.fns('tools/pre-execute')[0]).not.toBe(stub)

    const exec = bashExec('pnpm build')
    await m.dispatch('tools/post-execute', [exec, promotedResult()], async () => ({ kind: 'accept' }))
    const decision = await m.dispatch('tools/pre-execute', [exec], async () => ({ kind: 'allow' }))
    expect(decision).toEqual({
      kind: 'ask',
      reason: expect.stringContaining('identical retry'),
      displayReason: { en: expect.stringContaining('identical retry') },
    })
    // The final decision is the attendant's ask — the innermost permissive
    // allow was delegated to (append-order listeners run inside) but could
    // not override it.
    expect(stub).toHaveBeenCalledTimes(1)
  })

  it('live two-listener waterfall: a hooks-shaped listener registered AFTER the mount lands OUTSIDE it', async () => {
    const home = tempHome()
    enable(home, { enabled: true, guidance: true, escalate: true })
    const m = captureCtx(home)
    m.mount()
    const exec = bashExec('pnpm build')
    await m.dispatch('tools/post-execute', [exec, promotedResult()], async () => ({ kind: 'accept' }))

    // Hooks-shaped listener: delegates first, then folds the downstream
    // verdict. Registered AFTER the attendant with prepend:true → unshifted
    // → outermost (the exact ordering the preset row ordering produces).
    const calls: string[] = []
    const hook = async (_exec: unknown, next: () => Promise<unknown>): Promise<unknown> => {
      calls.push('hook:delegate')
      const downstream = (await next()) as { kind: string }
      calls.push(`hook:fold(${downstream.kind})`)
      return downstream.kind === 'ask' ? { kind: 'allow' } : downstream
    }
    m.on('tools/pre-execute', hook as never, { prepend: true })
    const decision = (await m.dispatch('tools/pre-execute', [exec], async () => ({ kind: 'allow' }))) as { kind: string }
    // Delegation order: outer hook first, attendant inside.
    expect(calls).toEqual(['hook:delegate', 'hook:fold(ask)'])
    expect(decision).toEqual({ kind: 'allow' }) // hook allow downgraded the ask
  })

  it('waterfall fold: hook ask replaces the downstream verdict; hook deny short-circuits without next', async () => {
    const home = tempHome()
    enable(home, { enabled: true, guidance: true, escalate: true })
    const m = captureCtx(home)
    m.mount()
    const exec = bashExec('pnpm build')
    await m.dispatch('tools/post-execute', [exec, promotedResult()], async () => ({ kind: 'accept' }))
    const list = m.fns('tools/pre-execute')
    const withOuter = (hook: AnyListener): AnyListener[] => [hook, ...list]
    const run = async (chain: AnyListener[]): Promise<unknown> => {
      const step = (i: number): unknown =>
        i < chain.length
          ? chain[i]!(exec, async (): Promise<unknown> => step(i + 1) as never)
          : { kind: 'allow' }
      return step(0)
    }

    // hook ask replaces the downstream allow → ask survives, attendant reason.
    const hookAsk = (async (_e: unknown, next: () => Promise<unknown>): Promise<unknown> => {
      const downstream = await next()
      return { kind: 'ask', reason: 'hook asks', displayReason: { en: 'hook asks' }, overrides: downstream }
    }) as AnyListener
    const askDecision = (await run([hookAsk, ...list])) as { kind: string; reason?: string }
    expect(askDecision.kind).toBe('ask')
    expect(askDecision.reason).toBe('hook asks')

    // hook deny short-circuits: next never called, attendant never ran.
    let innerRan = false
    const boundary = async (): Promise<unknown> => { innerRan = true; return { kind: 'allow' } }
    const hookDeny = (async (): Promise<unknown> => ({ kind: 'deny', reason: 'hook no' })) as AnyListener
    const denyDecision = await run([hookDeny, ...list, boundary as never])
    expect(denyDecision).toEqual({ kind: 'deny', reason: 'hook no' })
    expect(innerRan).toBe(false)
  })

  it('waterfall passthrough: downstream deny/cancel pass through the outer fold unchanged', async () => {
    const home = tempHome()
    enable(home, { enabled: true, guidance: true, escalate: true })
    const m = captureCtx(home)
    m.mount()
    const exec = bashExec('pnpm build')
    await m.dispatch('tools/post-execute', [exec, promotedResult()], async () => ({ kind: 'accept' }))
    // Outer hook would downgrade an ask, but the inner boundary denies: the
    // stricter inner verdict must win, unchanged.
    const hook = (async (_e: unknown, next: () => Promise<unknown>): Promise<unknown> => {
      const downstream = await next()
      return downstream.kind === 'ask' ? { kind: 'allow' } : downstream
    }) as AnyListener
    const boundary = async (): Promise<unknown> => ({ kind: 'deny', reason: 'boundary says no' })
    const chain = [hook, ...m.fns('tools/pre-execute'), boundary as never]
    const step = (i: number): unknown =>
      chain[i]!(exec, async (): Promise<unknown> => step(i + 1) as never)
    const decision = (await step(0)) as { kind: string; reason?: string }
    expect(decision.kind).toBe('deny')
    expect(decision.reason).toBe('boundary says no')
  })

  it('waterfall discipline: forced internal throw in the pre-execute listener ⇒ passthrough decision + debug log', async () => {
    const home = tempHome()
    enable(home, { enabled: true, guidance: true, escalate: true })
    const m = captureCtx(home)
    m.mount()
    const exec = bashExec('pnpm build')
    await m.dispatch('tools/post-execute', [exec, promotedResult()], async () => ({ kind: 'accept' }))
    // Cordis throws on missing-property access; an agent whose session getter
    // throws exercises the §4 swallow rule from INSIDE the try block.
    const poison = { get session(): never { throw new Error('cordis throw') } } as never
    const badExec = bashExec('pnpm build', { agent: poison })
    const decision = await m.dispatch('tools/pre-execute', [badExec], async () => ({ kind: 'allow' }))
    expect(decision).toEqual({ kind: 'allow' }) // delegated passthrough
    expect(m.debug).toHaveBeenCalledWith(expect.stringContaining('retry-attendant: pre-execute degraded to passthrough'))
  })

  it('guidance dedup (§5.5): two consecutive ambiguous outcomes of the same digest ⇒ guidance appended ONCE, entry recorded despite escalate:false', async () => {
    const home = tempHome()
    enable(home, { enabled: true, guidance: true, escalate: false })
    const m = captureCtx(home)
    m.mount()
    const exec = bashExec('pnpm build')
    const terminal = async (): Promise<unknown> => ({ kind: 'accept' })
    const guided = (d: { additionalContexts?: unknown[] }): number =>
      (d.additionalContexts ?? []).filter((c) => JSON.stringify(c).includes('[retry-attendant]')).length

    const first = (await m.dispatch('tools/post-execute', [exec, promotedResult()], terminal)) as { additionalContexts?: unknown[] }
    const second = (await m.dispatch('tools/post-execute', [exec, promotedResult()], terminal)) as { additionalContexts?: unknown[] }
    expect(guided(first)).toBe(1)
    expect(guided(second)).toBe(0)

    // The map entry was recorded despite escalate:false: flip the flag back on
    // and the identical retry escalates (the entry powers the M2 ask).
    enable(home, { enabled: true, guidance: true, escalate: true })
    const ask = await m.dispatch('tools/pre-execute', [exec], async () => ({ kind: 'allow' }))
    expect(ask).toMatchObject({ kind: 'ask' })
  })
})
