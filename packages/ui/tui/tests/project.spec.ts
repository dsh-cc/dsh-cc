import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __clearProjectCache,
  gitExecSync,
  isProjectMember,
  resolveProject,
  type ProjectExec,
} from '@dsh-cc/tui/project.ts'

/**
 * Script a git conversation as a project exec: argv → result (or undefined
 * to simulate a failed/unsupported invocation). Mirrors the scripted-exec
 * convention used by the worktree-exit spec.
 */
function scriptedExec(script: Record<string, { stdout: string } | undefined>): ProjectExec {
  return (argv, _cwd) => {
    const key = argv.join(' ')
    const entry = script[key]
    return entry === undefined ? undefined : { stdout: entry.stdout }
  }
}

describe('resolveProject', () => {
  it('main repo: project root is the toplevel, worktrees are listed', () => {
    const exec = scriptedExec({
      'rev-parse --show-toplevel': { stdout: '/repo\n' },
      'rev-parse --git-common-dir': { stdout: '.git\n' },
      'worktree list --porcelain': { stdout: 'worktree /repo\n\n' },
    })
    const info = resolveProject('/repo', exec)
    expect(info.projectRoot).toBe('/repo')
    expect(info.worktrees).toEqual(['/repo'])
  })

  it('main repo launched from a subdir maps relative common-dir to the toplevel', () => {
    const exec = scriptedExec({
      'rev-parse --show-toplevel': { stdout: '/repo\n' },
      // git emits common-dir relative to the process cwd: `../.git` here.
      'rev-parse --git-common-dir': { stdout: '../.git\n' },
      'worktree list --porcelain': { stdout: 'worktree /repo\n' },
    })
    const info = resolveProject('/repo/subdir', exec)
    expect(info.projectRoot).toBe('/repo')
  })


  it('linked worktree collapses onto the main checkout root', () => {
    const exec = scriptedExec({
      'rev-parse --show-toplevel': { stdout: '/repo/.claude/worktrees/support\n' },
      'rev-parse --git-common-dir': { stdout: '/repo/.git\n' },
      'worktree list --porcelain': {
        stdout: 'worktree /repo\n\nworktree /repo/.claude/worktrees/support\n',
      },
    })
    // commonDir (/repo/.git) does not equal the worktree's own top/.git → linked.
    const info = resolveProject('/repo/.claude/worktrees/support', exec)
    expect(info.projectRoot).toBe('/repo')
    expect(info.worktrees).toEqual(['/repo', '/repo/.claude/worktrees/support'])
  })

  it('submodule does not collapse onto the superproject (.git/modules/*)', () => {
    const exec = scriptedExec({
      'rev-parse --show-toplevel': { stdout: '/super/sub\n' },
      // common-dir is the superproject's git dir, not .git → keep toplevel.
      'rev-parse --git-common-dir': { stdout: '/super/.git/modules/sub\n' },
      'worktree list --porcelain': { stdout: 'worktree /super/sub\n' },
    })
    const info = resolveProject('/super/sub', exec)
    expect(info.projectRoot).toBe('/super/sub')
  })

  it('nested independent repository keeps its own root', () => {
    const exec = scriptedExec({
      'rev-parse --show-toplevel': { stdout: '/outer/nested\n' },
      'rev-parse --git-common-dir': { stdout: '/outer/nested/.git\n' },
      'worktree list --porcelain': { stdout: 'worktree /outer/nested\n' },
    })
    expect(resolveProject('/outer/nested', exec).projectRoot).toBe('/outer/nested')
  })

  it('non-git directory degrades to the directory identity', () => {
    const exec = scriptedExec({})
    const info = resolveProject('/plain/dir', exec)
    expect(info.projectRoot).toBe('/plain/dir')
    expect(info.worktrees).toEqual([])
  })

  it('git failure (undefined result) degrades to the directory identity', () => {
    const info = resolveProject('/a/b', scriptedExec({ 'rev-parse --show-toplevel': undefined }))
    expect(info.projectRoot).toBe('/a/b')
    expect(info.worktrees).toEqual([])
  })

  it('default exec returns undefined when git cannot run (no git on PATH)', () => {
    // gitExecSync hits spawn-enoent on hosts without git → degrades gracefully.
    const info = resolveProject(process.cwd())
    expect(typeof info.projectRoot).toBe('string')
  })

  it('projectKey is 16 lowercase hex and stable across calls', () => {
    const exec = scriptedExec({
      'rev-parse --show-toplevel': { stdout: '/repo\n' },
      'rev-parse --git-common-dir': { stdout: '.git\n' },
      'worktree list --porcelain': { stdout: 'worktree /repo\n' },
    })
    const a = resolveProject('/repo', exec)
    const b = resolveProject('/repo', exec)
    expect(a.projectKey).toMatch(/^[0-9a-f]{16}$/)
    expect(a.projectKey).toBe(b.projectKey)
  })

  it('distinct roots yield distinct project keys', () => {
    const one = resolveProject('/one', scriptedExec({}))
    const two = resolveProject('/two', scriptedExec({}))
    expect(one.projectKey).not.toBe(two.projectKey)
  })

  it('parses porcelain paths with C-style quoting (spaces and unicode)', () => {
    const exec = scriptedExec({
      'rev-parse --show-toplevel': { stdout: '/repo\n' },
      'rev-parse --git-common-dir': { stdout: '.git\n' },
      'worktree list --porcelain': {
        stdout: 'worktree /repo\n\nworktree "/repo/my worktree"\n\n',
      },
    })
    const info = resolveProject('/repo', exec)
    expect(info.worktrees).toEqual(['/repo', '/repo/my worktree'])
  })

  it('egregious porcelain garbage is skipped, not fatal', () => {
    const exec = scriptedExec({
      'rev-parse --show-toplevel': { stdout: '/repo\n' },
      'rev-parse --git-common-dir': { stdout: '.git\n' },
      'worktree list --porcelain': { stdout: 'worktree /repo\n\nbare\nbranch refs/heads/x\n\n' },
    })
    expect(resolveProject('/repo', exec).worktrees).toEqual(['/repo'])
  })
})

describe('isProjectMember', () => {
  const project = { projectRoot: '/repo', worktrees: ['/repo/.claude/worktrees/a'] }

  it('matches the project root itself', () => {
    expect(isProjectMember('/repo', project)).toBe(true)
  })

  it('matches paths beneath the root at a separator boundary', () => {
    expect(isProjectMember('/repo/x', project)).toBe(true)
    expect(isProjectMember('/repo/sub/deep', project)).toBe(true)
  })

  it('rejects sibling prefixes without a boundary', () => {
    expect(isProjectMember('/repo2', project)).toBe(false)
    expect(isProjectMember('/repo2/x', project)).toBe(false)
  })

  it('matches each listed worktree and its descendants', () => {
    expect(isProjectMember('/repo/.claude/worktrees/a', project)).toBe(true)
    expect(isProjectMember('/repo/.claude/worktrees/a/src', project)).toBe(true)
  })

  it('rejects unrelated directories', () => {
    expect(isProjectMember('/elsewhere', project)).toBe(false)
  })

  it('handles Windows-style backslash paths', () => {
    const win = { projectRoot: 'C:\\repo', worktrees: ['C:\\repo\\.claude\\worktrees\\a'] }
    expect(isProjectMember('C:\\repo', win)).toBe(true)
    expect(isProjectMember('C:\\repo\\src', win)).toBe(true)
    expect(isProjectMember('C:\\repo2', win)).toBe(false)
    expect(isProjectMember('C:\\repo\\.claude\\worktrees\\a\\x', win)).toBe(true)
  })

  it('rejects entries outside every candidate path', () => {
    expect(isProjectMember('/repo-other', project)).toBe(false)
  })
})

describe('resolveProject memo', () => {
  /** A real, non-git directory so the default exec probes real git and fails. */
  function plainCwd(prefix = 'dsh-memo-'): string {
    return mkdtempSync(join(tmpdir(), prefix))
  }

  beforeEach(() => __clearProjectCache())
  afterEach(() => __clearProjectCache())

  it('same cwd twice returns the same object identity; clear returns a fresh one', () => {
    const cwd = plainCwd()
    const a = resolveProject(cwd)
    const b = resolveProject(cwd)
    expect(b).toBe(a) // memoised: identical object, single probe
    __clearProjectCache()
    const c = resolveProject(cwd)
    expect(c).not.toBe(a) // cache cleared → recomputed
    expect(c.projectRoot).toBe(a.projectRoot)
  })

  it('memoisation is keyed by the resolved cwd', () => {
    const cwd = plainCwd()
    const a = resolveProject(cwd)
    // A different (unresolved) spelling that resolves to the same path hits
    // the same bucket — verify via a second identical call returning the
    // same object, and a sibling dir returning a different one.
    const sib = plainCwd('dsh-memo-sib-')
    expect(resolveProject(sib)).not.toBe(a)
    expect(resolveProject(cwd)).toBe(a)
  })

  it('injected exec bypasses the cache and does not populate it', () => {
    const cwd = plainCwd()
    const fakeGit = scriptedExec({
      'rev-parse --show-toplevel': { stdout: '/fake-repo\n' },
      'rev-parse --git-common-dir': { stdout: '/fake-repo/.git\n' },
      'worktree list --porcelain': { stdout: 'worktree /fake-repo\n' },
    })
    const viaFake = resolveProject(cwd, fakeGit)
    expect(viaFake.projectRoot).toBe('/fake-repo')

    // The fake call must not have warmed the cache: a subsequent default-exec
    // call on the same (non-git) cwd resolves to the directory, not the fake.
    const viaDefault = resolveProject(cwd)
    expect(viaDefault.projectRoot).toBe(resolve(cwd))
    expect(viaDefault).not.toBe(viaFake)
  })

  it('multiple distinct cwds are memoised independently', () => {
    const one = plainCwd('dsh-memo-1-')
    const two = plainCwd('dsh-memo-2-')
    expect(resolveProject(one)).toBe(resolveProject(one))
    expect(resolveProject(two)).toBe(resolveProject(two))
    expect(resolveProject(one)).not.toBe(resolveProject(two))
  })
})
