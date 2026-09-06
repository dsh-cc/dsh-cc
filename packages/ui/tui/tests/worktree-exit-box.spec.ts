import { describe, expect, it } from 'vitest'
import { Container } from '@dsh-cc/pi-tui'
import { createWorktreeExitBox } from '@dsh-cc/tui/components/overlays.ts'
import type { WorktreeExitView } from '@dsh-cc/tui/store.ts'

/** Render a box to stripped lines so structural assertions see plain text. */
function boxLines(box: Container): string[] {
  return box.render(80).map(line => line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd())
}

const baseView: WorktreeExitView = {
  repoRoot: '/repo',
  worktreePath: '/repo/.claude/worktrees/feat',
  branch: 'worktree-feat',
  managed: true,
  ownsBranch: true,
  baseHead: 'abc123',
  dirtyFiles: 2,
  commitsAhead: 3,
  focused: 0,
  busy: false,
}

describe('createWorktreeExitBox', () => {
  it('renders the title, path, and branch', () => {
    const lines = boxLines(createWorktreeExitBox(baseView))
    expect(lines).toContain('Exit worktree session?')
    expect(lines).toContain('Worktree: /repo/.claude/worktrees/feat')
    expect(lines).toContain('Branch: worktree-feat')
  })

  it('shows removal evidence when known', () => {
    const lines = boxLines(createWorktreeExitBox(baseView))
    expect(lines).toContain('Uncommitted changes: 2')
    expect(lines).toContain('Commits ahead of base: 3')
  })

  it('omits evidence rows when unavailable', () => {
    const view = { ...baseView, dirtyFiles: undefined, commitsAhead: undefined }
    const lines = boxLines(createWorktreeExitBox(view))
    expect(lines).not.toContain('Uncommitted changes')
    expect(lines).not.toContain('Commits ahead of base')
  })

  it('marks the focused option and defaults Keep', () => {
    const lines = boxLines(createWorktreeExitBox(baseView))
    expect(lines.some(line => line.includes('❯ Keep worktree and exit'))).toBe(true)
    expect(lines.some(line => / {2}Remove worktree and exit/.test(line))).toBe(true)
    expect(lines.some(line => / {2}Cancel/.test(line))).toBe(true)
  })

  it('moves the ❯ marker with focus', () => {
    const lines = boxLines(createWorktreeExitBox({ ...baseView, focused: 1 }))
    expect(lines.some(line => line.includes('❯ Remove worktree and exit'))).toBe(true)
    expect(lines.some(line => / {2}Keep worktree and exit/.test(line))).toBe(true)
  })

  it('annotates the remove option with an owned branch and hides it otherwise', () => {
    const owned = boxLines(createWorktreeExitBox(baseView))
    expect(owned.some(line => line.includes('Remove worktree and exit (and delete branch worktree-feat)'))).toBe(true)

    const foreign = {
      ...baseView,
      managed: false,
      ownsBranch: false,
      branch: 'my-custom-branch',
      baseHead: undefined,
      commitsAhead: undefined,
    }
    const foreignLines = boxLines(createWorktreeExitBox(foreign))
    expect(foreignLines.some(line => line.includes('Remove worktree and exit (and delete branch'))).toBe(false)
    expect(foreignLines.some(line => /Remove worktree and exit$/.test(line))).toBe(true)
  })

  it('swaps the footer for a progress note while busy', () => {
    const busy = boxLines(createWorktreeExitBox({ ...baseView, busy: true }))
    expect(busy.some(line => line.includes('Removing worktree…'))).toBe(true)
    expect(busy.some(line => line.includes('esc cancel'))).toBe(false)

    const idle = boxLines(createWorktreeExitBox(baseView))
    expect(idle.some(line => line.includes('↑↓ move · enter confirm · esc cancel'))).toBe(true)
    expect(idle.some(line => line.includes('Removing worktree…'))).toBe(false)
  })
})
