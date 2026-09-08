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
import { dirname } from 'node:path'

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
 * deduped. The result also carries each file's parent directory: chokidar
 * v4 emits nothing for a watched path whose parent directory does not yet
 * exist, so a settings file created after boot (e.g. the project
 * `.claude/settings.json`) is only seen through its directory watch.
 */
export async function resolveWatchPaths(
  paths: ReadonlyArray<string | undefined>,
): Promise<{ files: string[]; dirs: string[] }> {
  const concrete = paths.filter((path): path is string => path !== undefined)
  const canonical = [...new Set(await Promise.all(concrete.map(path => canonicalizeWatchPath(path))))]
  return {
    files: canonical,
    dirs: [...new Set(canonical.map(path => dirname(path)))],
  }
}

/** Options for {@link startWatchers}. */
export interface WatchersOptions {
  /** Files and parent dirs to watch (from {@link resolveWatchPaths}). */
  paths: { files: string[]; dirs: string[] }
  /** Resolved write-settle tuning. */
  tuning: WatchTuning
  /** Called on every settled watcher event (and once at ready). */
  refresh: () => void
  /** Called with non-fatal watcher errors. */
  onError: (error: unknown) => void
}

/**
 * Watch the settings files and their parent directories; returns the closer.
 * Both watchers share one `awaitWriteFinish` window: writeJsonAtomic commits
 * via rename, so the dir-derived events must settle the same window as the
 * file events or renames bypass the debounce entirely.
 */
export function startWatchers(options: WatchersOptions): () => Promise<void> {
  const { paths, tuning, refresh, onError } = options
  const awaitWriteFinish = {
    stabilityThreshold: tuning.stabilityThresholdMs,
    pollInterval: tuning.pollIntervalMs,
  }
  const watcher = chokidarWatch(paths.files, { ignoreInitial: true, awaitWriteFinish })
  // Parent directories are watched at depth 0: a plain dir watch would
  // recurse (a settings file may live directly in $HOME), which is both a
  // boot-cost and a noise problem. Depth 0 still reports direct children,
  // which is all the creation-after-boot case needs.
  const dirWatcher = chokidarWatch(paths.dirs, { ignoreInitial: true, depth: 0, awaitWriteFinish })
  for (const w of [watcher, dirWatcher]) {
    w.on('all', refresh)
    w.on('ready', () => {
      // The base init's load raced the watcher's own setup: a change written
      // between that read and the watcher becoming active never fires an
      // event. One reconcile at ready closes the gap.
      refresh()
    })
    w.on('error', (error) => {
      onError(error)
    })
  }
  return async () => {
    await Promise.all([watcher.close(), dirWatcher.close()])
  }
}
