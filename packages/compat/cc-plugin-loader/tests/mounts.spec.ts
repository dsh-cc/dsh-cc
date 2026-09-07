import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { parsePluginManifest } from '../src/manifest.ts'
import { mountCommands } from '../src/commands.ts'
import { mountHooks } from '../src/hooks.ts'
import { mountMcpServers } from '../src/mcp.ts'
import { mountSettings } from '../src/settings.ts'
import { mountAgents, isPluginAgentProvider, PLUGIN_AGENT_PROVIDER_BRAND } from '../src/agents.ts'
import { tempPluginRoot, writeFileAt } from './helpers.ts'

describe('mountCommands', () => {
  const makeAgent = () => {
    const sent: unknown[] = []
    return {
      sent,
      agent: { followup: (message: unknown) => { sent.push(message) } },
    }
  }
  const textOf = (message: unknown): string => {
    const content = (message as { content?: Array<{ text?: string }> }).content ?? []
    return content.map(part => part.text ?? '').join('')
  }
  const seamPushing = (defs: Array<unknown>) => ({
    register: (d: unknown) => { defs.push(d); return () => {} },
  })

  it('registers one bare name per command (colon names stay off the registry)', () => {
    const manifest = parsePluginManifest({
      name: 'p',
      commands: { hello: { content: 'say hi' }, byebye: { content: 'say bye' } },
    }, 'p')
    const defs: Array<{ name: string }> = []
    const { disposers, mounted, tally } = mountCommands({
      pluginRoot: '/tmp',
      manifest,
      commands: seamPushing(defs),
    })
    expect(tally.result().loaded).toBe(2)
    expect(tally.result().failed).toBe(0)
    expect(defs.map(d => d.name)).toEqual(['hello', 'byebye'])
    expect(disposers).toHaveLength(2)
    // The colon display form is served through the mounted-command channel.
    expect(mounted.map(c => c.info.name)).toEqual(['p:hello', 'p:byebye'])
    expect(mounted.map(c => c.info.plugin)).toEqual(['p', 'p'])
  })

  it('records a skipped command when its bare name is already registered', () => {
    const manifest = parsePluginManifest({ name: 'p', commands: { hello: { content: 'hi' } } }, 'p')
    const defs: Array<{ name: string }> = []
    const { disposers, mounted, tally } = mountCommands({
      pluginRoot: '/tmp',
      manifest,
      commands: {
        register: () => { throw new Error('name already registered') },
      },
    })
    expect(defs).toEqual([])
    expect(tally.result().loaded).toBe(0)
    expect(tally.result().skipped).toBe(1)
    expect(tally.result().reasons.some(reason => /bare name "hello" not registered/.test(reason))).toBe(true)
    expect(disposers).toHaveLength(0)
    expect(mounted).toEqual([])
  })

  it('registers a bare name even when it equals the plugin name (single-name form)', () => {
    const manifest = parsePluginManifest({ name: 'review', commands: { review: { content: 'hi' } } }, 'review')
    const defs: Array<{ name: string }> = []
    const { mounted, tally } = mountCommands({ pluginRoot: '/tmp', manifest, commands: seamPushing(defs) })
    expect(tally.result().loaded).toBe(1)
    expect(defs.map(d => d.name)).toEqual(['review'])
    expect(mounted.map(c => c.info.name)).toEqual(['review:review'])
  })

  it('skips commands when the commands seam is absent', () => {
    const manifest = parsePluginManifest({ name: 'p' }, 'p')
    const { tally } = mountCommands({ pluginRoot: '/tmp', manifest, commands: undefined })
    const result = tally.result()
    expect(result.skipped).toBe(1)
    expect(result.loaded).toBe(0)
  })

  it('reports a command whose source file is missing as failed', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      const manifest = parsePluginManifest({ name: 'p', commands: { a: { source: './missing.md' } } }, 'p')
      const { tally } = mountCommands({ pluginRoot: root, manifest, commands: { register: () => () => {} } })
      const result = tally.result()
      expect(result.failed).toBe(1)
      expect(result.reasons[0]).toMatch(/could not read command file/)
    } finally {
      await dispose()
    }
  })

  it('injects a source command file as a user prompt instead of echoing it', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'hello.md', '# hello')
      const manifest = parsePluginManifest({ name: 'p', commands: { hello: { source: './hello.md' } } }, 'p')
      const defs: Array<{ handler(invocation: unknown): Promise<unknown> }> = []
      mountCommands({ pluginRoot: root, manifest, commands: seamPushing(defs) })
      const { sent, agent } = makeAgent()
      const result = await defs[0]!.handler({ agent, rawInput: '' })
      expect(result).toEqual({ kind: 'success' })
      expect(sent).toHaveLength(1)
      expect(textOf(sent[0])).toBe('# hello')
      expect((sent[0] as { source?: { kind?: string } }).source?.kind).toBe('user')
    } finally {
      await dispose()
    }
  })

  it('substitutes $ARGUMENTS with the invocation raw input', async () => {
    const manifest = parsePluginManifest({
      name: 'p',
      commands: { rescue: { content: 'Fix $ARGUMENTS now' } },
    }, 'p')
    const defs: Array<{ handler(invocation: unknown): Promise<unknown> }> = []
    mountCommands({ pluginRoot: '/tmp', manifest, commands: seamPushing(defs) })
    const { sent, agent } = makeAgent()
    const result = await defs[0]!.handler({ agent, rawInput: 'the flaky test' })
    expect(result).toEqual({ kind: 'success' })
    expect(textOf(sent[0])).toBe('Fix the flaky test now')
  })

  it('reports success when an async followup resolves', async () => {
    const manifest = parsePluginManifest({
      name: 'p',
      commands: { rescue: { content: 'Fix $ARGUMENTS' } },
    }, 'p')
    const defs: Array<{ handler(invocation: unknown): Promise<unknown> }> = []
    mountCommands({ pluginRoot: '/tmp', manifest, commands: seamPushing(defs) })
    const sent: unknown[] = []
    const result = await defs[0]!.handler({
      agent: { followup: (message: unknown) => { sent.push(message); return Promise.resolve('id') } },
      rawInput: 'it',
    })
    expect(result).toEqual({ kind: 'success' })
    expect(textOf(sent[0])).toBe('Fix it')
  })

  it('folds a rejected async followup into an error result instead of an unhandled rejection', async () => {
    const manifest = parsePluginManifest({
      name: 'p',
      commands: { rescue: { content: 'Fix it' } },
    }, 'p')
    const defs: Array<{ handler(invocation: unknown): Promise<unknown> }> = []
    mountCommands({ pluginRoot: '/tmp', manifest, commands: seamPushing(defs) })
    const result = await defs[0]!.handler({
      agent: { followup: () => Promise.reject(new Error('agent busy')) },
      rawInput: '',
    })
    expect(result).toEqual({ kind: 'error', text: expect.stringContaining('agent busy') })
  })

  it('reports a synchronous followup throw as an error result', async () => {
    const manifest = parsePluginManifest({
      name: 'p',
      commands: { rescue: { content: 'Fix it' } },
    }, 'p')
    const defs: Array<{ handler(invocation: unknown): Promise<unknown> }> = []
    mountCommands({ pluginRoot: '/tmp', manifest, commands: seamPushing(defs) })
    const result = await defs[0]!.handler({
      agent: { followup: () => { throw new Error('no agent') } },
      rawInput: '',
    })
    expect(result).toEqual({ kind: 'error', text: expect.stringContaining('no agent') })
  })

  it('strips frontmatter and surfaces description and argument hint from a command file', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'hello.md', '---\ndescription: Say hello\nargument-hint: "[name]"\n---\n\n# hello body\n')
      const manifest = parsePluginManifest({ name: 'p', commands: { hello: { source: './hello.md' } } }, 'p')
      const defs: Array<{
        name: string
        description: string
        input?: { hint: string }
        handler(invocation: unknown): Promise<unknown>
      }> = []
      mountCommands({ pluginRoot: root, manifest, commands: seamPushing(defs) })
      expect(defs[0]!.description).toBe('Say hello')
      expect(defs[0]!.input?.hint).toBe('[name]')
      const { sent, agent } = makeAgent()
      await defs[0]!.handler({ agent, rawInput: '' })
      const text = textOf(sent[0])
      expect(text).not.toContain('---')
      expect(text).toContain('# hello body')
    } finally {
      await dispose()
    }
  })

  it('lets manifest description and argument hint override file frontmatter', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'hello.md', '---\ndescription: File loses\nargument-hint: "[file]"\n---\n\nbody\n')
      const manifest = parsePluginManifest({
        name: 'p',
        commands: { hello: { source: './hello.md', description: 'Manifest wins', argumentHint: '[override]' } },
      }, 'p')
      const defs: Array<{ description: string; input?: { hint: string } }> = []
      mountCommands({ pluginRoot: root, manifest, commands: seamPushing(defs) })
      expect(defs[0]!.description).toBe('Manifest wins')
      expect(defs[0]!.input?.hint).toBe('[override]')
    } finally {
      await dispose()
    }
  })

  it('scans commands/*.md when the manifest omitted commands', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'commands/foo.md', '# foo')
      const defs: Array<{ name: string }> = []
      const { disposers, tally } = mountCommands({
        pluginRoot: root,
        manifest: parsePluginManifest({ name: 'p' }, 'p'),
        commands: seamPushing(defs),
      })
      expect(tally.result().loaded).toBe(1)
      expect(defs.map(d => d.name)).toEqual(['foo'])
      expect(disposers).toHaveLength(1)
    } finally {
      await dispose()
    }
  })

  it('does not scan commands/ when the manifest declared commands', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'commands/foo.md', '# foo')
      const defs: Array<{ name: string }> = []
      const { tally } = mountCommands({
        pluginRoot: root,
        manifest: parsePluginManifest({ name: 'p', commands: { hello: { content: 'hi' } } }, 'p'),
        commands: seamPushing(defs),
      })
      expect(tally.result().loaded).toBe(1)
      expect(defs.map(d => d.name)).toEqual(['hello'])
    } finally {
      await dispose()
    }
  })

  it('skips nested command directories with a reason instead of registering them', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'commands/sub/x.md', '# nested')
      await writeFileAt(root, 'commands/bar.md', '# bar')
      const defs: Array<{ name: string }> = []
      const { tally } = mountCommands({
        pluginRoot: root,
        manifest: parsePluginManifest({ name: 'p' }, 'p'),
        commands: seamPushing(defs),
      })
      expect(defs.map(d => d.name)).toEqual(['bar'])
      expect(tally.result().skipped).toBeGreaterThanOrEqual(1)
      expect(tally.result().reasons.some(reason => /nested commands directory/.test(reason))).toBe(true)
    } finally {
      await dispose()
    }
  })
})

describe('mountHooks', () => {
  it('skips hooks when the hooks seam is absent', () => {
    const manifest = parsePluginManifest({ name: 'p' }, 'p')
    const { tally } = mountHooks({ pluginRoot: '/tmp', manifest, hooks: undefined })
    const result = tally.result()
    expect(result.skipped).toBe(1)
    expect(result.loaded).toBe(0)
  })

  it('injects inline manifest hooks through the seam', () => {
    const manifest = parsePluginManifest({
      name: 'p',
      hooks: { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'echo hi' }] }] } },
    }, 'p')
    let merged: unknown
    const { tally } = mountHooks({
      pluginRoot: '/tmp',
      manifest,
      hooks: { mergePluginHooks: (name, config) => { merged = { name, config }; return () => {} } },
    })
    const result = tally.result()
    expect(result.loaded).toBe(1)
    const record = merged as { name: string; config: unknown }
    expect(record.name).toBe('p')
    expect((record.config as Record<string, unknown>)['PreToolUse']).toBeDefined()
  })

  it('injects hooks from hooks/hooks.json', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'hooks/hooks.json', JSON.stringify({ hooks: { SessionStart: [] } }))
      const manifest = parsePluginManifest({ name: 'p' }, 'p')
      let merged: unknown
      const { tally } = mountHooks({
        pluginRoot: root,
        manifest,
        hooks: { mergePluginHooks: (name, config) => { merged = { name, config }; return () => {} } },
      })
      expect(tally.result().loaded).toBe(1)
      expect((merged as { config: Record<string, unknown> }).config['SessionStart']).toEqual([])
    } finally {
      await dispose()
    }
  })
})

describe('mountMcpServers', () => {
  it('skips mcpServers when the mcp seam is absent', () => {
    const manifest = parsePluginManifest({ name: 'p' }, 'p')
    const { tally } = mountMcpServers({ pluginRoot: '/tmp', manifest, mcp: undefined })
    const result = tally.result()
    expect(result.skipped).toBe(1)
    expect(result.loaded).toBe(0)
  })

  it('registers inline mcp servers through the seam', () => {
    const manifest = parsePluginManifest({ name: 'p', mcpServers: { one: { command: 'a' }, two: { command: 'b' } } }, 'p')
    const seen: string[] = []
    const { tally } = mountMcpServers({
      pluginRoot: '/tmp',
      manifest,
      mcp: { registerServer: (name) => { seen.push(name); return () => {} } },
    })
    expect(tally.result().loaded).toBe(2)
    expect(seen).toEqual(['one', 'two'])
  })

  it('registers servers from an mcp.json path', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, '.mcp.json', JSON.stringify({ mcpServers: { fileServer: { command: 'x' } } }))
      const manifest = parsePluginManifest({ name: 'p', mcpServers: './.mcp.json' }, 'p')
      const seen: string[] = []
      const { tally } = mountMcpServers({
        pluginRoot: root,
        manifest,
        mcp: { registerServer: (name) => { seen.push(name); return () => {} } },
      })
      expect(tally.result().loaded).toBe(1)
      expect(seen).toEqual(['fileServer'])
    } finally {
      await dispose()
    }
  })
})

describe('mountSettings', () => {
  it('skips settings when the settings seam is absent', () => {
    const manifest = parsePluginManifest({ name: 'p' }, 'p')
    const { tally } = mountSettings({ manifest, settings: undefined })
    const result = tally.result()
    expect(result.skipped).toBe(1)
  })

  it('writes only allowlisted settings through the seam', () => {
    const manifest = parsePluginManifest({
      name: 'p',
      settings: { agent: { model: 'x' }, nonce: 42, language: 'en' },
    }, 'p')
    let written: unknown
    const { tally } = mountSettings({
      manifest,
      settings: { set: (name, value) => { written = { name, value }; return () => {} } },
    })
    expect(tally.result().loaded).toBe(1)
    const record = written as { name: string; value: Record<string, unknown> }
    expect(record.name).toBe('p')
    expect(Object.keys(record.value)).toEqual(['agent'])
  })

  it('skips when no allowlisted settings are present', () => {
    const manifest = parsePluginManifest({ name: 'p', settings: { nonce: 1 } }, 'p')
    const { tally } = mountSettings({ manifest, settings: { set: () => () => {} } })
    expect(tally.result().skipped).toBe(1)
  })
})

describe('mountAgents', () => {
  it('registers each agent file as a provider', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'agents/researcher.md', '---\ndescription: researcher agent\ntools: [read]\n---\nYou are the researcher.')
      const manifest = parsePluginManifest({ name: 'p' }, 'p')
      const names: string[] = []
      const { tally } = await mountAgents({
        pluginRoot: root,
        manifest,
        subagents: { registerProvider: (p) => { names.push((p as { name: string }).name); return () => {} }, getProvider: () => undefined },
      })
      expect(tally.result().loaded).toBe(1)
      expect(names).toEqual(['researcher'])
    } finally {
      await dispose()
    }
  })

  it('namespaces provider names with the prefix while definitions stay bare', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'agents/researcher.md', '---\ndescription: researcher agent\n---\nYou are the researcher.')
      const manifest = parsePluginManifest({ name: 'p' }, 'p')
      const providers: Array<{ name: string; definition: { agentType: string } }> = []
      await mountAgents({
        pluginRoot: root,
        manifest,
        namespacePrefix: 'p',
        subagents: { registerProvider: (p) => { providers.push(p as never); return () => {} }, getProvider: () => undefined },
      })
      expect(providers).toHaveLength(1)
      expect(providers[0]!.name).toBe('p:researcher')
      expect(providers[0]!.definition.agentType).toBe('researcher')
    } finally {
      await dispose()
    }
  })

  it('exposes the definition on each provider without a prefix (back-compat)', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'agents/researcher.md', '---\ndescription: researcher agent\n---\nYou are the researcher.')
      const manifest = parsePluginManifest({ name: 'p' }, 'p')
      const providers: Array<{ name: string; definition: { agentType: string } }> = []
      await mountAgents({
        pluginRoot: root,
        manifest,
        subagents: { registerProvider: (p) => { providers.push(p as never); return () => {} }, getProvider: () => undefined },
      })
      expect(providers[0]!.name).toBe('researcher')
      expect(providers[0]!.definition.agentType).toBe('researcher')
      expect(providers[0]!.definition.systemPrompt).toMatch(/researcher/)
    } finally {
      await dispose()
    }
  })

  it('sanitizes the prefix by stripping colons and whitespace', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'agents/researcher.md', '---\ndescription: researcher agent\n---\nYou are the researcher.')
      const manifest = parsePluginManifest({ name: 'p' }, 'p')
      const providers: Array<{ name: string }> = []
      await mountAgents({
        pluginRoot: root,
        manifest,
        namespacePrefix: 'my plugin:',
        subagents: { registerProvider: (p) => { providers.push(p as never); return () => {} }, getProvider: () => undefined },
      })
      expect(providers[0]!.name).toBe('myplugin:researcher')
    } finally {
      await dispose()
    }
  })

  it('skips an agentType that contains a colon instead of registering it verbatim', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'agents/review:security.md', '---\ndescription: security review\n---\nYou review security.')
      const manifest = parsePluginManifest({ name: 'p' }, 'p')
      const providers: Array<{ name: string; definition: { agentType: string } }> = []
      const { tally } = await mountAgents({
        pluginRoot: root,
        manifest,
        namespacePrefix: 'p',
        subagents: { registerProvider: (p) => { providers.push(p as never); return () => {} }, getProvider: () => undefined },
      })
      // A colon agentType would escape the plugin namespace; it is warned,
      // skipped, and never registered (the verbatim rule is gone).
      expect(providers).toEqual([])
      const result = tally.result()
      expect(result.loaded).toBe(0)
      expect(result.skipped).toBe(1)
      expect(result.reasons.some(reason => /"review:security"/.test(reason))).toBe(true)
    } finally {
      await dispose()
    }
  })

  it('records a duplicate provider name as skipped instead of throwing', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'agents/researcher.md', '---\ndescription: researcher agent\n---\nYou are the researcher.')
      const manifest = parsePluginManifest({ name: 'p' }, 'p')
      const preExisting = { name: 'p:researcher' }
      const providers: Array<{ name: string }> = []
      const { tally } = await mountAgents({
        pluginRoot: root,
        manifest,
        namespacePrefix: 'p',
        subagents: {
          registerProvider: (p) => { providers.push(p as never); return () => {} },
          getProvider: (name) => (name === 'p:researcher' ? preExisting : undefined),
        },
      })
      expect(providers).toEqual([])
      const result = tally.result()
      expect(result.loaded).toBe(0)
      expect(result.skipped).toBe(1)
      expect(result.reasons.some(reason => /duplicate.*"p:researcher"/.test(reason))).toBe(true)
    } finally {
      await dispose()
    }
  })

  it('rolls back providers registered this call when registerProvider throws mid-mount', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'agents/one.md', '---\ndescription: one\n---\nOne.')
      await writeFileAt(root, 'agents/two.md', '---\ndescription: two\n---\nTwo.')
      const manifest = parsePluginManifest({ name: 'p' }, 'p')
      const disposed: string[] = []
      let call = 0
      await expect(mountAgents({
        pluginRoot: root,
        manifest,
        namespacePrefix: 'p',
        subagents: {
          registerProvider: (p) => {
            const name = (p as { name: string }).name
            call += 1
            if (call === 2) throw new Error('name already registered')
            return () => { disposed.push(name) }
          },
          getProvider: () => undefined,
        },
      })).rejects.toThrow(/name already registered/)
      // The first provider this call registered was disposed before the rethrow.
      expect(disposed).toEqual(['p:one'])
    } finally {
      await dispose()
    }
  })

  it('stamps the plugin-agent-provider brand on every registered provider', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'agents/researcher.md', '---\ndescription: researcher agent\n---\nYou are the researcher.')
      const manifest = parsePluginManifest({ name: 'p' }, 'p')
      const providers: unknown[] = []
      await mountAgents({
        pluginRoot: root,
        manifest,
        namespacePrefix: 'p',
        subagents: { registerProvider: (p) => { providers.push(p); return () => {} }, getProvider: () => undefined },
      })
      expect(providers).toHaveLength(1)
      expect(isPluginAgentProvider(providers[0])).toBe(true)
      expect((providers[0] as Record<symbol, unknown>)[PLUGIN_AGENT_PROVIDER_BRAND]).toBe(true)
      expect(isPluginAgentProvider({ start: () => {} })).toBe(false)
    } finally {
      await dispose()
    }
  })

  it('skips agents when the subagent seam is absent', async () => {
    const manifest = parsePluginManifest({ name: 'p' }, 'p')
    const { tally } = await mountAgents({ pluginRoot: '/tmp', manifest, subagents: undefined })
    expect(tally.result().skipped).toBe(1)
  })

  it('skips agents when the plugin ships none', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      const manifest = parsePluginManifest({ name: 'p' }, 'p')
      const { tally } = await mountAgents({
        pluginRoot: root,
        manifest,
        subagents: { registerProvider: () => () => {}, getProvider: () => undefined },
      })
      expect(tally.result().skipped).toBe(1)
    } finally {
      await dispose()
    }
  })
})

describe('mountCommands against the real harness CommandRuntime', () => {
  // Global-layer lookups treat the agent as an opaque scope key; a plain
  // object without a scope registration sees exactly the global commands.
  const fakeAgent = { id: 'mounts-spec-agent' } as never

  async function runtime(): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    return ctx
  }

  it('registers the bare alias into the real registry and keeps colon names out', async () => {
    const ctx = await runtime()
    const manifest = parsePluginManifest({
      name: 'codex',
      commands: { review: { content: 'do the review', description: 'Review the change' } },
    }, 'codex')
    const { mounted, tally } = mountCommands({ pluginRoot: '/tmp', manifest, commands: ctx.commands })
    expect(tally.result().loaded).toBe(1)
    expect(ctx.commands.find(fakeAgent, 'review')).toBeDefined()
    // The colon form would throw in normalizeDefinition; it must never be
    // registered and stays reachable only through the mounted-command channel.
    expect(ctx.commands.find(fakeAgent, 'codex:review')).toBeUndefined()
    expect(ctx.commands.list(fakeAgent).map(d => d.name)).toEqual(['review'])
    expect(mounted.map(c => c.info.name)).toEqual(['codex:review'])
  expect(mounted[0]!.info.description).toBe('Review the change')
  })

  it('records the second plugin same-named command as skipped in the real registry', async () => {
    const ctx = await runtime()
    const first = parsePluginManifest({ name: 'one', commands: { rescue: { content: 'a', description: 'first' } } }, 'one')
    const second = parsePluginManifest({ name: 'two', commands: { rescue: { content: 'b', description: 'second' } } }, 'two')
    mountCommands({ pluginRoot: '/tmp', manifest: first, commands: ctx.commands })
    const { mounted, tally } = mountCommands({ pluginRoot: '/tmp', manifest: second, commands: ctx.commands })
    expect(tally.result().loaded).toBe(0)
    expect(tally.result().skipped).toBe(1)
    expect(tally.result().reasons[0]).toMatch(/bare name "rescue" not registered/)
    expect(mounted).toEqual([])
    expect(ctx.commands.find(fakeAgent, 'rescue')?.handler).toBeDefined()
  })
})
