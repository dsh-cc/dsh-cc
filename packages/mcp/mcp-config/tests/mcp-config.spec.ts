import { describe, expect, it } from 'vitest'
import {
  expandEnv,
  parseMcpServers,
  normalizeServerEntry,
  applyEnv,
  dedupServers,
  buildRegistrations,
  type McpServerEntry,
} from '@dsh-cc/mcp-config/src/index.ts'

const ENV: Record<string, string> = {
  TOKEN: 'secret-token',
  PORT: '8080',
  EMPTY: '',
}

describe('normalizeServerEntry', () => {
  it('defaults a command entry to the stdio transport', () => {
    const entry = normalizeServerEntry({ command: 'node', args: ['server.js'] })
    expect(entry).toEqual({
      transport: 'stdio', command: 'node', args: ['server.js'], env: {}, cwd: '',
      toolCallTimeoutMs: 60_000, failOnStartupError: true,
    })
  })

  it('normalizes an explicit stdio entry', () => {
    const entry = normalizeServerEntry({ type: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { A: '1' }, cwd: '/tmp' })
    expect(entry).toEqual({
      transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { A: '1' }, cwd: '/tmp',
      toolCallTimeoutMs: 60_000, failOnStartupError: true,
    })
  })

  it('normalizes an http entry', () => {
    const entry = normalizeServerEntry({ type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'x' } })
    expect(entry).toEqual({
      transport: 'streamable-http', url: 'https://example.com/mcp', headers: { Authorization: 'x' },
      toolCallTimeoutMs: 60_000, failOnStartupError: true,
    })
  })

  it('normalizes an sse entry', () => {
    const entry = normalizeServerEntry({ type: 'sse', url: 'https://example.com/sse', headers: { Authorization: 'x' } })
    expect(entry).toEqual({
      transport: 'sse', url: 'https://example.com/sse', headers: { Authorization: 'x' },
      toolCallTimeoutMs: 60_000, failOnStartupError: true,
    })
  })

  it('throws on an unknown transport type', () => {
    const bad = { type: 'websocket', url: 'ws://x' } as unknown as McpServerEntry
    expect(() => normalizeServerEntry(bad)).toThrow(/unsupported MCP transport/i)
  })

  it('throws when an http entry lacks a url', () => {
    expect(() => normalizeServerEntry({ type: 'http' })).toThrow(/url/i)
  })

  it('throws when a stdio entry lacks a command', () => {
    expect(() => normalizeServerEntry({})).toThrow(/command/i)
  })
})

describe('expandEnv', () => {
  it('leaves text without substitutions unchanged', () => {
    expect(expandEnv('plain text', ENV)).toBe('plain text')
  })

  it('substitutes ${VAR} with the surrounding value', () => {
    expect(expandEnv('prefix-${TOKEN}-suffix', ENV)).toBe('prefix-secret-token-suffix')
  })

  it('substitutes ${VAR:-default} with the value when set (including empty)', () => {
    expect(expandEnv('${PORT:-9000}', ENV)).toBe('8080')
    expect(expandEnv('${EMPTY:-9000}', ENV)).toBe('9000')
    expect(expandEnv('${MISSING:-9000}', ENV)).toBe('9000')
  })

  it('throws on an unset variable without a default', () => {
    expect(() => expandEnv('${MISSING}', ENV)).toThrow(/MISSING/i)
  })
})

describe('applyEnv', () => {
  it('expands every env value for a server entry', () => {
    const entry = normalizeServerEntry({ command: 'node', env: { TOKEN: '${TOKEN}', PORT: '${PORT:-9}' } })
    expect(applyEnv(entry, ENV)).toEqual({
      transport: 'stdio',
      command: 'node',
      args: [],
      cwd: '',
      env: { TOKEN: 'secret-token', PORT: '8080' },
      toolCallTimeoutMs: 60_000,
      failOnStartupError: true,
    })
  })

  it('also expands command and args', () => {
    const entry = normalizeServerEntry({ command: 'node-${PORT}', args: ['${PORT}'] })
    expect(applyEnv(entry, ENV)).toMatchObject({
      command: 'node-8080',
      args: ['8080'],
    })
  })
})

describe('parseMcpServers / buildRegistrations', () => {
  it('rejects a non-object body', () => {
    expect(() => parseMcpServers(null)).toThrow(/object/i)
    expect(() => parseMcpServers('nope')).toThrow(/object/i)
  })

  it('rejects a body without mcpServers', () => {
    expect(() => parseMcpServers({})).toThrow(/mcpServers/i)
  })

  it('rejects a non-object mcpServers map', () => {
    expect(() => parseMcpServers({ mcpServers: 'not-an-object' })).toThrow(/mcpServers/i)
  })

  it('rejects when a duplicated server name appears twice in array-form mcpServers', () => {
    const body = {
      mcpServers: [
        { github: { command: 'node' } },
        { github: { command: 'node' } },
      ],
    }
    expect(() => dedupServers(parseMcpServers(body as never))).toThrow(/duplicate/i)
  })

  it('parses a full map and dedupes to unique normalized entries', () => {
    const body = {
      mcpServers: {
        local: { command: 'node', args: ['s.js'] },
        http: { type: 'http', url: 'http://localhost:3000/mcp', headers: {} },
        sse: { type: 'sse', url: 'http://localhost:3001/sse' },
      },
    }
    const servers = dedupServers(parseMcpServers(body))
    expect(servers).toHaveLength(3)
    expect(servers.map(s => s.name).sort()).toEqual(['http', 'local', 'sse'])
  })

  it('builds stdio registrations with expanded env', () => {
    const regs = buildRegistrations(
      { mcpServers: { github: { command: 'npx', args: ['p'], env: { T: '${TOKEN}' } } } },
      { env: ENV },
    )
    expect(regs).toEqual([{
      transport: 'stdio',
      serverName: 'github',
      command: 'npx',
      args: ['p'],
      env: { T: 'secret-token' },
      cwd: '',
      toolCallTimeoutMs: 60_000,
      failOnStartupError: true,
    }])
  })

  it('builds streamable-http registrations', () => {
    const regs = buildRegistrations(
      { mcpServers: { web: { type: 'http', url: 'http://localhost:3000/mcp', headers: { A: '${TOKEN}' } } } },
      { env: ENV },
    )
    expect(regs).toEqual([{
      transport: 'streamable-http',
      serverName: 'web',
      url: 'http://localhost:3000/mcp',
      headers: { A: 'secret-token' },
      toolCallTimeoutMs: 60_000,
      failOnStartupError: true,
    }])
  })

  it('builds sse registrations', () => {
    const regs = buildRegistrations(
      { mcpServers: { feed: { type: 'sse', url: 'http://localhost:3001/sse' } } },
      { env: ENV },
    )
    expect(regs[0]).toMatchObject({ transport: 'sse', serverName: 'feed', url: 'http://localhost:3001/sse' })
  })

  it('applies the enterprise allow/deny hooks in order', () => {
    const seen: string[] = []
    const regs = buildRegistrations(
      { mcpServers: { ok: { command: 'node' }, blocked: { command: 'node' }, silent: { command: 'node' } } },
      {
        env: ENV,
        policy: {
          deny: name => name === 'blocked',
          allow: (name) => {
            seen.push(name)
            return name !== 'silent'
          },
        },
      },
    )
    expect(seen).toEqual(['ok', 'silent'])
    expect(regs.map(r => r.serverName)).toEqual(['ok'])
  })

  it('throws on bad configuration at load time', () => {
    expect(() => buildRegistrations({ mcpServers: { bad: { type: 'http' } } } as never, { env: ENV }))
      .toThrow(/url/i)
  })
})

describe('buildRegistrations serverName normalization', () => {
  it('normalizes invalid characters in a server name to a single dash', () => {
    const regs = buildRegistrations(
      { mcpServers: { 'pxpipe docs': { type: 'http', url: 'https://example.com/mcp' } } },
      { env: ENV },
    )
    expect(regs).toHaveLength(1)
    expect(regs[0]?.serverName).toBe('pxpipe-docs')
    expect(regs[0]?.serverName).toMatch(/^[A-Za-z0-9_-]{1,32}$/)
  })

  it('passes already-valid server names through unchanged', () => {
    const regs = buildRegistrations(
      { mcpServers: { context7: { type: 'stdio', command: 'npx', args: [] } } },
      { env: ENV },
    )
    expect(regs).toHaveLength(1)
    expect(regs[0]?.serverName).toBe('context7')
  })

  it('gives policy hooks the original unnormalized name', () => {
    const seen: string[] = []
    buildRegistrations(
      { mcpServers: { 'pxpipe docs': { type: 'http', url: 'https://example.com/mcp' } } },
      {
        env: ENV,
        policy: {
          allow: (name) => {
            seen.push(name)
            return true
          },
        },
      },
    )
    expect(seen).toEqual(['pxpipe docs'])
  })

  it('truncates overlong server names to the 32-char tool-prefix limit', () => {
    const long = `${'a'.repeat(20)} ${'b'.repeat(19)}`
    const regs = buildRegistrations(
      { mcpServers: { [long]: { type: 'http', url: 'https://example.com/mcp' } } },
      { env: ENV },
    )
    expect(regs).toHaveLength(1)
    const name = regs[0]?.serverName ?? ''
    expect(name.length).toBeGreaterThan(0)
    expect(name.length).toBeLessThanOrEqual(32)
    expect(name).toMatch(/^[A-Za-z0-9_-]{1,32}$/)
  })
})
