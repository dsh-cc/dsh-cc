import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { projectKeyOf } from '@dsh-cc/sidecar-io'
import { apply } from '../src/index.ts'

/**
 * Listener-level tests at both observation seams with a fake ctx (house
 * rig precedent: post-edit-verify recovery-wiring.spec.ts): capture the
 * listeners `apply` registers and drive them with synthetic payloads — no
 * cordis runtime. The enable gate is the raw user-layer read, so tests
 * write `<dshHome>/settings.json` directly.
 */

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'skill-usage-home-'))
  dirs.push(home)
  return home
}

interface Rig {
  ctx: { logger: { debug: ReturnType<typeof vi.fn> } }
  onToolResult: (exec: unknown, result: unknown) => void
  onSessionEvent: (session: unknown, event: unknown) => void
  home: string
}

function rig(): Rig {
  const home = tempHome()
  const registrations: Array<[string, (...args: never[]) => unknown]> = []
  const ctx = {
    logger: { debug: vi.fn() },
    on: vi.fn((event: string, listener: (...args: never[]) => unknown) => {
      registrations.push([event, listener])
    }),
    get: () => undefined,
    dshHomePath: () => home,
  }
  apply(ctx as never)
  const byEvent = (event: string): (...args: never[]) => unknown => {
    const call = registrations.find(([name]) => name === event)
    expect(call, `expected a ${event} registration`).toBeDefined()
    return call![1]
  }
  return {
    ctx: ctx as unknown as Rig['ctx'],
    onToolResult: byEvent('tools/result') as unknown as Rig['onToolResult'],
    onSessionEvent: byEvent('session/event') as unknown as Rig['onSessionEvent'],
    home,
  }
}

function rigWithoutHome(): { ctx: Rig['ctx']; onToolResult: Rig['onToolResult']; onSessionEvent: Rig['onSessionEvent'] } {
  const registrations: Array<[string, (...args: never[]) => unknown]> = []
  const ctx = {
    logger: { debug: vi.fn() },
    on: vi.fn((event: string, listener: (...args: never[]) => unknown) => {
      registrations.push([event, listener])
    }),
    get: () => undefined,
  }
  apply(ctx as never)
  const byEvent = (event: string): (...args: never[]) => unknown => {
    const call = registrations.find(([name]) => name === event)
    expect(call, `expected a ${event} registration`).toBeDefined()
    return call![1]
  }
  return {
    ctx: ctx as unknown as Rig['ctx'],
    onToolResult: byEvent('tools/result') as unknown as Rig['onToolResult'],
    onSessionEvent: byEvent('session/event') as unknown as Rig['onSessionEvent'],
  }
}

function enable(home: string, enabled: boolean): void {
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ 'cc-skill-usage': { enabled } }))
}

function toolExec(name: string, args: unknown, agent?: unknown): unknown {
  return { name, arguments: args, ...(agent !== undefined ? { agent } : {}) }
}

function fakeAgent(id: string, cwd: string): unknown {
  // snapshotEvents is part of the session-cwd resolution surface.
  return { session: { id, header: { cwd }, snapshotEvents: () => [] } }
}

function skillAgent(id = 'agent-1'): unknown {
  return fakeAgent(id, 'REPLACE_ME')
}

function okSkillResult(value: unknown): unknown {
  return { isError: false, value, content: [] }
}

function slashEvent(name: string): unknown {
  return {
    type: 'user/message',
    data: { content: [], source: { kind: 'skill-invocation', name, form: 'instructions' } },
  }
}

function sessionWith(cwd: string | undefined, id = 'session-1'): unknown {
  return { id, header: { cwd }, snapshotEvents: () => [] }
}

function ledgerRow(home: string, cwd: string, index = 0): Record<string, unknown> {
  const path = join(home, 'skill-usage', `loads-${projectKeyOf(cwd)}.jsonl`)
  const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '')
  return JSON.parse(lines[index]!) as Record<string, unknown>
}

function markerText(home: string, cwd: string): string {
  return readFileSync(join(home, 'skill-usage', `observing-since-${projectKeyOf(cwd)}`), 'utf8')
}

// The commit path is awaited-then-detached and spans several fs I/O turns —
// a single setImmediate fires too early; a short timer lets it settle.
const flush = () => new Promise((resolve) => setTimeout(resolve, 25))

describe('skill-usage telemetry listeners', () => {
  it('registers exactly the two observe-only listeners (tools/result + session/event)', () => {
    const registrations: string[] = []
    const ctx = { logger: { debug: vi.fn() }, on: vi.fn((event: string) => { registrations.push(event) }), get: () => undefined, dshHomePath: () => '/x' }
    apply(ctx as never)
    expect(registrations).toEqual(['tools/result', 'session/event', 'session/created', 'skills/learned-changed'])
  })

  it('tool form: writes a shape-correct row and propagates provider', async () => {
    const { onToolResult, home } = rig()
    enable(home, true)
    const agent = skillAgent()
    ;(agent as { session: { header: { cwd: string } } }).session.header.cwd = home
    onToolResult(toolExec('skill', { name: 'my-skill' }, agent), okSkillResult({ name: 'my-skill', provider: 'claude-code' }))
    await flush()
    const row = ledgerRow(home, home)
    expect(row.v).toBe(1)
    expect(row.skill).toBe('my-skill')
    expect(row.via).toBe('tool')
    expect(row.sessionId).toBe('agent-1')
    expect(row.provider).toBe('claude-code')
    // Epoch milliseconds: within the last minute, i.e. not seconds or µs.
    expect(row.ts as number).toBeGreaterThan(Date.now() - 60_000)
    expect(row.ts as number).toBeLessThanOrEqual(Date.now())
    expect(markerText(home, home)).toMatch(/^\d+$/)
  })

  it('tool form: omits provider when the result value has none', async () => {
    const { onToolResult, home } = rig()
    enable(home, true)
    onToolResult(toolExec('skill', { name: 'my-skill' }, fakeAgent('a', home)), okSkillResult({ name: 'my-skill' }))
    await flush()
    expect(ledgerRow(home, home)).not.toHaveProperty('provider')
  })

  it('slash form: writes a row from a persisted skill-invocation user message', async () => {
    const { onSessionEvent, home } = rig()
    enable(home, true)
    onSessionEvent(sessionWith(home), slashEvent('other-skill'))
    await flush()
    const row = ledgerRow(home, home)
    expect(row.skill).toBe('other-skill')
    expect(row.via).toBe('slash')
    expect(row.sessionId).toBe('session-1')
  })

  it('non-matching events are ignored (failed result, wrong tool, wrong source kind)', async () => {
    const { onToolResult, onSessionEvent, home } = rig()
    enable(home, true)
    onToolResult(toolExec('skill', { name: 'x' }, fakeAgent('a', home)), { isError: true, error: {} })
    onToolResult(toolExec('read', { name: 'x' }, fakeAgent('a', home)), okSkillResult({}))
    onSessionEvent(sessionWith(home), { type: 'user/message', data: { source: { kind: 'user' } } })
    await flush()
    expect(existsSync(join(home, 'skill-usage'))).toBe(false)
  })

  it('dshHomePath undefined: complete no-op (no row, no marker, no throw)', async () => {
    const { ctx, onToolResult, onSessionEvent } = rigWithoutHome()
    onToolResult(toolExec('skill', { name: 'x' }, { session: { id: 'a', header: { cwd: '/tmp' } } }), okSkillResult({ name: 'x' }))
    onSessionEvent(sessionWith('/tmp'), slashEvent('x'))
    await flush()
    const messages = (ctx.logger.debug as ReturnType<typeof vi.fn>).mock.calls.map(([m]) => String(m))
    expect(messages.some((m) => m.includes('no-op'))).toBe(true)
  })

  it('unresolvable projectKey: row skipped (agent-less tool form; cwd-less slash form)', async () => {
    const { onToolResult, onSessionEvent, home } = rig()
    enable(home, true)
    onToolResult(toolExec('skill', { name: 'x' }), okSkillResult({ name: 'x' }))
    onSessionEvent(sessionWith(undefined), slashEvent('x'))
    await flush()
    expect(existsSync(join(home, 'skill-usage'))).toBe(false)
  })

  it('skill-less tool result: no row, never a skill-less write', async () => {
    const { onToolResult, home } = rig()
    enable(home, true)
    onToolResult(toolExec('skill', {}, fakeAgent('a', home)), okSkillResult({}))
    onToolResult(toolExec('skill', { name: 42 }, fakeAgent('a', home)), okSkillResult({}))
    await flush()
    expect(existsSync(join(home, 'skill-usage'))).toBe(false)
  })

  it('marker create-once: a second matched load never overwrites the marker', async () => {
    const { onToolResult, home } = rig()
    enable(home, true)
    onToolResult(toolExec('skill', { name: 'x' }, fakeAgent('a', home)), okSkillResult({ name: 'x' }))
    await flush()
    expect(markerText(home, home)).toMatch(/^\d+$/)
    // Simulate an older marker surviving — create-if-absent must not touch it.
    writeFileSync(join(home, 'skill-usage', `observing-since-${projectKeyOf(home)}`), '111')
    onToolResult(toolExec('skill', { name: 'x' }, fakeAgent('a', home)), okSkillResult({ name: 'x' }))
    await flush()
    expect(markerText(home, home)).toBe('111')
    // Two ledger rows prove the second load still appended.
    expect(ledgerRow(home, home, 1)).toBeDefined()
  })

  it('enabled=false (raw user layer): no row written, no marker touched', async () => {
    const { onToolResult, onSessionEvent, home } = rig()
    enable(home, false)
    mkdirSync(join(home, 'skill-usage'), { recursive: true })
    writeFileSync(join(home, 'skill-usage', `observing-since-${projectKeyOf(home)}`), '222')
    onToolResult(toolExec('skill', { name: 'x' }, fakeAgent('a', home)), okSkillResult({ name: 'x' }))
    onSessionEvent(sessionWith(home), slashEvent('x'))
    await flush()
    expect(existsSync(join(home, 'skill-usage', `loads-${projectKeyOf(home)}.jsonl`))).toBe(false)
    expect(markerText(home, home)).toBe('222')
  })
})
