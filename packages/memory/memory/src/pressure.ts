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
 * Arm the pressure marker with a value strictly above any previously recorded
 * arm (`max(now, previous + 1)`), preserving the previous `lastForcedAt` when
 * recoverable (else 0). The monotone stamp makes a new arm always
 * distinguishable from the marker's previous value even when wall-clock
 * timestamps collide or skew backwards, so a conditional clear can tell an
 * unserved newer arm from the one the dream already accounted for. Re-reads
 * the marker immediately before writing so a concurrent forced launch's fresh
 * stamp is not clobbered (a residual single-iteration race is accepted and
 * bounded). Best-effort: returns whether the write landed, so callers that
 * promise "consolidation queued" in model-visible text can gate that sentence
 * on it.
 * @param fs - the filesystem seam.
 * @param dir - the memory directory holding the marker.
 * @param now - the epoch stamped as `armedAt` (raised above a newer previous arm if needed).
 * @param policy - per-call sandbox policy for the marker write.
 */
export async function armPressure(fs: FileSystem, dir: string, now: number, policy?: MemoryWritePolicy): Promise<boolean> {
  try {
    const { target, absent } = await pressureTarget(fs, dir)
    let lastForcedAt = 0
    let previousArmedAt = 0
    if (!absent) {
      try {
        const prev = parse(await fs.readText(target))
        lastForcedAt = prev.lastForcedAt
        previousArmedAt = prev.armedAt
      } catch {
        // Corrupt marker: treat as never-armed/never-forced, arming still proceeds.
      }
    }
    const armedAt = Math.max(now, previousArmedAt + 1)
    await fs.writeText(target, format(armedAt, lastForcedAt), undefined, undefined, policy)
    return true
  } catch {
    return false
  }
}

/**
 * The fixed writers' strict marker read: content that is not a well-formed
 * `<armedAt>\n<lastForcedAt>\n` pair is treated exactly like a read failure,
 * never like a tombstone (the tolerant `parse` cannot distinguish corrupt
 * bytes from `armedAt = 0`, and disarming on unknown state is the destructive
 * direction). `null` means "unreadable or corrupt".
 */
async function readMarkerStrict(fs: FileSystem, target: FsTarget): Promise<PressureState | null> {
  try {
    const match = /^(\d+)\n(\d+)\n?$/.exec(await fs.readText(target))
    return match === null ? null : { armedAt: Number(match[1]), lastForcedAt: Number(match[2]) }
  } catch {
    return null
  }
}

/**
 * Stamp `lastForcedAt = now` while preserving the arm (consumes one cooldown
 * slot). Called by the consumer BEFORE lock acquisition so a held lock or a
 * killed spawn still throttles the next attempt. The arm is re-read
 * immediately before writing and the NEWER of the captured and current values
 * is kept, so a concurrent re-arm between the dream's read and this stamp is
 * no longer clobbered (issue #335 Face A); an already-tombstoned marker is
 * never resurrected; an unreadable or corrupt marker falls back to the
 * captured arm (never disarms). Best-effort: failures are swallowed so a
 * marker-hygiene problem never breaks a dream.
 * @param fs - the filesystem seam.
 * @param dir - the memory directory holding the marker.
 * @param armedAt - the armed epoch captured by the consumer's earlier read (fallback).
 * @param now - the epoch stamped as `lastForcedAt`.
 * @param policy - per-call sandbox policy for the marker write.
 */
export async function markPressureForced(fs: FileSystem, dir: string, armedAt: number, now: number, policy?: MemoryWritePolicy): Promise<void> {
  const target = await fs.resolve(join(dir, PRESSURE_FILE)).catch(() => undefined)
  if (target === undefined) return
  const current = await readMarkerStrict(fs, target)
  const keep = current === null ? armedAt
    : current.armedAt === 0 ? 0
      : Math.max(armedAt, current.armedAt)
  await fs.writeText(target, format(keep, now), undefined, undefined, policy).catch(() => {})
}

/**
 * Tombstone the marker after a successful consolidation — conditionally. The
 * dream passes the arm it captured at its initial read (`servedArmedAt`); an
 * arm that landed DURING the dream (newer than `servedArmedAt`) describes an
 * index state the rebuild did not address, so it SURVIVES with the cooldown
 * reference advanced to `now` (issue #335 Face B). Without `servedArmedAt`
 * the tombstone is unconditional (the historical contract for external
 * callers). An unreadable or corrupt marker is left untouched: tombstoning
 * on unknown state could silently disarm an unserved arm. Best-effort.
 * @param fs - the filesystem seam.
 * @param dir - the memory directory holding the marker.
 * @param now - the epoch stamped as the surviving `lastForcedAt`.
 * @param policy - per-call sandbox policy for the marker write.
 * @param servedArmedAt - the arm the completing dream accounted for; omit for an unconditional tombstone.
 */
export async function clearPressure(fs: FileSystem, dir: string, now: number, policy?: MemoryWritePolicy, servedArmedAt?: number): Promise<void> {
  const target = await fs.resolve(join(dir, PRESSURE_FILE)).catch(() => undefined)
  if (target === undefined) return
  const current = await readMarkerStrict(fs, target)
  if (current === null) return
  const armed = servedArmedAt !== undefined && current.armedAt > servedArmedAt ? current.armedAt : 0
  await fs.writeText(target, format(armed, now), undefined, undefined, policy).catch(() => {})
}
