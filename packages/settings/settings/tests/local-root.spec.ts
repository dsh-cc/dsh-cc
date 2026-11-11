import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { __clearLocalRootCache, resolveLocalSettingsDir, type LocalRootDeps } from '../src/cascade/local-root.ts'

afterEach(() => {
  __clearLocalRootCache()
})

const cleanups: string[] = []
afterEach(() => {
  while (cleanups.length > 0) rmSync(cleanups.pop()!, { recursive: true, force: true })
})

/** Real non-git temp dir (for cases that compare against realpathed cwd). */
function tempReal(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-local-root-'))
  cleanups.push(dir)
  return realpathSync(dir)
}

/** realpath-or-resolve, mirroring the implementation's canonical() helper. */
function canon(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

/** Scripted exec: maps `argv.join(' ')` to stdout; unmatched probes fail. */
function scriptExec(map: Record<string, string | undefined>) {
  const exec: LocalRootDeps['exec'] = argv => {
    const stdout = map[argv.join(' ')]
    return stdout === undefined ? undefined : { stdout }
  }
  return exec
}

/**
 * Base deps for scripted repos whose directories do not exist on disk:
 * a permissive stat (owner uid 0) unless the test overrides it.
 */
function depsWith(exec: LocalRootDeps['exec'], extra: LocalRootDeps = {}): LocalRootDeps {
  return { exec, getuid: () => 0, stat: () => ({ uid: 0 }), ...extra }
}

describe('resolveLocalSettingsDir', () => {
  it('returns the git toplevel when cwd is a subdirectory', () => {
    const exec = scriptExec({
      'rev-parse --show-toplevel': '/repo',
      'rev-parse --git-common-dir': '/repo/.git',
    })
    const got = resolveLocalSettingsDir('/repo/packages/pkg', depsWith(exec))
    expect(canon(got)).toBe(canon(resolve('/repo')))
  })

  it('hoists to the main checkout for a linked worktree', () => {
    const exec = scriptExec({
      'rev-parse --show-toplevel': '/repo/.claude/worktrees/feat',
      'rev-parse --git-common-dir': '/repo/.git',
    })
    expect(canon(resolveLocalSettingsDir('/repo/.claude/worktrees/feat', depsWith(exec)))).toBe(
      canon(resolve('/repo')),
    )
  })

  it('handles a relative commonDir ".git"', () => {
    const exec = scriptExec({
      'rev-parse --show-toplevel': '/repo',
      'rev-parse --git-common-dir': '.git',
    })
    expect(canon(resolveLocalSettingsDir('/repo', depsWith(exec)))).toBe(canon(resolve('/repo')))
  })

  it('resolves a commonDir relative to cwd deeper than the toplevel', () => {
    const exec = scriptExec({
      'rev-parse --show-toplevel': '/repo',
      'rev-parse --git-common-dir': '../.git',
    })
    expect(canon(resolveLocalSettingsDir('/repo/sub', depsWith(exec)))).toBe(canon(resolve('/repo')))
  })

  it('does not collapse a submodule onto its superproject', () => {
    const exec = scriptExec({
      'rev-parse --show-toplevel': '/super/sub',
      'rev-parse --git-common-dir': '/super/.git/modules/sub',
    })
    expect(canon(resolveLocalSettingsDir('/super/sub', depsWith(exec)))).toBe(canon(resolve('/super/sub')))
  })

  it('falls back to cwd on git failure', () => {
    const exec = scriptExec({})
    expect(resolveLocalSettingsDir('/repo/sub', { exec })).toBe(resolve('/repo/sub'))
  })

  it('falls back to cwd on empty stdout', () => {
    const exec = scriptExec({
      'rev-parse --show-toplevel': '',
      'rev-parse --git-common-dir': '/repo/.git',
    })
    expect(resolveLocalSettingsDir('/repo/sub', { exec })).toBe(resolve('/repo/sub'))
  })

  it('never hoists on win32', () => {
    const exec = scriptExec({
      'rev-parse --show-toplevel': '/repo',
      'rev-parse --git-common-dir': '/repo/.git',
    })
    expect(resolveLocalSettingsDir('/repo/sub', depsWith(exec, { platform: 'win32' }))).toBe(resolve('/repo/sub'))
  })

  it('refuses to hoist when mainRoot equals the home directory', () => {
    const exec = scriptExec({
      'rev-parse --show-toplevel': '/home/me/repo',
      'rev-parse --git-common-dir': '/home/me/repo/.git',
    })
    expect(resolveLocalSettingsDir('/home/me/repo', depsWith(exec, { homedir: '/home/me/repo' }))).toBe(
      resolve('/home/me/repo'),
    )
  })

  it('falls back when the uid of mainRoot does not match', () => {
    const exec = scriptExec({
      'rev-parse --show-toplevel': '/repo',
      'rev-parse --git-common-dir': '/repo/.git',
    })
    const deps = depsWith(exec, { getuid: () => 1000 })
    expect(resolveLocalSettingsDir('/repo', deps)).toBe(resolve('/repo'))
  })

  it('falls back fail-closed when stat throws (simulated EACCES)', () => {
    const exec = scriptExec({
      'rev-parse --show-toplevel': '/repo',
      'rev-parse --git-common-dir': '/repo/.git',
    })
    const deps = depsWith(exec, { getuid: () => 1000, stat: () => { throw new Error('EACCES') } })
    expect(resolveLocalSettingsDir('/repo', deps)).toBe(resolve('/repo'))
  })

  it('skips uid comparison when getuid is undefined but still fail-closes on stat throw', () => {
    const exec = scriptExec({
      'rev-parse --show-toplevel': '/repo',
      'rev-parse --git-common-dir': '/repo/.git',
    })
    const deps = depsWith(exec, { getuid: () => undefined, stat: () => { throw new Error('EACCES') } })
    expect(resolveLocalSettingsDir('/repo', deps)).toBe(resolve('/repo'))
  })

  it('refuses a hoist whose mainRoot has no .git (bare / exotic GIT_DIR parent)', () => {
    const exec = scriptExec({
      'rev-parse --show-toplevel': '/x/.worktrees/feat',
      'rev-parse --git-common-dir': '/x/not-a-repo/.git',
    })
    const deps = depsWith(exec, {
      getuid: () => 0,
      stat: path => {
        if (path === join('/x/not-a-repo', '.git')) throw new Error('ENOENT')
        return { uid: 0 }
      },
    })
    expect(resolveLocalSettingsDir('/x/.worktrees/feat', deps)).toBe(resolve('/x/.worktrees/feat'))
  })

  it('still hoists when mainRoot/.claude is missing (optional path)', () => {
    const exec = scriptExec({
      'rev-parse --show-toplevel': '/repo',
      'rev-parse --git-common-dir': '/repo/.git',
    })
    const deps = depsWith(exec, {
      getuid: () => 0,
      stat: path => {
        if (path === join('/repo', '.claude')) throw new Error('ENOENT')
        return { uid: 0 }
      },
    })
    expect(resolveLocalSettingsDir('/repo', deps)).toBe(resolve('/repo'))
  })

  it('does not memoise injected exec results', () => {
    const first = scriptExec({
      'rev-parse --show-toplevel': '/repo',
      'rev-parse --git-common-dir': '/repo/.git',
    })
    expect(canon(resolveLocalSettingsDir('/repo', depsWith(first)))).toBe(canon(resolve('/repo')))
    const second = scriptExec({
      'rev-parse --show-toplevel': '/other',
      'rev-parse --git-common-dir': '/other/.git',
    })
    expect(canon(resolveLocalSettingsDir('/repo', depsWith(second)))).toBe(canon(resolve('/other')))
  })

  it('resolves a bare non-git cwd to itself', () => {
    const dir = tempReal()
    expect(resolveLocalSettingsDir(dir, { exec: () => undefined })).toBe(resolve(dir))
  })
})
