import { describe, expect, it, vi } from 'vitest'
import {
  WRITEBACK_MAX_FILE_BYTES,
  WRITEBACK_MAX_FILES,
  memoryWritePolicy,
  validateMemoryWrites,
  writeMemoryFiles,
} from '../src/writeback.ts'

/**
 * The write-back is the security boundary that replaced the old prompt
 * contract: the fork's structured payload is untrusted model output, and the
 * plugin must confine it to flat `.md` files inside the memory directory
 * before stamping the per-call write policy.
 */

function fsMock() {
  const backing = new Map<string, string>()
  const writeText = vi.fn(async (target: unknown, content: string) => {
    backing.set(String((target as { targetKey: unknown }).targetKey), content)
    return {}
  })
  return {
    backing,
    writeText,
    async resolve(path: string) { return { targetKey: path, displayPath: path } },
  }
}

describe('memoryWritePolicy', () => {
  it('stays confined, rooted at the memory directory', () => {
    expect(memoryWritePolicy('/mem')).toEqual({ mode: 'workspace-write', workspaceRoot: '/mem' })
  })
})

describe('validateMemoryWrites', () => {
  it('accepts an empty batch (the no-durable-fact path)', () => {
    expect(validateMemoryWrites({ writes: [] })).toEqual([])
  })

  it('accepts MEMORY.md and flat topic names', () => {
    const writes = validateMemoryWrites({
      writes: [
        { path: 'MEMORY.md', content: '- [a.md](a.md)' },
        { path: 'user-profile.md', content: 'body' },
        { path: 'project.x_v2.md', content: 'body' },
      ],
    })
    expect(writes.map(w => w.path)).toEqual(['MEMORY.md', 'user-profile.md', 'project.x_v2.md'])
  })

  it('rejects non-object and non-array payloads', () => {
    expect(() => validateMemoryWrites(undefined)).toThrow(/"writes" array/)
    expect(() => validateMemoryWrites(null)).toThrow(/"writes" array/)
    expect(() => validateMemoryWrites([])).toThrow(/"writes" array/)
    expect(() => validateMemoryWrites({})).toThrow(/"writes" array/)
    expect(() => validateMemoryWrites({ writes: 'x' })).toThrow(/"writes" array/)
  })

  it('rejects path escapes, separators, dotfiles, and non-.md names', () => {
    for (const path of ['../evil.md', 'a/b.md', '/abs.md', '.hidden.md', 'notes.txt', '..md', '']) {
      expect(() => validateMemoryWrites({ writes: [{ path, content: 'x' }] }), path)
        .toThrow(/invalid memory filename/)
    }
  })

  it('rejects malformed entries and duplicate names', () => {
    expect(() => validateMemoryWrites({ writes: [{ path: 'a.md' }] })).toThrow(/path\/content strings/)
    expect(() => validateMemoryWrites({ writes: [{ path: 1, content: 'x' }] })).toThrow(/path\/content strings/)
    expect(() => validateMemoryWrites({ writes: ['a.md'] })).toThrow(/path\/content strings/)
    expect(() => validateMemoryWrites({
      writes: [{ path: 'a.md', content: '1' }, { path: 'a.md', content: '2' }],
    })).toThrow(/duplicate memory filename/)
  })

  it('enforces the file-count, per-file, and total caps', () => {
    const many = Array.from({ length: WRITEBACK_MAX_FILES + 1 }, (_, i) => ({ path: `t${i}.md`, content: 'x' }))
    expect(() => validateMemoryWrites({ writes: many })).toThrow(/over the .* cap/)

    expect(() => validateMemoryWrites({
      writes: [{ path: 'big.md', content: 'x'.repeat(WRITEBACK_MAX_FILE_BYTES + 1) }],
    })).toThrow(/over the .* cap/)

    // Five 60 KiB files each pass the per-file cap but exceed the total cap.
    const sixtyKib = 'x'.repeat(60 * 1024)
    expect(() => validateMemoryWrites({
      writes: ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'].map(path => ({ path, content: sixtyKib })),
    })).toThrow(/over the .* cap/)
  })

  it('accepts MEMORY.md at exactly 200 lines and exactly 25 000 bytes', () => {
    const index = (lines: number) =>
      Array.from({ length: lines }, (_, i) => `- [a](a.md) — entry ${i}`).join('\n')
    expect(() => validateMemoryWrites({
      writes: [{ path: 'MEMORY.md', content: index(200) }],
    })).not.toThrow()
    expect(() => validateMemoryWrites({
      writes: [{ path: 'MEMORY.md', content: 'x'.repeat(25_000) }],
    })).not.toThrow()
  })

  it('accepts 200 entries with a trailing newline (trim-then-count semantics)', () => {
    const index = `${Array.from({ length: 200 }, (_, i) => `- [a](a.md) — entry ${i}`).join('\n')}\n`
    expect(() => validateMemoryWrites({
      writes: [{ path: 'MEMORY.md', content: index }],
    })).not.toThrow()
  })

  it('rejects a 201-line MEMORY.md with the remediation message', () => {
    const index = Array.from({ length: 201 }, (_, i) => `- [a](a.md) — entry ${i}`).join('\n')
    expect(() => validateMemoryWrites({
      writes: [{ path: 'MEMORY.md', content: index }],
    })).toThrow(/under 140 lines/)
    try {
      validateMemoryWrites({ writes: [{ path: 'MEMORY.md', content: index }] })
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain('one line per entry')
      expect(message).toContain('move detail into topic files')
      expect(message).toContain('merge or drop stale entries')
      expect(message).toContain('overwrite an existing memory (same name)')
      expect(message).toContain("scope 'workspace'")
    }
  })

  it('rejects an over-25 000-byte MEMORY.md even within the line cap', () => {
    expect(() => validateMemoryWrites({
      writes: [{ path: 'MEMORY.md', content: 'x'.repeat(25_001) }],
    })).toThrow()
  })

  it('counts UTF-8 bytes, not UTF-16 code units (CJK)', () => {
    // 9 000 CJK chars = 9 000 code units but 27 000 bytes, one line.
    expect(() => validateMemoryWrites({
      writes: [{ path: 'MEMORY.md', content: '你'.repeat(9_000) }],
    })).toThrow()
    expect(() => validateMemoryWrites({
      writes: [{ path: 'MEMORY.md', content: '你'.repeat(8_000) }],
    })).not.toThrow()
  })

  it('does not gate a non-entrypoint .md write', () => {
    const index = Array.from({ length: 201 }, (_, i) => `- [a](a.md) — entry ${i}`).join('\n')
    expect(() => validateMemoryWrites({
      writes: [{ path: 'notes.md', content: index }],
    })).not.toThrow()
  })

  it('fail-opens when allowOverLimitEntrypoint is set (pre-existing over-limit index)', () => {
    const index = Array.from({ length: 300 }, (_, i) => `- [a](a.md) — entry ${i}`).join('\n')
    const writes = validateMemoryWrites(
      { writes: [{ path: 'MEMORY.md', content: index }] },
      { allowOverLimitEntrypoint: true },
    )
    expect(writes).toHaveLength(1)
  })
})

describe('writeMemoryFiles', () => {
  it('writes each file under the memory dir with the confined per-call policy', async () => {
    const fs = fsMock()
    const written = await writeMemoryFiles(fs as never, '/mem', [
      { path: 'MEMORY.md', content: 'index' },
      { path: 'a.md', content: 'body' },
    ])
    expect(written).toEqual(['MEMORY.md', 'a.md'])
    expect(fs.backing.get('/mem/MEMORY.md')).toBe('index')
    expect(fs.backing.get('/mem/a.md')).toBe('body')
    for (const call of fs.writeText.mock.calls) {
      expect(call[4]).toEqual({ mode: 'workspace-write', workspaceRoot: '/mem' })
    }
  })

  it('writes sequentially, leaving a deterministic prefix on failure', async () => {
    const fs = fsMock()
    fs.writeText.mockImplementationOnce(async () => { throw new Error('io') })
    await expect(writeMemoryFiles(fs as never, '/mem', [
      { path: 'a.md', content: '1' },
      { path: 'b.md', content: '2' },
    ])).rejects.toThrow('io')
    expect(fs.backing.size).toBe(0)
  })
})
