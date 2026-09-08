import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { SettingsCascadeProvider, type Config } from '../src/index.ts'

// Concurrency gate for `node:fs/promises.readFile`. When armed, the next read
// hangs in a controlled deferred instead of hitting the disk, letting a test
// land an external edit between the provider's read and its write. Disarmed
// (the default) it is a pure passthrough to the real implementation.
const readGate = vi.hoisted(() => ({
  held: 0,
  waiters: [] as Array<() => void>,
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile(path: Parameters<typeof actual.readFile>[0], options?: Parameters<typeof actual.readFile>[1]) {
      if (readGate.held > 0) {
        readGate.held -= 1
        return new Promise<string>((res) => {
          readGate.waiters.push(() => { void res(actual.readFile(path, options)) })
        })
      }
      return actual.readFile(path, options)
    },
  }
})

/** Release every read the gate is holding. */
function drainReadGate(): void {
  const waiters = readGate.waiters
  readGate.waiters = []
  for (const waiter of waiters) waiter()
}

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
  drainReadGate()
  readGate.held = 0
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** Boot the cascade pinned to a fresh temp home and project, with no flag layer. */
async function boot(config: Partial<Config> = {}): Promise<Context> {
  const home = config.dshHome ?? await tempDir('dsh-cascade-watch-home-')
  const projectDir = config.projectDir ?? await tempDir('dsh-cascade-watch-proj-')
  const ctx = new Context()
  const fiber = ctx.plugin(SettingsCascadeProvider, {
    dshHome: home,
    projectDir,
    userSettingsPath: join(home, 'settings.json'),
    projectSettingsPath: join(projectDir, '.claude', 'settings.json'),
    localSettingsPath: join(projectDir, '.claude', 'settings.local.json'),
    ...config,
  })
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return ctx
}

/** Create the parent directory, then write one JSON settings document. */
async function writeDoc(path: string, doc: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(doc))
}

/** The cascade's user settings file path (the write-through layer). */
function userPath(ctx: Context): string {
  return (ctx.settings as unknown as { documentPath: string }).documentPath
}

/** Count `settings/updated` commits observed from now on. */
function commitCounter(ctx: Context): { commits: () => number; stop: () => void } {
  let count = 0
  const stop = ctx.on('settings/updated', () => { count += 1 })
  return { commits: () => count, stop }
}

/** Parse a settings file on disk into a plain object. */
async function readDoc(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

/** Resolved `ui-theme` registration for read/update access. */
function theme(ctx: Context) {
  return ctx.settings.register('ui-theme' as SettingsNamespace, ThemeSchema)
}

describe('settings cascade hot reload', () => {
  it('hot-reloads an external edit of the user settings file into a registered consumer', async () => {
    const ctx = await boot()
    const scope = theme(ctx)
    expect(scope.get()).toEqual({ theme: 'dark', fontSize: 14 })

    await writeDoc(userPath(ctx), { 'ui-theme': { theme: 'light' } })
    await vi.waitFor(() => {
      expect(scope.get().theme).toBe('light')
    }, { timeout: 3000 })
  }, 15000)

  it('coalesces rapid consecutive writes into few reloads', async () => {
    const ctx = await boot()
    const scope = theme(ctx)
    const counter = commitCounter(ctx)

    // Five distinct values inside one write-settle window: the watcher's
    // awaitWriteFinish debounce must fold them into at most a couple of
    // reloads instead of one per write.
    for (let i = 0; i < 5; i++) {
      await writeDoc(userPath(ctx), { 'ui-theme': { theme: `tone-${i}` } })
    }
    await vi.waitFor(() => {
      expect(scope.get().theme).toBe('tone-4')
    }, { timeout: 3000 })
    // Let any trailing reloads land before counting.
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(counter.commits()).toBeLessThan(5)
    counter.stop()
  }, 15000)

  it('picks up a project settings file created after boot', async () => {
    const projectDir = await tempDir('dsh-cascade-watch-proj-')
    const ctx = await boot({ projectDir })
    const scope = theme(ctx)
    expect(scope.get()).toEqual({ theme: 'dark', fontSize: 14 })

    await writeDoc(join(projectDir, '.claude', 'settings.json'), { 'ui-theme': { theme: 'project' } })
    await vi.waitFor(() => {
      expect(scope.get().theme).toBe('project')
    }, { timeout: 3000 })
  }, 15000)

  it('keeps the last good document on malformed JSON and recovers on the fix', async () => {
    const ctx = await boot()
    await writeDoc(userPath(ctx), { 'ui-theme': { theme: 'light' } })
    const scope = theme(ctx)
    await vi.waitFor(() => {
      expect(scope.get().theme).toBe('light')
    }, { timeout: 3000 })

    await writeFile(userPath(ctx), '{not json')
    // The malformed reload fails into the warn-and-keep path; the last good
    // document stays published.
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(scope.get().theme).toBe('light')

    await writeDoc(userPath(ctx), { 'ui-theme': { theme: 'recovered' } })
    await vi.waitFor(() => {
      expect(scope.get().theme).toBe('recovered')
    }, { timeout: 3000 })
  }, 15000)

  it('does not thrash revisions on its own persisted write', async () => {
    const ctx = await boot()
    const scope = theme(ctx)
    await writeDoc(userPath(ctx), { 'ui-theme': { theme: 'seed' } })
    await vi.waitFor(() => {
      expect(scope.get().theme).toBe('seed')
    }, { timeout: 3000 })
    const counter = commitCounter(ctx)
    const revisionAt = (): number =>
      (ctx.settings.describe() as Array<{ ns: string; revision: number }>)
        .find(d => d.ns === 'ui-theme')!.revision

    await scope.update({ theme: 'darker' })
    expect(scope.get().theme).toBe('darker')
    const settled = revisionAt()

    // The write's own watcher event reloads the same document: the commit
    // dedup keeps the revision from bumping again.
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(revisionAt()).toBe(settled)
    expect(counter.commits()).toBe(1)
    // Document and persisted user layer converge.
    expect(await readDoc(userPath(ctx))).toMatchObject({ 'ui-theme': { theme: 'darker' } })
    counter.stop()
  }, 15000)

  it('preserves an external edit that lands during an in-flight persist', async () => {
    const ctx = await boot()
    const scope = theme(ctx)
    await scope.update({ theme: 'seed' })
    // Hold the next source read inside the persist operation so an external
    // write can land between the read and the atomic rename.
    readGate.held = 1
    const pending = scope.update({ theme: 'darker' })
    await writeDoc(userPath(ctx), {
      'ui-theme': { theme: 'seed' },
      'ui-font': { fontSize: 20 },
    })
    drainReadGate()
    await pending

    // The persisted document carries BOTH the persist intent and the
    // external namespace the gate let slip in mid-flight.
    expect(await readDoc(userPath(ctx))).toMatchObject({
      'ui-theme': { theme: 'darker' },
      'ui-font': { fontSize: 20 },
    })
  }, 15000)

  it('rejects a stale-revision write after an external edit with SettingsConflictError', async () => {
    const ctx = await boot()
    const scope = theme(ctx)
    const revisionAt = (): number =>
      (ctx.settings.describe() as Array<{ ns: string; revision: number }>)
        .find(d => d.ns === 'ui-theme')!.revision
    expect(revisionAt()).toBe(0)

    // The external edit bumps the registration revision through the reload.
    await writeDoc(userPath(ctx), { 'ui-theme': { theme: 'external' } })
    await vi.waitFor(() => {
      expect(scope.get().theme).toBe('external')
    }, { timeout: 3000 })
    expect(revisionAt()).toBe(1)

    await expect(
      ctx.settings.update('ui-theme' as SettingsNamespace, { theme: 'stale' }, 0),
    ).rejects.toThrow(SettingsConflictError)
  }, 15000)

  it('ignores edits after teardown', async () => {
    const projectDir = await tempDir('dsh-cascade-watch-proj-')
    const home = await tempDir('dsh-cascade-watch-home-')
    const ctx = new Context()
    const fiber = ctx.plugin(SettingsCascadeProvider, {
      dshHome: home,
      projectDir,
      userSettingsPath: join(home, 'settings.json'),
      projectSettingsPath: join(projectDir, '.claude', 'settings.json'),
      localSettingsPath: join(projectDir, '.claude', 'settings.local.json'),
    })
    await fiber
    const scope = ctx.settings.register('ui-theme' as SettingsNamespace, ThemeSchema)
    expect(scope.get()).toEqual({ theme: 'dark', fontSize: 14 })
    const counter = commitCounter(ctx)

    await fiber.dispose()
    await writeDoc(join(home, 'settings.json'), { 'ui-theme': { theme: 'post-dispose' } })
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(scope.get()).toEqual({ theme: 'dark', fontSize: 14 })
    expect(counter.commits()).toBe(0)
    counter.stop()
  }, 15000)
})
