import { describe, expect, it } from 'vitest'
import type { ToolExecutionResult } from '@dsh-cc/tools'
import { classify } from '../src/classes.ts'

const NOT_FOUND = 'The file /proj/a.ts has not been read yet. old_string was not found in it.'

/** Success-branch result with a structured value. */
function ok(value: unknown, text = ''): ToolExecutionResult {
  return { isError: false, value, content: [{ type: 'text', text }] } as unknown as ToolExecutionResult
}

/** Failure-branch result. */
function fail(text: string, info?: { code: string }): ToolExecutionResult {
  return { isError: true, error: { message: text, ...info ? { info } : {} }, content: [{ type: 'text', text }] } as unknown as ToolExecutionResult
}

describe('bash-timeout', () => {
  it('promoted success value', () => {
    expect(classify('bash', { command: 'pnpm build' }, ok({ kind: 'promoted' })))
      .toMatchObject({ class: 'bash-timeout' })
  })

  it('foreground timedOut:true value', () => {
    expect(classify('bash', { command: 'make' }, ok({ kind: 'foreground', timedOut: true, exitCode: null })))
      .toMatchObject({ class: 'bash-timeout' })
  })

  it('persistent-bash string result with marker (type-guard exercised: value is a string)', () => {
    expect(classify('bash', { command: 'make' }, ok('done\njob [still running after 30s]', 'job [still running after 30s]')))
      .toMatchObject({ class: 'bash-timeout' })
  })

  it('pwsh marker text on failure branch', () => {
    expect(classify('pwsh', { command: 'make' }, fail('[Command timed out or OOM] something')))
      .toMatchObject({ class: 'bash-timeout' })
  })

  it('marker "[timed out after" on text', () => {
    expect(classify('bash', { command: 'make' }, fail('bash: [timed out after 60000ms]')))
      .toMatchObject({ class: 'bash-timeout' })
  })
})

describe('bash-sandbox-denied', () => {
  it('success value sandbox.denied === true', () => {
    expect(classify('bash', { command: 'ls' }, ok({ kind: 'foreground', exitCode: 1, sandbox: { denied: true } })))
      .toMatchObject({ class: 'bash-sandbox-denied' })
  })

  it('marker text "[sandbox: file access denied"', () => {
    expect(classify('pwsh', { command: 'ls' }, fail('[sandbox: file access denied under workspace-write mode]')))
      .toMatchObject({ class: 'bash-sandbox-denied' })
  })

  it('marker "[sandbox: the sandbox runner itself failed"', () => {
    expect(classify('bash', { command: 'ls' }, fail('[sandbox: the sandbox runner itself failed]')))
      .toMatchObject({ class: 'bash-sandbox-denied' })
  })
})

describe('git-mutation', () => {
  it('foreground numeric exitCode !== 0 (git commit)', () => {
    expect(classify('bash', { command: 'git commit -m x' }, ok({ kind: 'foreground', exitCode: 128 })))
      .toMatchObject({ class: 'git-mutation' })
  })

  it('isError branch', () => {
    expect(classify('bash', { command: 'git push' }, fail('Error: push rejected')))
      .toMatchObject({ class: 'git-mutation' })
  })

  it('exitCode null does NOT match (timeout shapes stay bash-timeout — precedence)', () => {
    expect(classify('bash', { command: 'git commit -m x' }, ok({ kind: 'foreground', timedOut: true, exitCode: null })))
      .toMatchObject({ class: 'bash-timeout' })
  })

  it('non-mutating git subcommand → no class', () => {
    expect(classify('bash', { command: 'git status' }, fail('Error: x'))).toBeUndefined()
  })

  it('assignments before the command are stripped', () => {
    expect(classify('bash', { command: 'FOO=1 BAR=2 git commit -m x' }, fail('Error: x')))
      .toMatchObject({ class: 'git-mutation' })
  })
})

describe('pkg-install', () => {
  it('foreground numeric exitCode !== 0 (pnpm install)', () => {
    expect(classify('bash', { command: 'pnpm install' }, ok({ kind: 'foreground', exitCode: 1 })))
      .toMatchObject({ class: 'pkg-install' })
  })

  it('exitCode null does NOT match pkg-install', () => {
    expect(classify('bash', { command: 'npm add lodash' }, ok({ kind: 'foreground', timedOut: true, exitCode: null })))
      .toMatchObject({ class: 'bash-timeout' })
  })

  it('unrelated first token → no class', () => {
    expect(classify('bash', { command: 'cargo install foo' }, fail('Error: x'))).toBeUndefined()
  })
})

describe('mcp-mutation', () => {
  it('mcp__ tool with isError', () => {
    expect(classify('mcp__server__write_file', {}, fail('Error: boom')))
      .toMatchObject({ class: 'mcp-mutation' })
  })

  it('mcp__ success → no class', () => {
    expect(classify('mcp__server__read_file', {}, ok({}))).toBeUndefined()
  })
})

describe('write-partial', () => {
  it('multi-line old_string not-found (isRecoveryCandidate) → excluded', () => {
    expect(classify('edit', { old_string: 'a\nb', file_path: '/p/a.ts' }, fail(NOT_FOUND))).toBeUndefined()
  })

  it('single-line not-found text → excluded (union anchor)', () => {
    expect(classify('edit', { old_string: 'a', file_path: '/p/a.ts' }, fail(NOT_FOUND))).toBeUndefined()
  })

  it('FS_AMBIGUOUS_EDIT code → excluded', () => {
    expect(classify('edit', { old_string: 'a' }, fail('multiple matches', { code: 'FS_AMBIGUOUS_EDIT' }))).toBeUndefined()
  })

  it('FS_STALE_VERSION code → excluded', () => {
    expect(classify('edit', { old_string: 'a' }, fail('stale', { code: 'FS_STALE_VERSION' }))).toBeUndefined()
  })

  it('ordinary write failure (EACCES, no code) → NOT excluded', () => {
    expect(classify('write', { file_path: '/p/a.ts', content: 'x' }, fail('Error: EACCES: permission denied')))
      .toMatchObject({ class: 'write-partial' })
  })

  it('clean success → no class', () => {
    expect(classify('edit', { old_string: 'a', new_string: 'b' }, ok({}))).toBeUndefined()
  })
})

describe('clean outcomes', () => {
  it('clean bash success → no class', () => {
    expect(classify('bash', { command: 'ls' }, ok({ kind: 'foreground', exitCode: 0 }))).toBeUndefined()
  })

  it('non-object persistent-bash string value without markers → no class', () => {
    expect(classify('bash', { command: 'echo done' }, ok('done'))).toBeUndefined()
  })
})
