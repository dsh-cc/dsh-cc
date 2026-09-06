import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as commandDoctor from '@dsh-cc/command-doctor'
import type { DoctorReport } from '@dsh-cc/command-doctor/doctor'

function makeAgent(ctx: Context, session = ctx.sessions.create(SessionId(`doctor-${Math.random()}`))): Agent {
  return {
    id: session.id,
    options: {},
    session,
    inbox: null as never,
    ctx: new Context(),
    get status(): 'idle' { return 'idle' },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

describe('@dsh-cc/command-doctor registration', () => {
  it('registers one global command with Loader-safe exports and disposes it', async () => {
    expect(commandDoctor.name).toBe('command-doctor')
    expect(commandDoctor.inject).toEqual(['commands'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandDoctor)).toBe(commandDoctor)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    const plugin = await ctx.plugin(commandDoctor)
    const agent = makeAgent(ctx)
    ctx.agents.register(agent)
    expect(ctx.commands.find(agent, 'doctor')).toBeDefined()
    const execution = await ctx.commands.execute(agent, '/doctor', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    expect(execution?.result.text).toMatch(/seams\.fs|summary:/)
    await plugin.dispose()
    expect(ctx.commands.find(agent, 'doctor')).toBeUndefined()
  })

  it('runs through the registry against a bare composition', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(commandDoctor)
    const agent = makeAgent(ctx)
    ctx.agents.register(agent)
    const execution = await ctx.commands.execute(agent, '/doctor', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('seams.fs')
    expect(text).toMatch(/summary: \d+ ok/)
    // Bare composition: every optional seam skips rather than failing.
    expect(text).not.toContain('  fail ')
  })

  it('reads a version from the package manifest', () => {
    expect(commandDoctor.readVersion().length).toBeGreaterThan(0)
  })

  it('renders a structured report', async () => {
    const { formatDoctorReport } = await import('../src/render.ts')
    const report: DoctorReport = {
      schemaVersion: 1,
      generatedAt: '2026-09-03T00:00:00.000Z',
      durationMs: 0,
      env: {
        dshCc: '0.4.0', harness: '0.1.0-rc.5', node: 'v22.19.0',
        os: 'darwin', arch: 'arm64', cwd: '/repo',
      },
      checks: [
        { id: 'env.dsh-cc', group: 'env', status: 'ok', summary: 'dsh-cc 0.4.0' },
        { id: 'env.node', group: 'env', status: 'fail', summary: 'node v20 bad', fix: 'upgrade node' },
      ],
      summary: { ok: 1, warn: 0, fail: 1, skip: 0, info: 0 },
    }
    const text = formatDoctorReport(report)
    expect(text).toContain('dsh-cc 0.4.0')
    expect(text).toContain('harness 0.1.0-rc.5')
    expect(text).toContain('  ok   env.dsh-cc: dsh-cc 0.4.0')
    expect(text).toContain('  fail env.node: node v20 bad')
    expect(text).toContain('    fix: upgrade node')
    expect(text).toContain('summary: 1 ok, 0 warn, 1 fail, 0 skip, 0 info')
  })
})
