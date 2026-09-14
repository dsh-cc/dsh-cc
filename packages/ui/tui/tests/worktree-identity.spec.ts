import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { worktreeIdentityVerdict } from '@dsh-cc/tui/harness/worktree-identity.ts'
import { warnIfResumedCwdMissing } from '@dsh-cc/tui/harness/resumed-cwd-guard.ts'

let root: string
let launch: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wt-identity-'))
  launch = join(root, 'main')
  mkdirSync(launch)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Build a convention worktree with a `.git` pointer file. */
function makeWorktree(name: string, gitdir: string, options: { symlink?: string } = {}): string {
  const dir = join(root, '.claude', 'worktrees', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.git'), `gitdir: ${gitdir}\n`)
  if (options.symlink !== undefined) {
    rmSync(dir, { recursive: true })
    symlinkSync(options.symlink, dir)
  }
  return dir
}

describe('worktreeIdentityVerdict', () => {
  it('missing directory → missing', () => {
    expect(worktreeIdentityVerdict(join(root, 'gone'), launch)).toEqual({ kind: 'missing' })
  })

  it('existing non-convention cwd → ok (plain existence check only)', () => {
    expect(worktreeIdentityVerdict(launch, launch)).toEqual({ kind: 'ok' })
  })

  it('valid managed worktree pointing into the same repo → ok', () => {
    const dir = makeWorktree('feat', join(root, '.git', 'worktrees', 'feat'))
    expect(worktreeIdentityVerdict(dir, launch)).toEqual({ kind: 'ok' })
  })

  it('plain clone shape (directory .git) → refused', () => {
    const dir = join(root, '.claude', 'worktrees', 'clone')
    mkdirSync(join(dir, '.git'), { recursive: true })
    expect(worktreeIdentityVerdict(dir, launch)?.kind).toBe('refused')
  })

  it('core.worktree redirect (commondir into main .git) → refused', () => {
    const dir = join(root, '.claude', 'worktrees', 'redirect')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.git'), 'gitdir: .git\n') // resolves to <dir>/.git, not a registration
    expect(worktreeIdentityVerdict(dir, launch)?.kind).toBe('refused')
  })

  it('unreadable .git pointer → unverified (fail-open)', () => {
    const dir = makeWorktree('locked', join(root, '.git', 'worktrees', 'locked'))
    chmodSync(dir, 0o000)
    try {
      expect(worktreeIdentityVerdict(dir, launch)).toEqual({ kind: 'unverified' })
    } finally {
      chmodSync(dir, 0o755)
    }
  })

  it('network-path spelling (/net mount) → refused', () => {
    expect(worktreeIdentityVerdict('/net/repo/.claude/worktrees/feat', launch)?.kind).toBe('refused')
    expect(worktreeIdentityVerdict('//net/repo/.claude/worktrees/feat', launch)?.kind).toBe('refused')
  })

  it('worktree containing the launch directory → refused', () => {
    const dir = makeWorktree('anc', join(root, '.git', 'worktrees', 'anc'))
    const inside = join(dir, 'sub')
    mkdirSync(inside)
    expect(worktreeIdentityVerdict(dir, inside)?.kind).toBe('refused')
  })

  it('symlinked worktree path → refused', () => {
    const real = makeWorktree('real', join(root, '.git', 'worktrees', 'real'))
    const link = join(root, '.claude', 'worktrees', 'link')
    symlinkSync(real, link)
    expect(worktreeIdentityVerdict(link, launch)?.kind).toBe('refused')
  })

  it('infrastructure error (garbage cwd) → unverified, never throws', () => {
    expect(worktreeIdentityVerdict('\0bad', launch).kind).toBe('unverified')
  })
})

describe('warnIfResumedCwdMissing (unified guard)', () => {
  /** Minimal agent stub: empty event fold → liveSessionCwd falls back to header cwd. */
  function fakeAgentWithCwd(cwd: string): Agent {
    return { session: { snapshotEvents: () => [], header: { cwd } } } as unknown as Agent
  }

  function collect(cwd: string, launchCwd = launch): string[] {
    const notices: string[] = []
    warnIfResumedCwdMissing(fakeAgentWithCwd(cwd), launchCwd, (m) => notices.push(m))
    return notices
  }

  it('ok cwd → no notice', () => {
    const dir = makeWorktree('feat', join(root, '.git', 'worktrees', 'feat'))
    expect(collect(dir)).toEqual([])
    expect(collect(launch)).toEqual([])
  })

  it('missing dir → the plain missing-directory notice', () => {
    expect(collect(join(root, 'gone'))[0]).toContain('已不存在')
  })

  it('refusal → Refusing-to-use notice naming the cwd', () => {
    const dir = makeWorktree('anc', join(root, '.git', 'worktrees', 'anc'))
    const inside = join(dir, 'sub')
    mkdirSync(inside)
    const notice = collect(dir, inside)[0]
    expect(notice).toContain('已拒绝进入原 worktree')
    expect(notice).toContain(dir)
  })

  it('unverified → could-not-verify notice with the retry hint', () => {
    // Mirror the verdict-level test: an unreadable worktree dir degrades to
    // `unverified` (fail-open), which the guard surfaces with the retry hint.
    const dir = makeWorktree('locked', join(root, '.git', 'worktrees', 'locked'))
    chmodSync(dir, 0o000)
    try {
      const notice = collect(dir)[0]
      expect(notice).toContain('暂时无法验证')
      expect(notice).toContain('重试 resume')
    } finally {
      chmodSync(dir, 0o755)
    }
  })
})
