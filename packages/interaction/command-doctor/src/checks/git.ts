/**
 * `git` checks for `/doctor`: a verbose-only filesystem probe of the working
 * tree (worktree vs main checkout), plus an optional shell-based branch probe.
 * @module @dsh-cc/command-doctor/checks/git
 */

import { lstatSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { Check } from '../report.ts'

/** Filesystem git facts shared with the mcp group's Serena cross-note. */
export interface GitInfo {
  /** Whether the cwd is a git worktree (`.git` is a file). */
  readonly worktree: boolean
  /** Whether cwd contains a `.git` entry at all. */
  readonly isRepo: boolean
  /** Whether cwd contains `node_modules`. */
  readonly hasNodeModules: boolean
  /** Whether cwd contains a `.serena` directory. */
  readonly hasSerena: boolean
}

/** Read the filesystem git facts for cwd (safe in tests; no subprocess). */
export function gitInfo(cwd: string = process.cwd()): GitInfo {
  let worktree = false
  let isRepo = false
  try {
    const stat = lstatSync(`${cwd}/.git`)
    isRepo = true
    worktree = stat.isFile()
  } catch {
    isRepo = false
  }
  let hasNodeModules = false
  try {
    hasNodeModules = lstatSync(`${cwd}/node_modules`) !== undefined
  } catch {
    hasNodeModules = false
  }
  let hasSerena = false
  try {
    hasSerena = lstatSync(`${cwd}/.serena`).isDirectory()
  } catch {
    hasSerena = false
  }
  return { worktree, isRepo, hasNodeModules, hasSerena }
}

/** Collect the git group checks. */
export async function gitChecks(ctx: Context, options: { verbose: boolean; cwd?: string }): Promise<Check[]> {
  if (!options.verbose) {
    return [{
      id: 'git.worktree',
      group: 'git',
      status: 'skip',
      summary: 'not probed (use --verbose)',
    }]
  }
  const cwd = options.cwd ?? process.cwd()
  const info = gitInfo(cwd)
  if (!info.isRepo) {
    return [{
      id: 'git.worktree',
      group: 'git',
      status: 'skip',
      summary: 'not a git repo',
      evidence: { cwd },
    }]
  }
  const checks: Check[] = [{
    id: 'git.worktree',
    group: 'git',
    status: info.worktree ? 'info' : 'ok',
    summary: info.worktree ? 'worktree (linked checkout)' : 'main checkout',
    detail: await branchDetail(ctx),
    evidence: { cwd, worktree: info.worktree },
  }]
  if (info.worktree && !info.hasNodeModules) {
    checks.push({
      id: 'git.worktree-deps',
      group: 'git',
      status: 'warn',
      summary: 'worktree has no node_modules',
      fix: 'run the package manager install in this worktree',
      evidence: { cwd },
    })
  }
  return checks
}

/** Optional one-second branch probe through a mounted shell seam. */
async function branchDetail(ctx: Context): Promise<string | undefined> {
  const shell = ctx.get('shell') as
    | {
        run?(command: string, options?: { timeout?: number }): Promise<{ stdout?: string }>
        exec?(command: string, options?: { timeout?: number }): Promise<{ stdout?: string }>
      }
    | undefined
  const run = shell?.run?.bind(shell) ?? shell?.exec?.bind(shell)
  if (run === undefined) return undefined
  try {
    const result = await Promise.race([
      run('git rev-parse --abbrev-ref HEAD', { timeout: 1000 }),
      new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 1000)),
    ])
    const branch = result?.stdout?.trim()
    return branch === undefined || branch.length === 0 ? undefined : `branch ${branch}`
  } catch {
    return undefined
  }
}
