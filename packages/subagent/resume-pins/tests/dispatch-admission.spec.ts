import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../src/plugin.ts'
import { acquireAdmission } from '../src/admission.ts'

const roots: string[] = []
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
let serial = 0
function world(n: number) {
  const running = new Set(Array.from({ length: n }, (_, i) => `c-${i}`))
  const listed = [...running, 'A', 'B']
  const registry = { get: (id: unknown) => running.has(String(id)) ? { status: 'running' } : undefined }
  const root = mkdtempSync(join(tmpdir(), 'dispatch-admission-')); roots.push(root)
  const handlers = new Map<string, (...args: any[]) => Promise<any>>()
  const parent = { id: `dispatch-parent-${serial++}` }
  const services = { get: (name: string) => name === 'agents' ? registry : name === 'subagents' ? { listChildren: async () => listed.map(id => ({ id })) } : undefined }
  const ctx = { ...services, agents: registry, provide() {}, effect() {}, logger: { warn() {} }, on(name: string, fn: any) { handlers.set(name, fn) } }
  apply(ctx as never, { pinsRoot: root })
  const call = (target: string, signal = new AbortController().signal) => ({ name: 'send_message', token: Symbol('dsh.tool.execution'), arguments: { agent_id: target }, agent: parent, signal })
  return { running, parent, services, ctx, call, pre: handlers.get('tools/pre-execute')!, execute: handlers.get('tools/execute')! }
}
const allow = async () => ({ kind: 'allow' })
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
function gate() { let open!: () => void; const promise = new Promise<void>(r => { open = r }); return { promise, open } }

describe('continuation admission owns check + acceptance, after approval', () => {
  it('retains admission during slow activation beyond 30 seconds; a second activation cannot overtake it', async () => {
    vi.useFakeTimers()
    const w = world(24), a = w.call('A'), b = w.call('B'), startup = gate()
    await w.pre(a, allow)
    const first = w.execute(a, async () => { await startup.promise; w.running.add('A'); return { content: [] } })
    await flush(); await vi.advanceTimersByTimeAsync(60_000)
    await w.pre(b, allow)
    const body = vi.fn(async () => ({ content: [] }))
    const second = w.execute(b, body).catch((e: Error) => e.message)
    await flush()
    expect(body).not.toHaveBeenCalled()
    startup.open(); await first
    expect(await second).toContain('25 live subagents')
    expect(w.running.size).toBe(25)
  })

  it('rechecks a target that was running before approval but settled before dispatch', async () => {
    const w = world(25), a = w.call('c-0')
    await w.pre(a, allow)
    w.running.delete('c-0'); w.running.add('B')
    const body = vi.fn(async () => { w.running.add('c-0'); return { content: [] } })
    await expect(w.execute(a, body)).rejects.toThrow('25 live subagents')
    expect(body).not.toHaveBeenCalled()
  })

  it('two concurrent messages to one cold child share its eventual running slot', async () => {
    const w = world(24), a = w.call('A'), b = w.call('A'), startup = gate()
    expect((await w.pre(a, allow)).kind).toBe('allow')
    expect((await w.pre(b, allow)).kind).toBe('allow')
    const first = w.execute(a, async () => { await startup.promise; w.running.add('A'); return { content: [] } })
    const body = vi.fn(async () => ({ content: [] }))
    const second = w.execute(b, body)
    await flush(); expect(body).not.toHaveBeenCalled()
    startup.open(); await first; await second
    expect(body).toHaveBeenCalledOnce(); expect(w.running.size).toBe(25)
  })

  it('approval does not occupy admission, even if it fails without post-execute', async () => {
    const w = world(24), waiting = gate(), a = w.call('A')
    const pre = w.pre(a, async () => { await waiting.promise; throw new Error('approval failed') }).catch((e: Error) => e.message)
    await flush()
    const lease = await acquireAdmission(w.parent.id, a.signal); lease()
    waiting.open(); expect(await pre).toBe('approval failed')
    const b = w.call('B'); await w.pre(b, allow)
    await w.execute(b, async () => { w.running.add('B'); return { content: [] } })
  })

  it('a throwing execution wrapper releases admission without relying on post-execute', async () => {
    const w = world(24), a = w.call('A'), b = w.call('B')
    await w.pre(a, allow)
    await expect(w.execute(a, async () => { throw new Error('wrapper failed') })).rejects.toThrow('wrapper failed')
    await w.pre(b, allow)
    await w.execute(b, async () => { w.running.add('B'); return { content: [] } })
    expect(w.running.size).toBe(25)
  })

  it('cancellation during the listing never invokes the body or wedges the next call', async () => {
    const w = world(24), controller = new AbortController(), a = w.call('A', controller.signal)
    const original = w.ctx.get
    w.ctx.get = (name: string) => name === 'subagents' ? { listChildren: async () => { controller.abort(new Error('cancelled')); throw new Error('listing aborted') } } : original(name)
    await w.pre(a, allow)
    const body = vi.fn(async () => ({ content: [] }))
    await expect(w.execute(a, body)).rejects.toThrow('cancelled')
    expect(body).not.toHaveBeenCalled()
    w.ctx.get = original
    const b = w.call('B'); await w.pre(b, allow); await w.execute(b, async () => ({ content: [] }))
  })

  it('an abort does not hand off a held lease until activation has unwound', async () => {
    const w = world(24), controller = new AbortController(), a = w.call('A', controller.signal), b = w.call('B'), startup = gate()
    await w.pre(a, allow)
    const first = w.execute(a, async () => { await startup.promise; controller.signal.throwIfAborted(); return { content: [] } }).catch((e: Error) => e.message)
    await flush(); controller.abort(new Error('activation cancelled'))
    await w.pre(b, allow)
    const body = vi.fn(async () => ({ content: [] }))
    const second = w.execute(b, body)
    await flush(); expect(body).not.toHaveBeenCalled()
    startup.open(); expect(await first).toBe('activation cancelled')
    await second; expect(body).toHaveBeenCalledOnce()
  })

  it("child-to-parent reports do not consume one of the sending child's slots", async () => {
    const w = world(25), call = { ...w.call('parent-target'), agent: { ...w.parent, session: { header: { parentSession: 'parent-target' } } } }
    await w.pre(call, allow)
    const body = vi.fn(async () => ({ content: [] }))
    await w.execute(call, body)
    expect(body).toHaveBeenCalledOnce()
  })

})
