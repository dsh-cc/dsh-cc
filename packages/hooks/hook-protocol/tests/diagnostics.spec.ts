import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hookDiagnosticsWriter, readHookDiagnostics, type HookIssue } from '@dsh-cc/hook-protocol'

const dirs: string[] = []

function tmpPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hook-diag-'))
  dirs.push(dir)
  return join(dir, name)
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function issue(over: Partial<HookIssue> = {}): HookIssue {
  return { ts: '2026-09-03T10:00:00Z', dialect: 'claude-code', point: 'PreToolUse', kind: 'timeout', detail: 'timed out after 600000 ms', ...over }
}

describe('hookDiagnosticsWriter', () => {
  it('appends one JSON line per issue (readable back in order)', () => {
    const path = tmpPath('diagnostics.jsonl')
    const write = hookDiagnosticsWriter(path)
    write(issue({ kind: 'timeout' }))
    write(issue({ kind: 'exit-code', point: 'Stop', detail: 'exit 1: boom', handlerId: 'h1' }))
    expect(readHookDiagnostics(path, 10)).toEqual([
      issue({ kind: 'timeout' }),
      issue({ kind: 'exit-code', point: 'Stop', detail: 'exit 1: boom', handlerId: 'h1' }),
    ])
  })

  it('caps detail at 500 characters', () => {
    const path = tmpPath('diagnostics.jsonl')
    hookDiagnosticsWriter(path)(issue({ detail: 'x'.repeat(900) }))
    const [first] = readHookDiagnostics(path, 1)
    expect(first?.detail).toHaveLength(500)
  })

  it('compacts the file (keeps the last 100 valid lines + the new entry) once it would exceed 256 KB', () => {
    const path = tmpPath('diagnostics.jsonl')
    // Prefill 104 valid lines of ~2.5 KB each (~263 KB, already over the cap):
    // the writer's next append must compact instead of growing further.
    const fat = (id: string): string => JSON.stringify(issue({ detail: 'y'.repeat(2400), handlerId: id })) + '\n'
    writeFileSync(path, Array.from({ length: 104 }, (_, i) => fat(`h${i}`)).join(''))
    hookDiagnosticsWriter(path)(issue({ kind: 'config', handlerId: 'h200' }))
    const kept = readHookDiagnostics(path, 1000)
    expect(kept.length).toBe(101) // 100 kept + the newest entry
    expect(kept[0]?.handlerId).toBe('h4')
    expect(kept.at(-1)?.handlerId).toBe('h200')
    // And the writer keeps working after compaction.
    hookDiagnosticsWriter(path)(issue({ kind: 'config', handlerId: 'h201' }))
    expect(readHookDiagnostics(path, 1000).at(-1)?.handlerId).toBe('h201')
  })

  it('creates a missing parent directory best-effort', () => {
    const path = join(tmpPath('fresh'), 'hooks', 'diagnostics.jsonl')
    hookDiagnosticsWriter(path)(issue())
    expect(readHookDiagnostics(path, 5)).toEqual([issue()])
  })

  it('never throws: a detail that is fine + a path that cannot be written is swallowed', () => {
    // A FILE where a parent directory would be needed makes the path genuinely
    // unwritable (mkdir AND append both fail) — every error is swallowed and
    // nothing is readable back.
    const blocked = tmpPath('nope')
    writeFileSync(blocked, 'a file, not a directory')
    const path = join(blocked, 'missing-dir', 'diagnostics.jsonl')
    expect(() => hookDiagnosticsWriter(path)(issue())).not.toThrow()
    expect(readHookDiagnostics(path, 5)).toEqual([])
  })
})

describe('readHookDiagnostics', () => {
  it('returns [] for a missing file', () => {
    expect(readHookDiagnostics(join(tmpdir(), 'definitely-not-here.jsonl'), 10)).toEqual([])
  })

  it('returns the last `limit` valid entries; malformed lines are skipped', () => {
    const path = tmpPath('diagnostics.jsonl')
    const valid = [issue({ handlerId: 'a' }), issue({ handlerId: 'b' }), issue({ handlerId: 'c' })]
    writeFileSync(path, [
      'not json at all',
      JSON.stringify(valid[0]),
      '{"ts":"2026-09-03","truncated torn line…',
      JSON.stringify(valid[1]),
      JSON.stringify(valid[2]),
      '',
    ].join('\n'))
    expect(readHookDiagnostics(path, 2)).toEqual([valid[1], valid[2]])
    expect(readHookDiagnostics(path, 10)).toEqual(valid)
    expect(readHookDiagnostics(path, 1)).toEqual([valid[2]])
  })

  it('the raw file keeps one compact JSON object per line', () => {
    const path = tmpPath('diagnostics.jsonl')
    hookDiagnosticsWriter(path)(issue())
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toEqual(issue())
  })
})
