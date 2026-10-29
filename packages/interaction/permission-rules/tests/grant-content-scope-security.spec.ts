import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkGrantContentScope, commitRangeScopeViolations, pushScopeViolations,
  scopedCommandShapeViolations, snapshotCommitHead,
} from '../src/grant-content-scope.ts'

const roots: string[] = []
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'grant-content-'))
  roots.push(root)
  git(root, 'init', '-b', 'docs')
  git(root, 'config', 'user.email', 'test@example.invalid')
  git(root, 'config', 'user.name', 'Test')
  const remote = join(root, 'remote.git')
  git(root, 'init', '--bare', remote)
  git(root, 'remote', 'add', 'origin', remote)
  return root
}
function commit(root: string, path: string, content = path): string {
  writeFileSync(join(root, path), content)
  git(root, 'add', '--', path)
  git(root, 'commit', '-m', path)
  return git(root, 'rev-parse', 'HEAD')
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('tracked markdown command shape', () => {
  it.each([
    'git commit -am x', 'git commit --all -m x', 'git commit -m x README.md',
    'git commit -m x -- README.md', 'git commit --include -m x README.md',
    'git commit --only -m x README.md', 'git commit --amend -m x',
    'git commit --reuse-message=HEAD', 'git commit --unknown', 'git commit &',
    'git add README.md && git commit -m x', 'git commit -m x; git push origin docs',
    'git push origin docs &', 'git push origin HEAD:docs',
  ])('refuses a command whose checked set could differ: %s', command => {
    expect(scopedCommandShapeViolations(command, 'docs').length).toBeGreaterThan(0)
  })
  it.each(['git add README.md', 'git commit -m "git add && code.ts"', 'git commit --message=x --allow-empty', 'git push origin docs'])('allows separate safe operations: %s', command => {
    expect(scopedCommandShapeViolations(command, 'docs')).toEqual([])
  })
  it('checks the actual index for a safe commit', async () => {
    const root = repo()
    commit(root, 'README.md')
    writeFileSync(join(root, 'code.ts'), 'bad')
    git(root, 'add', 'code.ts')
    expect(await checkGrantContentScope({ root, branch: 'docs', contentScope: 'tracked-md-only' }, 'git commit -m x')).toContain('A code.ts is not markdown')
  })
})

describe('live exact-ref publication checks', () => {
  it('keeps rename-by-new-path semantics for published markdown renames', async () => {
    const root = repo()
    commit(root, 'README.md')
    git(root, 'push', 'origin', 'docs')
    git(root, 'mv', 'README.md', 'renamed.md')
    git(root, 'commit', '-m', 'rename')
    expect(await pushScopeViolations(root, 'docs')).toEqual([])
  })
  it('checks root commits when publishing an initial branch', async () => {
    const root = repo()
    commit(root, 'code.ts')
    expect(await pushScopeViolations(root, 'docs')).toContain('A code.ts is not markdown')
  })
  it('allows initial markdown and idempotent publication', async () => {
    const root = repo()
    commit(root, 'README.md')
    expect(await pushScopeViolations(root, 'docs')).toEqual([])
    git(root, 'push', 'origin', 'docs')
    expect(await pushScopeViolations(root, 'docs')).toEqual([])
  })
  it('checks the specified source branch even when HEAD is elsewhere', async () => {
    const root = repo()
    commit(root, 'README.md')
    git(root, 'push', 'origin', 'docs')
    const base = git(root, 'rev-parse', 'HEAD')
    commit(root, 'code.ts')
    git(root, 'switch', '-c', 'other', base)
    expect(await pushScopeViolations(root, 'docs')).toContain('A code.ts is not markdown')
  })
  it('does not trust a forged or stale origin tracking ref', async () => {
    const root = repo()
    commit(root, 'README.md')
    git(root, 'push', 'origin', 'docs')
    const bad = commit(root, 'code.ts')
    git(root, 'update-ref', 'refs/remotes/origin/docs', bad)
    expect(await pushScopeViolations(root, 'docs')).toContain('A code.ts is not markdown')
  })
  it('checks code introduced only by a merge resolution against every parent', async () => {
    const root = repo()
    commit(root, 'README.md')
    git(root, 'push', 'origin', 'docs')
    git(root, 'switch', '-c', 'side')
    commit(root, 'side.md')
    git(root, 'switch', 'docs')
    commit(root, 'main.md')
    git(root, 'merge', '--no-commit', '--no-ff', 'side')
    writeFileSync(join(root, 'code.ts'), 'merge-only code')
    git(root, 'add', 'code.ts')
    git(root, 'commit', '-m', 'merge')
    expect(await pushScopeViolations(root, 'docs')).toContain('A code.ts is not markdown')
  })
  it.each(['remote.origin.mirror', 'push.followTags'])('refuses publication broadened by %s', async key => {
    const root = repo()
    commit(root, 'README.md')
    git(root, 'config', key, 'true')
    expect((await pushScopeViolations(root, 'docs')).length).toBeGreaterThan(0)
  })
  it('refuses additional push destinations', async () => {
    const root = repo()
    commit(root, 'README.md')
    git(root, 'config', '--add', 'remote.origin.pushurl', join(root, 'remote.git'))
    git(root, 'config', '--add', 'remote.origin.pushurl', join(root, 'other.git'))
    expect((await pushScopeViolations(root, 'docs')).length).toBeGreaterThan(0)
  })
  it('fails closed when remote truth cannot be obtained', async () => {
    const root = repo()
    commit(root, 'README.md')
    git(root, 'remote', 'set-url', 'origin', join(root, 'missing.git'))
    await expect(pushScopeViolations(root, 'docs')).rejects.toThrow()
  })
  it('checks a pinned postexecution range including root history', async () => {
    const root = repo()
    expect(await snapshotCommitHead(root)).toBe(null)
    const after = commit(root, 'code.ts')
    expect(await commitRangeScopeViolations(root, null, after)).toContain('A code.ts is not markdown')
  })
})
