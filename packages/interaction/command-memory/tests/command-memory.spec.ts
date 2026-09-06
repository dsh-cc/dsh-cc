import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as commandMemory from '@dsh-cc/command-memory'
import { firstLine, formatIndex, formatIndexLine, type MemoryIndexLine } from '@dsh-cc/command-memory/memory'

let tempDir: string | undefined
afterAll(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
})

const GUIDE = `---
name: build-guide
description: how to build
type: project
---
Build with pnpm from the repo root.
More detail here.
`
const NOTE = `---
name: team-note
description: a team note
---
Remember this for later.
`

async function harness(): Promise<{
  ctx: Context
  agent: Agent
  plugin: Awaited<ReturnType<Context['plugin']>>
  dir: string
}> {
  tempDir = await mkdtemp(join(tmpdir(), 'command-memory-'))
  await mkdir(join(tempDir, 'mem'), { recursive: true })
  await writeFile(join(tempDir, 'mem', 'guides.md'), GUIDE)
  await writeFile(join(tempDir, 'mem', 'team.md'), NOTE)
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  const plugin = await ctx.plugin(commandMemory, { memoryHome: join(tempDir, 'mem') })
  const session = ctx.sessions.create(SessionId(`command-memory-${Math.random()}`))
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
  return { ctx, agent, plugin, dir: join(tempDir, 'mem') }
}

describe('@dsh-cc/command-memory registration', () => {
  it('registers one global command with Loader-safe exports and disposes it', async () => {
    expect(commandMemory.name).toBe('command-memory')
    expect(commandMemory.inject).toEqual(['commands', 'fs'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandMemory)).toBe(commandMemory)
    const { ctx, agent, plugin } = await harness()
    expect(ctx.commands.find(agent, 'memory')).toBeDefined()
    await plugin.dispose()
    expect(ctx.commands.find(agent, 'memory')).toBeUndefined()
  })
})

describe('/memory rendering', () => {
  it('extracts the first non-empty line of a body', () => {
    expect(firstLine('  \nFirst line.\nMore.')).toBe('First line.')
    expect(firstLine('   \n')).toBe('(empty)')
  })
  it('renders an index line with optional type', () => {
    const line: MemoryIndexLine = { name: 'build-guide', type: 'project', firstLine: 'Build it.' }
    expect(formatIndexLine(line)).toBe('- build-guide (project) — Build it.')
    expect(formatIndexLine({ name: 'n', firstLine: 'x' })).toBe('- n — x')
  })
  it('formats an empty directory index', () => {
    expect(formatIndex('/mem', [])).toContain('No memory topics.')
  })
})

describe('/memory human command', () => {
  it('lists name, type, and first line for each topic', async () => {
    const { ctx, agent, dir } = await harness()
    const execution = await ctx.commands.execute(agent, '/memory', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    const text = (execution?.result as { text: string }).text
    expect(text).toContain(`Memory directory: ${dir}`)
    expect(text).toContain('- build-guide (project) — Build with pnpm')
    expect(text).toContain('- team-note — Remember this for later.')
  })
  it('shows one memory body by name', async () => {
    const { ctx, agent } = await harness()
    const execution = await ctx.commands.execute(agent, '/memory build-guide', [], new AbortController().signal)
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('# build-guide')
    expect(text).toContain('Build with pnpm from the repo root.')
  })
  it('reports a missing memory name gracefully', async () => {
    const { ctx, agent } = await harness()
    const execution = await ctx.commands.execute(agent, '/memory nope', [], new AbortController().signal)
    expect((execution?.result as { text: string }).text).toContain('No memory named "nope".')
  })
})
