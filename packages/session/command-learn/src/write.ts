/**
 * `/learn apply` write path: composes the topic file + MEMORY.md pointer
 * through the REAL `@dsh-cc/memory` helpers (renderTopicFile, upsertPointer,
 * validateMemoryWrites, commitMemoryWrites) — the same composition the
 * `memory_save` tool uses; no reimplementation here.
 * @module @dsh-cc/command-learn/write
 */

import { join } from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import {
  resolveWorkspaceMemoryDir,
  renderTopicFile,
  upsertPointer,
  validateMemoryWrites,
  commitMemoryWrites,
} from '@dsh-cc/memory'
import type { ForensicsResult } from '@dsh-cc/session-forensics'
import { LEARNING_DESCRIPTION, TOPIC_NAME, TOPIC_TYPE, isoDate, renderBlock } from './render.ts'

/** Result of one `apply` (or deliberate no-op). */
export interface ApplyOutcome {
  /** False when findings were empty and nothing was written. */
  wrote: boolean
  /** Number of findings applied (0 when not written). */
  findings: number
  /** Absolute topic-file path, set only when written. */
  file?: string
}

/**
 * Write the learnings topic file and MEMORY.md pointer into the workspace
 * memory directory.
 *
 * `/learn` owns the WHOLE topic file (`session-learnings.md`), so apply is a
 * wholesale regenerate of that file — no managed-block surgery on partial
 * content. The MEMORY.md pointer is upserted (appended when absent) through
 * the shared writeback path, which confines writes to the memory directory.
 *
 * Empty findings are a hard no-op: never auto-delete memory on a weak run
 * (critic MUST-FIX).
 */
export async function applyLearnings(
  fs: FileSystem,
  home: string,
  cwd: string,
  result: ForensicsResult,
): Promise<ApplyOutcome> {
  if (result.findings.length === 0) return { wrote: false, findings: 0 }
  const dir = resolveWorkspaceMemoryDir(home, cwd)
  const args = {
    name: TOPIC_NAME,
    type: TOPIC_TYPE,
    description: LEARNING_DESCRIPTION,
    body: renderBlock(result, isoDate()),
  }
  // Upsert the pointer onto the index read fresh by the commit loop and write
  // both files in one batch: the same build shape as `memory_save`, so a
  // concurrent index writer is rebased onto instead of silently erased. The
  // upsert is re-appliable, so no baseline/merge is needed. A rejection
  // (validation) throws out of the loop; an exhausted rebase surfaces as
  // `MemoryIndexConflictError` to the command layer.
  await commitMemoryWrites(fs, dir, async (fresh) => ({
    writes: validateMemoryWrites({
      writes: [
        { path: `${TOPIC_NAME}.md`, content: renderTopicFile(args) },
        { path: 'MEMORY.md', content: upsertPointer(fresh, args) },
      ],
    }),
    meta: undefined,
  }))
  return { wrote: true, findings: result.findings.length, file: join(dir, `${TOPIC_NAME}.md`) }
}
