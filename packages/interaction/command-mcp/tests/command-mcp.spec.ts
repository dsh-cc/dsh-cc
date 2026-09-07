import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as commandMcp from '@dsh-cc/command-mcp'
import {
  formatConnections,
  formatDiscoveryNotice,
  formatMigrateReport,
  parseMcpInput,
  type McpConnectionEntry,
} from '@dsh-cc/command-mcp/mcp'
import type { ClaudeOnlySource, McpMigrationResult } from '@dsh-cc/mcp-config'

const SAMPLE: readonly McpConnectionEntry[] = [
  { name: 'files', state: 'ready', toolCount: 12 },
  { name: 'search', state: 'error', error: 'ECONNREFUSED' },
  { name: 'git', state: 'connecting', authRequired: true },
]

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'command-mcp-test-'))
}
function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2))
}
/** Save, override, and later restore the env vars the path resolution defaults read. */
function manageEnv(keys: string[]): { before(): void; after(): void } {
  const saved: Record<string, string | undefined> = {}
  return {
    before(): void {
      for (const key of keys) saved[key] = process.env[key]
    },
    after(): void {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
    },
  }
}
const PATH_ENV_KEYS = ['HOME', 'DSH_HOME', 'CLAUDE_CONFIG_DIR']

async function harness(seam?: { entries(): McpConnectionEntry[]; disconnect(name: string): Promise<void>; reconnect(name: string): Promise<void> }) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(commandMcp)
  if (seam) ctx.provide('mcpConnections', seam)
  const session = ctx.sessions.create(SessionId(`command-mcp-human-${Math.random()}`))
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
  return { ctx, agent }
}

describe('parseMcpInput', () => {
  it('parses the empty/whitespace form as a listing', () => {
    expect(parseMcpInput('')).toEqual({ kind: 'list' })
    expect(parseMcpInput('   ')).toEqual({ kind: 'list' })
  })
  it('parses reconnect and disconnect with a single name', () => {
    expect(parseMcpInput(' reconnect files ')).toEqual({ kind: 'reconnect', name: 'files' })
    expect(parseMcpInput('disconnect git')).toEqual({ kind: 'disconnect', name: 'git' })
  })
  it('rejects missing args and unknown subcommands as usage', () => {
    expect(parseMcpInput('reconnect')).toEqual({ kind: 'usage' })
    expect(parseMcpInput('reconnect a b')).toEqual({ kind: 'usage' })
    expect(parseMcpInput('disconnect')).toEqual({ kind: 'usage' })
    expect(parseMcpInput('foo')).toEqual({ kind: 'usage' })
    expect(parseMcpInput('stop files')).toEqual({ kind: 'usage' })
  })
})

describe('parseMcpInput migrate', () => {
  it('parses a bare `migrate` as a migration request', () => {
    expect(parseMcpInput('migrate')).toEqual({ kind: 'migrate' })
    expect(parseMcpInput('  migrate  ')).toEqual({ kind: 'migrate' })
  })
  it('rejects `migrate` with extra tokens as usage', () => {
    expect(parseMcpInput('migrate extra')).toEqual({ kind: 'usage' })
    expect(parseMcpInput('migrate now please')).toEqual({ kind: 'usage' })
  })
})

describe('formatMigrateReport (pure)', () => {
  it('reports nothing to migrate with the target path', () => {
    const result: McpMigrationResult = {
      target: '/tmp/home/.dsh/.mcp.json',
      added: [], kept: [], sourceConflicts: [], sources: [], wrote: false,
    }
    const text = formatMigrateReport(result)
    expect(text).toContain('Nothing to migrate')
    expect(text).toContain('/tmp/home/.dsh/.mcp.json')
  })
  it('renders per-source counts, added/kept, conflicts, backup, and the restart sentence', () => {
    const result: McpMigrationResult = {
      target: '/tmp/dsh/.mcp.json',
      added: ['alpha', 'beta'],
      kept: ['gamma'],
      sourceConflicts: [{ name: 'delta', kept: '/tmp/a/.mcp.json', skipped: '/tmp/b/.mcp.json' }],
      sources: [
        { path: '/tmp/a/.mcp.json', servers: ['alpha', 'delta'] },
        { path: '/tmp/b/.claude.json', servers: ['beta', 'delta'], error: undefined },
      ],
      wrote: true,
      backup: '/tmp/dsh/.mcp.json.bak',
    }
    const text = formatMigrateReport(result)
    expect(text).toContain('/tmp/a/.mcp.json: 2 servers')
    expect(text).toContain('/tmp/b/.claude.json: 2 servers')
    expect(text).toContain('added: alpha, beta')
    expect(text).toContain('kept (already in dsh config): gamma')
    expect(text).toContain('delta')
    expect(text).toContain('backup: /tmp/dsh/.mcp.json.bak')
    expect(text).toContain('restart')
    expect(text).toContain('not modified')
  })
  it('renders per-source errors for unreadable sources', () => {
    const result: McpMigrationResult = {
      target: '/tmp/dsh/.mcp.json',
      added: [], kept: [], sourceConflicts: [],
      sources: [{ path: '/tmp/broken/.mcp.json', servers: [], error: 'Unexpected token' }],
      wrote: true,
    }
    const text = formatMigrateReport(result)
    expect(text).toContain('unreadable')
    expect(text).toContain('Unexpected token')
  })
})

describe('formatDiscoveryNotice (pure)', () => {
  it('tells the user to run /mcp migrate into the target', () => {
    const sources: ClaudeOnlySource[] = [{ path: '/tmp/claude/.mcp.json', names: ['a', 'b'] }]
    const text = formatDiscoveryNotice(sources, '/tmp/dsh/.mcp.json')
    expect(text).toContain('/mcp migrate')
    expect(text).toContain('/tmp/dsh/.mcp.json')
    expect(text).toContain('/tmp/claude/.mcp.json')
  })
})



describe('formatConnections (pure)', () => {
  it('renders name, state, tool count, and auth markers', () => {
    const text = formatConnections(SAMPLE)
    expect(text).toContain('- files (ready) tools: 12')
    expect(text).toContain('- search (error) error: ECONNREFUSED')
    expect(text).toContain('- git (connecting) auth required')
  })
  it('reports an empty registry gracefully', () => {
    expect(formatConnections([])).toContain('No MCP servers are registered.')
  })
})

describe('/mcp human command', () => {
  it('registers one global command with Loader-safe exports', async () => {
    expect(commandMcp.name).toBe('command-mcp')
    expect(commandMcp.inject).toEqual(['commands'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandMcp)).toBe(commandMcp)
    const { ctx, agent } = await harness()
    expect(ctx.commands.find(agent, 'mcp')).toBeDefined()
  })

  it('degrades gracefully when the mcpConnections seam is absent', async () => {
    const { ctx, agent } = await harness()
    const execution = await ctx.commands.execute(agent, '/mcp', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    expect((execution?.result as { text: string }).text).toContain('mcp-client absent')
  })

  it('lists connections through the seam', async () => {
    const entries = vi.fn(() => [...SAMPLE])
    const { ctx, agent } = await harness({ entries, disconnect: async () => {}, reconnect: async () => {} })
    const execution = await ctx.commands.execute(agent, '/mcp', [], new AbortController().signal)
    expect(entries).toHaveBeenCalled()
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('- files (ready) tools: 12')
  })

  it('reconnects a server by name', async () => {
    const reconnect = vi.fn(async () => {})
    const { ctx, agent } = await harness({ entries: () => [], disconnect: async () => {}, reconnect })
    const execution = await ctx.commands.execute(agent, '/mcp reconnect files', [], new AbortController().signal)
    expect(reconnect).toHaveBeenCalledWith('files')
    expect((execution?.result as { text: string }).text).toContain('Reconnecting MCP server "files"')
  })

  it('disconnects a server by name', async () => {
    const disconnect = vi.fn(async () => {})
    const { ctx, agent } = await harness({ entries: () => [], disconnect, reconnect: async () => {} })
    const execution = await ctx.commands.execute(agent, '/mcp disconnect git', [], new AbortController().signal)
    expect(disconnect).toHaveBeenCalledWith('git')
    expect((execution?.result as { text: string }).text).toContain('Disconnected MCP server "git"')
  })

  it('reports unknown subcommands as usage', async () => {
    const { ctx, agent } = await harness({ entries: () => [], disconnect: async () => {}, reconnect: async () => {} })
    const execution = await ctx.commands.execute(agent, '/mcp frobnicate files', [], new AbortController().signal)
    expect((execution?.result as { text: string }).text).toContain('Usage:')
  })

  it('reports a failed drive action gracefully', async () => {
    const reconnect = vi.fn(async () => { throw new Error('no such server') })
    const { ctx, agent } = await harness({ entries: () => [], disconnect: async () => {}, reconnect })
    const execution = await ctx.commands.execute(agent, '/mcp reconnect nope', [], new AbortController().signal)
    expect((execution?.result as { text: string }).text).toContain('Failed to reconnect MCP server "nope"')
  })
})

describe('/mcp migrate handler', () => {
  const env = manageEnv(PATH_ENV_KEYS)
  let tmpRoot = ''
  let dshHome = ''
  let claudeDir = ''

  beforeEach(() => {
    env.before()
    tmpRoot = makeTmpDir()
    dshHome = join(tmpRoot, 'dsh')
    claudeDir = join(tmpRoot, 'claude')
    process.env.HOME = tmpRoot
    process.env.DSH_HOME = dshHome
    process.env.CLAUDE_CONFIG_DIR = claudeDir
  })
  afterEach(() => env.after())

  function claudeSources(): void {
    writeJson(join(claudeDir, '.mcp.json'), {
      mcpServers: {
        fsx: { command: 'npx', args: ['-y', 'fsx-mcp'], env: { TOKEN: '${FSX_TOKEN}' } },
        web: { type: 'http', url: 'https://example.test/mcp' },
      },
    })
    writeJson(join(tmpRoot, '.claude.json'), {
      mcpServers: { gitx: { command: 'git-mcp' } },
    })
  }

  it('migrates Claude Code servers without a mounted mcpConnections seam', async () => {
    claudeSources()
    const { ctx, agent } = await harness()
    const execution = await ctx.commands.execute(agent, '/mcp migrate', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('fsx')
    expect(text).toContain('gitx')
    expect(text).toContain(join(dshHome, '.mcp.json'))
    expect(text).toContain('restart')
    const target = JSON.parse(readFileSync(join(dshHome, '.mcp.json'), 'utf8'))
    expect(target.mcpServers.fsx).toEqual({ command: 'npx', args: ['-y', 'fsx-mcp'], env: { TOKEN: '${FSX_TOKEN}' } })
    expect(target.mcpServers.web).toEqual({ type: 'http', url: 'https://example.test/mcp' })
    expect(target.mcpServers.gitx).toEqual({ command: 'git-mcp' })
  })

  it('keeps colliding target names and is idempotent on re-run', async () => {
    claudeSources()
    const targetPath = join(dshHome, '.mcp.json')
    const existing = { mcpServers: { fsx: { command: 'existing-fsx' } } }
    writeJson(targetPath, existing)
    const { ctx, agent } = await harness()
    const execution = await ctx.commands.execute(agent, '/mcp migrate', [], new AbortController().signal)
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('fsx')
    expect(text).not.toContain('added: fsx')
    const after = JSON.parse(readFileSync(targetPath, 'utf8'))
    expect(after.mcpServers.fsx).toEqual({ command: 'existing-fsx' })
    expect(existsSync(`${targetPath}.bak`)).toBe(true)
    const second = await ctx.commands.execute(agent, '/mcp migrate', [], new AbortController().signal)
    const secondText = (second?.result as { text: string }).text
    expect(secondText).toContain('Nothing to migrate')
  })
})
describe('/mcp list discovery notice', () => {
  const env = manageEnv(PATH_ENV_KEYS)
  let tmpRoot = ''
  let dshHome = ''
  let claudeDir = ''

  beforeEach(() => {
    env.before()
    tmpRoot = makeTmpDir()
    dshHome = join(tmpRoot, 'dsh')
    claudeDir = join(tmpRoot, 'claude')
    process.env.HOME = tmpRoot
    process.env.DSH_HOME = dshHome
    process.env.CLAUDE_CONFIG_DIR = claudeDir
    mkdirSync(dshHome, { recursive: true })
    writeFileSync(join(dshHome, '.mcp.json'), JSON.stringify({ mcpServers: { local: { command: 'local-mcp' } } }))
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(join(claudeDir, '.mcp.json'), JSON.stringify({ mcpServers: { claudeonly: { command: 'claude-mcp' } } }))
  })
  afterEach(() => env.after())

  it('appends the discovery notice when claude-only servers exist, and clears it after migrate', async () => {
    const { ctx, agent } = await harness({ entries: () => [], disconnect: async () => {}, reconnect: async () => {} })
    const before = await ctx.commands.execute(agent, '/mcp', [], new AbortController().signal)
    const beforeText = (before?.result as { text: string }).text
    expect(beforeText).toContain('migrate')
    expect(beforeText).toContain(join(dshHome, '.mcp.json'))
    const migration = await ctx.commands.execute(agent, '/mcp migrate', [], new AbortController().signal)
    expect(migration?.result.kind).toBe('success')
    const after = await ctx.commands.execute(agent, '/mcp', [], new AbortController().signal)
    const afterText = (after?.result as { text: string }).text
    expect(afterText).not.toContain('migrate')
  })

  it('omits the notice when there is nothing to migrate', async () => {
    process.env.CLAUDE_CONFIG_DIR = join(tmpRoot, 'empty-claude')
    const { ctx, agent } = await harness({ entries: () => [], disconnect: async () => {}, reconnect: async () => {} })
    const execution = await ctx.commands.execute(agent, '/mcp', [], new AbortController().signal)
    expect((execution?.result as { text: string }).text).not.toContain('migrate')
  })

  it('omits the notice when no dsh config gates — the claude files are loaded, not skipped', async () => {
    // Same rule as the loader: a dsh-native file must declare ≥1 server for
    // gating to apply. Without one the claude config is live, and nagging
    // about "not loaded" servers would be a false positive.
    rmSync(join(dshHome, '.mcp.json'))
    const { ctx, agent } = await harness({ entries: () => [], disconnect: async () => {}, reconnect: async () => {} })
    const execution = await ctx.commands.execute(agent, '/mcp', [], new AbortController().signal)
    expect((execution?.result as { text: string }).text).not.toContain('migrate')
  })
})
describe('/mcp help interception', () => {
  it('answers a trailing help argument with formatted help text', async () => {
    const { ctx, agent } = await harness()
    const execution = await ctx.commands.execute(agent, '/mcp help', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    const text = execution?.result.text ?? ''
    expect(text).toContain('/mcp')
    expect(text).toContain('Usage:')
    expect(text).toContain('list')
    expect(text).toContain('migrate')
    expect(text).toContain('reconnect')
    expect(text).toContain('disconnect')
  })
})
