/**
 * Mount tests (plan §"Mounting singleton" + §Verification): registration shape,
 * the reference-counted root-owned singleton (cc + vwa double include), the
 * lifecycle (unmount one preset → listeners still fire; unmount the last →
 * disposed), the real sink wiring under a temp DSH_HOME, and the
 * "no settings file → observers fire" wiring contract.
 *
 * The fake root follows the sibling-package rigs (turn-rules / completion-gate
 * `wiring.spec.ts`): a plain object with `logger`, `on`, `get`, an optional
 * `dshHomePath`, and `root` pointing at itself.
 */

import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { projectKeyOf, shortHash } from '@dsh-cc/sidecar-io'
import type { AssembleRow, LedgerRow, RequestRow } from '../src/index.ts'
import {
  DEFAULT_INPUT_LEDGER_SETTINGS,
  mountInputLedger,
  mountStateOf,
  sessionLedgerPath,
} from '../src/index.ts'

type Listener = (...args: never[]) => unknown

interface Registration {
  event: string
  listener: Listener
  options: unknown
}

interface FakeContext {
  logger: { debug: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> }
  on: ReturnType<typeof vi.fn>
  get: () => undefined
  dshHomePath?: (...segments: string[]) => string
  root: FakeContext
  registrations: Registration[]
}

const roots: FakeContext[] = []
const homes: string[] = []

/** Release handles by the context they were mounted from, drained in afterEach. */
const releasesByRoot = new Map<FakeContext, Array<() => void>>()

afterEach(() => {
  for (const handles of releasesByRoot.values()) {
    for (const handle of handles.splice(0)) handle()
  }
  for (const root of roots.splice(0)) {
    const state = mountStateOf(root as never)
    if (state !== undefined) throw new Error(`leaked mount state: ${JSON.stringify(state)}`)
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function fakeContext(options: { home?: string } = {}): FakeContext {
  const registrations: Registration[] = []
  const ctx = {
    logger: { debug: vi.fn(), warn: vi.fn() },
    on: vi.fn((event: string, listener: Listener, onOptions?: unknown) => {
      const entry: Registration = { event, listener, options: onOptions }
      registrations.push(entry)
      return () => {
        const index = registrations.indexOf(entry)
        if (index >= 0) registrations.splice(index, 1)
      }
    }),
    get: () => undefined,
    registrations,
  } as unknown as FakeContext
  if (options.home !== undefined) {
    ctx.dshHomePath = (...segments: string[]) => join(options.home!, ...segments)
  }
  ctx.root = ctx
  roots.push(ctx)
  return ctx
}

/** A preset context that shares the root: mount must register on the root only. */
function presetContext(root: FakeContext): FakeContext {
  const ctx = Object.create(null) as FakeContext
  ctx.logger = root.logger
  ctx.on = vi.fn(() => () => {})
  ctx.get = () => undefined
  ctx.registrations = []
  if (root.dshHomePath !== undefined) ctx.dshHomePath = root.dshHomePath
  ctx.root = root
  return ctx
}

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'input-ledger-home-'))
  homes.push(home)
  return home
}

/** projectKey of an existing cwd, canonicalized exactly like the observers do. */
function keyOf(cwd: string): string {
  return projectKeyOf(realpathSync(cwd))
}

function mount(root: FakeContext, overrides: Parameters<typeof mountInputLedger>[1] = {}) {
  const handle = mountInputLedger(root as never, overrides)
  const handles = releasesByRoot.get(root) ?? []
  handles.push(handle)
  releasesByRoot.set(root, handles)
  return handle
}

function listenerFor(root: FakeContext, event: string): Listener {
  const entry = [...root.registrations].reverse().find(item => item.event === event)
  expect(entry, `no ${event} listener registered`).toBeDefined()
  return entry!.listener
}

function registrationFor(root: FakeContext, event: string): Registration {
  const entry = root.registrations.find(item => item.event === event)
  expect(entry, `no ${event} listener registered`).toBeDefined()
  return entry!
}

async function fireAssemble(
  root: FakeContext,
  sections: Array<{ name: string; text: string }>,
  scope: unknown,
): Promise<unknown> {
  const listener = listenerFor(root, 'system-prompt/assemble') as unknown as (
    assembly: unknown,
    context: { scope?: unknown },
    next: () => Promise<{ sections: Array<{ name: string; text: string }> }>,
  ) => Promise<unknown>
  return listener(undefined, { scope }, async () => ({ sections }))
}

async function firePreStep(root: FakeContext, sessionId: string, cwd: string, turn = 1, step = 1): Promise<void> {
  const listener = listenerFor(root, 'agent/pre-step') as unknown as (
    payload: unknown,
    next: () => Promise<unknown>,
  ) => Promise<unknown>
  await listener(
    {
      agent: { id: sessionId, session: { id: sessionId, header: { cwd } } },
      messages: [],
      turn,
      step,
      signal: new AbortController().signal,
      modelSelection: {},
    },
    async () => ({ decision: 'keep' }),
  )
}

function fireRequest(root: FakeContext, sessionId: string, purpose?: string): unknown {
  const listener = listenerFor(root, 'llm/stream') as unknown as (
    options: unknown,
    next: () => unknown,
  ) => unknown
  const next = { iterable: true }
  const returned = listener(
    {
      provider: 'deepseek',
      model: 'mock',
      messages: [
        { role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'SYS' }] },
        { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] },
      ],
      sessionId,
      ...(purpose === undefined ? {} : { purpose }),
    },
    () => next,
  )
  expect(returned).toBe(next)
  return returned
}

async function readRows(file: string, timeoutMs = 2000): Promise<LedgerRow[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const raw = await readFile(file, 'utf8')
      const lines = raw.split('\n').filter(line => line.length > 0)
      if (lines.length > 0) return lines.map(line => JSON.parse(line) as LedgerRow)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (Date.now() > deadline) throw new Error(`no ledger rows at ${file}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('registration shape', () => {
  it('registers the three observers on the root context with the pinned options', () => {
    const root = fakeContext()
    const preset = presetContext(root)
    mount(preset)

    expect(root.on).toHaveBeenCalledTimes(3)
    expect(preset.on).not.toHaveBeenCalled()

    const assemble = registrationFor(root, 'system-prompt/assemble')
    expect(assemble.options).toBeUndefined()

    const stream = registrationFor(root, 'llm/stream')
    expect(stream.options).toEqual({ global: true, prepend: true })

    const preStep = registrationFor(root, 'agent/pre-step')
    expect(preStep.options).toEqual({ prepend: true })

    expect(mountStateOf(root as never)).toEqual({ listenerCount: 3, refs: 1 })
  })
})

describe('singleton guard', () => {
  it('a double mount on one root registers a single listener set', async () => {
    const root = fakeContext()
    mount(root, { gen: 'gen-a' })
    mount(root, { gen: 'gen-a' })

    expect(root.on).toHaveBeenCalledTimes(3)
    expect(mountStateOf(root as never)).toEqual({ listenerCount: 3, refs: 2 })

    let emitted = 0
    const handle = mount(root, {
      emit: () => {
        emitted += 1
      },
    })
    // A refs-only mount never re-registers, so its overrides are inert.
    expect(handle).toBeTypeOf('function')
    expect(root.on).toHaveBeenCalledTimes(3)
  })

  it('mount cc, mount vwa, unmount cc → still fires; unmount vwa → disposed', async () => {
    const root = fakeContext()
    const emitted: LedgerRow[] = []
    const cc = presetContext(root)
    const vwa = presetContext(root)
    const releaseCc = mount(cc, { emit: row => emitted.push(row), gen: 'gen-a' })
    const releaseVwa = mount(vwa, { emit: row => emitted.push(row), gen: 'gen-a' })
    expect(root.on).toHaveBeenCalledTimes(3)

    await firePreStep(root, 'sess-1', '/repo/root')
    await fireAssemble(root, [{ name: 'core', text: 'A' }], { id: 'sess-1', session: { id: 'sess-1', header: { cwd: '/repo/root' } } })
    expect(emitted).toHaveLength(1)

    releaseCc()
    expect(mountStateOf(root as never)).toEqual({ listenerCount: 3, refs: 1 })
    await fireAssemble(root, [{ name: 'core', text: 'A' }], { id: 'sess-1', session: { id: 'sess-1', header: { cwd: '/repo/root' } } })
    expect(emitted).toHaveLength(2)

    releaseVwa()
    expect(mountStateOf(root as never)).toBeUndefined()
    expect(root.registrations).toHaveLength(0)
    expect(emitted).toHaveLength(2)
  })

  it('keeps a third mount alive while one reference remains', async () => {
    const root = fakeContext()
    const release = [mount(root), mount(root), mount(root)]
    expect(mountStateOf(root as never)?.refs).toBe(3)
    release[0]?.()
    release[1]?.()
    expect(mountStateOf(root as never)?.refs).toBe(1)
    release[2]?.()
    expect(mountStateOf(root as never)).toBeUndefined()
  })
})

describe('sink wiring', () => {
  it('writes rows under <dshHome>/input-ledger/<projectKey>/<sessionId>.jsonl', async () => {
    const home = tempHome()
    const root = fakeContext({ home })
    const cwd = join(home, 'project')
    mkdirSync(cwd, { recursive: true })
    mount(root)

    await firePreStep(root, 'sess-1', cwd, 5, 6)
    fireRequest(root, 'sess-1')

    const file = sessionLedgerPath(home, keyOf(cwd), 'sess-1')
    const rows = await readRows(file)
    const row = rows.find(candidate => candidate.type === 'request') as RequestRow
    expect(row).toBeDefined()
    expect(row.mainLoop).toBe(true)
    expect(row.turn).toBe(5)
    expect(row.step).toBe(6)
    expect(row.provider).toBe('deepseek')
    expect(row.systemBytes).toBe(Buffer.byteLength('SYS', 'utf8'))
    expect(row.systemHash8).toBe(shortHash('SYS', 8))
    expect(row.gen).toBeTypeOf('string')
    expect(row.gen.length).toBeGreaterThan(0)
  })

  it('fires with ship defaults when no settings file exists (wiring fallback)', async () => {
    const home = tempHome()
    const root = fakeContext({ home })
    const cwd = join(home, 'project')
    mkdirSync(cwd, { recursive: true })
    mount(root)

    await firePreStep(root, 'sess-2', cwd)
    await fireAssemble(root, [{ name: 'core', text: 'A' }], {
      id: 'sess-2',
      session: { id: 'sess-2', header: { cwd } },
    })

    const file = sessionLedgerPath(home, keyOf(cwd), 'sess-2')
    const rows = await readRows(file)
    const assemble = rows.find(candidate => candidate.type === 'assemble') as AssembleRow
    expect(assemble).toBeDefined()
    expect(assemble.isSubagent).toBe(false)
    expect(assemble.renderedFromCache).toBe(false)
    expect(assemble.sections).toEqual([{ name: 'core', bytes: 1, hash8: shortHash('A', 8) }])
    expect(DEFAULT_INPUT_LEDGER_SETTINGS.enabled).toBe(true)
  })

  it('hot-reads the settings file per event', async () => {
    const home = tempHome()
    const root = fakeContext({ home })
    const cwd = join(home, 'project')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({ 'cc-input-ledger': { enabled: false } }),
      'utf8',
    )
    mount(root)
    const scope = { id: 'sess-3', session: { id: 'sess-3', header: { cwd } } }
    await firePreStep(root, 'sess-3', cwd)
    await fireAssemble(root, [{ name: 'core', text: 'A' }], scope)

    const file = sessionLedgerPath(home, keyOf(cwd), 'sess-3')
    await expect(readFile(file, 'utf8')).rejects.toThrow()

    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({ 'cc-input-ledger': { enabled: true } }),
      'utf8',
    )
    await fireAssemble(root, [{ name: 'core', text: 'A' }], scope)
    expect(await readRows(file)).toHaveLength(1)
  })

  it('honors max-rows-per-file for the session file rotation', async () => {
    const home = tempHome()
    const root = fakeContext({ home })
    const cwd = join(home, 'project')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({ 'cc-input-ledger': { 'max-rows-per-file': 100 } }),
      'utf8',
    )
    mount(root)
    for (let index = 0; index < 100; index += 1) {
      await fireAssemble(root, [{ name: 'core', text: `A${index}` }], {
        id: 'sess-4',
        session: { id: 'sess-4', header: { cwd } },
      })
    }
    const file = sessionLedgerPath(home, keyOf(cwd), 'sess-4')
    await readRows(file, 5000)
    // Rotation happens on the append after the cap is reached.
    await fireAssemble(root, [{ name: 'core', text: 'overflow' }], {
      id: 'sess-4',
      session: { id: 'sess-4', header: { cwd } },
    })
    const deadline = Date.now() + 2000
    for (;;) {
      try {
        expect(await readRows(`${file}.1`)).toHaveLength(100)
        break
      } catch (error) {
        if (Date.now() > deadline) throw error
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    expect(await readRows(file)).toHaveLength(1)
  })

  it('registers nothing and writes nothing without a dshHomePath', async () => {
    const root = fakeContext()
    mount(root)
    await firePreStep(root, 'sess-5', '/repo/root')
    expect(fireRequest(root, 'sess-5')).toEqual({ iterable: true })
    expect(root.on).toHaveBeenCalledTimes(3)
  })
})
