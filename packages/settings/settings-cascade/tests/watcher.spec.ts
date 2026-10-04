import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsConflictError } from '@dsh-cc/settings-provider'
import type { SettingsNamespace } from '@dsh-cc/settings-provider'
import { SettingsCascadeProvider, type Config } from '../src/index.ts'

// TIMEOUT-BUDGET: keep byte-identical across spec files.
// scale: DSH_TEST_TIMEOUT_SCALE (debug override), else 2 on GitHub Actions, else 1.
// Must be an integer in [1,4]; anything else → 1. Values >2 exceed what R4 was sized for.
const raw = Number(process.env.DSH_TEST_TIMEOUT_SCALE ?? (process.env.CI === 'true' ? 2 : 1))
const scale = Number.isInteger(raw) && raw >= 1 && raw <= 4 ? raw : 1

/** Outer budget for tests whose sequential waits fit a default 15s outer. */
const OUTER_STD_MS = 15_000
/** Outer budget for the malformed-JSON test: setup ~2s + 3 scaled waits (5s×scale each) + headroom. */
const OUTER_MALFORMED_MS = 45_000
/** Outer budget for the self-write dedup test: setup ~2s + 2 scaled waits (5s×scale each) + headroom. */
const OUTER_SELF_WRITE_MS = 30_000

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
    }, { timeout: 5_000 * scale })
  }, OUTER_STD_MS)

  it('coalesces rapid consecutive writes into few reloads', async () => {
    // The 2s write-settle window makes this test deterministic: the watcher
    // must coalesce the burst into one reload instead of firing per write.
    // No wall-clock sleeps — completion is observed via the settle drain.
    const ctx = await boot({ watch: { stabilityThresholdMs: 2000 } })
    const scope = theme(ctx)
    const counter = commitCounter(ctx)
    const provider = ctx.settings as unknown as { settled(): Promise<void> }

    for (let i = 0; i < 5; i++) {
      await writeDoc(userPath(ctx), { 'ui-theme': { theme: `tone-${i}` } })
    }
    await vi.waitFor(() => {
      expect(scope.get().theme).toBe('tone-4')
    }, { timeout: 5_000 * scale })
    // Let the coalesced reload (and any trailing one) fully land before
    // counting: the operations-chain tail settles when the queue is drained.
    await provider.settled()
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
    }, { timeout: 5_000 * scale })
  }, OUTER_STD_MS)

  it('keeps the last good document on malformed JSON and recovers on the fix', async () => {
    const ctx = await boot()
    await writeDoc(userPath(ctx), { 'ui-theme': { theme: 'light' } })
    const scope = theme(ctx)
    await vi.waitFor(() => {
      expect(scope.get().theme).toBe('light')
    }, { timeout: 5_000 * scale })
    const warnSpy = vi.spyOn(ctx.logger, 'warn')

    await writeFile(userPath(ctx), '{not json')
    // Completion signal, not a hope-sleep: the malformed reload fails into
    // the queueRefresh catch path, which warns and keeps the last good
    // document. Waiting for that warn proves the malformed document was
    // actually processed before we assert the last good state survived.
    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith('settings-cascade: reload failed; keeping the last good document')
    }, { timeout: 5_000 * scale })
    expect(scope.get().theme).toBe('light')

    await writeDoc(userPath(ctx), { 'ui-theme': { theme: 'recovered' } })
    await vi.waitFor(() => {
      expect(scope.get().theme).toBe('recovered')
    }, { timeout: 5_000 * scale })
  }, OUTER_MALFORMED_MS)

  it('does not thrash revisions on its own persisted write', async () => {
    const ctx = await boot()
    const scope = theme(ctx)
    await writeDoc(userPath(ctx), { 'ui-theme': { theme: 'seed' } })
    await vi.waitFor(() => {
      expect(scope.get().theme).toBe('seed')
    }, { timeout: 5_000 * scale })
    const counter = commitCounter(ctx)
    // Dedup-completion seam (D3): each watcher-triggered reload runs exactly
    // one `load()` on the operation chain. Counting loads after the seed
    // reload observes that the self-write event ARRIVED and was handled;
    // the subsequent `settled()` drain proves its publish (and therefore the
    // dedup verdict) finished. No product-visible hook needed.
    const providerInternals = ctx.settings as unknown as {
      load(): Promise<unknown>
      settled(): Promise<void>
    }
    const loadSpy = vi.spyOn(providerInternals, 'load')
    const revisionAt = (): number =>
      (ctx.settings.describe() as Array<{ ns: string; revision: number }>)
        .find(d => d.ns === 'ui-theme')!.revision

    await scope.update({ theme: 'darker' })
    expect(scope.get().theme).toBe('darker')
    const settledRevision = revisionAt()

    // The write's own watcher event reloads the same document: the commit
    // dedup keeps the revision from bumping again. Wait for that reload to
    // be observed AND for the operation chain to drain before judging.
    await vi.waitFor(() => {
      expect(loadSpy.mock.calls.length).toBeGreaterThanOrEqual(1)
    }, { timeout: 5_000 * scale })
    await providerInternals.settled()
    expect(revisionAt()).toBe(settledRevision)
    expect(counter.commits()).toBe(1)
    // Document and persisted user layer converge.
    expect(await readDoc(userPath(ctx))).toMatchObject({ 'ui-theme': { theme: 'darker' } })
    counter.stop()
  }, OUTER_SELF_WRITE_MS)

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
    }, { timeout: 5_000 * scale })
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
    // Bounded NEGATIVE window, not a completion signal: after dispose the
    // provider must never reload, and absence cannot be awaited — we can
    // only observe that nothing fired within this fixed, named window.
    const TEARDOWN_NEGATIVE_WINDOW_MS = 400
    await new Promise(resolve => setTimeout(resolve, TEARDOWN_NEGATIVE_WINDOW_MS))
    expect(scope.get()).toEqual({ theme: 'dark', fontSize: 14 })
    expect(counter.commits()).toBe(0)
    counter.stop()
  }, 15000)
})
