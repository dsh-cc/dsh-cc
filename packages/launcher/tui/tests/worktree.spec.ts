import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  flattenSlug,
  parseWorktreeFlag,
  parseWorktreeRef,
  planWorktree,
  planWorktreeRef,
  prFetchRefs,
  remoteHost,
  randomWorktreeSlug,
  existingWorktreeDecision,
  slugRetryDecision,
  validateWorktreeSlug,
  WORKTREE_ENV,
  parseLocalConfig,
  repoRootFromCommonDir,
  worktreeAddArgv,
  worktreeIdentityRefusal,
  worktreeBranch,
  worktreeEnv,
  worktreePathFor,
} from '../bootstrap.mjs'

describe('parseWorktreeFlag', () => {
  it('reports undefined when the flag is absent and forwards everything', () => {
    expect(parseWorktreeFlag(['--verbose', 'x'])).toEqual({ name: undefined, args: ['--verbose', 'x'] })
  })

  it('parses a bare --worktree as a random-name request', () => {
    expect(parseWorktreeFlag(['--worktree'])).toEqual({ name: null, args: [] })
  })

  it('parses --worktree <name> and forwards the rest', () => {
    expect(parseWorktreeFlag(['--worktree', 'feat', '--verbose']))
      .toEqual({ name: 'feat', args: ['--verbose'] })
  })

  it('does not swallow a following flag as the name', () => {
    expect(parseWorktreeFlag(['--worktree', '--new'])).toEqual({ name: null, args: ['--new'] })
  })

  it('parses --worktree=<name>', () => {
    expect(parseWorktreeFlag(['--worktree=feat'])).toEqual({ name: 'feat', args: [] })
  })

  it('treats --worktree= (empty value) as a random-name request', () => {
    expect(parseWorktreeFlag(['--worktree='])).toEqual({ name: null, args: [] })
  })
})

// These cases mirror packages/workspace/tool-git-worktree/tests/worktree.spec.ts —
// the launcher duplicates the slug rules (plain JS, no TS import) and parity is
// locked by testing the same inputs here.
describe('validateWorktreeSlug (parity with tool-git-worktree)', () => {
  it('accepts nested slugs and common names', () => {
    expect(() => validateWorktreeSlug('feat')).not.toThrow()
    expect(() => validateWorktreeSlug('user/feature-x.1')).not.toThrow()
  })

  it('rejects traversal and empty segments', () => {
    for (const bad of ['../escape', '.', 'a//b', '/lead', 'trail/', '']) {
      expect(() => validateWorktreeSlug(bad)).toThrow(/invalid worktree name/)
    }
  })

  it('rejects whitespace and overlong names', () => {
    expect(() => validateWorktreeSlug('has space')).toThrow(/invalid worktree name/)
    expect(() => validateWorktreeSlug('x'.repeat(65))).toThrow(/64 characters or fewer/)
  })
})

describe('slug derivations', () => {
  it('flattens, prefixes, and places the path under .claude/worktrees', () => {
    expect(flattenSlug('user/feature')).toBe('user+feature')
    expect(worktreeBranch('user/feature')).toBe('worktree-user+feature')
    expect(worktreePathFor('/repo', 'user/feature')).toBe('/repo/.claude/worktrees/user+feature')
  })

  it('generates slugs in the swift-fox-8f3a shape', () => {
    expect(randomWorktreeSlug(() => 0.999)).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{4}$/)
  })
})

describe('planWorktree', () => {
  it('plans a named worktree', () => {
    expect(planWorktree('/repo', 'feat')).toEqual({
      slug: 'feat',
      worktreePath: '/repo/.claude/worktrees/feat',
      branch: 'worktree-feat',
    })
  })

  it('plans a random worktree when name is null and validates it', () => {
    const plan = planWorktree('/repo', null, () => 0.999)
    expect(plan.slug).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{4}$/)
    expect(plan.branch).toBe(`worktree-${plan.slug}`)
  })

  it('validates the requested name', () => {
    expect(() => planWorktree('/repo', '../escape')).toThrow(/invalid worktree name/)
  })
})

describe('worktreeAddArgv', () => {
  it('builds the execFile argv with -B and HEAD base', () => {
    expect(worktreeAddArgv({ worktreePath: '/repo/.claude/worktrees/feat', branch: 'worktree-feat' }))
      .toEqual(['worktree', 'add', '-B', 'worktree-feat', '/repo/.claude/worktrees/feat', 'HEAD'])
  })
})

describe('worktreeEnv', () => {
  it('carries the session descriptor as JSON', () => {
    const env = worktreeEnv(
      { worktreePath: '/repo/.claude/worktrees/feat', branch: 'worktree-feat' },
      '/repo',
      'abc123',
    )
    expect(Object.keys(env)).toEqual([WORKTREE_ENV])
    expect(JSON.parse(env[WORKTREE_ENV])).toEqual({
      repoRoot: '/repo',
      worktreePath: '/repo/.claude/worktrees/feat',
      branch: 'worktree-feat',
      baseHead: 'abc123',
      named: false,
    })
    // WS-5 coupling: the marker records whether the slug was user-chosen.
    const namedEnv = worktreeEnv(
      { worktreePath: '/repo/.claude/worktrees/feat', branch: 'worktree-feat' },
      '/repo',
      'abc123',
      true,
    )
    expect(JSON.parse(namedEnv[WORKTREE_ENV]).named).toBe(true)
  })
})

describe('slugRetryDecision', () => {
  it('never retries a user-named slug', () => {
    expect(slugRetryDecision({ named: true, attempt: 1 })).toBe('fail')
    expect(slugRetryDecision({ named: true, attempt: 4 })).toBe('fail')
  })

  it('retries random slugs until the attempt cap', () => {
    expect(slugRetryDecision({ named: false, attempt: 1 })).toBe('retry')
    expect(slugRetryDecision({ named: false, attempt: 4 })).toBe('retry')
    expect(slugRetryDecision({ named: false, attempt: 5 })).toBe('fail')
  })

  it('honours a custom cap', () => {
    expect(slugRetryDecision({ named: false, attempt: 2, maxAttempts: 2 })).toBe('fail')
  })
})

describe('existingWorktreeDecision', () => {
  it('reuses a named worktree whose path already exists', () => {
    expect(existingWorktreeDecision({ named: true, pathExists: true })).toBe('reuse')
  })

  it('creates when the named path is free, or when the slug is random', () => {
    expect(existingWorktreeDecision({ named: true, pathExists: false })).toBe('create')
    expect(existingWorktreeDecision({ named: false, pathExists: true })).toBe('create')
    expect(existingWorktreeDecision({ named: false, pathExists: false })).toBe('create')
  })
})

// WS-1 creation hardening parity (mirrors tool-git-worktree tests/harden.spec.ts).
describe('repoRootFromCommonDir', () => {
  it('resolves relative answers against the probe cwd and absolute ones as-is', () => {
    expect(repoRootFromCommonDir('/repo', '.git')).toBe('/repo')
    expect(repoRootFromCommonDir('/repo/.claude/worktrees/wt', '/main/.git')).toBe('/main')
    expect(repoRootFromCommonDir('/x', '  \n')).toBeUndefined()
  })
})

describe('parseLocalConfig', () => {
  it('collects filter names and refuses includeIf / ambiguous names', () => {
    const ok = parseLocalConfig('filter.lfs.required\ntrue\0user.name\nx\0')
    expect(ok.filters).toEqual(['lfs'])
    expect(ok.refusals).toEqual([])
    const inc = parseLocalConfig('includeif.gitdir:~/x/.path\n~/x/.gitconfig\0')
    expect(inc.refusals[0]).toContain('includeIf')
    const amb = parseLocalConfig('filter.a=b.clean\nx\0')
    expect(amb.filters).toEqual([])
    expect(amb.refusals[0]).toContain('ambiguous name')
  })
})

describe('worktreeAddArgv neutralization', () => {
  it('prepends empty -c overrides per filter plus required=false', () => {
    expect(worktreeAddArgv({ branch: 'b', worktreePath: '/p' }, ['lfs'])).toEqual([
      '-c', 'filter.lfs.command=',
      '-c', 'filter.lfs.smudge=',
      '-c', 'filter.lfs.clean=',
      '-c', 'filter.lfs.process=',
      '-c', 'filter.lfs.required=false',
      'worktree', 'add', '-B', 'b', '/p', 'HEAD',
    ])
    expect(worktreeAddArgv({ branch: 'b', worktreePath: '/p' })).toEqual(
      ['worktree', 'add', '-B', 'b', '/p', 'HEAD'],
    )
  })
})

describe('worktreeIdentityRefusal', () => {
  const makeRepo = () => mkdtempSync(join(tmpdir(), 'dsh-launcher-ident-'))

  it('accepts a gitdir pointer into the main worktrees registration', () => {
    const root = makeRepo()
    const target = join(root, '.claude', 'worktrees', 'wt')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, '.git'), `gitdir: ${join(root, '.git', 'worktrees', 'wt')}\n`)
    expect(worktreeIdentityRefusal(target, root)).toBeNull()
  })

  it('refuses a directory with no git metadata and a plain clone', () => {
    const root = makeRepo()
    const plain = join(root, '.claude', 'worktrees', 'plain')
    mkdirSync(plain, { recursive: true })
    expect(worktreeIdentityRefusal(plain, root)).toContain('no .git entry')
    const clone = join(root, '.claude', 'worktrees', 'clone')
    mkdirSync(join(clone, '.git'), { recursive: true })
    expect(worktreeIdentityRefusal(clone, root)).toContain('separate checkout')
  })

  it('refuses a target that contains the main checkout', () => {
    const root = makeRepo()
    expect(worktreeIdentityRefusal(root, root)).toContain('contains the main checkout')
  })
})

describe('WS-6 PR references', () => {
  it('parses #<n> without a host', () => {
    expect(parseWorktreeRef('#12')).toEqual({ pr: 12 })
    expect(parseWorktreeRef('#0')).toEqual({ pr: 0 })
    expect(parseWorktreeRef('#x')).toBeUndefined()
    expect(parseWorktreeRef('feature')).toBeUndefined()
    expect(parseWorktreeRef(null)).toBeUndefined()
    expect(parseWorktreeRef(undefined)).toBeUndefined()
  })

  it('parses GitHub PR URLs and GitLab MR URLs with their hosts', () => {
    expect(parseWorktreeRef('https://github.com/o/r/pull/12'))
      .toEqual({ pr: 12, host: 'github.com' })
    expect(parseWorktreeRef('https://github.com/o/r/pull/12/'))
      .toEqual({ pr: 12, host: 'github.com' })
    expect(parseWorktreeRef('https://gitlab.com/o/r/-/merge_requests/9'))
      .toEqual({ pr: 9, host: 'gitlab.com' })
    expect(parseWorktreeRef('https://gitlab.com/o/r/merge_requests/9'))
      .toEqual({ pr: 9, host: 'gitlab.com' })
    expect(parseWorktreeRef('https://example.com/o/r/pull/3'))
      .toEqual({ pr: 3, host: 'example.com' })
  })

  it('selects the fetch ref shape per host, first-then-second elsewhere', () => {
    expect(prFetchRefs('github.com', 12)).toEqual(['pull/12/head'])
    expect(prFetchRefs('gitlab.com', 9)).toEqual(['merge-requests/9/head'])
    expect(prFetchRefs('example.com', 3)).toEqual(['pull/3/head', 'merge-requests/3/head'])
    expect(prFetchRefs(undefined, 3)).toEqual(['pull/3/head', 'merge-requests/3/head'])
  })

  it('plans pr-<n> at the convention dir on branch worktree-pr-<n>', () => {
    expect(planWorktreeRef('/repo', 12)).toEqual({
      slug: 'pr-12',
      worktreePath: join('/repo', '.claude', 'worktrees', 'pr-12'),
      branch: 'worktree-pr-12',
    })
    // PR values never pass through the slug validator.
    expect(() => validateWorktreeSlug('#12')).toThrow(/invalid worktree name/)
  })

  it('extracts the host of https and scp-style remote URLs', () => {
    expect(remoteHost('https://github.com/o/r.git')).toBe('github.com')
    expect(remoteHost('git@github.com:o/r.git')).toBe('github.com')
    expect(remoteHost('ssh://git@gitlab.com/o/r.git')).toBe('gitlab.com')
    expect(remoteHost('/local/path')).toBeUndefined()
  })
})
