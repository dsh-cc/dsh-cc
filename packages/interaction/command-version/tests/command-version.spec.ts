import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as commandVersion from '@dsh-cc/command-version'
import { FALLBACK_VERSION, formatVersion, readOwnVersion } from '@dsh-cc/command-version/version'

// Derived from this package's own manifest (readOwnVersion's data source),
// not a literal: pins the version sync invariant (kept in lockstep by
// scripts/release.mjs) without breaking on every release bump.
const OWN_VERSION: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version

function makeAgent(ctx: Context): Agent {
  const session = ctx.sessions.create(SessionId(`command-version-${Math.random()}`))
  const agent: Agent = {
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
  ctx.agents.register(agent)
  return agent
}

async function harness(overrides: Record<string, unknown> = {}): Promise<{
  ctx: Context
  agent: Agent
  plugin: Awaited<ReturnType<Context['plugin']>>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  const plugin = await ctx.plugin(commandVersion)
  const agent = makeAgent(ctx)
  return { ctx, agent, plugin }
}

describe('@dsh-cc/command-version registration', () => {
  it('registers one global command with Loader-safe exports and disposes it', async () => {
    expect(commandVersion.name).toBe('command-version')
    expect(commandVersion.inject).toEqual(['commands'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandVersion)).toBe(commandVersion)
    const { ctx, agent, plugin } = await harness()
    expect(ctx.commands.find(agent, 'version')).toBeDefined()
    await plugin.dispose()
    expect(ctx.commands.find(agent, 'version')).toBeUndefined()
  })
})

describe('/version report', () => {
  it('reads the own version and renders, appending a harness line when present', async () => {
    const own = await readOwnVersion()
    expect(typeof own).toBe('string')
    expect(own.length).toBeGreaterThan(0)
    expect(formatVersion(own, undefined)).toBe(`@dsh-cc/plugins ${own}`)
    expect(formatVersion(own, '0.1.0-rc.5')).toBe(`@dsh-cc/plugins ${own}\nharness 0.1.0-rc.5`)
  })
  it('falls back to the compile-time constant', () => {
    expect(FALLBACK_VERSION).toBe(OWN_VERSION)
  })
})

describe('/version human command', () => {
  it('prints the plugin version without a harness line by default', async () => {
    const { ctx, agent } = await harness()
    const execution = await ctx.commands.execute(agent, '/version', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    const text = (execution?.result as { text: string }).text
    expect(text).toContain(`@dsh-cc/plugins ${OWN_VERSION}`)
  })
  it('includes a harness line when the host surfaces one', async () => {
    const { ctx, agent } = await harness()
    ctx.reflect.provide('harnessVersion', { version: '0.2.0-test' })
    const execution = await ctx.commands.execute(agent, '/version', [], new AbortController().signal)
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('harness 0.2.0-test')
  })
})
