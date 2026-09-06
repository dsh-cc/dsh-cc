import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrateMcpServers } from '@dsh-cc/mcp-config/src/migrate.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mcp-migrate-'))
})

afterEach(() => {
  // Each test gets a fresh mkdtemp dir; nothing else to clean up.
})

function writeMcp(file: string, body: unknown): string {
  writeFileSync(file, JSON.stringify(body, null, 2) + '\n')
  return file
}

describe('migrateMcpServers', () => {
  it('creates the target from absent, including the DSH_HOME directory', () => {
    const target = join(root, 'dsh', '.mcp.json')
    const src = writeMcp(join(root, 'claude-mcp.json'), {
      mcpServers: { cc: { command: 'npx', args: ['-y', 'pkg'], env: { T: '${TOKEN}' } } },
    })
    const result = migrateMcpServers({ sources: [src], target })
    expect(result.wrote).toBe(true)
    expect(result.added).toEqual(['cc'])
    expect(result.kept).toEqual([])
    expect(result.backup).toBeUndefined()
    const written = JSON.parse(readFileSync(target, 'utf8'))
    // Raw entry: ${TOKEN} NOT expanded.
    expect(written.mcpServers.cc).toEqual({ command: 'npx', args: ['-y', 'pkg'], env: { T: '${TOKEN}' } })
    expect(readFileSync(target, 'utf8').endsWith('\n')).toBe(true)
    // Two-space indentation.
    expect(readFileSync(target, 'utf8')).toContain('\n  "mcpServers"')
  })

  it('merges into an existing map-form target, preserving other top-level keys', () => {
    const target = writeMcp(join(root, 'target.json'), {
      version: 3,
      mcpServers: { existing: { command: 'keep' } },
    })
    const src = writeMcp(join(root, 'src.json'), {
      mcpServers: { fresh: { command: 'new' } },
    })
    const result = migrateMcpServers({ sources: [src], target })
    expect(result.wrote).toBe(true)
    const written = JSON.parse(readFileSync(target, 'utf8'))
    expect(written.version).toBe(3)
    expect(Object.keys(written.mcpServers)).toEqual(['existing', 'fresh'])
  })

  it('appends ONE group object to an array-form target', () => {
    const target = writeMcp(join(root, 'target.json'), {
      mcpServers: [{ a: { command: 'a' } }, { b: { command: 'b' } }],
    })
    const src = writeMcp(join(root, 'src.json'), { mcpServers: { c: { command: 'c' }, d: { command: 'd' } } })
    const result = migrateMcpServers({ sources: [src], target })
    expect(result.added).toEqual(['c', 'd'])
    const written = JSON.parse(readFileSync(target, 'utf8'))
    expect(written.mcpServers).toHaveLength(3)
    expect(written.mcpServers[2]).toEqual({ c: { command: 'c' }, d: { command: 'd' } })
  })

  it('keeps existing target names on collision, never overwriting the target entry', () => {
    const target = writeMcp(join(root, 'target.json'), {
      mcpServers: { shared: { command: 'target-version', cwd: '/x' } },
    })
    const src = writeMcp(join(root, 'src.json'), {
      mcpServers: { shared: { command: 'source-version' }, extra: { command: 'e' } },
    })
    const result = migrateMcpServers({ sources: [src], target })
    expect(result.kept).toEqual(['shared'])
    expect(result.added).toEqual(['extra'])
    const written = JSON.parse(readFileSync(target, 'utf8'))
    expect(written.mcpServers.shared).toEqual({ command: 'target-version', cwd: '/x' })
  })

  it('reports cross-source first-wins conflicts', () => {
    const src1 = writeMcp(join(root, 's1.json'), { mcpServers: { dup: { command: 'one' } } })
    const src2 = writeMcp(join(root, 's2.json'), { mcpServers: { dup: { command: 'two' } } })
    const target = join(root, 'target.json')
    const result = migrateMcpServers({ sources: [src1, src2], target })
    expect(result.added).toEqual(['dup'])
    expect(result.sourceConflicts).toEqual([{ name: 'dup', kept: src1, skipped: src2 }])
    expect(JSON.parse(readFileSync(target, 'utf8')).mcpServers.dup).toEqual({ command: 'one' })
  })

  it('tolerates an unreadable source, migrating the others', () => {
    const bad = join(root, 'bad.json')
    writeFileSync(bad, 'not json')
    const good = writeMcp(join(root, 'good.json'), { mcpServers: { g: { command: 'g' } } })
    const result = migrateMcpServers({ sources: [bad, good], target: join(root, 'target.json') })
    expect(result.sources).toEqual([
      { path: bad, servers: [], error: expect.stringContaining('json') },
      { path: good, servers: ['g'] },
    ])
    expect(result.added).toEqual(['g'])
  })

  it('throws on an unparseable target and leaves its bytes unchanged', () => {
    const target = join(root, 'target.json')
    writeFileSync(target, '{ broken')
    const src = writeMcp(join(root, 'src.json'), { mcpServers: { a: { command: 'a' } } })
    const before = readFileSync(target, 'utf8')
    expect(() => migrateMcpServers({ sources: [src], target })).toThrow(/target/)
    expect(readFileSync(target, 'utf8')).toBe(before)
    expect(existsSync(target + '.bak')).toBe(false)
    expect(existsSync(target)).toBe(true)
  })

  it('throws when the target mcpServers fails validation', () => {
    const target = writeMcp(join(root, 'target.json'), { mcpServers: 'nope' })
    const src = writeMcp(join(root, 'src.json'), { mcpServers: { a: { command: 'a' } } })
    const before = readFileSync(target, 'utf8')
    expect(() => migrateMcpServers({ sources: [src], target })).toThrow()
    expect(readFileSync(target, 'utf8')).toBe(before)
  })

  it('writes a .bak only when overwriting an existing target', () => {
    const src = writeMcp(join(root, 'src.json'), { mcpServers: { a: { command: 'a' } } })
    const target = join(root, 'target.json')
    migrateMcpServers({ sources: [src], target })
    expect(existsSync(target + '.bak')).toBe(false)
    const src2 = writeMcp(join(root, 'src2.json'), { mcpServers: { b: { command: 'b' } } })
    migrateMcpServers({ sources: [src2], target })
    expect(existsSync(target + '.bak')).toBe(true)
    expect(JSON.parse(readFileSync(target + '.bak', 'utf8')).mcpServers.a).toEqual({ command: 'a' })
  })

  it('is a no-write no-backup when nothing needs adding', () => {
    const target = writeMcp(join(root, 'target.json'), {
      mcpServers: { a: { command: 'a' } },
    })
    const before = readFileSync(target, 'utf8')
    const src = writeMcp(join(root, 'src.json'), { mcpServers: { a: { command: 'a' } } })
    const result = migrateMcpServers({ sources: [src], target })
    expect(result.wrote).toBe(false)
    expect(result.backup).toBeUndefined()
    expect(result.added).toEqual([])
    expect(readFileSync(target, 'utf8')).toBe(before)
  })

  it('round-trips raw ${VAR} entries byte-identically', () => {
    const src = writeMcp(join(root, 'src.json'), {
      mcpServers: { raw: { command: 'run', args: ['${PORT:-1}', '$$'], env: { K: '${TOKEN}' } } },
    })
    const target = join(root, 'nested', 'target.json')
    migrateMcpServers({ sources: [src], target })
    expect(JSON.parse(readFileSync(target, 'utf8')).mcpServers.raw)
      .toEqual({ command: 'run', args: ['${PORT:-1}', '$$'], env: { K: '${TOKEN}' } })
  })
})
