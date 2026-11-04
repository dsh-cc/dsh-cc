/**
 * Optimistic commit protocol for the always-loaded `MEMORY.md` index.
 *
 * Four independent writers (tool save, extraction write-back, dream write-back,
 * `/learn apply`) mutate the same index with no mutual exclusion, and the fs
 * seam exposes no atomic compare-and-swap or temp+rename contract. The protocol
 * here is therefore write-then-verify-and-rebase: every attempt rebuilds from a
 * fresh read, writes the batch's topic files first, re-verifies the index it
 * built from, writes the index, and then reads it back. A detected concurrent
 * commit restarts the attempt from the durable state; the builder's effect must
 * therefore be re-appliable (upsert / merge).
 *
 * The only remaining lost-update window is a foreign index write landing
 * between the pre-write verify and this attempt's index write — a single
 * `fs.writeText` wide, the same accepted symmetric-collision residual class the
 * consolidation lock documents (`lock.ts`). Everything else is either detected
 * as a stale build or as a post-write change and healed by a rebase round.
 * @module @dsh-cc/memory/index-commit
 */

import { Buffer } from 'node:buffer'
import { join } from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { ENTRYPOINT_NAME, MAX_ENTRYPOINT_BYTES, MAX_ENTRYPOINT_LINES } from './truncate.ts'
import { writeMemoryFiles } from './writeback.ts'
import type { MemoryWrite } from './writeback.ts'

/** One line's first pointer target: the `<name>.md` inside `](...)`. */
const POINTER_TARGET = /\]\(([^()\s]+\.md)\)/g

/** Extract the first pointer target on a line (case-sensitive, exact string). */
function firstPointerTarget(line: string): string | undefined {
  POINTER_TARGET.lastIndex = 0
  const match = POINTER_TARGET.exec(line)
  return match?.[1]
}

/** Append lines after a (possibly empty) body, newline-terminated. */
function appendLines(body: string, lines: readonly string[]): string {
  const trimmed = body.trimEnd()
  return trimmed.length > 0 ? `${trimmed}\n${lines.join('\n')}\n` : `${lines.join('\n')}\n`
}

/**
 * Read the index for the commit protocol. Absent index → `''` (stat first, so a
 * missing file is distinguished from an unreadable one). A read throw after a
 * successful stat propagates: a read failure is never "verified empty content".
 * @param fs - the filesystem seam.
 * @param dir - the memory directory root.
 * @returns the current index content, or `''` when the file does not exist.
 */
export async function readIndexStrict(fs: FileSystem, dir: string): Promise<string> {
  const target = await fs.resolve(join(dir, ENTRYPOINT_NAME))
  const info = await fs.stat(target)
  if (info === undefined) return ''
  return fs.readText(target)
}

/** The commit protocol exhausted its bounded attempts without a stable write. */
export class MemoryIndexConflictError extends Error {
  constructor(public readonly attempts: number) {
    super(`memory index commit conflicted with concurrent writers after ${attempts} attempts`)
    this.name = 'MemoryIndexConflictError'
  }
}

/** The outcome of a successful commit. */
export interface CommitResult<T> {
  /** Filenames written, in batch order (topic files, then `MEMORY.md`). */
  written: string[]
  /** The SUCCESSFUL attempt's build metadata. */
  meta: T
}

/**
 * Commit a built write batch against the durable index with verify-and-rebase.
 *
 * The builder owns validation: `commitMemoryWrites` never validates, and a
 * builder throw (invalid input, cap violation) exits the loop immediately. The
 * batch may contain at most one `MEMORY.md` write; the helper writes the topic
 * files before re-verifying the index, so the "index never references a topic
 * file that is not yet written" invariant holds structurally.
 * @param fs - the filesystem seam.
 * @param dir - the memory directory root.
 * @param build - rebuilds the batch from a fresh index; may throw to reject.
 * @param attempts - bounded commit rounds (positive integer below 1000).
 * @returns the written filenames and the winning attempt's metadata.
 * @throws {MemoryIndexConflictError} when every attempt observed a concurrent write.
 */
export async function commitMemoryWrites<T>(
  fs: FileSystem,
  dir: string,
  build: (freshIndex: string) => Promise<{ writes: readonly MemoryWrite[]; meta: T }>,
  attempts = 12,
): Promise<CommitResult<T>> {
  if (!Number.isInteger(attempts) || attempts <= 0 || attempts >= 1000) {
    throw new RangeError(`attempts must be a positive integer below 1000, got ${attempts}`)
  }

  for (let round = 0; round < attempts; round++) {
    const fresh = await readIndexStrict(fs, dir)
    const { writes, meta } = await build(fresh)
    const indexWrite = writes.find(write => write.path === ENTRYPOINT_NAME)
    if (writes.filter(write => write.path === ENTRYPOINT_NAME).length > 1) {
      throw new Error(`a memory batch may contain at most one ${ENTRYPOINT_NAME} write`)
    }
    // Topic files are idempotent and go first; a pure topic batch never reads
    // beyond the initial `fresh` and commits in one pass.
    const topicWrites = writes.filter(write => write.path !== ENTRYPOINT_NAME)
    const written = await writeMemoryFiles(fs, dir, topicWrites)
    if (indexWrite === undefined) return { written, meta }

    const pre = await readIndexStrict(fs, dir)
    if (pre !== fresh) continue // a concurrent commit landed mid-build; rebuild

    await writeMemoryFiles(fs, dir, [indexWrite])
    const back = await readIndexStrict(fs, dir)
    if (back === indexWrite.content) return { written: [...written, ENTRYPOINT_NAME], meta }
    // The durable index changed after our write (another writer interleaved,
    // or a concurrent writer rebased onto our content): rebase and re-apply.
  }
  throw new MemoryIndexConflictError(attempts)
}

/**
 * The pointer lines `current` added beyond what the model could have seen.
 *
 * A pointer target is the first `](<name>.md)` on a line. A line qualifies when
 * its target appears in NEITHER `base` nor `baseline`; duplicates within
 * `current` keep their first occurrence. Whole-document `includes` membership
 * matches `upsertPointer`'s semantics exactly.
 * @param current - the durable index read at commit time.
 * @param base - the model's full index rewrite.
 * @param baseline - the exact index snapshot the model could see.
 * @returns the qualifying lines, in `current` order.
 */
export function pointerAdditions(current: string, base: string, baseline: string): string[] {
  const additions: string[] = []
  const seen = new Set<string>()
  for (const line of current.split('\n')) {
    const target = firstPointerTarget(line)
    if (target === undefined || seen.has(target)) continue
    seen.add(target)
    if (base.includes(target) || baseline.includes(target)) continue
    additions.push(line)
  }
  return additions
}

/**
 * Merge the durable index's concurrent additions into the model's rewrite.
 *
 * `base` (the model's full rewrite) wins for content it contains — deletions
 * and same-target description edits included; only lines whose target is absent
 * from both `base` and `baseline` are appended, in `current` order.
 * @param base - the model's full index rewrite.
 * @param current - the durable index read at commit time.
 * @param baseline - the exact index snapshot the model could see.
 * @returns the merged document (`base` verbatim when nothing qualifies).
 */
export function mergeIndexContent(base: string, current: string, baseline: string): string {
  const additions = pointerAdditions(current, base, baseline)
  return additions.length === 0 ? base : appendLines(base, additions)
}

/**
 * Carve room for protected additions when the merged index exceeds its caps.
 *
 * Under-cap documents pass through unchanged. Over-cap documents drop tail
 * lines from the MODEL part until both the line budget (`MAX_ENTRYPOINT_LINES`
 * minus the additions' lines) and the byte budget (`MAX_ENTRYPOINT_BYTES` minus
 * the additions' bytes, including the separator newline before them and the
 * terminating newline) fit. Additions that alone exceed either cap throw — a
 * builder throw is terminal for the commit loop; an addition is never silently
 * dropped.
 * @param merged - the merged index (see {@link mergeIndexContent}).
 * @param modelIndex - the model's rewrite, whose tail may be sacrificed.
 * @param additions - the exact appended pointer lines from `mergeIndexContent`.
 * @returns a document within the entrypoint caps that keeps every addition.
 */
export function carveEntrypointRoom(merged: string, modelIndex: string, additions: string[]): string {
  const withinCaps = (content: string): boolean => {
    const trimmed = content.trim()
    return trimmed.split('\n').length <= MAX_ENTRYPOINT_LINES
      && Buffer.byteLength(trimmed, 'utf8') <= MAX_ENTRYPOINT_BYTES
  }
  if (withinCaps(merged)) return merged

  const suffix = additions.length > 0 ? `\n${additions.join('\n')}\n` : ''
  const lineBudget = MAX_ENTRYPOINT_LINES - additions.length
  const byteBudget = MAX_ENTRYPOINT_BYTES - Buffer.byteLength(suffix, 'utf8')
  if (lineBudget < 0 || byteBudget < 0) {
    throw new Error(
      `memory index additions alone exceed the entrypoint cap (${additions.length} lines / `
      + `${Buffer.byteLength(suffix, 'utf8')} bytes; limits: ${MAX_ENTRYPOINT_LINES} lines / `
      + `${MAX_ENTRYPOINT_BYTES} bytes)`,
    )
  }

  const lines = modelIndex.split('\n')
  const body = (): string => lines.join('\n').trimEnd()
  while (lines.length > 0 && (lines.length > lineBudget || Buffer.byteLength(body(), 'utf8') > byteBudget)) {
    lines.pop()
  }
  const kept = body()
  if (additions.length === 0) return kept.length > 0 ? `${kept}\n` : ''
  return kept.length > 0 ? `${kept}\n${additions.join('\n')}\n` : `${additions.join('\n')}\n`
}
