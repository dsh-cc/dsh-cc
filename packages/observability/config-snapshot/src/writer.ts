/**
 * Sidecar JSONL writer (§3.3): one file per session id, per-file serialized
 * write queue (distinct sessions fan out to distinct files; contention exists
 * only for sequential same-id constructions), lazy per-file `seq` init from
 * the file's total line count + 1 (counting EVERY line, unparseable included),
 * and repair-on-append for a torn tail. Fire-and-forget by contract: callers
 * do `void writer.append(...).catch(debug)`.
 *
 * @see docs/plans/2026-10-09-session-config-snapshot-event.md §3.3
 * @module @dsh-cc/config-snapshot/writer
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export class SidecarWriter {
  /** Per-file last-queued task — serializes writes into one file. */
  private readonly queues = new Map<string, Promise<void>>()
  /** Lazily initialized next-`seq` counters per file (the queue owns file state, §3.4). */
  private readonly nextSeq = new Map<string, number>()
  private readonly pending = new Set<Promise<void>>()

  /**
   * Enqueue one row; resolves once the row is appended (or the write failed
   * — never rejects, so callers can `.catch(debug)` for the debug log only).
   */
  append(file: string, build: (seq: number) => unknown): Promise<void> {
    const prev = this.queues.get(file) ?? Promise.resolve()
    const task = prev
      .then(() => this.writeOne(file, build))
      .catch(() => {
        // Internal catch-all (§3.7): the caller's `.catch` decides logging.
      })
    this.queues.set(file, task)
    this.pending.add(task)
    void task.finally(() => {
      this.pending.delete(task)
    })
    return task
  }

  /** Resolves when every queued write, across all files, has settled (test seam). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending, ...this.queues.values()])
  }

  private async writeOne(file: string, build: (seq: number) => unknown): Promise<void> {
    let seq = this.nextSeq.get(file)
    let tornTail = false
    if (seq === undefined) {
      try {
        const content = await readFile(file, 'utf8')
        const lines = content.split('\n')
        if (lines[lines.length - 1] === '') lines.pop()
        seq = lines.length + 1
        // Repair-on-append (§3.3): a torn tail gets a prepended newline, so a
        // crash fragment can never swallow the NEXT row.
        tornTail = content.length > 0 && !content.endsWith('\n')
      } catch {
        seq = 1 // ENOENT (or unreadable) ⇒ zero existing lines
      }
      this.nextSeq.set(file, seq)
    }
    const line = JSON.stringify(build(seq)) + '\n'
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, (tornTail ? '\n' : '') + line, 'utf8')
    this.nextSeq.set(file, seq + 1)
  }
}
