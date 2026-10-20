/**
 * Watcher wiring for the settings cascade: chokidar setup over the concrete
 * settings files and their parent directories, the write-settle
 * (`awaitWriteFinish`) tuning resolution, and the dispose closer. Kept apart
 * from the provider so the provider file stays on its seam (merge + persist)
 * and the watcher mechanics stay testable in isolation.
 * @module @dsh-cc/settings-cascade/watcher
 */

import { watch as chokidarWatch } from 'chokidar'
import { canonicalizeWatchPath } from '@deepseek-ai/dsh-home-paths'
import { stat } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

/** Watcher write-settle tuning (chokidar `awaitWriteFinish`). */
export interface WatchTuning {
  /** How long a file must stay unchanged before its event fires. */
  stabilityThresholdMs: number
  /** How often a settling file is polled for further changes. */
  pollIntervalMs: number
}

/** Watcher write-settle window in milliseconds (mirrors the harness file provider's default). */
const DEBOUNCE_MS = 100

/** Resolve the watch tuning from plugin config; defaults (100/10) mirror the file provider. */
export function resolveWatchTuning(
  config?: { stabilityThresholdMs?: number; pollIntervalMs?: number },
): WatchTuning {
  return {
    stabilityThresholdMs: config?.stabilityThresholdMs ?? DEBOUNCE_MS,
    pollIntervalMs: config?.pollIntervalMs ?? Math.max(1, Math.min(DEBOUNCE_MS, 10)),
  }
}

/**
 * Every concrete settings FILE path worth watching, canonicalized and
 * deduped. Anchor directory watches at existing ancestors so creation of
 * missing intermediate directories is observed without chokidar's fallback
 * to a parent outside the requested depth.
 */
export async function resolveWatchPaths(
  paths: ReadonlyArray<string | undefined>,
): Promise<{ files: string[]; dirs: string[] }> {
  const concrete = paths.filter((path): path is string => path !== undefined)
  const canonical = [...new Set(await Promise.all(concrete.map(path => canonicalizeWatchPath(path))))]
  return {
    files: canonical,
    dirs: [...new Set(await Promise.all(canonical.map(existingParent)))],
  }
}

async function existingParent(file: string): Promise<string> {
  let directory = dirname(file)
  while (true) {
    try {
      if (!(await stat(directory)).isDirectory()) throw new Error(`watch ancestor is not a directory: ${directory}`)
      return directory
    } catch (error) {
      const parent = dirname(directory)
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === directory) throw error
      directory = parent
    }
  }
}

/** Options for {@link startWatchers}. */
export interface WatchersOptions {
  /** Files and existing ancestor dirs to watch (from {@link resolveWatchPaths}). */
  paths: { files: string[]; dirs: string[] }
  /** Resolved write-settle tuning. */
  tuning: WatchTuning
  /** Called on every settled watcher event (and once at ready). */
  refresh: () => void
  /** Called with non-fatal watcher errors. */
  onError: (error: unknown) => void
}

/**
 * Watch the settings files and their parent directories; resolves with the
 * closer only after both watchers finish their initial scans.
 * Both watchers share one `awaitWriteFinish` window: writeJsonAtomic commits
 * via rename, so the dir-derived events must settle the same window as the
 * file events or renames bypass the debounce entirely.
 */
export async function startWatchers(options: WatchersOptions): Promise<() => Promise<void>> {
  const { paths, tuning, refresh, onError } = options
  const awaitWriteFinish = {
    stabilityThreshold: tuning.stabilityThresholdMs,
    pollInterval: tuning.pollIntervalMs,
  }
  const watcher = chokidarWatch(paths.files, { ignoreInitial: true, awaitWriteFinish })
  // Follow only ancestors of concrete settings files. A fixed depth misses
  // files in newly created directories; unrestricted recursion could scan HOME.
  const ignored = (path: string) => {
    const normalized = resolve(path)
    const prefix = normalized.endsWith(sep) ? normalized : normalized + sep
    return !paths.files.some(file => file === normalized || file.startsWith(prefix))
  }
  // Poll this small, filtered tree as a fallback for dropped native events.
  const dirWatcher = chokidarWatch(paths.dirs, { ignoreInitial: true, ignored, usePolling: true, awaitWriteFinish })
  await Promise.all([watcher, dirWatcher].map((w) => new Promise<void>((resolve) => {
    w.on('all', refresh)
    w.on('ready', () => {
      // The base init's load raced the watcher's own setup: a change written
      // between that read and the watcher becoming active never fires an
      // event. One reconcile at ready closes the gap.
      refresh()
      resolve()
    })
    w.on('error', (error) => {
      onError(error)
      // Watch failures stay non-fatal and must not leave service startup hung.
      resolve()
    })
  })))
  return async () => {
    await Promise.all([watcher.close(), dirWatcher.close()])
  }
}
