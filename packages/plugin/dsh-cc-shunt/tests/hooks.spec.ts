/**
 * Behavioral specs for the dsh-cc-shunt PreToolUse gates, transcribed from
 * the upstream shunt evals (/tmp/portal-ai-plugins/plugins/shunt/evals/
 * hook-evals.json and bash-hook-evals.json) plus dsh-cc-specific cases
 * (byte fallback, SHUNT_MAX_BYTES override, SHUNT_DISABLED kill switch).
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const HOOKS_DIR = join(dirname(import.meta.dirname), 'hooks')

let dir: string

function fixture(name: string, lines: number, trailingNewline = true): string {
  const path = join(dir, name)
  if (lines === 0) {
    writeFileSync(path, '')
  } else {
    const body = `${Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n')}${trailingNewline ? '\n' : ''}`
    writeFileSync(path, body)
  }
  return path
}

function runHook(script: string, toolInput: unknown, env: Record<string, string> = {}): {
  decision?: string
  reason?: string
} {
  const res = spawnSyncJson(script, JSON.stringify({ tool_input: toolInput }), env)
  return JSON.parse(res)
}

function spawnSyncJson(script: string, stdin: string, env: Record<string, string>): string {
  const res = spawnSync('node', [join(HOOKS_DIR, script)], {
    input: stdin,
    encoding: 'utf8',
    cwd: dir,
    env: { ...process.env, ...env },
  })
  expect(res.error, `hook spawn error: ${res.error}`).toBeUndefined()
  expect(res.status, `hook exited ${res.status}, stderr: ${res.stderr}`).toBe(0)
  return res.stdout
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-cc-shunt-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('check-file-size.mjs (upstream hook-evals.json transcription)', () => {
  it('allows a small file (100 lines)', () => {
    expect(runHook('check-file-size.mjs', { file_path: fixture('small.txt', 100) }).decision).toBe('allow')
  })

  it('allows a file exactly at the 350-line threshold', () => {
    expect(runHook('check-file-size.mjs', { file_path: fixture('boundary.txt', 350) }).decision).toBe('allow')
  })

  it('blocks one line over the threshold (351 lines)', () => {
    const out = runHook('check-file-size.mjs', { file_path: fixture('over.txt', 351) })
    expect(out.decision).toBe('block')
    expect(out.reason).toContain('bulk-reader')
  })

  it('blocks a large file (1200 lines)', () => {
    const out = runHook('check-file-size.mjs', { file_path: fixture('large.txt', 1200) })
    expect(out.decision).toBe('block')
  })

  it('blocks a very large file (5000 lines)', () => {
    expect(runHook('check-file-size.mjs', { file_path: fixture('huge.txt', 5000) }).decision).toBe('block')
  })

  it('allows an empty file', () => {
    expect(runHook('check-file-size.mjs', { file_path: fixture('empty.txt', 0) }).decision).toBe('allow')
  })

  it('allows a targeted read with offset set', () => {
    expect(
      runHook('check-file-size.mjs', { file_path: fixture('large-offset.txt', 1200), offset: 100 }).decision,
    ).toBe('allow')
  })

  it('allows a targeted read with limit set', () => {
    expect(
      runHook('check-file-size.mjs', { file_path: fixture('large-limit.txt', 1200), limit: 50 }).decision,
    ).toBe('allow')
  })

  it('allows a targeted read with both offset and limit', () => {
    expect(
      runHook('check-file-size.mjs', { file_path: fixture('large-both.txt', 1200), offset: 100, limit: 50 })
        .decision,
    ).toBe('allow')
  })

  it('allows a nonexistent file', () => {
    expect(runHook('check-file-size.mjs', { file_path: '/tmp/dsh-cc-shunt-does-not-exist.txt' }).decision).toBe('allow')
  })

  it('allows an empty file_path', () => {
    expect(runHook('check-file-size.mjs', { file_path: '' }).decision).toBe('allow')
  })

  it('allows a missing file_path field', () => {
    expect(runHook('check-file-size.mjs', {}).decision).toBe('allow')
  })

  it('treats offset: 0 as targeted (documented upstream bypass)', () => {
    expect(
      runHook('check-file-size.mjs', { file_path: fixture('large-off0.txt', 1200), offset: 0 }).decision,
    ).toBe('allow')
  })

  it('treats limit: 0 as targeted (documented upstream bypass)', () => {
    expect(
      runHook('check-file-size.mjs', { file_path: fixture('large-lim0.txt', 1200), limit: 0 }).decision,
    ).toBe('allow')
  })

  it('SHUNT_MIN_LINES=200 blocks a 250-line file', () => {
    expect(
      runHook('check-file-size.mjs', { file_path: fixture('medium.txt', 250) }, { SHUNT_MIN_LINES: '200' })
        .decision,
    ).toBe('block')
  })

  it('SHUNT_MIN_LINES=500 allows a 351-line file', () => {
    expect(
      runHook('check-file-size.mjs', { file_path: fixture('over2.txt', 351) }, { SHUNT_MIN_LINES: '500' })
        .decision,
    ).toBe('allow')
  })

  it('non-numeric SHUNT_MIN_LINES falls back to 350', () => {
    expect(
      runHook('check-file-size.mjs', { file_path: fixture('over3.txt', 351) }, { SHUNT_MIN_LINES: 'abc' })
        .decision,
    ).toBe('block')
  })
})

describe('check-file-size.mjs (dsh-cc additions)', () => {
  it('offset/limit set allows even a 600-line file', () => {
    expect(
      runHook('check-file-size.mjs', { file_path: fixture('six-hundred.txt', 600), offset: 10, limit: 20 })
        .decision,
    ).toBe('allow')
  })

  it('byte fallback blocks a small-line-count file over SHUNT_MAX_BYTES', () => {
    const path = join(dir, 'one-liner.txt')
    writeFileSync(path, `${'x'.repeat(150 * 1024)}\n`)
    const out = runHook('check-file-size.mjs', { file_path: path })
    expect(out.decision).toBe('block')
    expect(out.reason).toContain('bulk-reader')
  })

  it('SHUNT_MAX_BYTES override re-allows the same file', () => {
    const path = join(dir, 'one-liner.txt')
    writeFileSync(path, `${'x'.repeat(150 * 1024)}\n`)
    expect(runHook('check-file-size.mjs', { file_path: path }, { SHUNT_MAX_BYTES: '200000' }).decision).toBe('allow')
  })

  it('SHUNT_DISABLED=1 allows everything', () => {
    const path = fixture('big-disabled.txt', 5000)
    expect(runHook('check-file-size.mjs', { file_path: path }, { SHUNT_DISABLED: '1' }).decision).toBe('allow')
    expect(
      runHook('check-file-size.mjs', { file_path: path, offset: 1 }, { SHUNT_DISABLED: 'yes' }).decision,
    ).toBe('allow')
  })

  it('a 400-line file with no trailing newline is counted as 400 lines and blocked', () => {
    // wc -l counting: 400 lines joined by '\n' = 399 newline chars.
    const path = join(dir, 'no-trailing.txt')
    writeFileSync(path, `${Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join('\n')}`)
    const out = runHook('check-file-size.mjs', { file_path: path })
    expect(out.decision).toBe('block')
    expect(out.reason).toMatch(/399 lines/)
  })
})

describe('check-bash-read.mjs (upstream bash-hook-evals.json transcription)', () => {
  it('blocks plain cat of a large file, reason mentioning the skill', () => {
    const out = runHook('check-bash-read.mjs', { command: `cat ${fixture('b-large.txt', 800)}` })
    expect(out.decision).toBe('block')
    expect(out.reason).toContain('bulk-reader')
  })

  it('allows cat of a small file', () => {
    expect(runHook('check-bash-read.mjs', { command: `cat ${fixture('b-small.txt', 100)}` }).decision).toBe('allow')
  })

  it('blocks cat -n of a large file', () => {
    expect(runHook('check-bash-read.mjs', { command: `cat -n ${fixture('b-large.txt', 800)}` }).decision).toBe('block')
  })

  it('blocks head of a large file', () => {
    expect(runHook('check-bash-read.mjs', { command: `head ${fixture('b-large.txt', 800)}` }).decision).toBe('block')
  })

  it('blocks head -100 — flags are stripped, file size decides', () => {
    expect(runHook('check-bash-read.mjs', { command: `head -100 ${fixture('b-large.txt', 800)}` }).decision).toBe(
      'block',
    )
  })

  it('blocks tail of a large file', () => {
    expect(runHook('check-bash-read.mjs', { command: `tail ${fixture('b-large.txt', 800)}` }).decision).toBe('block')
  })

  it('blocks less of a large file', () => {
    expect(runHook('check-bash-read.mjs', { command: `less ${fixture('b-large.txt', 800)}` }).decision).toBe('block')
  })

  it('allows piped cat (targeted read)', () => {
    expect(
      runHook('check-bash-read.mjs', { command: `cat ${fixture('b-large.txt', 800)} | grep export` }).decision,
    ).toBe('allow')
  })

  it('allows redirected cat', () => {
    expect(
      runHook('check-bash-read.mjs', { command: `cat ${fixture('b-large.txt', 800)} > /tmp/out.txt` }).decision,
    ).toBe('allow')
  })

  it('allows a non-read command', () => {
    expect(runHook('check-bash-read.mjs', { command: 'git status' }).decision).toBe('allow')
  })

  it('allows grep (targeted search)', () => {
    expect(runHook('check-bash-read.mjs', { command: `grep -n 'export' ${fixture('b-large.txt', 800)}` }).decision).toBe(
      'allow',
    )
  })

  it('blocks cat with a quoted path', () => {
    expect(runHook('check-bash-read.mjs', { command: `cat "${fixture('b-large.txt', 800)}"` }).decision).toBe('block')
  })

  it('allows cat of a nonexistent file', () => {
    expect(runHook('check-bash-read.mjs', { command: 'cat /tmp/dsh-cc-shunt-does-not-exist.txt' }).decision).toBe(
      'allow',
    )
  })

  it('allows an empty command', () => {
    expect(runHook('check-bash-read.mjs', { command: '' }).decision).toBe('allow')
  })

  it('allows a missing command field', () => {
    expect(runHook('check-bash-read.mjs', {}).decision).toBe('allow')
  })

  it('blocks more on a large file', () => {
    expect(runHook('check-bash-read.mjs', { command: `more ${fixture('b-large.txt', 800)}` }).decision).toBe('block')
  })

  it('upstream parser quirk preserved: head -n 5 on a large file is ALLOWED', () => {
    // Upstream eval asserts allow: `-n` is stripped as a flag, `5` becomes the
    // "file path", which does not exist — so the hook passes through.
    expect(runHook('check-bash-read.mjs', { command: `head -n 5 ${fixture('b-large.txt', 800)}` }).decision).toBe(
      'allow',
    )
  })

  it('SHUNT_DISABLED=1 allows cat of a large file', () => {
    expect(
      runHook('check-bash-read.mjs', { command: `cat ${fixture('b-large.txt', 800)}` }, { SHUNT_DISABLED: '1' })
        .decision,
    ).toBe('allow')
  })

  it('resolves relative paths against the hook cwd', () => {
    fixture('rel.txt', 800)
    expect(runHook('check-bash-read.mjs', { command: 'cat rel.txt' }).decision).toBe('block')
  })
})
