/**
 * Directory scan over a memdir through the optional `ctx.fs` seam: list topic
 * files, parse their frontmatter, and read the always-loaded entrypoint. Used
 * by the system-prompt section index and by recall.
 * @module @dsh-cc/memory/scan
 */

import type { FileSystem, FsError, FsTarget } from '@deepseek-ai/dsh-fs'
import { parseMemoryFile } from './parser.ts'
import { ENTRYPOINT_NAME } from './truncate.ts'
import type { MemoryIndexEntry } from './types.ts'

/** One observed memdir state. */
export interface MemoryDirectoryState {
  /** The memory directory path. */
  dir: string
  /** Raw (pre-truncation) entrypoint text, or `undefined` when absent. */
  entrypoint: string | undefined
  /** Topic files with rationalized headers, excluding MEMORY.md itself. */
  topics: MemoryIndexEntry[]
}

/**
 * Scan a memory directory for its entrypoint and topic files.
 * A missing directory or entrypoint is not an error — the caller renders an
 * empty section. Files are read with the caller's cancellation signal; the
 * result contains only topics whose frontmatter parsed successfully.
 * @param fs - the contiguous filesystem seam.
 * @param dir - the memory directory to scan.
 * @param signal - optional cancellation for the underlying fs reads.
 * @returns the observed directory state, never throwing for absent files.
 */
export async function scanMemoryDirectory(
  fs: FileSystem,
  dir: string,
  signal?: AbortSignal,
): Promise<MemoryDirectoryState> {
  const topics: MemoryIndexEntry[] = []
  let entrypoint: string | undefined
  let entries
  try {
    const target = signal !== undefined
      ? await fs.resolve(dir, { signal })
      : await fs.resolve(dir)
    entries = await fs.listDir(target, signal)
  } catch {
    // Missing or unreadable memory directory: treat as empty.
    return { dir, entrypoint: undefined, topics }
  }
  for (const entry of entries) {
    if (entry.type !== 'file') continue
    if (entry.name === ENTRYPOINT_NAME) {
      entrypoint = await readOptionalText(fs, entry.target, signal)
      continue
    }
    if (!entry.name.endsWith('.md')) continue
    const raw = await readOptionalText(fs, entry.target, signal)
    if (raw === undefined) continue
    const parsed = parseMemoryFile(raw)
    if (parsed === undefined) continue
    topics.push({ path: entry.target.displayPath, filename: entry.name, frontmatter: parsed.frontmatter })
  }
  topics.sort((a, b) => a.filename.localeCompare(b.filename))
  return { dir, entrypoint, topics }
}

async function readOptionalText(
  fs: FileSystem,
  target: FsTarget,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    return await fs.readText(target, signal)
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error
    && ((error as FsError).code === 'FS_NOT_FOUND'
      || (error as FsError).code === 'FS_NOT_DIRECTORY'
      || (error as { code?: string }).code === 'ENOENT')
}
