/**
 * Shared sidecar IO plumbing for observer packages: dsh-home resolution,
 * project-key hashing, and JSONL ledger append/read with swallow-on-error.
 * Ledger ordering/trimming sinks stay per-package; this module holds only the
 * byte-identical primitives that were being copied across five packages.
 * @module @dsh-cc/sidecar-io
 */

import { createHash } from 'node:crypto'
import { appendFile, mkdir, open, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Harness-home path resolver, provided by @deepseek-ai/dsh-app-boot at boot. Optional in tests. */
    dshHomePath?: (...segments: string[]) => string
  }
}

/** dshHomePath seam, read defensively (a providerless host must not crash the plugin). */
export type HomeFn = (...segments: string[]) => string

/**
 * Read a dsh-home path without throwing when the boot-provided `dshHomePath`
 * resolver is absent — cordis throws on the property access itself (not a
 * plain `undefined`), so the read must be guarded.
 */
export function dshHomeFn(ctx: Context): HomeFn | undefined {
  try {
    return ctx.dshHomePath
  } catch {
    return undefined
  }
}

/** sha256 hex, first `width` chars — the shared content/project key shape. */
export function shortHash(input: string, width = 16): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, width)
}

/** projectKey = shortHash of the session cwd (context-crusher idiom). */
export function projectKeyOf(cwd: string, width = 16): string {
  return shortHash(cwd, width)
}

/** Join a ledger file path under a dsh-home root. */
export function jsonlPath(root: string, ...parts: string[]): string {
  return join(root, ...parts)
}

/**
 * Append one JSONL row; never throws. Creates the parent directory when
 * missing. With `repairTail`, append a missing trailing newline to a
 * pre-existing non-empty file first (best-effort: a concurrent appender may
 * interleave, leaving one unparseable line — readers skip it). Best-effort
 * observability — must never surface into the caller's waterfall.
 */
export async function appendJsonl(
  filePath: string,
  row: unknown,
  opts: { repairTail?: boolean } = {},
): Promise<void> {
  try {
    await mkdir(dirname(filePath), { recursive: true })
    if (opts.repairTail) {
      const info = await stat(filePath).catch(() => undefined)
      if (info && info.size > 0) {
        const handle = await open(filePath, 'r')
        try {
          const buf = Buffer.alloc(1)
          const read = await handle.read(buf, 0, 1, info.size - 1)
          if (read.bytesRead === 1 && buf[0] !== 0x0a) {
            await appendFile(filePath, '\n', 'utf8')
          }
        } finally {
          await handle.close()
        }
      }
    }
    await appendFile(filePath, `${JSON.stringify(row)}\n`, 'utf8')
  } catch {
    // Best-effort observability; never surface into the caller's waterfall.
  }
}

/**
 * Read a JSONL file into typed rows; never throws (a missing file yields `[]`).
 * Tolerant of a truncated tail line: a torn final write from a crash
 * mid-append is skipped, not fatal. Blank lines are skipped.
 */
export async function readJsonl<T>(filePath: string): Promise<T[]> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    return []
  }
  const rows: T[] = []
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      rows.push(JSON.parse(line) as T)
    } catch {
      // Truncated tail line: torn final write; skip and keep the prefix.
    }
  }
  return rows
}
