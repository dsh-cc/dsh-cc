/**
 * The ledger emission wiring — plan doc
 * `docs/plans/2026-11-12-per-step-input-budget-governor.md` §"GovernorRow":
 * `@dsh-cc/input-ledger` owns the row schema and the append sink, this package
 * owns the row fields, and this module is the one place the two meet.
 *
 * The dependency is SOFT by design ("when the ledger package is absent/disabled,
 * the governor still runs; rows are simply not persisted"):
 *
 * - no dsh-home on the host (a bare test host) — nothing to write to;
 * - no cwd on the session header — no project bucket, so no file path exists
 *   (the ledger's own observers skip the same rows by convention);
 * - `cc-input-ledger.enabled: false` — the ledger's own kill switch, hot-read
 *   per row exactly like the ledger's observers read it.
 *
 * Every one of those is a silent skip; every actual failure (a thrown path
 * build, a failed append reported through `onError`) counts into
 * {@linkcode getGovernorLedgerHealth}'s `droppedRows` and is debug-logged.
 * Nothing here is ever thrown into the `agent/pre-step` waterfall and nothing
 * here is awaited on the hot path: the append is detached and serialized by the
 * ledger's own per-file write chain.
 *
 * @module @dsh-cc/input-budget/ledger
 */

import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import {
  DEFAULT_INPUT_LEDGER_SETTINGS,
  appendLedgerRow,
  readUserSettingsSync,
  sessionLedgerPath,
  type GovernorRow,
  type InputLedgerSettings,
} from '@dsh-cc/input-ledger'

/** Width of a project key: the `projectKeyOf` convention's 16 hex chars. */
const PROJECT_KEY_CHARS = 16

/** Rows lost to a failed append since process start (fresh object per call). */
let droppedRows = 0

/**
 * In-process emission health: governor rows that never reached the ledger.
 * A fresh object each call, so callers cannot mutate the counter. Mirrors the
 * ledger's own `getLedgerHealth()`; the sink counts here even when the ledger's
 * counter also saw the failure, because this is the governor's view.
 */
export function getGovernorLedgerHealth(): { droppedRows: number } {
  return { droppedRows }
}

/** The object face of an untyped value, or `undefined`. */
function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/** Canonicalize a cwd: `realpathSync` when it resolves, the raw spelling otherwise. */
function canonicalize(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Project bucket of one cwd: the first 16 hex chars of `sha256(realpath(cwd))`
 * — the `cwdProjectKey` convention (handoff-store `cwdProjectKey`, sidecar-io
 * `projectKeyOf`). A local replica, byte-identical to the one in
 * `@dsh-cc/input-ledger` `src/observe.ts` (`projectKeyOfAgent`): that package
 * keeps it private, and importing `@dsh-cc/sidecar-io` here would add a
 * runtime dependency this soft wiring must not have.
 */
export function projectKeyForCwd(cwd: string): string {
  return createHash('sha256').update(canonicalize(cwd), 'utf8').digest('hex').slice(0, PROJECT_KEY_CHARS)
}

/** Header-derived cwd of an agent face, or `undefined` when the header carries none. */
function cwdOf(agent: unknown): string | undefined {
  const header = objectOf(objectOf(objectOf(agent)?.session)?.header)
  const cwd = header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/**
 * The project bucket of one `agent/pre-step` payload's agent, or `undefined`
 * when the session header carries no cwd (the row is then skipped, as the
 * ledger's observers skip theirs).
 *
 * @param agent - the payload's agent, of unknown shape.
 */
export function cwdProjectKeyOf(agent: unknown): string | undefined {
  const cwd = cwdOf(agent)
  return cwd === undefined ? undefined : projectKeyForCwd(cwd)
}

/** Collaborators of the emission sink; the listener wires them to the runtime. */
export interface GovernorLedgerDeps {
  /** dsh-home root; `undefined` means no persistence (a bare host). */
  home: string | undefined
  /**
   * Hot read of the LEDGER's settings (its `enabled` kill switch and row cap).
   * Defaults to the raw user-layer file, re-read per row like the ledger's own
   * observers, so a hot toggle applies on the next step without a restart.
   */
  readSettings?(): InputLedgerSettings
  /** Debug sink for swallowed failures (must not throw). */
  debug(message: string): void
}

/** One row sink: the listener's `emit` seam, project bucket included. */
export type GovernorRowSink = (row: GovernorRow, projectKey?: string | undefined) => void

/** Best-effort one-line description of a caught failure. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Build the sink that persists governor rows through the input ledger.
 *
 * @param deps - dsh-home root, the ledger settings read and the debug sink.
 * @returns a synchronous, never-throwing row sink.
 */
export function createGovernorLedgerSink(deps: GovernorLedgerDeps): GovernorRowSink {
  const warn = (message: string): void => {
    try {
      deps.debug(message)
    } catch {
      // The debug sink is best-effort; a failure there must not escape either.
    }
  }
  const readSettings = deps.readSettings
    ?? ((): InputLedgerSettings => (
      deps.home === undefined ? DEFAULT_INPUT_LEDGER_SETTINGS : readUserSettingsSync(deps.home)
    ))
  return (row, projectKey) => {
    const home = deps.home
    // Silent skips (never counted as drops): nothing to write to, or no bucket.
    if (home === undefined || projectKey === undefined) return
    const settings = ledgerSettingsOf(readSettings, warn)
    if (!settings.enabled) return
    try {
      const file = sessionLedgerPath(home, projectKey, row.sessionId)
      void appendLedgerRow(
        file,
        row,
        (error) => {
          droppedRows += 1
          warn(`input-budget: governor row dropped: ${describe(error)}`)
        },
        settings['max-rows-per-file'],
      ).catch(() => {
        // `appendLedgerRow` resolves on every path by contract: belt-and-braces.
        droppedRows += 1
      })
    } catch (error) {
      droppedRows += 1
      warn(`input-budget: governor row dropped: ${describe(error)}`)
    }
  }
}

/**
 * One hot settings read, fail-soft: a throwing reader must never suppress rows,
 * so it degrades to the ship defaults (the ledger's own reader never throws).
 */
function ledgerSettingsOf(
  readSettings: () => InputLedgerSettings,
  warn: (message: string) => void,
): InputLedgerSettings {
  try {
    return readSettings()
  } catch (error) {
    warn(`input-budget: ledger settings read failed: ${describe(error)}`)
    return DEFAULT_INPUT_LEDGER_SETTINGS
  }
}
