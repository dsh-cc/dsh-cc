/**
 * Plugin-side concurrency primitives (plan §4.6/§4.7): per-child gate
 * serialization and execution-token-keyed notice delivery.
 *
 * - {@link serializePerKey} runs tasks with the same key strictly in start
 *   order (a per-key promise chain): concurrent gate evaluations +
 *   persistence + delivery admission for one cold child cannot interleave.
 *   A failing task propagates its rejection to its own caller only — the
 *   chain continues for later tasks.
 * - {@link ExecutionNoticeBus} keys pending gate notices by the tool
 *   execution identity (`exec.token`, present on both the pre- and
 *   post-execute payloads), so a failing send can never leak its notice into
 *   a later call: only the very same execution may take them.
 *
 * @module @dsh-cc/subagent-resume-pins/serialize
 */

/** Run `task` after any pending same-key task settles; keyed FIFO order. */
export function serializePerKey<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const tail = (locks.get(key) ?? Promise.resolve()).then(task, task)
  locks.set(key, tail.catch(() => {}))
  return tail
}

/** Pending gate notices keyed by tool execution identity. */
export class ExecutionNoticeBus {
  private readonly pending = new Map<unknown, string[]>()

  /** Publish the notices a passing gate produced for ONE execution. */
  publish(token: unknown, notices: readonly string[]): void {
    if (notices.length > 0) this.pending.set(token, [...notices])
  }

  /** Take (and clear) the notices published for exactly this execution. */
  take(token: unknown): string[] {
    const notices = this.pending.get(token)
    this.pending.delete(token)
    return notices ?? []
  }
}
