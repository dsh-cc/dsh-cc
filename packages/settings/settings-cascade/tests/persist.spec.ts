import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { SettingsCascadeProvider, type Config } from '../src/index.ts'
import { applyOpsToSection, diffSections } from '../src/persist.ts'

// Concurrency gate for `node:fs/promises.readFile` (same pattern as
// watcher.spec.ts): when armed, the next read hangs in a controlled deferred
// instead of hitting the disk, letting the test interleave a watcher reload
// with a queued persist. Disarmed (the default) it is a pure passthrough.
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

/**
 * Persistence contract of the writable cascade: writes travel the seam and are
 * persisted as a surgical leaf-delta onto the user layer, so higher-layer
 * (project/local/flag/policy) contributions never leak into the user file.
 * These specs drive the provider through the real seam and assert on the user
 * file on disk, plus cover the pure `persist.ts` diff/apply helpers directly.
 */

/** Permissive schema: pass the registered section through unchanged. */
const Passthrough: z<Record<string, unknown>> = z.any()

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  drainReadGate()
  readGate.held = 0
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cascade-persist-'))
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

/** Parse a settings file on disk into a plain object. */
async function readDoc(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

/** Register a permissive namespace schema so the seam accepts writes to it. */
function register(ctx: Context, ns: string): void {
  ctx.settings.register(ns as SettingsNamespace, Passthrough)
}

describe('writable surface', () => {
  it('is writable and creates an absent user file with mode 0o600', async () => {
    const dir = await tempDir()
    const user = join(dir, 'user.json')
    const ctx = await boot({ userSettingsPath: user })
    register(ctx, 'persist-a')

    expect(ctx.settings.writable).toBe(true)
    await ctx.settings.update('persist-a' as SettingsNamespace, { K: 'v' })

    expect(statSync(user).mode & 0o777).toBe(0o600)
    expect(await readDoc(user)).toEqual({ 'persist-a': { K: 'v' } })
  })

  it('preserves sibling namespaces and unknown keys across a write', async () => {
    const dir = await tempDir()
    const user = await writeSettings(dir, 'user.json', {
      'persist-b': { a: 1 },
      sibling: { s: 'kept' },
      'other:key': 42,
    })
    const ctx = await boot({ userSettingsPath: user })
    register(ctx, 'persist-b')

    expect(ctx.settings.documentPath).toBe(user)
    expect(await ctx.settings.prepareDocument()).toBe(user)
    expect(await ctx.settings.prepareDocument()).toBe(user)

    await ctx.settings.update('persist-b' as SettingsNamespace, { b: 2 })

    expect(await readDoc(user)).toEqual({
      'persist-b': { a: 1, b: 2 },
      sibling: { s: 'kept' },
      'other:key': 42,
    })
  })
})

describe('surgical delta', () => {
  it('writes only the changed key, not project-layer siblings', async () => {
    const dir = await tempDir()
    const user = join(dir, 'user.json')
    const project = await writeSettings(dir, 'project.json', { 'persist-c': { A: 'pa' } })
    const ctx = await boot({ userSettingsPath: user, projectSettingsPath: project })
    register(ctx, 'persist-c')

    await ctx.settings.update('persist-c' as SettingsNamespace, { B: 'sec' })

    const doc = await readDoc(user)
    expect(doc).toEqual({ 'persist-c': { B: 'sec' } })
    expect((doc['persist-c'] as Record<string, unknown>)).not.toHaveProperty('A')
  })

  it('advances the shadow so a second delta does not repeat the first op', async () => {
    const dir = await tempDir()
    const user = join(dir, 'user.json')
    const ctx = await boot({ userSettingsPath: user })
    register(ctx, 'persist-d')

    await ctx.settings.update('persist-d' as SettingsNamespace, { B: 'b' })
    await ctx.settings.update('persist-d' as SettingsNamespace, { C: 'c' })

    const doc = await readDoc(user)
    expect(doc).toEqual({ 'persist-d': { B: 'b', C: 'c' } })
    expect((doc['persist-d'] as Record<string, unknown>).B).toBe('b')
  })

  it('keeps a failed persist from folding into the next delta', async () => {
    const dir = await tempDir()
    const user = join(dir, 'user.json')
    const ctx = await boot({ userSettingsPath: user })
    register(ctx, 'persist-e')

    await ctx.settings.update('persist-e' as SettingsNamespace, { C: 'c' })

    await writeFile(user, '{ broken json')
    await expect(ctx.settings.update('persist-e' as SettingsNamespace, { D: 'd' })).rejects.toThrow()
    expect(await readFile(user, 'utf8')).toBe('{ broken json')

    await writeFile(user, '{}')
    await ctx.settings.update('persist-e' as SettingsNamespace, { D: 'd' })

    expect(await readDoc(user)).toEqual({ 'persist-e': { D: 'd' } })
  })

  it('a watcher reload between capture and persist does not re-emit keys the file already had', async () => {
    const dir = await tempDir()
    const user = join(dir, 'user.json')
    const ctx = await boot({ userSettingsPath: user })
    const ns = 'persist-g' as SettingsNamespace
    register(ctx, 'persist-g')

    // (1) A successful write seeds both the file and the shadow with C.
    await ctx.settings.update(ns, { C: 'c' })
    expect(await readDoc(user)).toEqual({ 'persist-g': { C: 'c' } })

    // (2)-(3) A failed persist leaves the shadow at {C:'c'} while the seam's
    // in-memory document still carries C.
    await writeFile(user, '{ broken json')
    await expect(ctx.settings.update(ns, { D: 'd' })).rejects.toThrow()

    // (4) The file is repaired externally to '{}'.
    await writeFile(user, '{}')

    // (5)-(6) Queue a watcher reload and let it start so IT holds the gated
    // read; then start a persist WITHOUT awaiting it: the harness captures
    // the section {C:'c',D:'d'} (its in-memory doc still has C) and the
    // persist lands in the queue behind the reload.
    readGate.held = 1
    const provider = ctx.settings as unknown as { queueRefresh(): void }
    provider.queueRefresh()
    await new Promise(resolve => setImmediate(resolve))
    const pending = ctx.settings.update(ns, { D: 'd' })
    await vi.waitFor(() => {
      expect(readGate.waiters.length).toBe(1)
    }, { timeout: 3000 })

    // (7) Release the reload's held source read so the reload publishes the
    // repaired '{}' — resetting the LIVE shadow — before the queued persist
    // executes. The diff base must be the one frozen at capture time
    // ({C:'c'}), so the delta is exactly {D:'d'}.
    drainReadGate()
    await pending

    // (8) The file must carry ONLY D: the reload reset the live shadow, but
    // the persist's diff base was captured before it.
    expect(await readDoc(user)).toEqual({ 'persist-g': { D: 'd' } })
  })
})

describe('unset', () => {
  it('leaves the user file unchanged when unsetting a project-only key', async () => {
    const dir = await tempDir()
    const user = await writeSettings(dir, 'user.json', { sibling: { s: 'kept' } })
    const project = await writeSettings(dir, 'project.json', { 'persist-f1': { A: 'pa' } })
    const ctx = await boot({ userSettingsPath: user, projectSettingsPath: project })
    register(ctx, 'persist-f1')

    await ctx.settings.mutate('persist-f1' as SettingsNamespace, [{ op: 'unset', path: ['A'] }])

    expect(await readDoc(user)).toEqual({ sibling: { s: 'kept' } })
  })

  it('removes a user-layer key from the user file on unset', async () => {
    const dir = await tempDir()
    const user = await writeSettings(dir, 'user.json', { 'persist-f2': { u: 'x' } })
    const ctx = await boot({ userSettingsPath: user })
    register(ctx, 'persist-f2')

    await ctx.settings.mutate('persist-f2' as SettingsNamespace, [{ op: 'unset', path: ['u'] }])

    const doc = await readDoc(user)
    expect((doc['persist-f2'] as Record<string, unknown>)).not.toHaveProperty('u')
  })
})

describe('replace mode', () => {
  it('unsets user-layer keys omitted by replace, leaving project keys untouched', async () => {
    const dir = await tempDir()
    const user = await writeSettings(dir, 'user.json', { 'persist-g': { B: 'ub', C: 'uc' } })
    const project = await writeSettings(dir, 'project.json', { 'persist-g': { P: 'pp' } })
    const ctx = await boot({ userSettingsPath: user, projectSettingsPath: project })
    register(ctx, 'persist-g')

    await ctx.settings.replace('persist-g' as SettingsNamespace, { C: 'uc2' })

    const doc = await readDoc(user)
    expect(doc['persist-g']).toEqual({ C: 'uc2' })
  })
})

describe('scalar/object conflict', () => {
  it('replaces a scalar leaf with an object wholesale', async () => {
    const dir = await tempDir()
    const user = await writeSettings(dir, 'user.json', { 'persist-h1': { k: 'scalar' } })
    const ctx = await boot({ userSettingsPath: user })
    register(ctx, 'persist-h1')

    await ctx.settings.update('persist-h1' as SettingsNamespace, { k: { deep: 1 } })

    const doc = await readDoc(user)
    expect(doc['persist-h1']).toEqual({ k: { deep: 1 } })
  })

  it('replaces an object leaf with a scalar wholesale', async () => {
    const dir = await tempDir()
    const user = await writeSettings(dir, 'user.json', { 'persist-h2': { k: { deep: 1 } } })
    const ctx = await boot({ userSettingsPath: user })
    register(ctx, 'persist-h2')

    await ctx.settings.update('persist-h2' as SettingsNamespace, { k: 'scalar' })

    const doc = await readDoc(user)
    expect(doc['persist-h2']).toEqual({ k: 'scalar' })
  })
})

describe('reboot consistency', () => {
  it('round-trips persisted user-layer values across a fresh boot', async () => {
    const dir = await tempDir()
    const user = join(dir, 'user.json')
    const config: Config = { userSettingsPath: user, projectDir: dir }

    const ctx1 = new Context()
    const fiber1 = ctx1.plugin(SettingsCascadeProvider, config)
    await fiber1
    register(ctx1, 'persist-i')
    await ctx1.settings.update('persist-i' as SettingsNamespace, { a: 1, n: { deep: 1 } })
    await fiber1.dispose()

    const ctx2 = new Context()
    const fiber2 = ctx2.plugin(SettingsCascadeProvider, config)
    await fiber2
    const scope = ctx2.settings.register('persist-i' as SettingsNamespace, Passthrough)
    expect(scope.get()).toEqual({ a: 1, n: { deep: 1 } })
    expect(await readDoc(user)).toEqual({ 'persist-i': { a: 1, n: { deep: 1 } } })
    await fiber2.dispose()
  })
})

describe('persist.ts pure functions', () => {
  it('diffSections emits no op for equal leaves and set/unset for changes', () => {
    expect(diffSections({ a: 1 }, { a: 1 })).toEqual([])
    expect(diffSections({}, {})).toEqual([])
    expect(diffSections({ a: 1 }, { a: 2 })).toEqual([{ op: 'set', path: ['a'], value: 2 }])
    expect(diffSections({ a: 1, b: 2 }, { a: 1 })).toEqual([{ op: 'unset', path: ['b'] }])
  })

  it('diffSections compares arrays as a whole leaf', () => {
    expect(diffSections({ a: [1, 2] }, { a: [1, 3] })).toEqual([
      { op: 'set', path: ['a'], value: [1, 3] },
    ])
  })

  it('diffSections replaces a node wholesale on a scalar/object type conflict', () => {
    expect(diffSections({ a: { b: 1 } }, { a: 'x' })).toEqual([
      { op: 'set', path: ['a'], value: 'x' },
    ])
    expect(diffSections({ a: 'x' }, { a: { b: 1 } })).toEqual([
      { op: 'set', path: ['a'], value: { b: 1 } },
    ])
  })

  it('applyOpsToSection replaces the whole section for an empty-path set', () => {
    expect(applyOpsToSection({ old: 1 }, [{ op: 'set', path: [], value: { new: 1 } }])).toEqual({ new: 1 })
  })

  it('applyOpsToSection treats an unset on a missing key as a no-op', () => {
    expect(applyOpsToSection({ a: 1 }, [{ op: 'unset', path: ['b'] }])).toEqual({ a: 1 })
    expect(applyOpsToSection(undefined, [{ op: 'unset', path: ['a'] }])).toEqual(undefined)
  })

  it('applyOpsToSection replaces a scalar intermediate with a nested set', () => {
    expect(applyOpsToSection({ a: 'scalar' }, [{ op: 'set', path: ['a', 'b'], value: 1 }])).toEqual({
      a: { b: 1 },
    })
  })

  it('applyOpsToSection builds an object section from an absent one on a nested set', () => {
    expect(applyOpsToSection(undefined, [{ op: 'set', path: ['a', 'b'], value: 1 }])).toEqual({
      a: { b: 1 },
    })
  })
})
