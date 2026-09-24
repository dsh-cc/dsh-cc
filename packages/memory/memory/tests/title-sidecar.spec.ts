import { mkdtempSync, mkdirSync, existsSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readTitleSidecar, titleSidecarPath, writeTitleSidecar } from '../src/title-sidecar.ts'

let tempRoots: string[] = []

function tempSessionsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'title-sidecar-'))
  tempRoots.push(root)
  return root
}

afterEach(() => {
  tempRoots = []
})

const CWD = '/Users/bytedance/workspace/github.com/dsh-cc'
const ID = 'session-1'

/** Create the session dir with one session-log file carrying the given mtime. */
function seedSession(root: string, cwd: string, id: string, opts: { file?: string; mtime?: Date; absent?: boolean } = {}): string {
  const dir = join(root, `--${cwd.slice(1).replace(/[/:\\]/g, '-')}--`, id)
  mkdirSync(dir, { recursive: true })
  if (!opts.absent) {
    const file = join(dir, opts.file ?? 'session.v3.jsonl.zstd')
    writeFileSync(file, 'frame')
    if (opts.mtime) utimesSync(file, opts.mtime, opts.mtime)
  }
  return dir
}

describe('titleSidecarPath', () => {
  it('derives the harness on-disk `--<slug>--` grouping byte-exactly', () => {
    const path = titleSidecarPath(CWD, 'session-1', { sessionsRoot: '/tmp/sessions' })
    expect(path).toBe('/tmp/sessions/--Users-bytedance-workspace-github.com-dsh-cc--/session-1/title.txt')
  })
})

describe('writeTitleSidecar / readTitleSidecar', () => {
  it('round-trips a written title', () => {
    const root = tempSessionsRoot()
    writeTitleSidecar(CWD, 'session-1', 'Refactor the parser', { sessionsRoot: root })
    expect(readTitleSidecar(CWD, 'session-1', { sessionsRoot: root })).toBe('Refactor the parser')
  })

  it('truncates to 200 code points without splitting a surrogate pair', () => {
    const root = tempSessionsRoot()
    // 200 code points, the last one a two-code-unit surrogate pair.
    const title = 'a'.repeat(199) + '😀'
    writeTitleSidecar(CWD, 'session-1', title + 'trailing', { sessionsRoot: root })
    const stored = readTitleSidecar(CWD, 'session-1', { sessionsRoot: root })!
    expect([...stored]).toHaveLength(200)
    expect([...stored][199]).toBe('😀')
    // The written file is exactly the 200 code points, never half a pair.
    const raw = readFileSync(titleSidecarPath(CWD, 'session-1', { sessionsRoot: root }), 'utf8')
    expect([...raw]).toHaveLength(200)
    expect(raw).toBe(title)
  })

  it('returns undefined for a stale sidecar (older than the session log)', () => {
    const root = tempSessionsRoot()
    const old = new Date(Date.now() - 10_000)
    const fresh = new Date()
    writeTitleSidecar(CWD, 'stale', 'Old title', { sessionsRoot: root })
    utimesSync(titleSidecarPath(CWD, 'stale', { sessionsRoot: root }), old, old)
    seedSession(root, CWD, 'stale', { mtime: fresh })
    expect(readTitleSidecar(CWD, 'stale', { sessionsRoot: root })).toBeUndefined()
  })

  it('counts the sidecar fresh when the session log is missing', () => {
    const root = tempSessionsRoot()
    seedSession(root, CWD, 'no-log', { absent: true })
    writeTitleSidecar(CWD, 'no-log', 'Orphan title', { sessionsRoot: root })
    expect(readTitleSidecar(CWD, 'no-log', { sessionsRoot: root })).toBe('Orphan title')
  })

  it('falls back to session.jsonl.zstd for the freshness comparison', () => {
    const root = tempSessionsRoot()
    seedSession(root, CWD, 'v1', { file: 'session.jsonl.zstd' })
    writeTitleSidecar(CWD, 'v1', 'V1 title', { sessionsRoot: root })
    expect(readTitleSidecar(CWD, 'v1', { sessionsRoot: root })).toBe('V1 title')
  })

  it('returns undefined for an empty sidecar', () => {
    const root = tempSessionsRoot()
    const dir = seedSession(root, CWD, 'empty-sidecar', { absent: true })
    writeFileSync(join(dir, 'title.txt'), '')
    expect(readTitleSidecar(CWD, 'empty-sidecar', { sessionsRoot: root })).toBeUndefined()
  })

  it('returns undefined for a corrupt (invalid UTF-8) sidecar', () => {
    const root = tempSessionsRoot()
    const dir = seedSession(root, CWD, 'corrupt')
    writeFileSync(join(dir, 'title.txt'), Buffer.from([0x80, 0x81, 0x82, 0x00]))
    expect(readTitleSidecar(CWD, 'corrupt', { sessionsRoot: root })).toBeUndefined()
  })

  it('returns undefined when nothing exists, without throwing', () => {
    const root = tempSessionsRoot()
    expect(existsSync(root)).toBe(true)
    expect(readTitleSidecar(CWD, 'missing', { sessionsRoot: root })).toBeUndefined()
  })

  it('writes never throw on an unwritable target', () => {
    const root = tempSessionsRoot()
    // A file where the project directory would be: mkdir fails, still no throw.
    writeFileSync(join(root, '--Users-bytedance-workspace-github.com-dsh-cc--'), '')
    expect(() => writeTitleSidecar(CWD, 'blocked', 'nope', { sessionsRoot: root })).not.toThrow()
  })
})

describe('sidecar mtime tie', () => {
  it('accepts an equal mtime (sidecar newer-or-equal wins)', () => {
    const root = tempSessionsRoot()
    const at = new Date(1_700_000_000_000)
    const dir = seedSession(root, CWD, 'tie', { mtime: at })
    writeTitleSidecar(CWD, 'tie', 'Same mtime', { sessionsRoot: root })
    utimesSync(join(dir, 'title.txt'), at, at)
    expect(readTitleSidecar(CWD, 'tie', { sessionsRoot: root })).toBe('Same mtime')
    expect(statSync(join(dir, 'title.txt')).mtimeMs).toBe(at.getTime())
  })
})
