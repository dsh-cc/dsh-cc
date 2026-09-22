/**
 * The consolidation-pressure marker: a durable "index is over pressure, queue
 * a forced dream" flag inside the memory directory.
 *
 * The file `.consolidation-needed` carries `<armedAtMs>\n<lastForcedAtMs>\n`
 * (two lines, mirroring the lock file's `<pid>\n<at>\n` convention). The fs
 * seam exposes no remove, so "clear" is a tombstone write (`armedAt = 0`)
 * exactly like `rollbackLock`; `lastForcedAt` survives so the consumer's
 * cooldown still applies to a fresh arm. Every writer is best-effort: arming
 * must never break a save and marker hygiene must never break a dream.
 * @module @dsh-cc/memory/pressure
 */

import { join } from 'node:path'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import type { MemoryWritePolicy } from './writeback.ts'

/** Pressure marker filename inside the memory directory. */
export const PRESSURE_FILE = '.consolidation-needed'

/** Parsed marker state; zeros mean absent/cleared. */
export interface PressureState {
  /** Epoch of the latest arming; `> 0` means pressure is pending. */
  armedAt: number
  /** Epoch of the last forced launch (cooldown reference); 0 when never. */
  lastForcedAt: number
}

/** Content of the marker file: `<armedAtMs>\n<lastForcedAtMs>\n`. */
const format = (armedAt: number, lastForcedAt: number): string => `${armedAt}\n${lastForcedAt}\n`

/** Mirror of lock.ts's tolerant parse: any finite number, else 0. */
function parse(content: string): PressureState {
  const [armedRaw, forcedRaw] = content.trim().split('\n')
  const of = (raw: string | undefined) =>
    raw !== undefined && Number.isFinite(Number(raw)) ? Number(raw) : 0
  return { armedAt: of(armedRaw), lastForcedAt: of(forcedRaw) }
}

/** Resolve the marker target and whether it exists. */
async function pressureTarget(fs: FileSystem, dir: string): Promise<{ target: FsTarget; absent: boolean }> {
  const target = await fs.resolve(join(dir, PRESSURE_FILE))
  const info = await fs.stat(target)
  return { target, absent: info === undefined }
}

/**
 * Best-effort read of the pressure marker. Any failure (absent file,
 * unreadable, corrupt content) yields zeros — "no pressure pending".
 * @param fs - the filesystem seam.
 * @param dir - the memory directory holding the marker.
 */
export async function readPressure(fs: FileSystem, dir: string): Promise<PressureState> {
  try {
    const { target, absent } = await pressureTarget(fs, dir)
    if (absent) return { armedAt: 0, lastForcedAt: 0 }
    return parse(await fs.readText(target))
  } catch {
    return { armedAt: 0, lastForcedAt: 0 }
  }
}

/**
 * Arm the pressure marker with `now` as `armedAt`, preserving the previous
 * `lastForcedAt` when recoverable (else 0). Re-reads the marker immediately
 * before writing so a concurrent forced launch's fresh stamp is not clobbered
 * (a residual single-iteration race is accepted and bounded). Best-effort:
 * returns whether the write landed, so callers that promise "consolidation
 * queued" in model-visible text can gate that sentence on it.
 * @param fs - the filesystem seam.
 * @param dir - the memory directory holding the marker.
 * @param now - the epoch stamped as `armedAt`.
 * @param policy - per-call sandbox policy for the marker write.
 */
export async function armPressure(fs: FileSystem, dir: string, now: number, policy?: MemoryWritePolicy): Promise<boolean> {
  try {
    const { target, absent } = await pressureTarget(fs, dir)
    let lastForcedAt = 0
    if (!absent) {
      try {
        lastForcedAt = parse(await fs.readText(target)).lastForcedAt
      } catch {
        // Corrupt marker: treat as never-forced, arming still proceeds.
      }
    }
    await fs.writeText(target, format(now, lastForcedAt), undefined, undefined, policy)
    return true
  } catch {
    return false
  }
}

/**
 * Stamp `lastForcedAt = now` while keeping `armedAt` (consumes one cooldown
 * slot). Called by the consumer BEFORE lock acquisition so a held lock or a
 * killed spawn still throttles the next attempt. Best-effort: failures are
 * swallowed so a marker-hygiene problem never breaks a dream.
 * @param fs - the filesystem seam.
 * @param dir - the memory directory holding the marker.
 * @param armedAt - the armed epoch to carry through unchanged.
 * @param now - the epoch stamped as `lastForcedAt`.
 * @param policy - per-call sandbox policy for the marker write.
 */
export async function markPressureForced(fs: FileSystem, dir: string, armedAt: number, now: number, policy?: MemoryWritePolicy): Promise<void> {
  const target = await fs.resolve(join(dir, PRESSURE_FILE)).catch(() => undefined)
  if (target === undefined) return
  await fs.writeText(target, format(armedAt, now), undefined, undefined, policy).catch(() => {})
}

/**
 * Tombstone the marker (`armedAt = 0`, `lastForcedAt = now`) after a
 * successful consolidation; the cooldown timestamp survives so a fresh arm
 * still waits out the remainder of the window. Best-effort.
 * @param fs - the filesystem seam.
 * @param dir - the memory directory holding the marker.
 * @param now - the epoch stamped as the surviving `lastForcedAt`.
 * @param policy - per-call sandbox policy for the marker write.
 */
export async function clearPressure(fs: FileSystem, dir: string, now: number, policy?: MemoryWritePolicy): Promise<void> {
  const target = await fs.resolve(join(dir, PRESSURE_FILE)).catch(() => undefined)
  if (target === undefined) return
  await fs.writeText(target, format(0, now), undefined, undefined, policy).catch(() => {})
}
