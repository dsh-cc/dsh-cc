import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { SettingsCascadeProvider, type Config } from '../src/index.ts'

const StatusLineSchema: z<{ type: string; command: string }> = z.object({
  type: z.string(),
  command: z.string(),
})

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cc-alias-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function boot(config: Config): Promise<Context> {
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

/** Resolved `statusline` section through the CC-key alias. */
function statusLineOf(ctx: Context): { type: string; command: string } {
  return ctx.settings.register('statusline' as SettingsNamespace, StatusLineSchema)!.get() as { type: string; command: string }
}

describe('CC-key aliasing', () => {
  it('resolves a top-level camelCase `statusLine` key through the kebab namespace', async () => {
    const dir = await tempDir()
    const user = await writeSettings(dir, 'user.json', {
      statusLine: { type: 'command', command: 'echo hi' },
    })
    const ctx = await boot({ userSettingsPath: user })
    expect(statusLineOf(ctx)).toEqual({ type: 'command', command: 'echo hi' })
  })

  it('deep-merges sub-keys across two layers under the CC key', async () => {
    const dir = await tempDir()
    const user = await writeSettings(dir, 'user.json', {
      statusLine: { type: 'command', command: 'user.sh', padding: 2 },
    })
    const project = await writeSettings(dir, 'project.json', {
      statusLine: { command: 'project.sh' },
    })
    const ctx = await boot({ userSettingsPath: user, projectSettingsPath: project })
    expect(statusLineOf(ctx)).toEqual({ type: 'command', command: 'project.sh', padding: 2 })
  })

  it('prefers the dsh-native kebab key when both are present', async () => {
    const dir = await tempDir()
    const user = await writeSettings(dir, 'user.json', {
      statusLine: { type: 'command', command: 'cc.sh' },
      statusline: { type: 'command', command: 'dsh.sh' },
    })
    const ctx = await boot({ userSettingsPath: user })
    expect(statusLineOf(ctx)).toEqual({ type: 'command', command: 'dsh.sh' })
  })

  it('ignores non-object CC values', async () => {
    const dir = await tempDir()
    const user = await writeSettings(dir, 'user.json', { statusLine: 'nope' })
    const ctx = await boot({ userSettingsPath: user })
    const scope = ctx.settings.register('statusline' as SettingsNamespace, z.object({
      type: z.string().default('command'),
      command: z.string().default(''),
    }))
    // The scalar CC value must not leak through as the section.
    expect(scope!.get()).toEqual({ type: 'command', command: '' })
  })

  it('keeps the alias stable when persisting an unrelated namespace', async () => {
    const dir = await tempDir()
    const user = await writeSettings(dir, 'user.json', {
      statusLine: { type: 'command', command: 'echo hi' },
    })
    const ctx = await boot({ userSettingsPath: user })
    const scope = ctx.settings.register('statusline' as SettingsNamespace, StatusLineSchema)
    expect(scope!.get()).toEqual({ type: 'command', command: 'echo hi' })
    const theme = ctx.settings.register('ui-theme' as SettingsNamespace, z.object({ theme: z.string().default('dark') }))
    await ctx.settings.update('ui-theme' as SettingsNamespace, { theme: 'light' })
    expect(theme!.get()).toEqual({ theme: 'light' })
    // The aliased section still resolves to the same value afterwards.
    // And the user file kept the original CC key intact.
    const onDisk = JSON.parse(await readFileAsString(user))
    expect(onDisk.statusLine).toEqual({ type: 'command', command: 'echo hi' })
  })
})

async function readFileAsString(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return readFile(path, 'utf8')
}
