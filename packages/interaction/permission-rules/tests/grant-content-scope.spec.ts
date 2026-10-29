import { describe, expect, it } from 'vitest'
import {
  commitPostHocViolations,
  commitScopeViolations,
  contentScopeViolations,
  isCommitCommand,
  isPushCommand,
  parseNameStatusZ,
  pushScopeViolations,
  stagesAtCommit,
  type GitRunner,
} from '../src/grant-content-scope.ts'

/** A fake git runner returning scripted stdout per argv shape. */
function git(stdout: string): GitRunner {
  return async () => stdout
}

describe('contentScope name-status parsing (§3.6)', () => {
  it('parses M/A/D entries from -z output', () => {
    expect(parseNameStatusZ('M\0docs/a.md\0A\0docs/b.md\0D\0docs/c.md\0')).toEqual([
      { status: 'M', path: 'docs/a.md' },
      { status: 'A', path: 'docs/b.md' },
      { status: 'D', path: 'docs/c.md' },
    ])
  })

  it('judges a rename by its NEW path (R100-shaped status parsed by its first letter)', () => {
    expect(parseNameStatusZ('R100\0old.md\0new.md\0')).toEqual([{ status: 'R100', path: 'new.md' }])
    expect(contentScopeViolations([{ status: 'R100', path: 'new.md' }])).toEqual([])
    expect(contentScopeViolations([{ status: 'R100', path: 'new.png' }])).toEqual(['R100 new.png is not markdown'])
  })

  it('class rules: M/A need .md/.mdx, D always violates, other letters fail closed', () => {
    expect(contentScopeViolations([
      { status: 'M', path: 'docs/a.md' },
      { status: 'A', path: 'docs/b.mdx' },
    ])).toEqual([])
    expect(contentScopeViolations([{ status: 'M', path: 'src/a.ts' }])).toEqual(['M src/a.ts is not markdown'])
    expect(contentScopeViolations([{ status: 'D', path: 'docs/a.md' }]))
      .toEqual(['D docs/a.md deletes a tracked file'])
    expect(contentScopeViolations([{ status: 'T', path: 'docs/a.md' }]))
      .toEqual(['T docs/a.md is outside the markdown-only scope'])
  })

  it('an empty change set passes (idempotent push)', async () => {
    expect(contentScopeViolations([])).toEqual([])
    expect(await pushScopeViolations('/work', 'b', git(''))).toEqual([])
  })

  it('the three git checks spawn DIRECT git with the pinned argv shapes', async () => {
    const calls: string[][] = []
    const runner: GitRunner = async (_root, args) => {
      calls.push([...args])
      return ''
    }
    await commitScopeViolations('/work', runner)
    await pushScopeViolations('/work', 'b', runner)
    await commitPostHocViolations('/work', runner)
    expect(calls).toEqual([
      ['diff', '--cached', '-z', '--name-status'],
      ['log', '--format=', '-z', '--name-status', 'origin/b..HEAD'],
      ['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', 'HEAD'],
    ])
  })

  it('recognizes commit/push shapes and the -a staging form', () => {
    expect(isCommitCommand('git commit -m x')).toBe(true)
    expect(isPushCommand('git push origin b')).toBe(true)
    expect(stagesAtCommit('git commit -a -m x')).toBe(true)
    expect(stagesAtCommit('git commit --all -m x')).toBe(true)
    expect(stagesAtCommit('git commit -m x')).toBe(false)
  })

  it('P1c/P2d: commit/push is detected in ANY segment, including -am staging', () => {
    expect(isCommitCommand('echo x && git commit -a -m x')).toBe(true)
    expect(isCommitCommand('echo x; git commit -m x')).toBe(true)
    expect(isPushCommand('echo x && git push origin b')).toBe(true)
    expect(stagesAtCommit('echo x && git commit -am x')).toBe(true)
    expect(stagesAtCommit('echo x && git commit -m x')).toBe(false)
    // A non-command mention is not a commit.
    expect(isCommitCommand('echo git commit')).toBe(false)
  })

  it('`-am`/`-a` staging forms and the `git stash push` non-push token boundary', () => {
    expect(stagesAtCommit('git commit -am "x"')).toBe(true)
    expect(stagesAtCommit('git commit -a')).toBe(true)
    expect(stagesAtCommit('git commit --amend -m x')).toBe(false)
    expect(isPushCommand('git stash push')).toBe(false)
    expect(isPushCommand('git push origin b')).toBe(true)
  })

  it('a violation in the staged set is reported (pre-check)', async () => {
    expect(await commitScopeViolations('/work', git('M\0src/a.ts\0'))).toEqual(['M src/a.ts is not markdown'])
  })
})
