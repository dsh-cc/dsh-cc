import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SettingsProvider, { settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import * as commandConfig from '@dsh-cc/command-config'
import { keyAllowed, parseConfigArgs, parseValue, renderConfig } from '@dsh-cc/command-config/config'

/** Minimal in-memory settings provider for the test. */
class MemorySettings extends SettingsProvider {
  readonly writable = true
  private doc: Record<string, unknown> = {}
  protected async load(): Promise<Record<string, unknown>> { return this.doc }
  protected async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = section
  }
}

const THEME_SCHEMA = z.object({ theme: z.string().default('light'), fontSize: z.number().default(12) })

async function harness(): Promise<{
  ctx: Context
  agent: Agent
  plugin: Awaited<ReturnType<Context['plugin']>>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(MemorySettings)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  ctx.settings.register('ui-theme' as SettingsNamespace, THEME_SCHEMA)
  const plugin = await ctx.plugin(commandConfig)
  const session = ctx.sessions.create(SessionId(`command-config-${Math.random()}`))
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
  return { ctx, agent, plugin }
}

describe('@dsh-cc/command-config registration', () => {
  it('registers one global command with Loader-safe exports and disposes it', async () => {
    expect(commandConfig.name).toBe('command-config')
    expect(commandConfig.inject).toEqual(['commands', 'settings'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandConfig)).toBe(commandConfig)
    const { ctx, agent, plugin } = await harness()
    expect(ctx.commands.find(agent, 'config')).toBeDefined()
    await plugin.dispose()
    expect(ctx.commands.find(agent, 'config')).toBeUndefined()
  })
})

describe('/config parsing and allowlist', () => {
  it('parses key, value, and optional scope in order', () => {
    expect(parseConfigArgs('theme dark ui-theme', 'ui-theme'))
      .toEqual({ scope: 'ui-theme', key: 'theme', value: 'dark' })
    expect(parseConfigArgs('fontSize 14', 'ui-theme'))
      .toEqual({ scope: 'ui-theme', key: 'fontSize', value: 14 })
    expect(parseConfigArgs('', 'ui-theme')).toBeUndefined()
  })
  it('parses JSON-typed values', () => {
    expect(parseValue('true')).toBe(true)
    expect(parseValue('14')).toBe(14)
    expect(parseValue('{"a":1}')).toEqual({ a: 1 })
    expect(parseValue('dark')).toBe('dark')
  })
  it('enforces the write allowlist', () => {
    const allow = ['ui-theme', 'other.k']
    expect(keyAllowed('ui-theme', 'theme', allow)).toBe(true)
    expect(keyAllowed('ui-theme', 'anything', allow)).toBe(true) // bare namespace
    expect(keyAllowed('other', 'k', allow)).toBe(true)
    expect(keyAllowed('other', 'z', allow)).toBe(false)
  })
  it('renders the effective config from descriptors', () => {
    expect(renderConfig([])).toContain('No configuration namespaces registered.')
  })
})

describe('/config human command', () => {
  it('renders the effective config with no args', async () => {
    const { ctx, agent } = await harness()
    const execution = await ctx.commands.execute(agent, '/config', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('ui-theme = ')
    expect(text).toContain('(live)')
  })
  it('updates an allowlisted key and reports it', async () => {
    const { ctx, agent } = await harness()
    const execution = await ctx.commands.execute(agent, '/config theme dark ui-theme', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('Set ui-theme.theme = "dark"')
    expect(ctx.settings.get('ui-theme' as SettingsNamespace)).toMatchObject({ theme: 'dark' })
  })
  it('refuses unknown scopes and non-allowlisted keys with a friendly message', async () => {
    const { ctx, agent } = await harness()
    const badScope = await ctx.commands.execute(agent, '/config theme dark nope', [], new AbortController().signal)
    expect((badScope?.result as { text: string }).text).toContain('Unknown configuration scope "nope"')
    const badKey = await ctx.commands.execute(agent, '/config secret pwn ui-theme', [], new AbortController().signal)
    expect((badKey?.result as { text: string }).text).toContain('is not writable')
  })
})

describe('/config help interception', () => {
  it('answers a trailing help argument with formatted help text', async () => {
    const { ctx, agent } = await harness()
    const execution = await ctx.commands.execute(agent, '/config help', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    const text = execution?.result.text ?? ''
    expect(text).toContain('/config')
    expect(text).toContain('Usage:')
    expect(text).toContain('[key] [value] [scope]')
  })
})
