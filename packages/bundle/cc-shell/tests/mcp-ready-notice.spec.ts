/**
 * Tests for the MCP ready/settle notice: after the session-start "still
 * connecting" notice, the glue mounts an `agent/pre-step` listener that
 * appends ONE settle summary user message (by REWRITING the enter decision —
 * never `agent.inject()`, the phantom-wake bug) once every announced deferred
 * server has stopped handshaking. Text is built lazily at delivery time, so
 * tool counts registered after the latch still appear.
 */
import { describe, expect, it, vi } from 'vitest'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { McpConnectionEntry } from '@dsh-cc/mcp-client'
import { buildSettleText, mountMcpReadyNotice } from '../src/mcpReadyNotice.ts'

class FakeCtx {
  readonly listeners = new Map<string, {
    fn: (info: unknown, next: (decision: PreStepDecision) => Promise<PreStepDecision>) => Promise<PreStepDecision>
    disposed: boolean
  }[]>()

  on(event: string, fn: never, _opts?: unknown): () => void {
    const record = { fn, disposed: false }
    const list = this.listeners.get(event) ?? []
    list.push(record)
    this.listeners.set(event, list)
    return () => { record.disposed = true }
  }

  preStepListener():
    | ((info: unknown, next: (decision: PreStepDecision) => Promise<PreStepDecision>) => Promise<PreStepDecision>)
    | undefined {
    return this.listeners.get('agent/pre-step')?.find(r => !r.disposed)?.fn
  }
}

class FakeRegistry {
  readonly map = new Map<string, McpConnectionEntry>()
  private readonly listeners = new Set<(entry: McpConnectionEntry) => void>()

  entries(): McpConnectionEntry[] {
    return Array.from(this.map.values()).map(entry => ({ ...entry }))
  }

  onDidChange(listener: (entry: McpConnectionEntry) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  emit(entry: McpConnectionEntry): void {
    this.map.set(entry.name, entry)
    for (const listener of this.listeners) listener({ ...entry })
  }

  remove(name: string): void {
    this.map.delete(name)
    for (const listener of this.listeners) listener({ name, state: 'gone' } as McpConnectionEntry)
  }

  listenerCount(): number {
    return this.listeners.size
  }
}

const enter = (): PreStepDecision => ({ kind: 'enter', messages: [] })

interface Appended {
  text: string
}

/** Run the captured pre-step listener; extract appended message texts. */
async function drive(
  listener: ReturnType<FakeCtx['preStepListener']>,
  agent: unknown,
  decision: PreStepDecision,
): Promise<{ decision: PreStepDecision; appended: Appended[] }> {
  const result = await listener({ agent }, async () => decision)
  const appended: Appended[] = []
  if (result.kind === 'enter') {
    for (const message of result.messages) {
      const content = (message as { content?: { type: string; text?: string }[] }).content
      for (const part of content ?? []) {
        if (part.type === 'text' && part.text?.startsWith('MCP:')) appended.push({ text: part.text })
      }
    }
  }
  return { decision: result, appended }
}

function stubAgent(sid: string): unknown {
  return { session: { id: sid } }
}

describe('buildSettleText', () => {
  it('all ready with tool counts', () => {
    const entries: McpConnectionEntry[] = [
      { name: 'a', state: 'ready', toolCount: 16 },
      { name: 'b', state: 'ready', toolCount: 4 },
    ]
    expect(buildSettleText(entries, ['a', 'b']))
      .toBe('MCP: servers ready — a (16 tools), b (4 tools). Load their mcp__* tools via ToolSearch.')
  })

  it('ready without toolCount omits the count', () => {
    expect(buildSettleText([{ name: 'a', state: 'ready' }], ['a']))
      .toBe('MCP: servers ready — a. Load their mcp__* tools via ToolSearch.')
  })

  it('missing announced name renders as gone', () => {
    expect(buildSettleText([], ['ghost']))
      .toBe('MCP: servers unavailable — ghost (gone). Retry with /mcp reconnect ghost.')
  })
})

describe('mountMcpReadyNotice', () => {
  it('delivers exactly one settle message after all announced servers settle, then disposes', async () => {
    const ctx = new FakeCtx()
    const registry = new FakeRegistry()
    registry.emit({ name: 'a', state: 'connecting' })
    registry.emit({ name: 'b', state: 'connecting' })
    mountMcpReadyNotice(ctx as never, registry, ['a', 'b'], 'sid-1')

    registry.emit({ name: 'a', state: 'ready', toolCount: 16 })
    // Not yet settled (b still pending) → no text appended.
    const listener = ctx.preStepListener()
    const before = await drive(listener!, stubAgent('sid-1'), enter())
    expect(before.appended).toEqual([])

    registry.emit({ name: 'b', state: 'ready', toolCount: 4 })
    const delivered = await drive(ctx.preStepListener()!, stubAgent('sid-1'), enter())
    expect(delivered.appended).toHaveLength(1)
    expect(delivered.appended[0]!.text).toBe('MCP: servers ready — a (16 tools), b (4 tools). Load their mcp__* tools via ToolSearch.')
    // A later decision is untouched (listener disposed itself).
    const after = await drive(listener!, stubAgent('sid-1'), enter())
    expect(after.appended).toEqual([])
    expect(ctx.preStepListener()).toBeUndefined()
    // Registry subscription dropped too.
    expect(registry.listenerCount()).toBe(0)
  })

  it('partial settle keeps the decision identity and the latch', async () => {
    const ctx = new FakeCtx()
    const registry = new FakeRegistry()
    registry.emit({ name: 'a', state: 'connecting' })
    registry.emit({ name: 'b', state: 'connecting' })
    mountMcpReadyNotice(ctx as never, registry, ['a', 'b'], 'sid-1')
    registry.emit({ name: 'a', state: 'ready', toolCount: 1 })

    const decision = enter()
    const { decision: returned, appended } = await drive(ctx.preStepListener()!, stubAgent('sid-1'), decision)
    expect(returned).toBe(decision)
    expect(appended).toEqual([])
    expect(ctx.preStepListener()).toBeDefined()
  })

  it('error settle with none ready carries the reconnect hint', async () => {
    const ctx = new FakeCtx()
    const registry = new FakeRegistry()
    mountMcpReadyNotice(ctx as never, registry, ['a'], 'sid-1')
    registry.emit({ name: 'a', state: 'error', error: 'boom happened' })

    const { appended } = await drive(ctx.preStepListener()!, stubAgent('sid-1'), enter())
    expect(appended[0]!.text).toBe('MCP: servers unavailable — a (error: boom happened). Retry with /mcp reconnect a.')
  })

  it('mixed settle keeps the ToolSearch clause and names the failure', async () => {
    const ctx = new FakeCtx()
    const registry = new FakeRegistry()
    mountMcpReadyNotice(ctx as never, registry, ['a', 'b'], 'sid-1')
    registry.emit({ name: 'a', state: 'ready', toolCount: 2 })
    registry.emit({ name: 'b', state: 'error', error: 'kaboom' })

    const { appended } = await drive(ctx.preStepListener()!, stubAgent('sid-1'), enter())
    expect(appended[0]!.text)
      .toBe('MCP: servers settled — ready: a (2 tools); unavailable/active: b (error: kaboom). Ready servers\' mcp__* tools are loadable via ToolSearch.')
  })

  it('sid mismatch leaves the decision unchanged and keeps the latch', async () => {
    const ctx = new FakeCtx()
    const registry = new FakeRegistry()
    mountMcpReadyNotice(ctx as never, registry, ['a'], 'sid-1')
    registry.emit({ name: 'a', state: 'ready', toolCount: 1 })

    const wrong = await drive(ctx.preStepListener()!, stubAgent('other'), enter())
    expect(wrong.appended).toEqual([])
    expect(ctx.preStepListener()).toBeDefined()

    const right = await drive(ctx.preStepListener()!, stubAgent('sid-1'), enter())
    expect(right.appended).toHaveLength(1)
    expect(right.appended[0]!.text).toContain('servers ready')
  })

  it('reject decisions are left unchanged and do not consume the latch', async () => {
    const ctx = new FakeCtx()
    const registry = new FakeRegistry()
    mountMcpReadyNotice(ctx as never, registry, ['a'], 'sid-1')
    registry.emit({ name: 'a', state: 'ready', toolCount: 1 })

    const reject = { kind: 'reject' } as unknown as PreStepDecision
    const { decision: returned } = await drive(ctx.preStepListener()!, stubAgent('sid-1'), reject)
    expect(returned).toBe(reject)
    expect(ctx.preStepListener()).toBeDefined()

    const { appended } = await drive(ctx.preStepListener()!, stubAgent('sid-1'), enter())
    expect(appended).toHaveLength(1)
  })

  it('an announced name vanishing from entries counts as settled', async () => {
    const ctx = new FakeCtx()
    const registry = new FakeRegistry()
    mountMcpReadyNotice(ctx as never, registry, ['a', 'gone-srv'], 'sid-1')
    registry.emit({ name: 'a', state: 'ready', toolCount: 3 })
    registry.remove('gone-srv')

    const { appended } = await drive(ctx.preStepListener()!, stubAgent('sid-1'), enter())
    expect(appended).toHaveLength(1)
    expect(appended[0]!.text).toContain('gone-srv (gone)')
  })

  it('re-entering connecting before the latch defers delivery to the final settle', async () => {
    const ctx = new FakeCtx()
    const registry = new FakeRegistry()
    registry.emit({ name: 'a', state: 'connecting' })
    mountMcpReadyNotice(ctx as never, registry, ['a'], 'sid-1')

    registry.emit({ name: 'a', state: 'ready', toolCount: 1 })
    registry.emit({ name: 'a', state: 'connecting' }) // re-handshake (e.g. /mcp reconnect)
    const mid = await drive(ctx.preStepListener()!, stubAgent('sid-1'), enter())
    expect(mid.appended).toEqual([])

    registry.emit({ name: 'a', state: 'ready', toolCount: 1 })
    const final = await drive(ctx.preStepListener()!, stubAgent('sid-1'), enter())
    expect(final.appended).toHaveLength(1)
  })

  it('a disconnected announced server counts as settled and renders as (disconnected)', async () => {
    const ctx = new FakeCtx()
    const registry = new FakeRegistry()
    mountMcpReadyNotice(ctx as never, registry, ['a'], 'sid-1')
    registry.emit({ name: 'a', state: 'disconnected' })

    const { appended } = await drive(ctx.preStepListener()!, stubAgent('sid-1'), enter())
    expect(appended[0]!.text).toBe('MCP: servers unavailable — a (disconnected). Retry with /mcp reconnect a.')
  })
})
