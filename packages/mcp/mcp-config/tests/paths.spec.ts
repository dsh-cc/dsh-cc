import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  claudeOnlyServers,
  readMcpServerNames,
  resolveDefaultMcpPaths,
} from '@dsh-cc/mcp-config/src/paths.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mcp-paths-'))
})

afterEach(() => {
  // Vitest leaves tmp dirs alone; each test uses its own fresh tempdir.
})

describe('resolveDefaultMcpPaths', () => {
  it('classifies defaults without DSH_HOME or CLAUDE_CONFIG_DIR', () => {
    const paths = resolveDefaultMcpPaths({ env: {}, cwd: '/proj', home: '/home/u' })
    expect(paths.dsh).toEqual(['/proj/.mcp.json', '/home/u/.dsh/.mcp.json'])
    expect(paths.claude).toEqual(['/home/u/.claude/.mcp.json', '/home/u/.claude.json'])
    expect(paths.target).toBe('/home/u/.dsh/.mcp.json')
  })

  it('honors DSH_HOME for dsh paths and target', () => {
    const paths = resolveDefaultMcpPaths({
      env: { DSH_HOME: join(root, 'dsh') },
      cwd: '/proj',
      home: '/home/u',
    })
    const dshFile = join(root, 'dsh', '.mcp.json')
    expect(paths.dsh).toEqual(['/proj/.mcp.json', dshFile])
    expect(paths.target).toBe(dshFile)
  })

  it('honors CLAUDE_CONFIG_DIR for the claude config dir but not ~/.claude.json', () => {
    const paths = resolveDefaultMcpPaths({
      env: { CLAUDE_CONFIG_DIR: join(root, 'claude') },
      cwd: '/proj',
      home: '/home/u',
    })
    expect(paths.claude).toEqual([join(root, 'claude', '.mcp.json'), '/home/u/.claude.json'])
  })
})

describe('readMcpServerNames', () => {
  it('reports absent for a missing file', () => {
    expect(readMcpServerNames(join(root, 'nope.json'))).toEqual({ kind: 'absent' })
  })

  it('reports invalid with the error message for unparseable JSON', () => {
    const file = join(root, 'bad.json')
    writeFileSync(file, '{ not json')
    const result = readMcpServerNames(file)
    expect(result.kind).toBe('invalid')
    if (result.kind === 'invalid') expect(result.error.length).toBeGreaterThan(0)
  })

  it('reports invalid when mcpServers is missing', () => {
    const file = join(root, 'noservers.json')
    writeFileSync(file, '{}')
    const result = readMcpServerNames(file)
    expect(result.kind).toBe('invalid')
    if (result.kind === 'invalid') expect(result.error).toContain('mcpServers')
  })

  it('returns map-form names in key order without expansion or normalization', () => {
    const file = join(root, 'map.json')
    writeFileSync(file, JSON.stringify({
      mcpServers: {
        'zeta srv': { command: 'npx', args: ['${TOKEN}'] },
        alpha: { type: 'http', url: '${PORT:-1}' },
      },
    }))
    const result = readMcpServerNames(file)
    expect(result).toEqual({ kind: 'ok', names: ['zeta srv', 'alpha'] })
  })

  it('returns array-form names flattened in order', () => {
    const file = join(root, 'array.json')
    writeFileSync(file, JSON.stringify({
      mcpServers: [{ b: { command: 'b' } }, { a: { command: 'a' } }],
    }))
    expect(readMcpServerNames(file)).toEqual({ kind: 'ok', names: ['b', 'a'] })
  })
})

describe('claudeOnlyServers', () => {
  it('subtracts the union of readable dsh names per claude file', () => {
    const dshA = join(root, 'dsh-project.json')
    const dshB = join(root, 'dsh-home.json')
    const claudeA = join(root, 'claude-mcp.json')
    const claudeB = join(root, 'claude-state.json')
    writeFileSync(dshA, JSON.stringify({ mcpServers: { shared: { command: 's' }, dshOnly: { command: 'd' } } }))
    writeFileSync(dshB, JSON.stringify({ mcpServers: { homeOnly: { command: 'h' } } }))
    writeFileSync(claudeA, JSON.stringify({ mcpServers: { shared: { command: 's' }, ccOnly: { command: 'c' } } }))
    writeFileSync(claudeB, JSON.stringify({ mcpServers: { other: { command: 'o' }, ccOnly: { command: 'c' } } }))
    expect(claudeOnlyServers({ dsh: [dshA, dshB], claude: [claudeA, claudeB] })).toEqual([
      { path: claudeA, names: ['ccOnly'] },
      { path: claudeB, names: ['other', 'ccOnly'] },
    ])
  })

  it('returns an empty result when claude files are absent', () => {
    const dsh = join(root, 'dsh.json')
    writeFileSync(dsh, JSON.stringify({ mcpServers: { a: { command: 'a' } } }))
    expect(claudeOnlyServers({ dsh: [dsh], claude: [join(root, 'absent.json')] })).toEqual([])
  })

  it('returns nothing when claude names are fully shadowed by dsh', () => {
    const dsh = join(root, 'dsh.json')
    const claude = join(root, 'claude.json')
    writeFileSync(dsh, JSON.stringify({ mcpServers: { a: { command: 'a' }, b: { command: 'b' } } }))
    writeFileSync(claude, JSON.stringify({ mcpServers: { a: { command: 'a' } } }))
    expect(claudeOnlyServers({ dsh: [dsh], claude: [claude] })).toEqual([])
  })

  it('skips invalid or absent files on either side', () => {
    const badDsh = join(root, 'bad-dsh.json')
    writeFileSync(badDsh, 'not json')
    const claude = join(root, 'claude.json')
    writeFileSync(claude, JSON.stringify({ mcpServers: { c: { command: 'c' } } }))
    expect(claudeOnlyServers({ dsh: [badDsh, join(root, 'absent.json')], claude: [claude] })).toEqual([
      { path: claude, names: ['c'] },
    ])
  })
})
