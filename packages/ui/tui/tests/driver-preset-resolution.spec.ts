import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'
import {
  isPresetNotFound,
  readSelectedDefault,
  resolvePresetId,
} from '@dsh-cc/tui/harness/preset.ts'
import { readResumeTarget, writeResumeTarget } from '@dsh-cc/tui/resume-target.ts'

const NOT_FOUND = Object.assign(new Error('agent-preset/not-found: Unknown agent preset: gone'), { code: 'agent-preset/not-found' })

/**
 * Duck-typed ctx stub (driver-auto-resume idiom) with a mount-recording
 * registry and a session projection that reports `recordedPreset`.
 */
function makeCtx(opts: { recordedPreset?: string | null; selectedDefault?: string }): {
  ctx: Record<string, unknown>
  mounted: string[]
  resumeCalls: unknown[]
  createCalls: Array<{ meta: { agentPreset?: string } }>
} {
  const mounted: string[] = []
  const resumeCalls: unknown[] = []
  const createCalls: Array<{ meta: { agentPreset?: string } }> = []
  const makeHandle = (id: string) => ({
    agent: {
      options: {},
      session: { id, header: {}, events: [], snapshotEvents() { return this.events } },
      id: `agent-${id}`,
      status: 'idle',
      followup: vi.fn(),
      steer: vi.fn(),
      cancel: vi.fn(),
    },
    dispose: async () => {},
  })
  // The harness runs `setup` inside create/resume (the preset mount lives
  // there); the duck-typed agent ctx resolves the same services as the host.
  const runSetup = async (req: { setup?: (ctx: never, agent: never) => Promise<void> }): Promise<void> => {
    const handle = makeHandle('x')
    const agentCtx = { get: (ctx as { get: (key: string) => unknown }).get, on: () => () => {} } as never
    if (req.setup !== undefined) await req.setup(agentCtx, handle.agent as never)
  }
  const ctx: Record<string, unknown> = {
    get(key: string) {
      if (key === 'agentPresets') {
        return {
          defaultId: 'cc',
          resolve: async () => ({ id: 'cc' }),
          mount: async (_agentCtx: unknown, id: string) => {
            mounted.push(id)
            if (id === 'gone') throw NOT_FOUND
            return { id }
          },
        }
      }
      if (key === 'sessionProjections') {
        return {
          stateOf: (_session: unknown, keyState: string) => keyState === 'agentPreset' ? (opts.recordedPreset ?? null) : null,
          onChanged: () => () => {},
        }
      }
      if (key === 'settings') {
        // Structural user-section read face (settings.describe() -> user layer)
        // used by bindPresetResolution's readSelectedDefault.
        return {
          describe: () => opts.selectedDefault === undefined
            ? []
            : [{ ns: 'vwa-preset', user: { selectedDefault: opts.selectedDefault } }],
        }
      }
      return undefined
    },
    on: () => () => {},
    agents: {
      create: async (req: { meta: { agentPreset?: string }; setup?: unknown }) => {
        createCalls.push(req)
        await runSetup(req as never)
        return makeHandle('s-fresh')
      },
      resume: async (req: unknown) => {
        resumeCalls.push(req)
        await runSetup(req as never)
        return makeHandle('s-old')
      },
    },
  }
  return { ctx, mounted, resumeCalls, createCalls }
}

beforeEach(() => {
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-driver-preset-'))
  return () => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  }
})

describe('resolvePresetId (shared chain, doc §3.3)', () => {
  it('resume: recorded wins over the persisted and deployment defaults', () => {
    expect(resolvePresetId({ recorded: 'vwa', selectedDefault: 'cc', configPreset: 'cc' })).toBe('vwa')
    expect(resolvePresetId({ recorded: null, selectedDefault: 'vwa', configPreset: 'cc' })).toBe('vwa')
  })

  it('fresh: persisted default → deployment default → cc', () => {
    expect(resolvePresetId({})).toBe('cc')
    expect(resolvePresetId({ configPreset: 'vwa' })).toBe('vwa')
    expect(resolvePresetId({ selectedDefault: 'vwa', configPreset: 'cc' })).toBe('vwa')
  })

  it('isPresetNotFound duck-types the registry RemoteError and the rewrapped message', () => {
    expect(isPresetNotFound(NOT_FOUND)).toBe(true)
    expect(isPresetNotFound(new Error(`wrapped: ${NOT_FOUND.message}`))).toBe(true)
    expect(isPresetNotFound(new Error('agent-preset/locked: already started'))).toBe(false)
  })

  it('readSelectedDefault reads the raw user section (registration-independent)', () => {
    // describe-face stub: readUserSection reaches the user layer directly.
    const ctxOf = (user: unknown) => ({
      get: (key: string) => key === 'settings'
        ? { describe: () => [{ ns: 'vwa-preset', user }] }
        : undefined
    })
    expect(readSelectedDefault(ctxOf({ selectedDefault: 'vwa' }) as never)).toBe('vwa')
    expect(readSelectedDefault(ctxOf({ selectedDefault: '' }) as never)).toBeUndefined()
    expect(readSelectedDefault(ctxOf(null) as never)).toBeUndefined()
    expect(readSelectedDefault({ get: () => undefined } as never)).toBeUndefined()
  })
})

describe('createDriver preset resolution', () => {
  it('RESUME-GAP FIX: a recorded preset that no longer exists keeps the resume target, remounts down the default chain, and reports loudly', async () => {
    const home = process.env.DSH_HOME!
    writeResumeTarget('s-old', { cwd: home })
    const { ctx, mounted, resumeCalls, createCalls } = makeCtx({ recordedPreset: 'gone' })
    const driver = await createDriver(ctx as never, { autoResume: true, cwd: home })
    expect(resumeCalls).toHaveLength(1)
    expect(createCalls).toHaveLength(0)
    // Resume target survives — the stale-marker path never ran.
    expect(readResumeTarget({ cwd: home })).toBe('s-old')
    expect(driver.state.notice).toContain('no longer exists')
    expect(driver.state.notice).toContain('remounted "cc"')
    // Remount went down the default chain (fallback 'cc'), never a fresh create.
    expect(mounted).toEqual(['gone', 'cc'])
    await driver.dispose()
  })

  it('resume re-mounts the recorded preset, recomposing past the cached boot composition', async () => {
    const home = process.env.DSH_HOME!
    writeResumeTarget('s-old', { cwd: home })
    const { ctx, mounted, createCalls } = makeCtx({ recordedPreset: 'vwa' })
    await createDriver(ctx as never, { autoResume: true, cwd: home })
    expect(createCalls).toHaveLength(0)
    expect(mounted).toEqual(['vwa'])
  })

  it('legacy transcripts (no recorded preset) resolve through the fresh-create chain', async () => {
    const home = process.env.DSH_HOME!
    writeResumeTarget('s-old', { cwd: home })
    const { ctx, mounted } = makeCtx({ recordedPreset: null, selectedDefault: 'vwa' })
    await createDriver(ctx as never, { autoResume: true, cwd: home })
    expect(mounted).toEqual(['vwa'])
  })

  it('fresh create: the persisted vwa-preset.selectedDefault lands in the creation meta and the mount', async () => {
    const { ctx, mounted, createCalls } = makeCtx({ selectedDefault: 'vwa' })
    await createDriver(ctx as never, {})
    expect(createCalls[0]?.meta.agentPreset).toBe('vwa')
    expect(mounted).toEqual(['vwa'])
  })

  it('fresh create without a persisted default stays on the deployment default (cc)', async () => {
    const { ctx, mounted, createCalls } = makeCtx({})
    await createDriver(ctx as never, {})
    expect(createCalls[0]?.meta.agentPreset).toBe('cc')
    expect(mounted).toEqual(['cc'])
  })

  it('fresh create ignores a non-null recorded projection (the projection seeds from the header this create writes)', async () => {
    // Self-reference guard (acceptance S2): header agentPreset=vwa seeded from
    // an EARLY read must not claim the setup-side resolution; the resumed
    // closure is the only place the recorded leg belongs.
    const { ctx, mounted, createCalls } = makeCtx({ recordedPreset: 'vwa', selectedDefault: 'cc' })
    await createDriver(ctx as never, {})
    expect(createCalls[0]?.meta.agentPreset).toBe('cc')
    expect(mounted).toEqual(['cc'])
  })
})
