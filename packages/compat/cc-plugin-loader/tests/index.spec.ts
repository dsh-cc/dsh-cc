import { basename } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mountCcPlugin } from '../src/index.ts'
import { tempPluginRoot, writeFileAt, makeContext } from './helpers.ts'

describe('mountCcPlugin', () => {
  it('mounts all components with the seams present and reports loaded counts', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'plugin.json', JSON.stringify({
        name: 'p',
        commands: { hello: { content: 'hi' } },
        settings: { agent: { model: 'x' } },
      }))
      const ctx = makeContext()
      const mount = await mountCcPlugin(ctx, {
        root,
        seams: {
          commands: { register: () => () => {} },
          settings: { set: () => () => {} },
          skills: { register: () => () => {} },
          subagents: { registerProvider: () => () => {}, getProvider: () => undefined },
          hooks: { mergePluginHooks: () => () => {} },
          mcp: { registerServer: () => () => {} },
        },
      })
      const report = mount.report
      expect(report.name).toBe('p')
      const byKind = Object.fromEntries(report.components.map(c => [c.kind, c]))
      expect(byKind['commands']?.loaded).toBe(1)
      expect(byKind['settings']?.loaded).toBe(1)
      expect(byKind['skills']?.skipped).toBe(1)
      expect(byKind['agents']?.skipped).toBe(1)
      expect(byKind['hooks']?.skipped).toBe(1)
      expect(byKind['mcpServers']?.skipped).toBe(1)
      mount.dispose()
    } finally {
      await dispose()
    }
  })

  it('skips components whose seams are absent (guest seams default off)', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'plugin.json', JSON.stringify({ name: 'p', mcpServers: { s: { command: 'x' } }, settings: { language: 'en' } }))
      const ctx = makeContext()
      const mount = await mountCcPlugin(ctx, { root, seams: {} })
      const report = mount.report
      const byKind = Object.fromEntries(report.components.map(c => [c.kind, c]))
      expect(byKind['mcpServers']?.skipped).toBe(1)
      expect(byKind['mcpServers']?.reasons[0]).toMatch(/not mounted/)
      expect(byKind['settings']?.skipped).toBe(1)
      mount.dispose()
    } finally {
      await dispose()
    }
  })

  it('throws on an invalid manifest with the plugin path', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'plugin.json', JSON.stringify({ commands: 42 }))
      const ctx = makeContext()
      await expect(mountCcPlugin(ctx, { root })).rejects.toThrow(/name/)
    } finally {
      await dispose()
    }
  })

  it('recalls every mounted component when the context stops', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'plugin.json', JSON.stringify({
        name: 'p',
        commands: { hello: { content: 'hi' } },
      }))
      const disposed: string[] = []
      const register = (tag: string) => () => { disposed.push(tag) }
      const ctx = makeContext()
      const mount = await mountCcPlugin(ctx, {
        root,
        seams: {
          commands: { register: () => register('commands') },
          skills: { register: () => register('skills') },
          subagents: { registerProvider: () => register('agents'), getProvider: () => undefined },
          hooks: { mergePluginHooks: () => register('hooks') },
          mcp: { registerServer: () => register('mcp') },
          settings: { set: () => register('settings') },
        },
      })
      await mount.dispose()
      expect(disposed).toContain('commands')
    } finally {
      await dispose()
    }
  })

  it('unchanged effect labels are idempotent across mounts', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'plugin.json', JSON.stringify({ name: 'p' }))
      const ctx = makeContext()
      const seams = { commands: { register: () => () => {} } }
      const first = await mountCcPlugin(ctx, { root, seams })
      const second = await mountCcPlugin(ctx, { root, seams })
      first.dispose()
      second.dispose()
      expect(true).toBe(true)
    } finally {
      await dispose()
    }
  })

  it('prefers .claude-plugin/plugin.json over a top-level plugin.json', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'plugin.json', JSON.stringify({ name: 'top-level' }))
      await writeFileAt(root, '.claude-plugin/plugin.json', JSON.stringify({ name: 'nested' }))
      const ctx = makeContext()
      const mount = await mountCcPlugin(ctx, { root, seams: {} })
      expect(mount.report.name).toBe('nested')
      mount.dispose()
    } finally {
      await dispose()
    }
  })

  it('synthesizes a name and mounts skills/ when no manifest is present', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'skills/do-thing/SKILL.md', '---\nname: do-thing\ndescription: Does a thing\n---\n')
      const ctx = makeContext()
      const names: string[] = []
      const mount = await mountCcPlugin(ctx, {
        root,
        nameHint: 'synth',
        seams: { skills: { register: (d) => { names.push((d as { name: string }).name); return () => {} } } },
      })
      expect(mount.report.name).toBe('synth')
      expect(names).toEqual(['do-thing'])
      mount.dispose()
    } finally {
      await dispose()
    }
  })

  it('loads a tavily-shaped skills string path from the nested manifest', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, '.claude-plugin/plugin.json', JSON.stringify({
        name: 'tavily',
        skills: './skills/',
      }))
      await writeFileAt(root, 'skills/tavily-search/SKILL.md', '---\nname: tavily-search\ndescription: Search\n---\n')
      const ctx = makeContext()
      const names: string[] = []
      const mount = await mountCcPlugin(ctx, {
        root,
        seams: { skills: { register: (d) => { names.push((d as { name: string }).name); return () => {} } } },
      })
      expect(mount.report.name).toBe('tavily')
      expect(names).toEqual(['tavily-search'])
      mount.dispose()
    } finally {
      await dispose()
    }
  })

  it('marketplace overlay with a matching nameHint loads only listed skills', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, '.claude-plugin/marketplace.json', JSON.stringify({
        name: 'anthropic-agent-skills',
        plugins: [{
          name: 'document-skills',
          skills: ['./skills/xlsx', './skills/docx'],
        }],
      }))
      await writeFileAt(root, 'skills/xlsx/SKILL.md', '---\nname: xlsx\ndescription: Excel\n---\n')
      await writeFileAt(root, 'skills/docx/SKILL.md', '---\nname: docx\ndescription: Word\n---\n')
      await writeFileAt(root, 'skills/pdf/SKILL.md', '---\nname: pdf\ndescription: PDF\n---\n')
      const ctx = makeContext()
      const names: string[] = []
      const mount = await mountCcPlugin(ctx, {
        root,
        nameHint: 'document-skills',
        seams: { skills: { register: (d) => { names.push((d as { name: string }).name); return () => {} } } },
      })
      expect(mount.report.name).toBe('document-skills')
      expect(names.sort()).toEqual(['docx', 'xlsx'])
      mount.dispose()
    } finally {
      await dispose()
    }
  })

  it('threads the manifest-name prefix into agent provider names', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'plugin.json', JSON.stringify({ name: 'p' }))
      await writeFileAt(root, 'agents/researcher.md', '---\ndescription: researcher agent\n---\nYou are the researcher.')
      const ctx = makeContext()
      const providers: Array<{ name: string }> = []
      const mount = await mountCcPlugin(ctx, {
        root,
        seams: { subagents: { registerProvider: (p) => { providers.push(p as never); return () => {} }, getProvider: () => undefined } },
      })
      expect(mount.report.name).toBe('p')
      expect(providers.map(provider => provider.name)).toEqual(['p:researcher'])
      mount.dispose()
    } finally {
      await dispose()
    }
  })

  it('falls back to nameHint as the agent namespace prefix when the manifest is synthesized', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'agents/researcher.md', '---\ndescription: researcher agent\n---\nYou are the researcher.')
      const ctx = makeContext()
      const providers: Array<{ name: string }> = []
      const mount = await mountCcPlugin(ctx, {
        root,
        nameHint: 'synth',
        seams: { subagents: { registerProvider: (p) => { providers.push(p as never); return () => {} }, getProvider: () => undefined } },
      })
      expect(mount.report.name).toBe('synth')
      expect(providers.map(provider => provider.name)).toEqual(['synth:researcher'])
      mount.dispose()
    } finally {
      await dispose()
    }
  })

  it('falls back to the root basename as the agent namespace prefix with no manifest and no nameHint', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'agents/researcher.md', '---\ndescription: researcher agent\n---\nYou are the researcher.')
      const ctx = makeContext()
      const providers: Array<{ name: string }> = []
      const mount = await mountCcPlugin(ctx, {
        root,
        seams: { subagents: { registerProvider: (p) => { providers.push(p as never); return () => {} }, getProvider: () => undefined } },
      })
      expect(providers.map(provider => provider.name)).toEqual([`${basename(root)}:researcher`])
      mount.dispose()
    } finally {
      await dispose()
    }
  })

  it('threads the marketplace overlay plugin name as the agent namespace prefix', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, '.claude-plugin/marketplace.json', JSON.stringify({
        plugins: [{ name: 'document-skills', agents: ['./agents'] }],
      }))
      await writeFileAt(root, 'agents/researcher.md', '---\ndescription: researcher agent\n---\nYou are the researcher.')
      const ctx = makeContext()
      const providers: Array<{ name: string }> = []
      const mount = await mountCcPlugin(ctx, {
        root,
        nameHint: 'document-skills',
        seams: { subagents: { registerProvider: (p) => { providers.push(p as never); return () => {} }, getProvider: () => undefined } },
      })
      expect(mount.report.name).toBe('document-skills')
      expect(providers.map(provider => provider.name)).toEqual(['document-skills:researcher'])
      mount.dispose()
    } finally {
      await dispose()
    }
  })

  it('propagates a seam registerProvider throw (duplicate-name semantics are the seam\u2019s)', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'agents/researcher.md', '---\ndescription: researcher agent\n---\nYou are the researcher.')
      const ctx = makeContext()
      await expect(mountCcPlugin(ctx, {
        root,
        seams: {
          subagents: {
            registerProvider: () => { throw new Error('name already registered') },
            getProvider: () => undefined,
          },
        },
      })).rejects.toThrow(/name already registered/)
    } finally {
      await dispose()
    }
  })

  it('rolls back earlier components when a later component mount throws', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'plugin.json', JSON.stringify({
        name: 'p',
        agents: ['./agents'],
        skills: ['./skills/x'],
      }))
      await writeFileAt(root, 'skills/x/SKILL.md', '---\nname: x\ndescription: X\n---\n')
      await writeFileAt(root, 'agents/researcher.md', '---\ndescription: researcher\n---\nYou research.')
      const ctx = makeContext()
      const disposed: string[] = []
      await expect(mountCcPlugin(ctx, {
        root,
        seams: {
          skills: { register: () => () => { disposed.push('skills') } },
          subagents: {
            registerProvider: () => { throw new Error('name already registered') },
            getProvider: () => undefined,
          },
        },
      })).rejects.toThrow(/name already registered/)
      // Skills mounted before agents threw; its disposer must have run.
      expect(disposed).toEqual(['skills'])
    } finally {
      await dispose()
    }
  })

  it('fails a marketplace overlay whose nameHint matches no entry (zero skills)', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, '.claude-plugin/marketplace.json', JSON.stringify({
        plugins: [{ name: 'document-skills', skills: ['./skills/xlsx'] }],
      }))
      await writeFileAt(root, 'skills/xlsx/SKILL.md', '---\nname: xlsx\ndescription: Excel\n---\n')
      const ctx = makeContext()
      const names: string[] = []
      await expect(mountCcPlugin(ctx, {
        root,
        nameHint: 'ghost',
        seams: { skills: { register: (d) => { names.push((d as { name: string }).name); return () => {} } } },
      })).rejects.toThrow(/no plugin named "ghost"/)
      expect(names).toEqual([])
    } finally {
      await dispose()
    }
  })
})
