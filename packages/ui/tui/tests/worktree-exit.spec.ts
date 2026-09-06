import { describe, expect, it, vi } from 'vitest'
import {
  detectWorktreeSession,
  gatherEvidence,
  ownsBranch,
  removeWorktree,
  WORKTREE_ENV,
  type WorktreeExec,
  type WorktreeExitSession,
} from '@dsh-cc/tui/harness/worktree-exit.ts'

/**
 * Scripted git conversation. `map[key]` keys are `argv.join(' ')` and values
 * are either a result or a thrown Error for the failure cases.
 */
function scriptedExec(map: Record<string, { stdout: string; stderr: string } | Error>): WorktreeExec {
  return vi.fn(async (argv) => {
    const key = argv.join(' ')
    const entry = map[key]
    if (entry instanceof Error) throw entry
    if (entry === undefined) throw new Error(`unexpected git call: ${key}`)
    return entry
  })
}

const rootTopAbbrev = 'main' // abbrev-ref of the main checkout

describe('detectWorktreeSession (env marker)', () => {
  it('returns a managed session when the marker path matches cwd', async () => {
    const cwd = '/repo/.claude/worktrees/feat'
    const exec = scriptedExec({})
    const session = await detectWorktreeSession(cwd, {
      [WORKTREE_ENV]: JSON.stringify({
        repoRoot: '/repo',
        worktreePath: '/repo/.claude/worktrees/feat',
        branch: 'worktree-feat',
        baseHead: 'abc123',
      }),
    }, exec)
    expect(session).toEqual({
      kind: 'managed',
      repoRoot: '/repo',
      worktreePath: '/repo/.claude/worktrees/feat',
      branch: 'worktree-feat',
      baseHead: 'abc123',
    })
    // Managed detection must NOT touch git.
    expect(exec).not.toHaveBeenCalled()
  })

  it('ignores a marker whose path does not match cwd (inherited env), falling through to probe', async () => {
    const cwd = '/other/repo'
    const exec = scriptedExec({
      'rev-parse --show-toplevel': { stdout: '/other/repo\n', stderr: '' },
      'rev-parse --path-format=absolute --git-common-dir': { stdout: '/other/repo/.git\n', stderr: '' },
    })
    const session = await detectWorktreeSession(cwd, {
      [WORKTREE_ENV]: JSON.stringify({
        repoRoot: '/repo',
        worktreePath: '/repo/.claude/worktrees/feat',
        branch: 'worktree-feat',
      }),
    }, exec)
    expect(session).toBeUndefined()
  })

  it('treats a malformed marker as absent and falls through to probe', async () => {
    const cwd = '/repo'
    const exec = scriptedExec({
      'rev-parse --show-toplevel': { stdout: '/repo\n', stderr: '' },
      'rev-parse --path-format=absolute --git-common-dir': { stdout: '/repo/.git\n', stderr: '' },
    })
    const session = await detectWorktreeSession(cwd, { [WORKTREE_ENV]: 'not json:::{{' }, exec)
    expect(session).toBeUndefined()
  })
})

describe('detectWorktreeSession (git probe)', () => {
  it('detects a convention worktree under <mainRoot>/.claude/worktrees/', async () => {
    const cwd = '/repo/.claude/worktrees/support'
    const exec = scriptedExec({
      'rev-parse --show-toplevel': { stdout: '/repo/.claude/worktrees/support\n', stderr: '' },
      'rev-parse --path-format=absolute --git-common-dir': { stdout: '/repo/.git\n', stderr: '' },
      'rev-parse --abbrev-ref HEAD': { stdout: 'worktree-support\n', stderr: '' },
    })
    const session = await detectWorktreeSession(cwd, {}, exec)
    expect(session).toEqual({
      kind: 'detected',
      repoRoot: '/repo',
      worktreePath: '/repo/.claude/worktrees/support',
      branch: 'worktree-support',
    })
  })

  it('returns undefined when top-level equals the main root (not a worktree)', async () => {
    const cwd = '/repo'
    const exec = scriptedExec({
      'rev-parse --show-toplevel': { stdout: '/repo\n', stderr: '' },
      'rev-parse --path-format=absolute --git-common-dir': { stdout: '/repo/.git\n', stderr: '' },
    })
    expect(await detectWorktreeSession(cwd, {}, exec)).toBeUndefined()
    // Should not have branched to a HEAD probe for the main checkout.
    expect(exec).not.toHaveBeenCalledWith(['rev-parse', '--abbrev-ref', 'HEAD'], '/repo')
  })

  it('returns undefined for a worktree outside the .claude/worktrees convention dir', async () => {
    const cwd = '/repo/other-wt'
    const exec = scriptedExec({
      'rev-parse --show-toplevel': { stdout: '/repo/other-wt\n', stderr: '' },
      'rev-parse --path-format=absolute --git-common-dir': { stdout: '/repo/.git\n', stderr: '' },
    })
    expect(await detectWorktreeSession(cwd, {}, exec)).toBeUndefined()
  })

  it('returns undefined when the common dir is non-standard (not ending in .git)', async () => {
    const cwd = '/repo/.claude/worktrees/support'
    const exec = scriptedExec({
      'rev-parse --show-toplevel': { stdout: '/repo/.claude/worktrees/support\n', stderr: '' },
      'rev-parse --path-format=absolute --git-common-dir': { stdout: '/repo/custom-git\n', stderr: '' },
    })
    expect(await detectWorktreeSession(cwd, {}, exec)).toBeUndefined()
  })

  it('returns undefined when git is unavailable (non-repo)', async () => {
    const exec = scriptedExec({
      'rev-parse --show-toplevel': new Error('fatal: not a git repository'),
    })
    expect(await detectWorktreeSession('/nowhere', {}, exec)).toBeUndefined()
  })

  it('returns undefined when the worktree HEAD probe fails', async () => {
    const cwd = '/repo/.claude/worktrees/support'
    const exec = scriptedExec({
      'rev-parse --show-toplevel': { stdout: '/repo/.claude/worktrees/support\n', stderr: '' },
      'rev-parse --path-format=absolute --git-common-dir': { stdout: '/repo/.git\n', stderr: '' },
      'rev-parse --abbrev-ref HEAD': new Error('detached head?'),
    })
    expect(await detectWorktreeSession(cwd, {}, exec)).toBeUndefined()
  })
})

describe('ownsBranch', () => {
  it('always concedes the branch of a managed session', () => {
    expect(ownsBranch(mkSession('managed', 'worktree-feat'))).toBe(true)
    expect(ownsBranch(mkSession('managed', 'user/special'))).toBe(true)
  })

  it('only concedes detected sessions whose branch follows the worktree- prefix', () => {
    expect(ownsBranch(mkSession('detected', 'worktree-feat'))).toBe(true)
    expect(ownsBranch(mkSession('detected', 'my-own-branch'))).toBe(false)
  })

  function mkSession(kind: 'managed' | 'detected', branch: string): WorktreeExitSession {
    return { kind, repoRoot: '/repo', worktreePath: '/repo/.claude/worktrees/x', branch }
  }
})

describe('gatherEvidence', () => {
  const base: WorktreeExitSession = {
    kind: 'managed',
    repoRoot: '/repo',
    worktreePath: '/repo/.claude/worktrees/feat',
    branch: 'worktree-feat',
    baseHead: 'abc123',
  }

  it('counts porcelain lines and commits ahead', async () => {
    const exec = scriptedExec({
      'status --porcelain': { stdout: ' M file.ts\n?? new.ts\n', stderr: '' },
      'rev-list --count abc123..HEAD': { stdout: '3\n', stderr: '' },
    })
    expect(await gatherEvidence(base, exec)).toEqual({ dirtyFiles: 2, commitsAhead: 3 })
  })

  it('reports an empty worktree as zero dirty files', async () => {
    const exec = scriptedExec({
      'status --porcelain': { stdout: '', stderr: '' },
      'rev-list --count abc123..HEAD': { stdout: '0\n', stderr: '' },
    })
    expect(await gatherEvidence(base, exec)).toEqual({ dirtyFiles: 0, commitsAhead: 0 })
  })

  it('skips commits-ahead when there is no baseHead', async () => {
    const exec = scriptedExec({ 'status --porcelain': { stdout: ' M a\n', stderr: '' } })
    const session: WorktreeExitSession = { kind: 'detected', repoRoot: '/repo', worktreePath: '/wt', branch: 'worktree-x' }
    expect(await gatherEvidence(session, exec)).toEqual({ dirtyFiles: 1, commitsAhead: undefined })
  })

  it('degrades each dimension to undefined on exec failure', async () => {
    const exec = scriptedExec({
      'status --porcelain': new Error('boom'),
      'rev-list --count abc123..HEAD': new Error('boom'),
    })
    expect(await gatherEvidence(base, exec)).toEqual({ dirtyFiles: undefined, commitsAhead: undefined })
  })
})

describe('removeWorktree', () => {
  const managed: WorktreeExitSession = {
    kind: 'managed',
    repoRoot: '/repo',
    worktreePath: '/repo/.claude/worktrees/feat',
    branch: 'worktree-feat',
  }

  it('chdirs to repo root, removes the worktree, then deletes the owned branch', async () => {
    const seen: string[] = []
    const chdir = vi.fn((dir: string) => { seen.push(dir) })
    const exec = scriptedExec({
      'worktree remove --force /repo/.claude/worktrees/feat': { stdout: '', stderr: '' },
      'branch -D worktree-feat': { stdout: '', stderr: '' },
    })
    const outcome = await removeWorktree(managed, exec, chdir)
    expect(outcome).toEqual({ branchDeleted: true })
    expect(seen).toEqual(['/repo'])
    const calls = (exec as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0] as string[])
    expect(calls).toEqual([
      ['worktree', 'remove', '--force', '/repo/.claude/worktrees/feat'],
      ['branch', '-D', 'worktree-feat'],
    ])
    // Both git calls run from the repo root.
    for (const c of (exec as ReturnType<typeof vi.fn>).mock.calls) expect(c[1]).toBe('/repo')
  })

  it('does not delete a detected session branch outside the worktree- prefix', async () => {
    const session: WorktreeExitSession = {
      kind: 'detected',
      repoRoot: '/repo',
      worktreePath: '/repo/.claude/worktrees/feat',
      branch: 'user/special',
    }
    const exec = scriptedExec({
      'worktree remove --force /repo/.claude/worktrees/feat': { stdout: '', stderr: '' },
    })
    const outcome = await removeWorktree(session, exec, vi.fn())
    expect(outcome).toEqual({ branchDeleted: false })
    expect(exec).not.toHaveBeenCalledWith(['branch', '-D', 'user/special'], '/repo')
  })

  it('throws on worktree-remove failure and never attempts the branch delete', async () => {
    const exec = scriptedExec({
      'worktree remove --force /repo/.claude/worktrees/feat': new Error('not empty'),
    })
    await expect(removeWorktree(managed, exec, vi.fn())).rejects.toThrow('not empty')
    expect(exec).not.toHaveBeenCalledWith(['branch', '-D', 'worktree-feat'], '/repo')
  })

  it('reports a failed branch delete without throwing', async () => {
    const exec = scriptedExec({
      'worktree remove --force /repo/.claude/worktrees/feat': { stdout: '', stderr: '' },
      'branch -D worktree-feat': new Error('branch pushed'),
    })
    const outcome = await removeWorktree(managed, exec, vi.fn())
    expect(outcome).toEqual({ branchDeleted: false })
  })
})
