/**
 * Process-wide holder for the harness `workingDirectory` service, kept in a leaf
 * module so the sync cwd APIs can write through without importing the bridge
 * (which imports the APIs).
 *
 * dsh-cc keeps a synchronous cwd overlay because several consumers (project
 * keys, ledger rows, the WS2 boundary guard) read cwd synchronously, while the
 * harness service is async. This holder lets `setSessionCwd` push the change
 * into the real service as a best-effort side effect, so execution (bash, fs,
 * skills, LSP, run_code) follows the same directory the overlay advertises.
 *
 * @module @dsh-cc/session-cwd/service-holder
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'

/** Structural face of the upstream `workingDirectory` service. */
export interface WorkingDirectoryLike {
  /** Recorded directory for a session, or null/undefined when none is recorded. */
  get(session: Session): string | null | undefined
  /** Commit a new directory for a live agent; rejects when the path is not a directory. */
  set(agent: Agent, path: string, signal?: AbortSignal): Promise<string>
}

let installed: WorkingDirectoryLike | undefined
let warn: ((message: string) => void) | undefined

/**
 * Publish the resolved service (called by the bridge once it is available).
 * @param service - the upstream service instance.
 * @param onError - sink for best-effort write failures.
 */
export function setWorkingDirectoryService(
  service: WorkingDirectoryLike | undefined,
  onError?: (message: string) => void,
): void {
  installed = service
  warn = onError
}

/** The published service, when the harness composition mounted one. */
export function workingDirectoryService(): WorkingDirectoryLike | undefined {
  return installed
}

/**
 * Best-effort write-through of one cwd change into the harness service.
 * Failures are logged (never thrown): the durable overlay event already
 * records the change, and the next `ensure` revalidates.
 * @param agent - the live agent whose directory changed.
 * @param path - the new absolute directory.
 */
export function writeThroughWorkingDirectory(agent: Agent, path: string): void {
  const service = installed
  if (service === undefined) return
  void service.set(agent, path).catch((error: unknown) => {
    warn?.(`session-cwd: workingDirectory.set failed for ${path}: ${String(error)}`)
  })
}
