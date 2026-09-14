/**
 * WS-6 `.worktreeinclude` coverage (§8 WS-6 row): the matcher conformance
 * table (comments, `!` negation, trailing `/`, `*`, `?`, `**`, and CC's
 * `**` + `/`-piercing rule) plus the copy step over a fake git runner.
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyIncludedFiles, includeMatches, parseWorktreeInclude } from '../src/include.ts'

const P = (...lines: string[]): string[] => lines

describe('includeMatches conformance table', () => {
  it('comments and blank lines are dropped by the parser', () => {
    expect(parseWorktreeInclude('# comment\n\n  \n*.log\n')).toEqual(['*.log'])
  })

  it('basename patterns match at any depth; `*` and `?` stay inside one segment', () => {
    const p = P('*.log')
    expect(includeMatches(p, 'a.log')).toBe(true)
    expect(includeMatches(p, 'deep/dir/a.log')).toBe(true)
    expect(includeMatches(p, 'dir')).toBe(false)
    const q = P('a?c')
    expect(includeMatches(q, 'abc')).toBe(true)
    expect(includeMatches(q, 'a/c')).toBe(false)
    expect(includeMatches(q, 'abbc')).toBe(false)
  })

  it('a pattern with an inner slash is anchored to the root', () => {
    const p = P('build/out.txt')
    expect(includeMatches(p, 'build/out.txt')).toBe(true)
    expect(includeMatches(p, 'x/build/out.txt')).toBe(false)
    expect(includeMatches(p, 'build/other.txt')).toBe(false)
  })

  it('a leading slash anchors too', () => {
    const p = P('/top.txt')
    expect(includeMatches(p, 'top.txt')).toBe(true)
    expect(includeMatches(p, 'sub/top.txt')).toBe(false)
  })

  it('trailing slash matches directories only', () => {
    const p = P('logs/')
    expect(includeMatches(p, 'logs', { isDir: true })).toBe(true)
    expect(includeMatches(p, 'logs')).toBe(false)
  })

  it('a middle `**` spans zero or more whole directories', () => {
    const p = P('a/**/b.txt')
    expect(includeMatches(p, 'a/b.txt')).toBe(true)
    expect(includeMatches(p, 'a/x/b.txt')).toBe(true)
    expect(includeMatches(p, 'a/x/y/b.txt')).toBe(true)
    expect(includeMatches(p, 'b.txt')).toBe(false)
  })

  it('a trailing `**` matches everything below', () => {
    const p = P('dist/**')
    expect(includeMatches(p, 'dist/a.js')).toBe(true)
    expect(includeMatches(p, 'dist/x/a.js')).toBe(true)
    expect(includeMatches(p, 'distx/a.js')).toBe(false)
  })

  it('last matching pattern wins: `!` negation re-excludes', () => {
    const p = P('*.log', '!keep.log')
    expect(includeMatches(p, 'keep.log')).toBe(false)
    expect(includeMatches(p, 'drop.log')).toBe(true)
    const p2 = P('!keep.log', '*.log')
    expect(includeMatches(p2, 'keep.log')).toBe(true)
  })

  it('piercing: a `**` + `/` pattern inside a wholly-ignored directory only matches when the dir itself matches or the first name equals the literal', () => {
    const p = P('**/foo.txt')
    // Not inside an ignored directory: matches at any depth (plain gitignore).
    expect(includeMatches(p, 'a/foo.txt')).toBe(true)
    expect(includeMatches(p, 'a/b/foo.txt')).toBe(true)
    // Inside a wholly-ignored directory, the directory itself must match…
    expect(includeMatches(p, 'x/foo.txt/inner.log', { ancestorIgnored: true })).toBe(true) // dir 'x/foo.txt' matches the pattern
    // …or the path's first name must equal the pattern's first literal segment.
    expect(includeMatches(p, 'foo.txt/deep/file', { ancestorIgnored: true })).toBe(true)
    expect(includeMatches(p, 'a/b/foo.txt', { ancestorIgnored: true })).toBe(false)
    // A wildcard first segment has no literal: the piercing exception never fires.
    const w = P('**/f*.txt')
    expect(includeMatches(w, 'a/foo.txt', { ancestorIgnored: true })).toBe(false)
  })
})

describe('copyIncludedFiles (fake git)', () => {
  function fakeGit(ignored: string[]) {
    const calls: string[] = []
    return {
      calls,
      run(command: string) {
        calls.push(command)
        if (command.includes('ls-files')) {
          return { status: 0, stdout: ['tracked', 'secret.key', 'logs/app.log'].join('\0') + '\0' }
        }
        // check-ignore: echo back the requested paths that are in `ignored`.
        const requested = [...command.matchAll(/'([^']+)'/g)].map(m => m[1])
        const hits = requested.filter(p => ignored.includes(p))
        return { status: hits.length > 0 ? 0 : 1, stdout: hits.join('\0') + (hits.length > 0 ? '\0' : '') }
      },
    }
  }

  it('copies only matched AND check-ignore-confirmed files, preserving relative paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-inc-'))
    try {
      writeFileSync(join(root, 'secret.key'), 'k')
      mkdirSync(join(root, 'logs'), { recursive: true })
      writeFileSync(join(root, 'logs', 'app.log'), 'l')
      writeFileSync(join(root, 'tracked'), 't')
      writeFileSync(join(root, '.worktreeinclude'), '*.key\nlogs/\n')
      const worktree = join(root, 'wt')
      mkdirSync(worktree)
      const git = fakeGit(['secret.key', 'logs/app.log', 'logs'])
      const copied = await copyIncludedFiles(root, worktree, (cmd, wd) => { git.calls.push(cmd + '@' + wd); return Promise.resolve(git.run(cmd)) })
      // `tracked` matches no pattern; `logs/app.log` rides in under the
      // dir-matched `logs/` directory; `secret.key` matches `*.key` directly.
      expect(copied.sort()).toEqual(['logs/app.log', 'secret.key'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns [] when no .worktreeinclude exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-inc-'))
    try {
      expect(await copyIncludedFiles(root, root, async () => { throw new Error('unreachable') })).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns [] when the ls-files probe fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-inc-'))
    try {
      writeFileSync(join(root, '.worktreeinclude'), '*.key\n')
      expect(await copyIncludedFiles(root, root, async () => ({ status: 128, stdout: '' }))).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
