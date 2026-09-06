/**
 * The serena-first prompt steering. What it owes its caller: while a serena
 * MCP server is ready (registry-only, live detection), the assembled prompt
 * carries the `serena-first` policy section and one appended sentence each on
 * the upstream `tool:read` / `tool:grep` sections; otherwise the assembly is
 * byte-identical to baseline. Scope-less assemblies pass through, the rename
 * config flows into every emitted tool name, and state changes take effect on
 * the next assembly (no sticky latch, no provider state leak).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { renderPrompt, SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as SerenaFirst from '@dsh-cc/serena-first'
import type { Config } from '@dsh-cc/serena-first'

/** Upstream tool-fs / tool-fs-search section texts (deepseek-harness sources), as registered at mount. */
const FS_SECTIONS: Array<{ name: string; order: number; text: string }> = [
  {
    name: 'tool:read',
    order: 100,
    text: 'Use the read tool — not shell commands like cat — to inspect text files. Results include line numbers. Use offset and limit to continue reading large files.',
  },
  {
    name: 'tool:write',
    order: 101,
    text: 'Use the write tool to create files or completely replace file contents. Existing files are overwritten, so read an existing file first (the default fs-observation-policy requires it) and prefer edit for targeted changes.',
  },
  {
    name: 'tool:edit',
    order: 102,
    text: 'Use the edit tool for targeted changes to existing UTF-8 text files. It replaces literal old_string with new_string; by default old_string must appear exactly once. If old_string appears multiple times, provide a more specific old_string or set replace_all to true. Read the file first (the default fs-observation-policy requires it), unless you just created or edited it in this session.',
  },
  {
    name: 'tool:glob',
    order: 103,
    text: 'Use the glob tool — not shell find — to discover files by path pattern. A pattern with no "/" matches basenames at any depth, so "*" matches every file in the tree rather than its top level. Results are files only, never directories, and include hidden and ignored files.',
  },
  {
    name: 'tool:grep',
    order: 104,
    text: 'Use the grep tool — not shell grep or rg — to search file contents. Use read on a matched file when you need surrounding context.',
  },
]

/** Duck-typed `mcpConnections` entry, mirroring command-doctor's face. */
interface Entry {
  name: string
  state: string
  toolCount?: number
}

/**
 * A host plane with the system prompt, the upstream fs sections, and the
 * serena-first plugin — like `packages/core/tool-search/tests`, which builds
 * the real `@deepseek-ai/dsh-system-prompt` host and asserts on assemblies.
 */
async function host(options: { config?: Config; entries?: Entry[]; withPlugin?: boolean } = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  for (const section of FS_SECTIONS) ctx.systemPrompt.section(section)
  if (options.entries !== undefined) {
    const entries = options.entries
    ctx.provide('mcpConnections', { entries: () => entries })
  }
  if (options.withPlugin !== false) await ctx.plugin(SerenaFirst, options.config ?? {})
  return ctx
}

/** Mint an agent-scoped context under the host, as a preset subtree does. */
async function mintAgent(host: Context, id: string): Promise<{ agent: Agent; scope: Scope }> {
  const agent = { id: SessionId(id) } as Agent
  let scope!: Scope
  const fiber = host.plugin(Object.assign((inner: Context) => {
    scope = createScope(inner, agent)
  }, { inject: ['systemPrompt'] }))
  await fiber.await()
  return { agent, scope }
}

/** Assemble (scoped or global) and return the rendered prompt plus raw sections. */
async function assemble(host: Context, scope?: Agent): Promise<{ rendered: string; assembly: PromptAssembly }> {
  const assembly = await host.systemPrompt.assemble(scope === undefined ? {} : { scope })
  return { rendered: renderPrompt(assembly), assembly }
}

/** A baseline host: same plane, no serena-first plugin. */
async function baseline(options: { entries?: Entry[] } = {}) {
  return host({ ...options, withPlugin: false })
}

describe('when serena is not connected', () => {
  it('keeps the assembly byte-identical to baseline with no mcpConnections service', async () => {
    const plain = await host({ withPlugin: false })
    const withSerenaFirst = await host()
    const { agent } = await mintAgent(withSerenaFirst, 'agent-a')
    await mintAgent(plain, 'agent-a')

    const base = await assemble(plain, agent)
    const actual = await assemble(withSerenaFirst, agent)
    expect(actual.rendered).toBe(base.rendered)
    const section = actual.assembly.sections.find(s => s.name === 'serena-first')
    expect(section?.text ?? '').toBe('')
  })
})

describe('when serena is ready', () => {
  it('appends the read/grep sentences and renders the policy section; glob/write/edit and tools stay untouched', async () => {
    const ctx = await host({ entries: [{ name: 'serena', state: 'ready', toolCount: 30 }] })
    const { agent } = await mintAgent(ctx, 'agent-b')

    const { rendered, assembly } = await assemble(ctx, agent)
    const read = assembly.sections.find(s => s.name === 'tool:read')!
    const grep = assembly.sections.find(s => s.name === 'tool:grep')!
    expect(read.text).toContain(' When serena tools are available, prefer mcp__serena__find_symbol and mcp__serena__get_symbols_overview for code questions')
    expect(read.text.startsWith(FS_SECTIONS[0].text)).toBe(true)
    expect(grep.text).toContain(' For identifier lookups, mcp__serena__find_referencing_symbols is usually sharper than grepping raw text.')
    expect(grep.text.startsWith(FS_SECTIONS[4].text)).toBe(true)
    for (const name of ['tool:write', 'tool:edit', 'tool:glob']) {
      expect(assembly.sections.find(s => s.name === name)!.text).toBe(FS_SECTIONS.find(s => s.name === name)!.text)
    }
    const policy = assembly.sections.find(s => s.name === 'serena-first')!
    expect(policy.text).toContain('A serena MCP server is connected')
    expect(policy.text).toContain('mcp__serena__find_symbol')
    expect(policy.text).toContain('tool_search')
    expect(rendered).toContain('A serena MCP server is connected')
  })
})

describe('non-ready states', () => {
  it.each(['connecting', 'error', 'disconnected'] as const)('treats %s as inactive (baseline)', async (state) => {
    const plain = await host({ withPlugin: false })
    const ctx = await host({ entries: [{ name: 'serena', state, toolCount: 30 }] })
    const { agent: a } = await mintAgent(plain, 'x')
    const { agent: b } = await mintAgent(ctx, 'x')
    expect((await assemble(ctx, b)).rendered).toBe((await assemble(plain, a)).rendered)
  })

  it.each([[0], [undefined]] as const)('treats a ready entry with toolCount %s as inactive (baseline)', async (toolCount) => {
    const plain = await host({ withPlugin: false })
    const ctx = await host({ entries: [{ name: 'serena', state: 'ready', ...(toolCount === undefined ? {} : { toolCount }) }] })
    const { agent: a } = await mintAgent(plain, 'x')
    const { agent: b } = await mintAgent(ctx, 'x')
    expect((await assemble(ctx, b)).rendered).toBe((await assemble(plain, a)).rendered)
  })

  it('honors enabled: false even with a ready entry', async () => {
    const plain = await host({ withPlugin: false })
    const ctx = await host({ config: { enabled: false }, entries: [{ name: 'serena', state: 'ready', toolCount: 30 }] })
    const { agent: a } = await mintAgent(plain, 'x')
    const { agent: b } = await mintAgent(ctx, 'x')
    expect((await assemble(ctx, b)).rendered).toBe((await assemble(plain, a)).rendered)
  })
})

describe('serverName config', () => {
  it('follows the renamed entry and emits mcp__my-serena__* names everywhere', async () => {
    const ctx = await host({
      config: { serverName: 'my-serena' },
      entries: [{ name: 'my-serena', state: 'ready', toolCount: 30 }],
    })
    const { agent } = await mintAgent(ctx, 'agent-c')
    const { assembly } = await assemble(ctx, agent)

    // Detection followed the renamed entry, so steering is active.
    expect(assembly.sections.find(s => s.name === 'serena-first')!.text).toContain('mcp__my-serena__find_symbol')
    for (const section of assembly.sections) {
      expect(section.text).not.toContain('mcp__serena__')
    }
    const read = assembly.sections.find(s => s.name === 'tool:read')!
    expect(read.text).toContain('mcp__my-serena__find_symbol')
    expect(read.text).toContain('mcp__my-serena__get_symbols_overview')
    const grep = assembly.sections.find(s => s.name === 'tool:grep')!
    expect(grep.text).toContain('mcp__my-serena__find_referencing_symbols')

    // The default name does not match a renamed entry: inactive with plain 'serena'.
    const plain = await host({ withPlugin: false, entries: [{ name: 'serena', state: 'ready', toolCount: 30 }] })
    const other = await host({ config: { serverName: 'my-serena' }, entries: [{ name: 'serena', state: 'ready', toolCount: 30 }] })
    const { agent: a } = await mintAgent(plain, 'y')
    const { agent: b } = await mintAgent(other, 'y')
    expect((await assemble(other, b)).rendered).toBe((await assemble(plain, a)).rendered)
  })
})

describe('scope-less assemblies', () => {
  it('pass through even while serena is ready', async () => {
    const plain = await host({ withPlugin: false, entries: [{ name: 'serena', state: 'ready', toolCount: 30 }] })
    const ctx = await host({ entries: [{ name: 'serena', state: 'ready', toolCount: 30 }] })

    const base = await assemble(plain)
    const actual = await assemble(ctx)
    // The waterfall listener passes through: the fs sections stay untouched
    // (no appended sentences). The registered `serena-first` section is a
    // global section and still renders its policy text while serena is
    // ready — only the waterfall rewrite is scope-gated.
    expect(actual.assembly.sections.find(s => s.name === 'tool:read')!.text).toBe(FS_SECTIONS[0].text)
    expect(actual.assembly.sections.find(s => s.name === 'tool:grep')!.text).toBe(FS_SECTIONS[4].text)
    expect(actual.rendered).toBe([base.rendered, actual.assembly.sections.find(s => s.name === 'serena-first')!.text].filter(Boolean).join('\n\n'))
  })
})

describe('deployments without the fs sections', () => {
  it('still renders the policy section and never throws', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    ctx.provide('mcpConnections', { entries: () => [{ name: 'serena', state: 'ready', toolCount: 30 }] })
    await ctx.plugin(SerenaFirst, {})

    const { rendered, assembly } = await assemble(ctx)
    expect(assembly.sections.find(s => s.name === 'serena-first')!.text).toContain('A serena MCP server is connected')
    expect(rendered).toContain('A serena MCP server is connected')
    // No tool:read / tool:grep sections were invented.
    expect(assembly.sections.find(s => s.name === 'tool:read')).toBeUndefined()
    expect(assembly.sections.find(s => s.name === 'tool:grep')).toBeUndefined()
  })
})

describe('repeat assemblies', () => {
  it('produces identical output twice while active (no double-append, no provider state leak)', async () => {
    const ctx = await host({ entries: [{ name: 'serena', state: 'ready', toolCount: 30 }] })
    const { agent } = await mintAgent(ctx, 'agent-d')

    const first = await assemble(ctx, agent)
    const second = await assemble(ctx, agent)
    expect(second.rendered).toBe(first.rendered)
    const read = second.assembly.sections.find(s => s.name === 'tool:read')!
    expect(read.text.split(' When serena tools are available').length - 1).toBe(1)
  })

  it('re-evaluates live: a ready entry flipping to error returns to baseline', async () => {
    const entries: Entry[] = [{ name: 'serena', state: 'ready', toolCount: 30 }]
    const plain = await host({ withPlugin: false })
    const ctx = await host({ entries })
    const { agent: a } = await mintAgent(plain, 'x')
    const { agent: b } = await mintAgent(ctx, 'x')

    const active = await assemble(ctx, b)
    expect(active.rendered).toContain('A serena MCP server is connected')

    entries[0] = { name: 'serena', state: 'error' }
    const after = await assemble(ctx, b)
    expect(after.rendered).toBe((await assemble(plain, a)).rendered)
    expect(after.assembly.sections.find(s => s.name === 'tool:read')!.text).toBe(FS_SECTIONS[0].text)
  })
})
