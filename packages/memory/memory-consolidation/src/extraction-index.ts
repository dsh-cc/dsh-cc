/**
 * The index read shared by the legacy extraction prompt and the extraction
 * coordinator (design
 * docs/plans/2026-11-02-systemone-04-memory-extraction-gate.md §"Building a
 * complete window from the event watermark", §"State machine and commit
 * rules").
 *
 * One filesystem read, two shapes:
 * - the RAW snapshot the window builder sees, where a failed read or an
 *   over-cap index marks the window incomplete (never "reviewed nothing");
 * - the CAPPED injection string the legacy whole-session prompt embeds and the
 *   write-back uses as its baseline, byte-identical to the pre-gate behavior.
 *
 * Both shapes come from the same read so the prompt's "Existing topics" section
 * and the write-back baseline can never describe different indexes.
 *
 * @module @dsh-cc/memory-consolidation/extraction-index
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { IndexSnapshot } from './extraction-window.ts'

/** Upper bound on the injected index: first 200 lines or 8 KiB, whichever first. */
const INDEX_CAP_LINES = 200
const INDEX_CAP_BYTES = 8 * 1024
/** Marker the injected index carries when it was truncated. */
const INDEX_TRUNCATED_MARKER = '(index truncated; rely on MEMORY.md in-dir for the rest)'

/** What one raw index read yielded, before any capping. */
export type RawIndexRead =
  | { kind: 'absent' }
  | { kind: 'text'; text: string }
  | { kind: 'failed' }

/**
 * One host index read in the two shapes the extraction coordinator needs.
 */
export interface ExtractionIndexRead {
  /** What `buildExtractionWindow` sees. */
  readonly snapshot: IndexSnapshot
  /** The legacy capped injection string, marker included. */
  readonly promptIndex: string
}

/**
 * Read the existing topic index once, uncapped: the MEMORY.md body when present,
 * else the names of sibling topic `.md` files. `absent` means the directory
 * genuinely has no index (a complete empty index); `failed` means the read itself
 * failed, which the window builder must treat as incomplete rather than as
 * "nothing was reviewed".
 * @param ctx - the host context carrying the optional `fs` service.
 * @param dir - the canonical workspace memory directory.
 * @returns the raw read.
 */
export async function readRawIndex(ctx: Context, dir: string): Promise<RawIndexRead> {
  const fs = ctx.get('fs')
  if (fs === undefined) return { kind: 'failed' }
  try {
    const memoryTarget = await fs.resolve(join(dir, 'MEMORY.md'))
    const info = await fs.stat(memoryTarget)
    let raw: string
    if (info !== undefined) {
      raw = await fs.readText(memoryTarget)
    } else {
      // No index file: fall back to listing topic `.md` files in the directory.
      const dirTarget = await fs.resolve(dir)
      const entries = await fs.listDir(dirTarget)
      raw = entries
        .filter((e) => e.type === 'file' && e.name.endsWith('.md') && e.name !== 'MEMORY.md')
        .map((e) => e.name)
        .sort()
        .join('\n')
    }
    return raw === '' ? { kind: 'absent' } : { kind: 'text', text: raw }
  } catch {
    return { kind: 'failed' }
  }
}

/**
 * Cap an index for prompt injection at the first 200 lines OR 8 KiB, whichever
 * comes first, appending a marker when truncated so the model knows to rely on
 * the in-dir file.
 * @param raw - the full index text.
 * @returns the capped injection string, marker included.
 */
export function capIndexForPrompt(raw: string): string {
  if (raw === '') return ''
  const lines = raw.split('\n')
  const kept: string[] = []
  let bytes = 0
  let truncated = false
  for (const line of lines) {
    if (kept.length >= INDEX_CAP_LINES) { truncated = true; break }
    const add = line.length + (kept.length > 0 ? 1 : 0)
    if (bytes + add > INDEX_CAP_BYTES) { truncated = true; break }
    kept.push(line)
    bytes += add
  }
  const capped = kept.join('\n')
  return truncated ? `${capped}\n${INDEX_TRUNCATED_MARKER}` : capped
}

/**
 * Read the existing topic index to inject into the extraction prompt.
 * Swallow-all: any error or an absent fs yields an empty index so a spawn is
 * never blocked by the read.
 * @param ctx - the host context carrying the optional `fs` service.
 * @param dir - the canonical workspace memory directory.
 * @returns the capped injection string (`''` when absent or unreadable).
 */
export async function readExistingIndex(ctx: Context, dir: string): Promise<string> {
  const raw = await readRawIndex(ctx, dir)
  return raw.kind === 'text' ? capIndexForPrompt(raw.text) : ''
}

/**
 * One index read for the extraction coordinator, in both required shapes.
 * @param ctx - the host context carrying the optional `fs` service.
 * @param dir - the canonical workspace memory directory.
 * @returns the coordinator's index read.
 */
export async function readExtractionIndex(ctx: Context, dir: string): Promise<ExtractionIndexRead> {
  const raw = await readRawIndex(ctx, dir)
  if (raw.kind === 'text') {
    return { snapshot: { kind: 'text', text: raw.text }, promptIndex: capIndexForPrompt(raw.text) }
  }
  return { snapshot: raw, promptIndex: '' }
}
