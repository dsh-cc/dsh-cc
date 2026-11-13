/**
 * The row-construction seam — plan doc
 * `docs/plans/2026-11-12-per-step-input-budget-governor.md` §"GovernorRow":
 * `@dsh-cc/input-ledger` owns the row schema (single schema source, doc 3);
 * this package supplies only the fields it owns — `mode`, `bytesByClass`,
 * `trimmed`, `offeredBacklog`, `hardOver` — plus the `{ error: true }` marker
 * of the failure path.
 *
 * The seam exists so the ledger emission is a pure wiring step: this module
 * builds a complete `GovernorRow` and hands it to the listener's `emit` sink.
 * Until that sink is wired (the ledger slice), rows are simply dropped; the
 * governor still runs, so a missing ledger can never change admission.
 *
 * @module @dsh-cc/input-budget/row
 */

import { LEDGER_SCHEMA_VERSION, type GovernorRow } from '@dsh-cc/input-ledger'
import { INPUT_CLASSES } from './classes.ts'
import type { GovernorDecision } from './core.ts'
import type { InputBudgetMode } from './settings.ts'

/**
 * Every class key at zero bytes, in the design table's order. Used by the
 * failure path, where no batch was measured: the row keeps the full key set so
 * a reader never has to distinguish "class absent" from "class empty".
 */
export function emptyBytesByClass(): Record<string, number> {
  const bytesByClass: Record<string, number> = {}
  for (const cls of INPUT_CLASSES) bytesByClass[cls] = 0
  return bytesByClass
}

/** The inputs one `GovernorRow` is built from. */
export interface GovernorRowInput {
  /** Durable session id the invocation belongs to. */
  sessionId: string
  /** Process boot id stamped into every row (the ledger's `gen`). */
  gen: string
  /** Turn-local attribution from the pre-step payload, when present. */
  turn?: number | undefined
  /** Turn-local attribution from the pre-step payload, when present. */
  step?: number | undefined
  /** The governor's decision for this invocation; absent on the failure path. */
  decision?: GovernorDecision | undefined
  /** Mode to record when `decision` is absent (the failure path). */
  mode?: InputBudgetMode | undefined
  /** The governor threw and returned the batch unmodified. */
  error?: true | undefined
}

/**
 * Build one `GovernorRow`.
 *
 * @param input - the invocation's attribution plus either its decision or the
 *   failure marker.
 * @returns the row, ready for the ledger sink.
 */
export function buildGovernorRow(input: GovernorRowInput): GovernorRow {
  const decision = input.decision
  return {
    v: LEDGER_SCHEMA_VERSION,
    ts: Date.now(),
    sessionId: input.sessionId,
    gen: input.gen,
    ...(input.turn === undefined ? {} : { turn: input.turn }),
    ...(input.step === undefined ? {} : { step: input.step }),
    type: 'governor',
    mode: decision?.mode ?? input.mode ?? 'observe',
    bytesByClass: decision?.bytesByClass ?? emptyBytesByClass(),
    trimmed: decision?.trimmed ?? [],
    offeredBacklog: decision?.offeredBacklog ?? 0,
    hardOver: decision?.hardOver ?? false,
    ...(input.error === true ? { error: true as const } : {}),
  }
}
