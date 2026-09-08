import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { SettingsCascadeProvider, type Config, type EnvSettings } from '../src/index.ts'

// Concurrency gate for `node:fs/promises.readFile`. When armed, reads hang in
// a controlled deferred instead of hitting the disk, letting a test observe
// how many source reads are in flight before any completes. Disarmed (the
// default) it is a pure passthrough to the real implementation.
const gate = vi.hoisted(() => ({
  armed: false,
  pending: [] as Array<() => void>,
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile(path: Parameters<typeof actual.readFile>[0], options?: Parameters<typeof actual.readFile>[1]) {
      if (!gate.armed) return actual.readFile(path, options)
      return new Promise<string>((res) => gate.pending.push(() => res('{}')))
    },
  }
})

interface ThemeConfig {
  theme: string
  fontSize: number
}

const ThemeSchema: z<ThemeConfig> = z.object({
  theme: z.string().default('dark'),
  fontSize: z.number().default(14),
})

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cascade-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function boot(config: Config): Promise<Context> {
  // Pin every boot to a fresh non-git temp project dir: the default local
  // settings path now hoists via a git probe from the launch dir, and tests
  // run inside a git worktree — an unpinned cwd would load the real main
  // checkout's `.claude/settings.local.json`.
  const pinned = config.projectDir ?? (await tempDir())
  const ctx = new Context()
  const fiber = ctx.plugin(SettingsCascadeProvider, { ...config, projectDir: pinned })
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return ctx
}


/** Write a settings.json and return its path. */
async function writeSettings(dir: string, name: string, doc: unknown): Promise<string> {
  await mkdir(dir, { recursive: true })
  const path = join(dir, name)
  await writeFile(path, JSON.stringify(doc))
  return path
}

/** Resolved `ui-theme` section given a plugin default and a registered default. */
function themeOf(ctx: Context, base?: Partial<ThemeConfig>): ThemeConfig {
  const options: { base?: Partial<ThemeConfig> } = {}
  if (base !== undefined) options.base = base
  return ctx.settings.register('ui-theme' as SettingsNamespace, ThemeSchema, options)!.get() as ThemeConfig
}

describe('five-level precedence', () => {
  it('applies sources from low to high priority', async () => {
    const dir = await tempDir()
    const user = await writeSettings(dir, 'user.json', { 'ui-theme': { theme: 'user' } })
    const project = await writeSettings(dir, 'project.json', { 'ui-theme': { theme: 'project' } })
    const local = await writeSettings(dir, 'local.json', { 'ui-theme': { theme: 'local' } })
    const flag = await writeSettings(dir, 'flag.json', { 'ui-theme': { theme: 'flag' } })
    const policy = await writeSettings(dir, 'policy.json', { 'ui-theme': { theme: 'policy' } })

    const ctx = await boot({
      userSettingsPath: user,
      projectSettingsPath: project,
      localSettingsPath: local,
      flagSettingsPath: flag,
      policy: { userPath: policy },
    })
    // The namespace key must match the raw section key.
    const scope = ctx.settings.register('ui-theme' as SettingsNamespace, ThemeSchema)
    expect((scope.get() as ThemeConfig).theme).toBe('policy')
  })

  it('lets a higher source fill a missing key while lower keys survive', async () => {
    const dir = await tempDir()
    const user = await writeSettings(dir, 'user.json', { 'ui-theme': { theme: 'user', fontSize: 12 } })
    const project = await writeSettings(dir, 'project.json', { 'ui-theme': { fontSize: 20 } })
    const ctx = await boot({ userSettingsPath: user, projectSettingsPath: project })
    expect(themeOf(ctx)).toEqual({ theme: 'user', fontSize: 20 })
  })

  it('resolves plugin defaults below every file source', async () => {
    const dir = await tempDir()
    const user = await writeSettings(dir, 'user.json', { 'ui-theme': { theme: 'user' } })
    const ctx = await boot({ userSettingsPath: user })
    const scope = ctx.settings.register('ui-theme' as SettingsNamespace, ThemeSchema, {
      base: { fontSize: 18 },
    })
    expect(scope.get()).toEqual({ theme: 'user', fontSize: 18 })
  })

  it('resolves only defaults and base when every source is absent', async () => {
    const dir = await tempDir()
    const ctx = await boot({
      userSettingsPath: join(dir, 'missing-user.json'),
      projectSettingsPath: join(dir, 'missing-project.json'),
    })
    expect(themeOf(ctx)).toEqual({ theme: 'dark', fontSize: 14 })
  })
})

describe('flag settings', () => {
  it('merges inline flag settings above the flag file', async () => {
    const dir = await tempDir()
    const user = await writeSettings(dir, 'user.json', { 'ui-theme': { theme: 'user', fontSize: 12 } })
    const flagFile = await writeSettings(dir, 'flag.json', { 'ui-theme': { theme: 'flagfile' } })
    const ctx = await boot({
      userSettingsPath: user,
      flagSettingsPath: flagFile,
      flagSettingsInline: { 'ui-theme': { theme: 'inline' } },
    })
    expect(themeOf(ctx)).toEqual({ theme: 'inline', fontSize: 12 })
  })
})

describe('deny precedence across sources', () => {
  it('unions deny and removes denied rules from allow across sources', async () => {
    const dir = await tempDir()
    const user = await writeSettings(dir, 'user.json', {
      'ui-theme': { permissions: { allow: ['Bash(a)', 'Bash(b)'], deny: ['Bash(c)'] } },
    })
    const project = await writeSettings(dir, 'project.json', {
      'ui-theme': { permissions: { allow: ['Bash(c)'], deny: ['Bash(a)'] } },
    })
    const ctx = await boot({ userSettingsPath: user, projectSettingsPath: project })
    const value = themeOf(ctx) as ThemeConfig & { permissions: { allow: string[]; deny: string[] } }
    expect(value.permissions.allow).toEqual(['Bash(b)'])
    expect(value.permissions.deny).toEqual(['Bash(c)', 'Bash(a)'])
  })
})

describe('policy first-source-wins', () => {
  it('prefers remote over system over user policy sources', async () => {
    const dir = await tempDir()
    const system = await writeSettings(dir, 'system.json', { 'ui-theme': { theme: 'system' } })
    const user = await writeSettings(dir, 'policy-user.json', { 'ui-theme': { theme: 'policy-user' } })
    const ctx = await boot({
      policy: { remoteSettings: { 'ui-theme': { theme: 'remote' } }, systemPath: system, userPath: user },
    })
    expect(themeOf(ctx)).toEqual({ theme: 'remote', fontSize: 14 })
  })

  it('falls back to system when remote is empty', async () => {
    const dir = await tempDir()
    const system = await writeSettings(dir, 'system.json', { 'ui-theme': { theme: 'system' } })
    const user = await writeSettings(dir, 'policy-user.json', { 'ui-theme': { theme: 'policy-user' } })
    const ctx = await boot({
      policy: { remoteSettings: {}, systemPath: system, userPath: user },
    })
    expect(themeOf(ctx)).toEqual({ theme: 'system', fontSize: 14 })
  })

  it('falls back to user when remote and system are absent', async () => {
    const dir = await tempDir()
    const user = await writeSettings(dir, 'policy-user.json', { 'ui-theme': { theme: 'policy-user' } })
    const ctx = await boot({
      policy: { remoteSettings: {}, systemPath: join(dir, 'missing-system.json'), userPath: user },
    })
    expect(themeOf(ctx)).toEqual({ theme: 'policy-user', fontSize: 14 })
  })
})

describe('misconfiguration fails loud', () => {
  it('fails plugin load on an invalid user settings file', async () => {
    const dir = await tempDir()
    const bad = join(dir, 'bad.json')
    await writeFile(bad, '{ not valid json')
    await expect(boot({ userSettingsPath: bad })).rejects.toThrow()
  })

  it('fails plugin load on a non-object settings root', async () => {
    const dir = await tempDir()
    const bad = await writeSettings(dir, 'scalar.json', ['not', 'a', 'map'])
    await expect(boot({ userSettingsPath: bad })).rejects.toThrow()
  })

  it('fails with an error naming the single invalid file', async () => {
    const dir = await tempDir()
    const bad = join(dir, 'bad.json')
    await writeFile(bad, '{ not valid json')
    await expect(boot({ userSettingsPath: bad })).rejects.toThrow(bad)
  })
})

describe('parallel source loading', () => {
  // Records the env section split out of `load()` so the split behavior is
  // observable without reaching into the fiber tree.
  class ProbeCascade extends SettingsCascadeProvider {
    static lastEnv: EnvSettings | undefined
    protected override async load(): Promise<Record<string, unknown>> {
      const doc = await super.load()
      ProbeCascade.lastEnv = this.getEnv()
      return doc
    }
  }

  async function bootProbe(config: Config): Promise<Context> {
    const pinned = config.projectDir ?? (await tempDir())
    const ctx = new Context()
    const fiber = ctx.plugin(ProbeCascade, { ...config, projectDir: pinned })
    cleanups.push(async () => { await fiber.dispose() })
    await fiber
    return ctx
  }

  it('produces the same merged document and env split as serial loading', async () => {
    const dir = await tempDir()
    const user = await writeSettings(dir, 'user.json', { 'ui-theme': { theme: 'user', fontSize: 12 } })
    const local = await writeSettings(dir, 'local.json', { 'ui-theme': { theme: 'local' }, env: { LOCAL_VAR: '1' } })
    const flagFile = await writeSettings(dir, 'flag.json', { 'ui-theme': { theme: 'flagfile' } })
    // user layer intentionally absent; policy comes from inline remote settings.
    const ctx = await bootProbe({
      userSettingsPath: join(dir, 'missing-user.json'),
      localSettingsPath: local,
      flagSettingsPath: flagFile,
      flagSettingsInline: { 'ui-theme': { theme: 'inline' } },
      policy: { remoteSettings: { 'ui-theme': { fontSize: 30 }, env: { POLICY_VAR: '2' } } },
    })
    // Highest layer wins per key; lower layers still fill missing keys.
    expect(themeOf(ctx)).toEqual({ theme: 'inline', fontSize: 30 })
    // Top-level `env` is split out of the merged document, string-coerced.
    expect(ProbeCascade.lastEnv).toEqual({ LOCAL_VAR: '1', POLICY_VAR: '2' })
  })

  it('reads multiple sources concurrently before any completes', async () => {
    const dir = await tempDir()
    const user = await writeSettings(dir, 'user.json', { 'ui-theme': { theme: 'user' } })
    const project = await writeSettings(dir, 'project.json', { 'ui-theme': { theme: 'project' } })
    const local = await writeSettings(dir, 'local.json', { 'ui-theme': { theme: 'local' } })
    const flag = await writeSettings(dir, 'flag.json', { 'ui-theme': { theme: 'flag' } })

    gate.armed = true
    try {
      const bootPromise = boot({ userSettingsPath: user, projectSettingsPath: project, localSettingsPath: local, flagSettingsPath: flag })
      // Without completing any read, more than one read must already be in flight.
      await expect.poll(() => gate.pending.length, { timeout: 1000 }).toBeGreaterThanOrEqual(2)
      while (gate.pending.length > 0) gate.pending.pop()!()
      await bootPromise
    } finally {
      gate.armed = false
    }
  })

  it('still fails loud on a single invalid source with the same error identity', async () => {
    const dir = await tempDir()
    const bad = join(dir, 'bad.json')
    await writeFile(bad, '{ not valid json')
    await expect(boot({ userSettingsPath: bad })).rejects.toThrow(
      `settings-cascade: invalid settings document at ${bad}:`,
    )
  })

  it('rejects on multiple invalid sources with one of their paths (fail loud)', async () => {
    const dir = await tempDir()
    const badUser = join(dir, 'bad-user.json')
    const badProject = join(dir, 'bad-project.json')
    await writeFile(badUser, '{ nope')
    await writeFile(badProject, '{ nope')
    // Promise.all surfaces whichever invalid source rejects first in time —
    // serial loading surfaced the lowest layer — but the load must still fail.
    await expect(boot({ userSettingsPath: badUser, projectSettingsPath: badProject })).rejects.toThrow(
      new RegExp(`invalid settings document at (${badUser}|${badProject})`),
    )
  })
})
