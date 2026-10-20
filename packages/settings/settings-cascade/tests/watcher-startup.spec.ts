/** Watcher initialization must finish before consumers can write settings. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { watch } from 'chokidar'

const state = vi.hoisted(() => ({ watchers: [] as Array<import('node:events').EventEmitter & { close: ReturnType<typeof vi.fn> }> }))
vi.mock('chokidar', () => ({
  watch: vi.fn(() => {
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn(async () => {}) })
    state.watchers.push(watcher)
    return watcher
  }),
}))

import { resolveWatchPaths, startWatchers } from '../src/watcher.ts'

beforeEach(() => { state.watchers = [] })

const projectRoot = resolve('project')
const settingsPath = join(projectRoot, '.claude', 'settings.json')
const options = () => ({
  paths: { files: [settingsPath], dirs: [projectRoot] },
  tuning: { stabilityThresholdMs: 100, pollIntervalMs: 10 },
  refresh: vi.fn(),
  onError: vi.fn(),
})

describe('settings watcher startup', () => {
  it('anchors missing settings directories at an existing ancestor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cascade-watch-root-'))
    try {
      const paths = await resolveWatchPaths([join(root, '.claude', 'nested', 'settings.json')])
      expect(paths.dirs).toEqual([await realpath(root)])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('follows only settings branches below the existing ancestor', async () => {
    const input = options()
    const startup = startWatchers(input)
    const directoryOptions = vi.mocked(watch).mock.calls.at(-1)![1]!
    expect(directoryOptions.depth).toBeUndefined()
    expect(directoryOptions.ignored).toBeTypeOf('function')
    const ignored = directoryOptions.ignored as (path: string) => boolean
    expect(ignored(projectRoot)).toBe(false)
    expect(ignored(dirname(settingsPath))).toBe(false)
    expect(ignored(settingsPath)).toBe(false)
    expect(ignored(settingsPath + '.backup')).toBe(true)
    expect(ignored(join(projectRoot, 'node_modules'))).toBe(true)
    for (const watcher of state.watchers) watcher.emit('ready')
    await (await startup)()
  })

  it('waits for both file and directory watchers before finishing setup', async () => {
    const input = options()
    let initialized = false
    const startup = Promise.resolve(startWatchers(input)).then((close) => {
      initialized = true
      return close
    })
    await Promise.resolve()
    expect(initialized).toBe(false)
    state.watchers[0]!.emit('ready')
    await Promise.resolve()
    expect(initialized).toBe(false)
    state.watchers[1]!.emit('ready')
    const close = await startup
    expect(initialized).toBe(true)
    expect(input.refresh).toHaveBeenCalledTimes(2)
    await close()
    for (const watcher of state.watchers) expect(watcher.close).toHaveBeenCalledOnce()
  })

  it('keeps watcher errors non-fatal without hanging startup or losing cleanup', async () => {
    const input = options()
    const startup = startWatchers(input)
    const error = new Error('watch unavailable')
    state.watchers[0]!.emit('error', error)
    state.watchers[1]!.emit('ready')
    const close = await startup
    expect(input.onError).toHaveBeenCalledWith(error)
    expect(input.refresh).toHaveBeenCalledOnce()
    await close()
    for (const watcher of state.watchers) expect(watcher.close).toHaveBeenCalledOnce()
  })

  it('does not block service startup when a watcher never reports ready or error', async () => {
    vi.useFakeTimers()
    try {
      const input = options()
      let close: (() => Promise<void>) | undefined
      const startup = startWatchers(input).then((closer) => { close = closer })
      state.watchers[1]!.emit('ready')
      await vi.advanceTimersByTimeAsync(4_999)
      expect(close).toBeUndefined()
      expect(input.onError).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(close).toBeTypeOf('function')
      expect(input.onError).toHaveBeenCalledOnce()
      expect(input.onError).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('file watcher'),
      }))
      await startup
      // A late ready signal still reconciles and leaves change delivery active.
      state.watchers[0]!.emit('ready')
      state.watchers[0]!.emit('all', 'change', settingsPath)
      expect(input.refresh).toHaveBeenCalledTimes(3)
      await close!()
      for (const watcher of state.watchers) expect(watcher.close).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
