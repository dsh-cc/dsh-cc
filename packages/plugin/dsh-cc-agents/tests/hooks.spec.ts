/**
 * Behavioral specs for the serena gate wrappers (design:
 * docs/plans/2026-09-22-serena-hooks-agents-plugin.md). Every case is
 * hermetic: a stub `serena-hooks` executable lives on a tmp PATH, so whether
 * the real binary is installed has no effect on the suite. The stub records
 * what it received (stdin, SERENA_HOME, argv) into marker files; absence of
 * the marker dir after a run proves the gate vetoed the spawn.
 *
 * Assertions follow the shunt idiom: node spawnSync against the wrapper
 * scripts, expecting status 0 in EVERY scenario (exit-0 discipline — a hook
 * must never break a tool call).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const HOOKS_DIR = join(dirname(import.meta.dirname), 'hooks')
const STUB_STDOUT = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"stubbed"}}'

let base: string
let stubBin: string

interface RunResult {
  status: number | null
  stdout: string
  markerDir: string
}

function writeStub(): void {
  mkdirSync(stubBin, { recursive: true })
  // Records stdin/SERENA_HOME/argv under $SERENA_STUB_MARKER_DIR, then echoes
  // $SERENA_STUB_STDOUT. Posix-only by design (matches the plugin hooks'
  // own shell assumption).
  writeFileSync(
    join(stubBin, 'serena-hooks'),
    [
      '#!/bin/sh',
      '# The sandboxed PATH handed to the wrapper is stub-only; external',
      '# commands (mkdir/cat) must be found via a sane in-script PATH.',
      'PATH=/bin:/usr/bin; export PATH',
      'mkdir -p "$SERENA_STUB_MARKER_DIR"',
      'cat > "$SERENA_STUB_MARKER_DIR/stdin.json"',
      'printf %s "$SERENA_HOME" > "$SERENA_STUB_MARKER_DIR/serena_home"',
      'printf %s "$*" > "$SERENA_STUB_MARKER_DIR/argv"',
      'printf %s "$SERENA_STUB_STDOUT"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
}

function runHook(
  script: 'serena-remind.mjs' | 'serena-session-cleanup.mjs',
  opts: { cwd: string; payload?: Record<string, unknown>; withStub: boolean; env?: Record<string, string>; unsetEnv?: string[] },
): RunResult {
  const markerDir = join(mkdtempSync(join(base, 'marker-')), 'm')
  const env: Record<string, string> = {
    ...process.env,
    PATH: opts.withStub ? stubBin : join(base, 'empty-path'),
    SERENA_STUB_MARKER_DIR: markerDir,
    SERENA_STUB_STDOUT: STUB_STDOUT,
    CLAUDE_PROJECT_DIR: opts.cwd,
    ...opts.env,
  }
  delete env.SERENA_HOME // the wrapper must be the only source of it
  for (const key of opts.unsetEnv ?? []) delete env[key]
  // Absolute node path: the child's PATH is deliberately minimal (stub or
  // empty), and spawnSync resolves the command through the env option.
  const res = spawnSync(process.execPath, [join(HOOKS_DIR, script)], {
    input: JSON.stringify(opts.payload ?? { hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: {}, cwd: opts.cwd }),
    encoding: 'utf8',
    env,
  })
  expect(res.error, `hook spawn error: ${res.error}`).toBeUndefined()
  return { status: res.status, stdout: res.stdout ?? '', markerDir }
}

/** projectRoot gets `.serena/project.yml`; subdirs listed in `mkdirs`. */
function makeProject(rel: string, mkdirs: string[] = []): string {
  const root = join(base, rel)
  mkdirSync(join(root, '.serena'), { recursive: true })
  writeFileSync(join(root, '.serena', 'project.yml'), 'project_name: "test"\n')
  for (const sub of mkdirs) mkdirSync(join(root, sub), { recursive: true })
  return root
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'dsh-cc-agents-hooks-'))
  mkdirSync(join(base, 'empty-path'), { recursive: true })
  stubBin = join(base, 'stub-bin')
  writeStub()
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('serena-remind.mjs', () => {
  it('no .serena/project.yml anywhere up the walk → silent pass, no spawn', () => {
    const plain = join(base, 'plain-repo')
    mkdirSync(plain, { recursive: true })
    const r = runHook('serena-remind.mjs', { cwd: plain, withStub: true })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(existsSync(r.markerDir)).toBe(false)
  })

  it('git toplevel without serena stops the walk (ancestor .serena is NOT picked up)', () => {
    // Ancestor above the git root adopts serena; the repo itself has not.
    const ancestor = makeProject('ancestor-with-serena', ['repo/src'])
    const repoRoot = join(ancestor, 'repo')
    mkdirSync(join(repoRoot, '.git'), { recursive: true })
    const r = runHook('serena-remind.mjs', { cwd: join(repoRoot, 'src'), withStub: true })
    expect(r.status).toBe(0)
    expect(existsSync(r.markerDir)).toBe(false)
  })

  it('serena project but binary not on PATH → silent pass, no spawn', () => {
    const root = makeProject('no-binary')
    const r = runHook('serena-remind.mjs', { cwd: root, withStub: false })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(existsSync(r.markerDir)).toBe(false)
  })

  it('project + stub binary → payload proxied, stdout relayed, SERENA_HOME pinned to the project', () => {
    const root = makeProject('happy')
    const payload = { session_id: 's-1', hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'x' }, cwd: root }
    const r = runHook('serena-remind.mjs', { cwd: root, payload, withStub: true })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe(STUB_STDOUT) // relayed verbatim for the bridge to decode
    expect(readFileSync(join(r.markerDir, 'stdin.json'), 'utf8')).toBe(JSON.stringify(payload))
    expect(readFileSync(join(r.markerDir, 'serena_home'), 'utf8')).toBe(join(root, '.serena'))
    expect(readFileSync(join(r.markerDir, 'argv'), 'utf8')).toBe('remind --client claude-code')
  })

  it('launch two levels below the project root resolves the root via the walk', () => {
    const root = makeProject('nested', ['a/b'])
    const r = runHook('serena-remind.mjs', { cwd: join(root, 'a', 'b'), withStub: true })
    expect(r.status).toBe(0)
    expect(readFileSync(join(r.markerDir, 'serena_home'), 'utf8')).toBe(join(root, '.serena'))
  })

  it('CLAUDE_PROJECT_DIR absent → payload cwd is the fallback start dir', () => {
    const root = makeProject('payload-fallback')
    const r = runHook('serena-remind.mjs', { cwd: root, withStub: true, unsetEnv: ['CLAUDE_PROJECT_DIR'] })
    expect(r.status).toBe(0)
    expect(readFileSync(join(r.markerDir, 'serena_home'), 'utf8')).toBe(join(root, '.serena'))
  })
})

describe('serena-session-cleanup.mjs', () => {
  it('project + stub binary → runs the cleanup subcommand with the same env pin', () => {
    const root = makeProject('cleanup-happy')
    const r = runHook('serena-session-cleanup.mjs', {
      cwd: root,
      payload: { session_id: 's-9', hook_event_name: 'SessionEnd', reason: 'other', cwd: root },
      withStub: true,
    })
    expect(r.status).toBe(0)
    expect(readFileSync(join(r.markerDir, 'argv'), 'utf8')).toBe('cleanup --client claude-code')
    expect(readFileSync(join(r.markerDir, 'serena_home'), 'utf8')).toBe(join(root, '.serena'))
  })

  it('non-serena project → silent pass, no spawn', () => {
    const plain = join(base, 'cleanup-plain')
    mkdirSync(plain, { recursive: true })
    const r = runHook('serena-session-cleanup.mjs', { cwd: plain, withStub: true })
    expect(r.status).toBe(0)
    expect(existsSync(r.markerDir)).toBe(false)
  })
})
