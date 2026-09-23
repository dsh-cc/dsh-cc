import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { SettingsCascadeProvider, type Config, type ResolvedSpec } from '../src/index.ts'

// Concurrency gate for `node:fs/promises.readFile` (same pattern as
// persist.spec.ts / watcher.spec.ts): when armed, the next read hangs in a
// controlled deferred, letting the test interleave an external writer between
// the edit's first read and its verification re-read. Disarmed it is a
// passthrough.
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
 * Contract of the raw user-layer edit seam: `editUserSection` sees only the
 * user file's own section (never the merged one, so project-layer entries are
 * never smeared in), writes atomically with optimistic re-read retry, runs on
 * the exclusive operations queue, and republishes the re-merged document.
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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cascade-edit-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function boot(config: Config): Promise<Context> {
  // Pin to a fresh non-git temp project dir (see persist.spec.ts).
  const pinned = config.projectDir ?? (await tempDir())
  const ctx = new Context()
  const fiber = ctx.plugin(SettingsCascadeProvider, { ...config, projectDir: pinned })
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return ctx
}

async function writeSettings(dir: string, name: string, doc: unknown): Promise<string> {
  await mkdir(dir, { recursive: true })
  const path = join(dir, name)
  await writeFile(path, JSON.stringify(doc))
  return path
}

async function readDoc(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

function register(ctx: Context, ns: string) {
  return ctx.settings.register(ns as SettingsNamespace, Passthrough)
}

/** Release exactly the oldest read the gate is holding. */
function releaseOneRead(): void {
  const waiter = readGate.waiters.shift()
  waiter?.()
}

/** Reach the public editUserSection seam on the mounted provider. */
function editUserSection(ctx: Context, ns: SettingsNamespace, edit: (raw: Record<string, unknown>) => Record<string, unknown> | undefined): Promise<void> {
  return (ctx.settings as unknown as {
    editUserSection(ns: SettingsNamespace, edit: typeof edit): Promise<void>
  }).editUserSection(ns, edit)
}

describe('editUserSection', () => {
  it('edits only the raw user section, never smearing project-layer entries', async () => {
    const dir = await tempDir()
    const user = await writeSettings(dir, 'user.json', { 'edit-a': { keep: 'u', drop: 'x' } })
    const project = await writeSettings(dir, 'project.json', { 'edit-a': { project: 'p' } })
    const ctx = await boot({ userSettingsPath: user, projectSettingsPath: project })
    const scope = register(ctx, 'edit-a')
    const ns = 'edit-a' as SettingsNamespace

    await editUserSection(ctx, ns, (raw) => {
      expect(raw).toEqual({ keep: 'u', drop: 'x' }) // raw user section, NOT merged
      const { drop: _dropped, ...kept } = raw
      return kept
    })

    expect(await readDoc(user)).toEqual({ 'edit-a': { keep: 'u' } })
    // The merged view still carries the project contribution.
    expect(scope.get()).toEqual({ keep: 'u', project: 'p' })
  })

  it('republishes the re-merged document after the write', async () => {
    const dir = await tempDir()
    const user = await writeSettings(dir, 'user.json', { 'edit-b': { a: 1 } })
    const ctx = await boot({ userSettingsPath: user })
    const ns = 'edit-b' as SettingsNamespace
    const scope = register(ctx, 'edit-b')

    await editUserSection(ctx, ns, () => ({ added: 'by-edit' }))

    expect(scope.get()).toEqual({ added: 'by-edit' })
  })

  it('a returning-undefined edit is a no-op and leaves the file byte-identical', async () => {
    const dir = await tempDir()
    const user = await writeSettings(dir, 'user.json', { 'edit-c': { a: 1 } })
    const ctx = await boot({ userSettingsPath: user })
    const ns = 'edit-c' as SettingsNamespace
    register(ctx, 'edit-c')
    const before = await readFile(user, 'utf8')

    await editUserSection(ctx, ns, () => undefined)

    expect(await readFile(user, 'utf8')).toBe(before)
  })

  it('retries optimistically against a concurrent external edit, re-applying edit to the fresh root', async () => {
    const dir = await tempDir()
    const user = await writeSettings(dir, 'user.json', { 'edit-d': { a: 1 } })
    const ctx = await boot({ userSettingsPath: user })
    const ns = 'edit-d' as SettingsNamespace
    register(ctx, 'edit-d')

    let calls = 0
    readGate.held = 1 // hold the edit's first read
    const pending = editUserSection(ctx, ns, (raw) => {
      calls += 1
      return { ...raw, fromEdit: 'yes' }
    })
    await vi.waitFor(() => { expect(readGate.waiters.length).toBe(1) }, { timeout: 3000 })
    // Release the first read (observing the pre-external content) and re-arm
    // the gate so the edit's verification re-read hangs too.
    releaseOneRead()
    readGate.held = 1
    await vi.waitFor(() => { expect(readGate.waiters.length).toBe(1) }, { timeout: 3000 })
    // Land an external edit, then release the verification re-read: it sees
    // different bytes, so the round restarts from a fresh root.
    await writeFile(user, JSON.stringify({ 'edit-d': { a: 1 }, external: { e: 1 } }))
    drainReadGate()
    await pending

    expect(calls).toBe(2) // re-applied to the freshly re-read root
    expect(await readDoc(user)).toEqual({
      'edit-d': { a: 1, fromEdit: 'yes' },
      external: { e: 1 }, // the concurrent writer's key survives
    })
  })

  it('serializes behind an already-queued reload on the operations chain', async () => {
    const dir = await tempDir()
    const user = await writeSettings(dir, 'user.json', { 'edit-e': { a: 1 } })
    const ctx = await boot({ userSettingsPath: user })
    const ns = 'edit-e' as SettingsNamespace
    const scope = register(ctx, 'edit-e')

    const order: string[] = []
    readGate.held = 1
    const provider = ctx.settings as unknown as { queueRefresh(): void }
    provider.queueRefresh()
    await new Promise(resolve => setImmediate(resolve))
    const pending = editUserSection(ctx, ns, (raw) => {
      order.push('edit')
      return { ...raw, b: 2 }
    })
    await vi.waitFor(() => { expect(readGate.waiters.length).toBe(1) }, { timeout: 3000 })
    drainReadGate()
    await pending

    expect(order).toEqual(['edit']) // edit ran exactly once, after the reload settled
    expect(await readDoc(user)).toEqual({ 'edit-e': { a: 1, b: 2 } })
    expect(scope.get()).toEqual({ a: 1, b: 2 })
  })

  it('a queued edit after dispose is a no-op', async () => {
    const dir = await tempDir()
    const user = await writeSettings(dir, 'user.json', { 'edit-f': { a: 1 } })
    const ctx = await boot({ userSettingsPath: user })
    register(ctx, 'edit-f')
    const before = await readFile(user, 'utf8')
    const provider = ctx.settings as unknown as {
      editUserSection(ns: SettingsNamespace, edit: () => Record<string, unknown> | undefined): Promise<void>
    }
    await cleanups.pop()!() // dispose the provider fiber

    await provider.editUserSection('edit-f' as SettingsNamespace, () => ({ b: 2 }))

    expect(await readFile(user, 'utf8')).toBe(before)
  })

  it('throws loud when no userSettings source is configured', async () => {
    const dir = await tempDir()
    const ctx = await boot({ userSettingsPath: join(dir, 'user.json') })
    // Simulate an unconfigured user source the way resolveSpec cannot express.
    const spec = (ctx.settings as unknown as { spec: ResolvedSpec }).spec
    ;(ctx.settings as unknown as { spec: ResolvedSpec }).spec = {
      ...spec,
      sources: { ...spec.sources, userSettings: undefined },
    }

    await expect(editUserSection(ctx, 'edit-g' as SettingsNamespace, () => ({}))).rejects.toThrow(/userSettings source is not configured/)
  })
})
