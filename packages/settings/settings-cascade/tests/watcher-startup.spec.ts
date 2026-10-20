/** Optional watcher initialization must never block service startup. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { watchFile, unwatchFile, type Stats } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'

const state = vi.hoisted(() => ({ watchers: [] as Array<import('node:events').EventEmitter & { close: ReturnType<typeof vi.fn> }> }))
vi.mock('chokidar', () => ({
  watch: vi.fn(() => {
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn(async () => {}) })
    state.watchers.push(watcher)
    return watcher
  }),
}))

vi.mock('node:fs', () => ({ watchFile: vi.fn(), unwatchFile: vi.fn() }))

import { startWatchers } from '../src/watcher.ts'
import { SettingsCascadeProvider } from '../src/index.ts'

beforeEach(() => { state.watchers = []; vi.clearAllMocks() })

const projectRoot = resolve('project')
const settingsPath = join(projectRoot, '.claude', 'settings.json')
const options = () => ({
  paths: { files: [settingsPath] },
  tuning: { stabilityThresholdMs: 100, pollIntervalMs: 10 },
  refresh: vi.fn(),
  onError: vi.fn(),
})

describe('settings watcher startup', () => {
  it('does not make provider startup wait for a ready-triggered reload', async () => {
    let loads = 0
    let release!: () => void
    const pendingReload = new Promise<void>((resolve) => { release = resolve })
    class HeldReloadProvider extends SettingsCascadeProvider {
      protected override async load(): Promise<Record<string, unknown>> {
        if (++loads > 1) await pendingReload
        return super.load()
      }
    }
    const root = await mkdtemp(join(tmpdir(), 'cascade-startup-'))
    const ctx = new Context()
    const fiber = ctx.plugin(HeldReloadProvider, { dshHome: root, projectDir: root })
    let started = false
    const startup = Promise.resolve(fiber).then(() => { started = true })
    try {
      await vi.waitFor(() => expect(state.watchers).toHaveLength(1))
      for (const watcher of state.watchers) watcher.emit('ready')
      await vi.waitFor(() => expect(loads).toBeGreaterThan(1))
      await vi.waitFor(() => expect(started).toBe(true), { timeout: 1_000 })
    } finally {
      release()
      await startup
      await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns a closer without waiting for any watcher signal', async () => {
    const input = options()
    const close = startWatchers(input)
    expect(close).toBeTypeOf('function')
    expect(input.refresh).not.toHaveBeenCalled()
    await close()
    for (const watcher of state.watchers) expect(watcher.close).toHaveBeenCalledOnce()
  })

  it('polls concrete files even when their parent directories do not exist', async () => {
    vi.useFakeTimers()
    const input = options()
    const close = startWatchers(input)
    try {
      expect(vi.mocked(watchFile)).toHaveBeenCalledWith(settingsPath, expect.objectContaining({ persistent: false }), expect.any(Function))
      const listener = vi.mocked(watchFile).mock.calls.at(-1)![2]!
      listener({ mtimeMs: 2 } as Stats, { mtimeMs: 1 } as Stats)
      await vi.advanceTimersByTimeAsync(100)
      expect(input.refresh).toHaveBeenCalledOnce()
    } finally {
      await close()
      vi.useRealTimers()
    }
  })

  it('coalesces polling changes and cancels pending refresh on disposal', async () => {
    vi.useFakeTimers()
    const input = options()
    const close = startWatchers(input)
    try {
      const listener = vi.mocked(watchFile).mock.calls.at(-1)![2]!
      listener({ mtimeMs: 2 } as Stats, { mtimeMs: 1 } as Stats)
      await vi.advanceTimersByTimeAsync(99)
      listener({ mtimeMs: 3 } as Stats, { mtimeMs: 2 } as Stats)
      await vi.advanceTimersByTimeAsync(99)
      expect(input.refresh).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(input.refresh).toHaveBeenCalledOnce()
      listener({ mtimeMs: 4 } as Stats, { mtimeMs: 3 } as Stats)
      await close()
      expect(vi.mocked(unwatchFile)).toHaveBeenCalledWith(settingsPath, listener)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(input.refresh).toHaveBeenCalledOnce()
      expect(input.onError).not.toHaveBeenCalled()
    } finally {
      await close()
      vi.useRealTimers()
    }
  })

  it('keeps silent or late native readiness off the boot path', async () => {
    vi.useFakeTimers()
    const input = options()
    const close = startWatchers(input)
    try {
      await vi.advanceTimersByTimeAsync(5_000)
      expect(input.onError).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(100)
      expect(input.refresh).toHaveBeenCalledOnce()
      state.watchers[0]!.emit('ready')
      await vi.advanceTimersByTimeAsync(100)
      expect(input.refresh).toHaveBeenCalledTimes(2)
      await close()
      state.watchers[0]!.emit('ready')
      state.watchers[0]!.emit('all', 'change', settingsPath)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(input.onError).toHaveBeenCalledOnce()
      expect(input.refresh).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      await close()
      vi.useRealTimers()
    }
  })

  it('reconciles the initial read even when native watching fails', async () => {
    vi.useFakeTimers()
    const input = options()
    const close = startWatchers(input)
    try {
      const error = new Error('native watch unavailable')
      state.watchers[0]!.emit('error', error)
      expect(input.onError).toHaveBeenCalledWith(error)
      await vi.advanceTimersByTimeAsync(100)
      expect(input.refresh).toHaveBeenCalledOnce()
    } finally {
      await close()
      vi.useRealTimers()
    }
  })
})
