/**
 * Watcher wiring for the settings cascade: chokidar setup over the concrete
 * settings files, the write-settle
 * (`awaitWriteFinish`) tuning resolution, and the dispose closer. Kept apart
 * from the provider so the provider file stays on its seam (merge + persist)
 * and the watcher mechanics stay testable in isolation.
 * @module @dsh-cc/settings-cascade/watcher
 */

import { watch as chokidarWatch } from 'chokidar'
import { canonicalizeWatchPath } from '@deepseek-ai/dsh-home-paths'
import { watchFile, unwatchFile, type Stats } from 'node:fs'

/** Watcher write-settle tuning (chokidar `awaitWriteFinish`). */
export interface WatchTuning {
  /** How long a file must stay unchanged before its event fires. */
  stabilityThresholdMs: number
  /** How often a settling file is polled for further changes. */
  pollIntervalMs: number
}

/** Watcher write-settle window in milliseconds (mirrors the harness file provider's default). */
const DEBOUNCE_MS = 100
const READY_TIMEOUT_MS = 5_000

/** Resolve the watch tuning from plugin config; defaults (100/10) mirror the file provider. */
export function resolveWatchTuning(
  config?: { stabilityThresholdMs?: number; pollIntervalMs?: number },
): WatchTuning {
  return {
    stabilityThresholdMs: config?.stabilityThresholdMs ?? DEBOUNCE_MS,
    pollIntervalMs: config?.pollIntervalMs ?? Math.max(1, Math.min(DEBOUNCE_MS, 10)),
  }
}

/** Canonicalize and deduplicate the concrete settings files, including absent ones. */
export async function resolveWatchPaths(
  paths: ReadonlyArray<string | undefined>,
): Promise<{ files: string[] }> {
  const concrete = paths.filter((path): path is string => path !== undefined)
  return { files: [...new Set(await Promise.all(concrete.map(path => canonicalizeWatchPath(path))))] }
}

/** Options for {@link startWatchers}. */
export interface WatchersOptions {
  /** Concrete files to watch (from {@link resolveWatchPaths}). */
  paths: { files: string[] }
  /** Resolved write-settle tuning. */
  tuning: WatchTuning
  /** Called on every settled watcher event (and once at ready). */
  refresh: () => void
  /** Called with non-fatal watcher errors. */
  onError: (error: unknown) => void
}

/**
 * Start optional hot reload and return its closer immediately. Native scans
 * and queued reloads must never gate service/plugin initialization. Poll the
 * concrete files as a fallback: unlike directory watches this also survives
 * missing parents, directory removal, and recreation without a rescan gap.
 */
export function startWatchers(options: WatchersOptions): () => Promise<void> {
  const { paths, tuning, refresh, onError } = options
  const watcher = chokidarWatch(paths.files, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: tuning.stabilityThresholdMs, pollInterval: tuning.pollIntervalMs },
  })
  let closed = false
  let reconciliation: ReturnType<typeof setTimeout> | undefined
  const reconcile = () => {
    if (closed) return
    clearTimeout(reconciliation)
    reconciliation = setTimeout(() => { if (!closed) refresh() }, tuning.stabilityThresholdMs)
  }
  const readyDeadline = setTimeout(() => {
    if (closed) return
    onError(new Error(`settings-cascade: file watcher did not become ready within ${READY_TIMEOUT_MS}ms`))
    reconcile()
  }, READY_TIMEOUT_MS)
  watcher.on('all', () => { if (!closed) refresh() })
  watcher.on('ready', () => { clearTimeout(readyDeadline); reconcile() })
  watcher.on('error', error => {
    clearTimeout(readyDeadline)
    if (!closed) { onError(error); reconcile() }
  })
  const polls = paths.files.map(path => {
    const listener = (current: Stats, previous: Stats) => {
      if (current.mtimeMs === previous.mtimeMs && current.ctimeMs === previous.ctimeMs
        && current.size === previous.size && current.ino === previous.ino && current.nlink === previous.nlink) return
      reconcile()
    }
    watchFile(path, { persistent: false, interval: Math.max(100, tuning.pollIntervalMs) }, listener)
    return { path, listener }
  })
  return async () => {
    closed = true
    clearTimeout(readyDeadline)
    clearTimeout(reconciliation)
    for (const { path, listener } of polls) unwatchFile(path, listener)
    await watcher.close()
  }
}
