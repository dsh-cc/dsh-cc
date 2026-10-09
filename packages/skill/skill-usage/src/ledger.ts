/**
 * Ledger plumbing for skill-usage telemetry (design §3.2): the per-workspace
 * JSONL load ledger and the observation-start marker, both under
 * `<dshHome>/skill-usage/`. Every write is best-effort — a failure here must
 * never surface into an emitter — and the marker is create-if-absent only
 * (trigger #1 of two; trigger #2 belongs to the rollup slice).
 *
 * @module
 */

import { mkdir, open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { appendJsonl } from '@dsh-cc/sidecar-io'
import { readUserSettingsSync } from './settings.ts'

/** One committed skill load (design §3.2 row shape). */
export interface SkillLoadRow {
  v: 1
  /** Epoch milliseconds. */
  ts: number
  sessionId: string
  skill: string
  via: 'tool' | 'slash'
  provider?: string
}

/** The per-workspace load ledger path. */
export function ledgerPath(dshHome: string, projectKey: string): string {
  return join(dshHome, 'skill-usage', `loads-${projectKey}.jsonl`)
}

/** The observation-start marker path (§3.4 coverage guard input). */
export function markerPath(dshHome: string, projectKey: string): string {
  return join(dshHome, 'skill-usage', `observing-since-${projectKey}`)
}

/**
 * Create the observation-start marker iff absent, stamping the current epoch
 * ms. `wx` makes the create-once semantics atomic: an existing marker is
 * never overwritten. Never throws.
 */
export async function createMarkerIfAbsent(filePath: string): Promise<void> {
  try {
    await mkdir(join(filePath, '..'), { recursive: true })
    const handle = await open(filePath, 'wx')
    try {
      await writeFile(handle, String(Date.now()), 'utf8')
    } finally {
      await handle.close()
    }
  } catch {
    // Exists (or fs denied) — create-if-absent means both are fine.
  }
}

/**
 * Commit one matched skill load: raw user-layer enabled gate (hot toggle;
 * when false, no row AND no marker), then an awaited-then-detached ledger
 * append followed by the create-if-absent marker. Every error is swallowed —
 * telemetry must never throw into an emitter.
 */
export function commitLoad(
  ctx: { logger?: { debug?: (message: string) => void } },
  dshHome: string,
  projectKey: string,
  base: Omit<SkillLoadRow, 'v' | 'ts'>,
): void {
  // Raw user-layer read per matched event (§3.5) — hot toggle, user layer only.
  let enabled: boolean
  try {
    enabled = readUserSettingsSync(dshHome).enabled
  } catch {
    enabled = true
  }
  if (!enabled) {
    debug(ctx, 'skill-usage: telemetry disabled — load row skipped')
    return
  }
  const row: SkillLoadRow = { v: 1, ts: Date.now(), ...base }
  void appendJsonl(ledgerPath(dshHome, projectKey), row, { repairTail: true })
    .then(() => createMarkerIfAbsent(markerPath(dshHome, projectKey)))
    .catch((error: unknown) => { debug(ctx, `skill-usage: ledger append failed: ${String(error)}`) })
}

/** Debug notice (fail-soft, watchdog pattern). */
export function debug(ctx: { logger?: { debug?: (message: string) => void } }, message: string): void {
  try {
    ctx.logger?.debug?.(message)
  } catch {
    // Never throw into a hot path.
  }
}
