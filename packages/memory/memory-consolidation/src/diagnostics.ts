/**
 * Dream dispatch diagnostics: a durable "why did the dream die" breadcrumb
 * inside the memory directory. The file `.dream-last-error.json` carries the
 * LATEST failure (overwrite, never append — failure is a cold path and one
 * fresh record beats an unbounded log):
 * `{ at, pid, sessionId, phase, detail }` where phase distinguishes the death
 * modes: `dispatch-started` (spawn dispatched, outcome unknown = hang when the
 * file is never overwritten), `dispatch-throw` (the dispatch threw; detail
 * carries the error + stack), `outcome-failed` (the job settled as failed or
 * killed; detail carries the job outcome).
 *
 * The write mirrors lock.ts/pressure.ts byte-for-byte (`fs.writeText(target,
 * content, policy)` direct write) — it MUST NOT go through `writeMemoryFiles`,
 * whose FILE_NAME whitelist rejects dotfiles/`.json`. Never throws: a
 * diagnostic failure must not kill the dream path it is reporting on.
 * @module @dsh-cc/memory-consolidation/diagnostics
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import type { MemoryWritePolicy } from '@dsh-cc/memory'

/** Diagnostic filename inside the workspace memory directory. */
export const DREAM_DIAGNOSTIC_FILE = '.dream-last-error.json'

/** The death mode the entry records. */
export type DreamDiagnosticPhase = 'dispatch-started' | 'dispatch-throw' | 'outcome-failed'

/** One diagnostic record; written as `{ at, pid, ...entry }` JSON. */
export interface DreamDiagnosticEntry {
  /** The owning session id (`agent.session.header.id`). */
  sessionId: string
  phase: DreamDiagnosticPhase
  /** Human-readable error text (error + stack, or the job outcome detail). */
  detail: string
}

/**
 * Overwrite `<dir>/.dream-last-error.json` with the entry. Best-effort: any
 * failure is swallowed after a single `ctx.logger.warn` so diagnostics can
 * never break a dream (plan §2.1, review Minor-3).
 * @param ctx - the host context (logger only).
 * @param fs - the filesystem seam.
 * @param dir - the workspace memory directory holding the diagnostic file.
 * @param policy - per-call sandbox policy for the write (same as the lock).
 * @param entry - the phase/session/detail payload.
 */
export async function recordDreamDiagnostic(
  ctx: Context,
  fs: FileSystem,
  dir: string,
  policy: MemoryWritePolicy | undefined,
  entry: DreamDiagnosticEntry,
): Promise<void> {
  try {
    const target: FsTarget = await fs.resolve(join(dir, DREAM_DIAGNOSTIC_FILE))
    const content = `${JSON.stringify({ at: Date.now(), pid: process.pid, ...entry })}\n`
    await fs.writeText(target, content, undefined, undefined, policy)
  } catch (err) {
    ctx.logger.warn(`memory-consolidation: failed to write dream diagnostic: ${String(err)}`)
  }
}
