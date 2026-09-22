/**
 * Scanner tests against real tmp dirs and real zstd frames (plan §5): no fs
 * fake — the scanner reads `node:fs` byte streams directly, so the only honest
 * fixture is a real store layout on disk.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { gateWindow, scanSessions } from '../src/session-scan.ts'

const zlibState = vi.hoisted(() => ({ capability: true }))

// Capability seam (case 5): drop `createZstdDecompress` from the namespace the
// scanner sees, while keeping `zstdCompressSync` real for building fixtures.
vi.mock('node:zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:zlib')>()
  return {
    ...actual,
    // Getter: the factory runs once (before the capability flips), so the
    // absent-capability state must be evaluated per import/read.
    get createZstdDecompress() {
      return zlibState.capability ? actual.createZstdDecompress : undefined
    },
    zstdCompressSync: actual.zstdCompressSync,
  }
})

// Case 7 guard: any subprocess spawn attempt fails the suite loudly.
vi.mock('node:child_process', () => {
  throw new Error('session-scan must not spawn child processes')
})

let root: string

afterEach(() => {
  zlibState.capability = true
})

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

async function makeRoot(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'session-scan-'))
  return root
}

/** Seed one session dir with a zstd stream whose first JSONL line is `header`. */
async function seedSession(
  base: string,
  project: string,
  id: string,
  header: Record<string, unknown>,
  file: 'session.v3.jsonl.zstd' | 'session.jsonl.zstd' = 'session.v3.jsonl.zstd',
  trailer = '',
): Promise<string> {
  const { zstdCompressSync } = await import('node:zlib')
  const dir = join(base, project, id)
  await mkdir(dir, { recursive: true })
  const line = `${JSON.stringify({ type: 'session', ...header })}\n${trailer}`
  await writeFile(join(dir, file), zstdCompressSync(Buffer.from(line)))
  return dir
}

const HEADER = { version: 3, id: 'tui-x', createdAt: 1_790_042_832_672, delegationDepth: 0 }

describe('scanSessions', () => {
  it('1. prefers the v3 stream and falls back to the legacy stream', async () => {
    const base = await makeRoot()
    // v3 present: its header wins even though legacy also exists.
    const dirA = await seedSession(base, '--proj--', 'sess-a', { ...HEADER, id: 'from-v3' })
    const { zstdCompressSync } = await import('node:zlib')
    await writeFile(
      join(dirA, 'session.jsonl.zstd'),
      zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', data: { origin: 'subagent' } })}\n`)),
    )
    // v3 absent: legacy stream is read.
    await seedSession(base, '--proj--', 'sess-b', { version: 1, id: 'legacy-1' }, 'session.jsonl.zstd')

    const result = await scanSessions(base)
    expect(result.scanned).toBe(2)
    expect(result.unreadable).toBe(0)
    const ids = result.sessions.map((s) => s.id).sort()
    expect(ids).toEqual(['from-v3', 'legacy-1'])
    // The v3 dir is not flagged sub via the ignored legacy stream.
    expect(result.sessions.find((s) => s.id === 'from-v3')?.sub).toBe(false)
  })

  it('2. parses the pinned header contract defensively', async () => {
    const base = await makeRoot()
    // v3: top-level fields.
    await seedSession(base, '--p--', 'main', { ...HEADER, id: 'main-1', delegationDepth: 0 })
    // v3: delegationDepth > 0 flags sub.
    await seedSession(base, '--p--', 'child', { ...HEADER, id: 'child-1', delegationDepth: 1 })
    // legacy: origin under data flags sub.
    await seedSession(base, '--p--', 'fork', { id: 'fork-1', data: { origin: 'subagent' } }, 'session.jsonl.zstd')
    // missing createdAt falls open to MAX_SAFE_INTEGER (still qualifies in the gate).
    await seedSession(base, '--p--', 'no-ts', { id: 'no-ts-1' })
    // garbage createdAt also falls back.
    await seedSession(base, '--p--', 'bad-ts', { id: 'bad-ts-1', createdAt: 'yesterday' })
    // header without id falls back to the directory name.
    await seedSession(base, '--p--', 'dirid', { createdAt: 5 })

    const result = await scanSessions(base)
    expect(result.scanned).toBe(6)
    expect(result.unreadable).toBe(0)
    const byId = new Map(result.sessions.map((s) => [s.id, s]))
    expect(byId.get('main-1')).toMatchObject({ sub: false, createdAt: 1_790_042_832_672 })
    expect(byId.get('child-1')?.sub).toBe(true)
    expect(byId.get('fork-1')?.sub).toBe(true)
    expect(byId.get('no-ts-1')).toMatchObject({ createdAt: Number.MAX_SAFE_INTEGER, sub: false })
    expect(byId.get('bad-ts-1')?.createdAt).toBe(Number.MAX_SAFE_INTEGER)
    expect(byId.get('dirid')).toMatchObject({ id: 'dirid', createdAt: 5 })

    // Fail-open: MAX_SAFE_INTEGER createdAt still qualifies through gateWindow.
    const window = gateWindow([byId.get('no-ts-1')!], Date.now())
    expect(window.count).toBe(1)
    expect(window.hints).toEqual(['no-ts-1'])
  })

  it('3. enforces read bounds and skips unreadable directories', async () => {
    const base = await makeRoot()
    // Header beyond the 16 KiB decompressed budget → unreadable.
    const { zstdCompressSync: zcs } = await import('node:zlib')
    const lateDir = join(base, '--p--', 'late')
    await mkdir(lateDir, { recursive: true })
    await writeFile(
      join(lateDir, 'session.v3.jsonl.zstd'),
      zcs(Buffer.from(`${'x'.repeat(20_000)}\n${JSON.stringify({ type: 'session', ...HEADER, id: 'late-1' })}\n`)),
    )
    // Corrupt zstd frame → unreadable, never throws.
    await mkdir(join(base, '--p--', 'corrupt'), { recursive: true })
    await writeFile(join(base, '--p--', 'corrupt', 'session.v3.jsonl.zstd'), Buffer.from('not zstd at all'))
    // No stream file at all → unreadable.
    await mkdir(join(base, '--p--', 'empty'), { recursive: true })
    // Compressed stream far larger than the 256 KiB read window, header early → still read.
    const { zstdCompressSync } = await import('node:zlib')
    const bigDir = join(base, '--p--', 'big')
    await mkdir(bigDir, { recursive: true })
    await writeFile(
      join(bigDir, 'session.v3.jsonl.zstd'),
      zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', ...HEADER, id: 'big-1' })}\n${'y'.repeat(600_000)}\n`)),
    )

    const result = await scanSessions(base)
    expect(result.scanned).toBe(4)
    expect(result.unreadable).toBe(3)
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({ id: 'big-1' })
  })

  it('4. missing root yields a zeroed result without throwing', async () => {
    const base = await makeRoot()
    const missing = join(base, 'does', 'not', 'exist')
    await expect(scanSessions(missing)).resolves.toEqual({ sessions: [], scanned: 0, unreadable: 0 })
  })

  it('5. absent zstd capability yields a zeroed result without throwing', async () => {
    const base = await makeRoot()
    await seedSession(base, '--p--', 'sess-1', HEADER)
    zlibState.capability = false
    await expect(scanSessions(base)).resolves.toEqual({ sessions: [], scanned: 0, unreadable: 0 })
  })
})

describe('gateWindow', () => {
  it('6. qualifies !sub && createdAt > lastAt, counts all, caps hints at 50 newest-first', () => {
    const lastAt = 1_000
    const sessions = [
      { id: 'a', createdAt: 2_000, sub: false },
      { id: 'b', createdAt: 3_000, sub: false },
      { id: 'sub', createdAt: 4_000, sub: true },
      { id: 'old', createdAt: 1_000, sub: false }, // not > lastAt
      { id: 'c', createdAt: 5_000, sub: false },
    ]
    const w = gateWindow(sessions, lastAt)
    expect(w.count).toBe(3)
    expect(w.hints).toEqual(['c', 'b', 'a'])

    // 60 qualifying sessions: count is uncapped, hints capped at 50 newest.
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `s${i}`, createdAt: i + 1, sub: false }))
    const big = gateWindow(many, 0)
    expect(big.count).toBe(60)
    expect(big.hints).toHaveLength(50)
    expect(big.hints[0]).toBe('s59')
    expect(big.hints[49]).toBe('s10')
  })

  it('7. never spawns a subprocess (mock throws at import; scanner runs in-process)', async () => {
    const base = await makeRoot()
    await seedSession(base, '--p--', 'sess-1', HEADER)
    // Any exec/spawn dependency would have thrown when node:child_process was mocked above.
    await expect(scanSessions(base)).resolves.toMatchObject({ scanned: 1 })
    // The mocked module must fail on import: the scanner must never touch it.
    await expect(import('node:child_process')).rejects.toThrow()
  })
})
