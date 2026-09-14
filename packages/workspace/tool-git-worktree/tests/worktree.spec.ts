/**
 * Unit tests for the centralized git-worktree command construction and the slug /
 * path helpers. These pin the exact git commands so a future pure-JS backend
 * can replace the module without changing tool behavior.
 */

import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  addWorktree,
  commitsAhead,
  deleteBranch,
  flattenSlug,
  forceRemoveWorktree,
  randomSlug,
  status,
  validateSlug,
  worktreeBranch,
  worktreePathFor,
  worktreesDir,
} from '../src/worktree.ts'

describe('validateSlug', () => {
  it('accepts simple and nested valid slugs', () => {
    expect(() => validateSlug('feature')).not.toThrow()
    expect(() => validateSlug('user/feature-foo')).not.toThrow()
    expect(() => validateSlug('a.b_c-d')).not.toThrow()
  })

  it('rejects path traversal and absolute paths', () => {
    for (const bad of ['..', '.', '../escape', 'a/../b', '/abs', 'a//b']) {
      expect(() => validateSlug(bad)).toThrow(/invalid worktree name/)
    }
  })

  it('rejects empty segments, spaces, and uppercase-invalid characters', () => {
    for (const bad of ['', '/a', 'a/', 'a b', 'a*b', 'a:b']) {
      expect(() => validateSlug(bad)).toThrow(/invalid worktree name/)
    }
  })

  it('rejects slugs longer than 64 characters', () => {
    expect(() => validateSlug('x'.repeat(65))).toThrow(/64 characters or fewer/)
    expect(() => validateSlug('x'.repeat(64))).not.toThrow()
  })
})

describe('slug and path mapping', () => {
  it('flattens nested slugs injectively into single segments', () => {
    expect(flattenSlug('user/feature')).toBe('user+feature')
    expect(flattenSlug('feature')).toBe('feature')
  })

  it('derives a worktree- prefix branch and the on-disk path', () => {
    expect(worktreeBranch('user/feature')).toBe('worktree-user+feature')
    expect(worktreePathFor('/repo', 'user/feature')).toBe(join('/repo', '.claude', 'worktrees', 'user+feature'))
    expect(worktreesDir('/repo')).toBe(join('/repo', '.claude', 'worktrees'))
  })

  it('randomSlug always produces a valid slug', () => {
    for (let i = 0; i < 200; i++) {
      const slug = randomSlug()
      expect(() => validateSlug(slug)).not.toThrow()
      expect(slug).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{4}$/)
    }
  })
})

describe('git command construction', () => {
  const repo = '/repo'
  const path = join(repo, '.claude', 'worktrees', 'feature+x')

  it('add uses -B with the worktree branch, quoted path, and HEAD base, run from the repo root', () => {
    expect(addWorktree(repo, 'feature/x')).toEqual({
      command: `git worktree add -B 'worktree-feature+x' '${path}' HEAD`,
      workdir: repo,
      label: `create worktree "${path}"`,
    })
  })

  it('add prepends empty -c overrides neutralizing repository-local filter drivers', () => {
    expect(addWorktree(repo, 'f', ['lfs']).command).toBe(
      "git '-c' 'filter.lfs.command=' '-c' 'filter.lfs.smudge=' '-c' 'filter.lfs.clean=' "
      + "'-c' 'filter.lfs.process=' '-c' 'filter.lfs.required=false' "
      + `worktree add -B 'worktree-f' '${join(repo, '.claude', 'worktrees', 'f')}' HEAD`,
    )
  })

  it('forceRemove runs from the repo root with a quoted path', () => {
    expect(forceRemoveWorktree(repo, path)).toEqual({
      command: `git worktree remove --force '${path}'`,
      workdir: repo,
      label: `remove worktree "${path}"`,
    })
  })

  it('deleteBranch deletes the worktree branch from the repo root', () => {
    expect(deleteBranch(repo, 'worktree-feature+x')).toEqual({
      command: 'git branch -D \'worktree-feature+x\'',
      workdir: repo,
      label: 'delete worktree branch "worktree-feature+x"',
    })
  })

  it('status runs inside the worktree', () => {
    expect(status(path)).toEqual({ command: 'git status --porcelain', workdir: path, label: `status "${path}"` })
  })

  it('commitsAhead runs inside the worktree against the original head', () => {
    expect(commitsAhead(path, 'abc123')).toEqual({
      command: 'git rev-list --count \'abc123..HEAD\'',
      workdir: path,
      label: `count commits ahead of worktree "${path}"`,
    })
  })

  it('quotes single quotes inside interpolated arguments', () => {
    // The path segment is shell-escaped with the `'\''` idiom.
    expect(addWorktree(repo, 'o\'brien').command).toContain("'/repo/.claude/worktrees/o'\\''brien'")
  })
})
