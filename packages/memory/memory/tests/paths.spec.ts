import { afterEach, describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { defaultDshHome } from '@deepseek-ai/dsh-home-paths'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  __clearMemoryRootCache,
  canonicalMemoryRoot,
  cwdOf,
  projectSlug,
  resolveMemoryHome,
  resolveWorkspaceMemoryDir,
  type MemoryGitExec,
} from '../src/paths.ts'

/**
 * Script a git conversation: argv → result (or undefined to simulate
 * failure). Combined `rev-parse --show-toplevel --git-common-dir` is the
 * only probe canonicalMemoryRoot issues.
 */
function scriptedExec(script: Record<string, { stdout: string } | undefined>): MemoryGitExec {
  return (argv, _cwd) => {
    const entry = script[argv.join(' ')]
    return entry === undefined ? undefined : { stdout: entry.stdout }
  }
}

const COMBINED = 'rev-parse --show-toplevel --git-common-dir'

/**
 * Regression coverage for the default memdir resolution: the default must be
 * `<dsh home>/memory`, NEVER the harness home itself. `apply()` regressed this
 * once by forwarding `defaultDshHome()` as the configured root, which pinned
 * memory writes (MEMORY.md and topic files) into the harness home root.
 */
describe('resolveMemoryHome', () => {
  it('resolves the default to the memory subdirectory of the harness home', () => {
    expect(resolveMemoryHome(undefined)).toBe(join(defaultDshHome(), 'memory'))
    expect(resolveMemoryHome('')).toBe(join(defaultDshHome(), 'memory'))
  })

  it('never returns the bare harness home', () => {
    expect(resolveMemoryHome(undefined)).not.toBe(defaultDshHome())
  })

  it('honors an explicit root verbatim', () => {
    expect(resolveMemoryHome('/tmp/mem')).toBe('/tmp/mem')
  })
})

/**
 * The workspace slug is ported from upstream `projectKey`
 * (session-persistence-jsonl) minus the `--` wrapper. The input is the
 * canonical git root, not the raw session cwd.
 */
describe('projectSlug', () => {
  it('collapses separators and drive colons to single dashes', () => {
    expect(projectSlug('/home/x/work/repo')).toBe('home-x-work-repo')
    expect(projectSlug('C:\\src\\repo')).toBe('C-src-repo')
    expect(projectSlug('/a//b\\\\c')).toBe('a-b-c')
  })

  it('strips leading dashes and falls back to root', () => {
    expect(projectSlug('/')).toBe('root')
    expect(projectSlug('')).toBe('root')
  })

  it('escapes unsafe code units as ~XXXX', () => {
    expect(projectSlug('/a b/c')).toBe('a~0020b-c')
    expect(projectSlug('/a~b')).toBe('a~007Eb')
  })

  it('keeps dots, underscores and dashes readable', () => {
    expect(projectSlug('/x/y_z.q-r')).toBe('x-y_z.q-r')
  })

  it('truncates to 251 chars', () => {
    const slug = projectSlug(`/${'a'.repeat(300)}`)
    expect(slug.length).toBe(251)
  })
})

describe('canonicalMemoryRoot', () => {
  afterEach(() => { __clearMemoryRootCache() })

  it('main repo: root is the toplevel', () => {
    const exec = scriptedExec({
      [COMBINED]: { stdout: '/repo\n.git\n' },
    })
    expect(canonicalMemoryRoot('/repo', exec)).toBe('/repo')
  })

  it('main repo launched from a subdir maps relative common-dir to the toplevel', () => {
    const exec = scriptedExec({
      [COMBINED]: { stdout: '/repo\n../.git\n' },
    })
    expect(canonicalMemoryRoot('/repo/subdir', exec)).toBe('/repo')
  })

  it('linked worktree collapses onto the main checkout root', () => {
    const exec = scriptedExec({
      [COMBINED]: { stdout: '/repo/.claude/worktrees/support\n/repo/.git\n' },
    })
    expect(canonicalMemoryRoot('/repo/.claude/worktrees/support', exec)).toBe('/repo')
  })

  it('submodule does not collapse onto the superproject (.git/modules/*)', () => {
    const exec = scriptedExec({
      [COMBINED]: { stdout: '/super/sub\n/super/.git/modules/sub\n' },
    })
    expect(canonicalMemoryRoot('/super/sub', exec)).toBe('/super/sub')
  })

  it('nested independent repository keeps its own root', () => {
    const exec = scriptedExec({
      [COMBINED]: { stdout: '/outer/nested\n/outer/nested/.git\n' },
    })
    expect(canonicalMemoryRoot('/outer/nested', exec)).toBe('/outer/nested')
  })

  it('non-git directory degrades to the directory identity', () => {
    expect(canonicalMemoryRoot('/plain/dir', scriptedExec({}))).toBe(resolve('/plain/dir'))
  })

  it('git failure (undefined result) degrades to the directory identity', () => {
    expect(canonicalMemoryRoot('/a/b', scriptedExec({ [COMBINED]: undefined }))).toBe(resolve('/a/b'))
  })
})

describe('resolveWorkspaceMemoryDir', () => {
  afterEach(() => { __clearMemoryRootCache() })

  it('nests the workspace slug under <home>/projects', () => {
    const exec = scriptedExec({})
    expect(resolveWorkspaceMemoryDir('/mem', '/work/repo', exec)).toBe('/mem/projects/work-repo')
  })

  it('collapses a linked worktree onto the same dir as the main checkout', () => {
    const main = scriptedExec({ [COMBINED]: { stdout: '/repo\n.git\n' } })
    const worktree = scriptedExec({
      [COMBINED]: { stdout: '/repo/.claude/worktrees/foo\n/repo/.git\n' },
    })
    const fromMain = resolveWorkspaceMemoryDir('/mem', '/repo', main)
    const fromWorktree = resolveWorkspaceMemoryDir('/mem', '/repo/.claude/worktrees/foo', worktree)
    expect(fromMain).toBe(`/mem/projects/${projectSlug('/repo')}`)
    expect(fromWorktree).toBe(fromMain)
  })

  it('shares the team layer of the collapsed workspace dir', () => {
    const worktree = scriptedExec({
      [COMBINED]: { stdout: '/repo/.claude/worktrees/foo\n/repo/.git\n' },
    })
    const dir = resolveWorkspaceMemoryDir('/mem', '/repo/.claude/worktrees/foo', worktree)
    expect(join(dir, 'team')).toBe(`/mem/projects/${projectSlug('/repo')}/team`)
  })
})

describe('cwdOf', () => {
  it('prefers the session header cwd and falls back to the process cwd', () => {
    const agent = { session: { header: { cwd: '/work/repo' } } } as unknown as Agent
    expect(cwdOf(agent)).toBe('/work/repo')
    const bare = { session: { header: {} } } as unknown as Agent
    expect(cwdOf(bare)).toBe(process.cwd())
  })
})
