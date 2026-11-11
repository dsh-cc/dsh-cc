import { afterEach, describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { __clearLocalRootCache } from '../src/cascade/local-root.ts'
import { resolveSpec, type Config } from '../src/cascade/index.ts'
import type { LocalRootDeps } from '../src/cascade/local-root.ts'

afterEach(() => {
  __clearLocalRootCache()
})

const worktreeExec = (top: string, commonDir: string) => (argv: readonly string[]) => {
  if (argv[1] === '--show-toplevel') return { stdout: top }
  if (argv[1] === '--git-common-dir') return { stdout: commonDir }
  return undefined
}

describe('resolveSpec hoisting', () => {
  it('defaults projectSettings to the launch dir even when local hoists', () => {
    const config: Config = { projectDir: '/repo/.claude/worktrees/feat' }
    const deps: LocalRootDeps = { exec: worktreeExec('/repo/.claude/worktrees/feat', '/repo/.git'), getuid: () => 0, stat: () => ({ uid: 0 }) }
    const spec = resolveSpec(config, deps)
    expect(spec.sources.projectSettings).toBe(join(resolve('/repo/.claude/worktrees/feat'), '.claude', 'settings.json'))
    expect(spec.sources.localSettings).toBe(join(resolve('/repo'), '.claude', 'settings.local.json'))
  })

  it('explicit localSettingsPath wins (no hoist)', () => {
    const config: Config = { projectDir: '/repo/wt', localSettingsPath: '/custom/local.json' }
    const deps: LocalRootDeps = { exec: worktreeExec('/repo/wt', '/repo/.git') }
    const spec = resolveSpec(config, deps)
    expect(spec.sources.localSettings).toBe('/custom/local.json')
  })

  it('explicit projectSettingsPath wins', () => {
    const config: Config = { projectDir: '/repo', projectSettingsPath: '/custom/project.json' }
    const spec = resolveSpec(config)
    expect(spec.sources.projectSettings).toBe('/custom/project.json')
  })

  it('passes resolve(projectDir) as the exec cwd', () => {
    const seen: string[] = []
    const deps: LocalRootDeps = {
      exec: (_argv, cwd) => {
        seen.push(cwd)
        return undefined
      },
    }
    resolveSpec({ projectDir: 'rel/dir' }, deps)
    expect(seen).toEqual([resolve('rel/dir')])
  })

  it('falls back to cwd when not a git repo', () => {
    const config: Config = { projectDir: '/plain' }
    const deps: LocalRootDeps = { exec: () => undefined }
    const spec = resolveSpec(config, deps)
    expect(spec.sources.localSettings).toBe(join(resolve('/plain'), '.claude', 'settings.local.json'))
  })
})
