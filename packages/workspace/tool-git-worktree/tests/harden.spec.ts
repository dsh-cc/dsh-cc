/**
 * Unit tests for the WS-1 creation-hardening helpers: common-dir root
 * pinning, local-config scanning / neutralization argv, and the adoption
 * identity check (real filesystem via mkdtemp fixtures).
 */

import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adoptionRefusal, neutralizationArgv, repoRootFromCommonDir, scanLocalConfig } from '../src/harden.ts'

describe('repoRootFromCommonDir', () => {
  it('resolves a relative .git answer against the probe cwd', () => {
    expect(repoRootFromCommonDir('/repo', '.git')).toBe('/repo')
  })

  it('accepts an absolute common-dir answer (linked worktree)', () => {
    expect(repoRootFromCommonDir('/repo/.claude/worktrees/wt', '/main/.git')).toBe('/main')
  })

  it('resolves a nested relative answer and trims whitespace', () => {
    expect(repoRootFromCommonDir('/a/b/c', '../../.git\n')).toBe('/a')
  })

  it('returns undefined for an empty answer', () => {
    expect(repoRootFromCommonDir('/x', '')).toBeUndefined()
    expect(repoRootFromCommonDir('/x', '  \n')).toBeUndefined()
  })
})

describe('scanLocalConfig', () => {
  it('collects filter names from filter.* keys', () => {
    const scan = scanLocalConfig(
      'filter.lfs.required=true\nfilter.lfs.process=git-lfs filter-process\nuser.name=x\n',
    )
    expect(scan.filters).toEqual(['lfs'])
    expect(scan.refusals).toEqual([])
  })

  it('refuses includeIf keys (local scope, CC parity)', () => {
    const scan = scanLocalConfig('includeif.gitdir:~/secret/.path=~/secret/.gitconfig\n')
    expect(scan.filters).toEqual([])
    expect(scan.refusals).toHaveLength(1)
    expect(scan.refusals[0]).toContain('includeIf')
  })

  it('refuses a filter name containing = (decidable via the -z listing)', () => {
    const scan = scanLocalConfig('filter.a=b.clean\nx\0')
    expect(scan.filters).toEqual([])
    expect(scan.refusals[0]).toContain('ambiguous name')
  })

  it('tolerates values containing newlines under the -z listing', () => {
    const scan = scanLocalConfig('filter.x.smudge\nline one\nline two\0')
    expect(scan.filters).toEqual(['x'])
    expect(scan.refusals).toEqual([])
  })

  it('keeps multi-dot subsections intact (name up to last dot)', () => {
    const scan = scanLocalConfig('filter.my.lfs.required=true\n')
    expect(scan.filters).toEqual(['my.lfs'])
  })
})

describe('neutralizationArgv', () => {
  it('emits empty -c overrides for every filter knob plus required=false', () => {
    expect(neutralizationArgv(['lfs'])).toEqual([
      '-c', 'filter.lfs.command=',
      '-c', 'filter.lfs.smudge=',
      '-c', 'filter.lfs.clean=',
      '-c', 'filter.lfs.process=',
      '-c', 'filter.lfs.required=false',
    ])
  })

  it('emits nothing without filters', () => {
    expect(neutralizationArgv([])).toEqual([])
  })
})

describe('adoptionRefusal', () => {
  const makeRepo = (): string => mkdtempSync(join(tmpdir(), 'dsh-harden-'))
  const write = (path: string, text: string): void => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }

  it('accepts a gitdir pointer into the main worktrees registration', () => {
    const root = makeRepo()
    const target = join(root, '.claude', 'worktrees', 'wt')
    mkdirSync(target, { recursive: true })
    write(join(target, '.git'), `gitdir: ${join(root, '.git', 'worktrees', 'wt')}\n`)
    expect(adoptionRefusal(target, root)).toBeNull()
  })

  it('accepts a relative gitdir pointer resolved against the target', () => {
    const root = makeRepo()
    const target = join(root, '.claude', 'worktrees', 'wt')
    mkdirSync(target, { recursive: true })
    write(join(target, '.git'), `gitdir: ${join(root, '.git', 'worktrees', 'wt')}`)
    expect(adoptionRefusal(target, root)).toBeNull()
  })

  it('refuses a directory with no git metadata (may hold user work)', () => {
    const root = makeRepo()
    const target = join(root, '.claude', 'worktrees', 'plain')
    mkdirSync(target, { recursive: true })
    const refusal = adoptionRefusal(target, root)
    expect(refusal).toContain('no .git entry')
    expect(refusal).toContain('Remove or rename')
  })

  it('refuses a plain clone (directory .git)', () => {
    const root = makeRepo()
    const target = join(root, '.claude', 'worktrees', 'clone')
    mkdirSync(join(target, '.git'), { recursive: true })
    const refusal = adoptionRefusal(target, root)
    expect(refusal).toContain('separate checkout')
  })

  it('refuses a directory .git whose commondir resolves into the main .git root', () => {
    const root = makeRepo()
    const target = join(root, '.claude', 'worktrees', 'redirect')
    mkdirSync(join(target, '.git'), { recursive: true })
    write(join(target, '.git', 'commondir'), join(root, '.git') + '\n')
    const refusal = adoptionRefusal(target, root)
    expect(refusal).toContain('commondir resolves into the main checkout')
  })

  it('refuses a gitdir pointer outside the worktrees registration (redirect)', () => {
    const root = makeRepo()
    const target = join(root, '.claude', 'worktrees', 'weird')
    mkdirSync(target, { recursive: true })
    write(join(target, '.git'), `gitdir: ${join(root, '.git', 'objects')}\n`)
    const refusal = adoptionRefusal(target, root)
    expect(refusal).toContain('not this repository\'s worktree registration')
  })

  it('refuses a target that contains the main checkout', () => {
    const root = makeRepo()
    const target = root // the dir "contains" the main checkout itself
    const refusal = adoptionRefusal(target, root)
    expect(refusal).toContain('contains the main checkout')
  })

  it('refuses an unreadable .git entry', () => {
    const root = makeRepo()
    const target = join(root, '.claude', 'worktrees', 'unreadable')
    mkdirSync(target, { recursive: true })
    // A dangling symlink entry: not missing, not a pointer file.
    symlinkSync(join(target, 'nowhere'), join(target, '.git'))
    const refusal = adoptionRefusal(target, root)
    expect(refusal).not.toBeNull()
  })
})
