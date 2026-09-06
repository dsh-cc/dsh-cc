/**
 * Host-side write-back for memory fork output.
 *
 * The extraction/dream forks inherit the parent session's sandbox policy,
 * under which the memory directory (the harness home) is OUTSIDE the session
 * workspace: every model-side `write` is fenced, and a background job cannot
 * escalate (escalation prompts, and its approval policy is `never`). So the
 * forks return their file set as structured output and the plugin — trusted
 * host code — performs the writes itself, stamping a per-call policy whose
 * writable root IS the memory directory. The sandbox still confines each
 * write behind the filename validation below (defense in depth); nothing
 * outside the memory directory becomes writable.
 *
 * Validation rejects the WHOLE batch on any violation — a partial write would
 * leave the index and its topic files inconsistent with no signal back to the
 * fork that produced them.
 * @module @dsh-cc/memory-consolidation/writeback
 */

import { join } from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'

/** One file the fork asks the plugin to write: a flat filename plus full body. */
export interface MemoryWrite {
  readonly path: string
  readonly content: string
}

/** The structured-output contract every memory fork reports. */
export const MEMORY_WRITES_SCHEMA = {
  type: 'object',
  properties: {
    writes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  required: ['writes'],
  additionalProperties: false,
} as const

/** At most this many files per fork report. */
export const WRITEBACK_MAX_FILES = 32
/** Per-file body cap, in UTF-8 bytes. */
export const WRITEBACK_MAX_FILE_BYTES = 64 * 1024
/** Whole-batch body cap, in UTF-8 bytes. */
export const WRITEBACK_MAX_TOTAL_BYTES = 256 * 1024

/**
 * Flat `.md` filenames only: a leading alphanumeric, then alphanumerics /
 * dots / dashes / underscores. This forbids separators, `..` escapes,
 * absolute paths, and dotfiles (including the consolidation lock) in one rule.
 */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/

/**
 * The per-call policy stamped on host-side memory writes: confinement is kept
 * (`workspace-write`), but the writable root is the memory directory itself.
 * Mirrors the upstream "an approved escalation stamps a wider mode for one
 * call" mechanism — here the plugin is the approver, and the name validation
 * above has already narrowed the file set.
 */
export interface MemoryWritePolicy {
  readonly mode: 'workspace-write'
  readonly workspaceRoot: string
}

/** The policy for host-side writes inside `dir` (also used for the dream lock). */
export function memoryWritePolicy(dir: string): MemoryWritePolicy {
  return { mode: 'workspace-write', workspaceRoot: dir }
}

/**
 * Validate a fork's structured payload into a writable batch. Throws with a
 * precise reason on ANY violation; an empty `writes` array is a valid no-op.
 * @param input - the raw `structured` value captured from the fork.
 * @returns the validated writes.
 */
export function validateMemoryWrites(input: unknown): MemoryWrite[] {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('memory fork output must be an object with a "writes" array')
  }
  const raw = (input as { writes?: unknown }).writes
  if (!Array.isArray(raw)) {
    throw new Error('memory fork output must be an object with a "writes" array')
  }
  if (raw.length > WRITEBACK_MAX_FILES) {
    throw new Error(`memory fork reported ${raw.length} files, over the ${WRITEBACK_MAX_FILES} cap`)
  }
  const seen = new Set<string>()
  let total = 0
  const writes: MemoryWrite[] = raw.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`memory write #${i} must be an object with path/content strings`)
    }
    const { path, content } = entry as { path?: unknown; content?: unknown }
    if (typeof path !== 'string' || typeof content !== 'string') {
      throw new Error(`memory write #${i} must be an object with path/content strings`)
    }
    if (!FILE_NAME.test(path)) {
      throw new Error(`invalid memory filename "${path}": expected a flat .md name`)
    }
    if (seen.has(path)) {
      throw new Error(`duplicate memory filename "${path}" in one batch`)
    }
    seen.add(path)
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > WRITEBACK_MAX_FILE_BYTES) {
      throw new Error(`memory file "${path}" is ${bytes} bytes, over the ${WRITEBACK_MAX_FILE_BYTES} cap`)
    }
    total += bytes
    return { path, content }
  })
  if (total > WRITEBACK_MAX_TOTAL_BYTES) {
    throw new Error(`memory batch is ${total} bytes, over the ${WRITEBACK_MAX_TOTAL_BYTES} cap`)
  }
  return writes
}

/**
 * Validate, then write the batch inside the memory directory under the
 * confined per-call policy. Writes are sequential so a mid-batch failure
 * leaves a deterministic prefix; the caller maps any throw to a failed job.
 * @param fs - the filesystem seam.
 * @param dir - the memory directory root.
 * @param writes - an already-validated batch (see {@link validateMemoryWrites}).
 * @returns the filenames written, in batch order.
 */
export async function writeMemoryFiles(
  fs: FileSystem,
  dir: string,
  writes: readonly MemoryWrite[],
): Promise<string[]> {
  const policy = memoryWritePolicy(dir)
  const written: string[] = []
  for (const { path, content } of writes) {
    const target = await fs.resolve(join(dir, path))
    await fs.writeText(target, content, undefined, undefined, policy)
    written.push(path)
  }
  return written
}
