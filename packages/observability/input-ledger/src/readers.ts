/**
 * Typed readers over input-governance ledgers. Each reader yields only rows of
 * its own type and skips everything else: rows of the other types (the files
 * are shared by all producers), unparseable lines, and a torn final line left
 * by a crash mid-append (sidecar-io contract).
 *
 * @module @dsh-cc/input-ledger/readers
 */

import { readJsonl } from '@dsh-cc/sidecar-io'
import type {
  AssembleRow,
  CapRow,
  DedupeRow,
  GovernorRow,
  LedgerRow,
  LedgerRowType,
  RequestRow,
} from './rows.ts'
import { LEDGER_SCHEMA_VERSION } from './rows.ts'

/**
 * Stream the rows of one type from `filePath`.
 * @param filePath - ledger file; a missing file yields nothing.
 * @param type - the row type to keep.
 */
export async function* readLedgerRows<T extends LedgerRow>(
  filePath: string,
  type: LedgerRowType,
): AsyncGenerator<T, void, undefined> {
  const rows = await readJsonl<unknown>(filePath)
  for (const candidate of rows) {
    if (isRowOfType(candidate, type)) yield candidate as T
  }
}

/** Shape check: a JSON value that claims to be a schema-v1 row of `type`. */
function isRowOfType(candidate: unknown, type: LedgerRowType): boolean {
  if (typeof candidate !== 'object' || candidate === null) return false
  const row = candidate as { v?: unknown; type?: unknown }
  return row.v === LEDGER_SCHEMA_VERSION && row.type === type
}

/** Assembly observations (Observer A). */
export function readAssembleRows(filePath: string): AsyncIterable<AssembleRow> {
  return readLedgerRows<AssembleRow>(filePath, 'assemble')
}

/** Outgoing request observations (Observer B). */
export function readRequestRows(filePath: string): AsyncIterable<RequestRow> {
  return readLedgerRows<RequestRow>(filePath, 'request')
}

/** Budget-governor decision rows (doc 1). */
export function readGovernorRows(filePath: string): AsyncIterable<GovernorRow> {
  return readLedgerRows<GovernorRow>(filePath, 'governor')
}

/** Injection-dedupe decision rows (doc 7). */
export function readDedupeRows(filePath: string): AsyncIterable<DedupeRow> {
  return readLedgerRows<DedupeRow>(filePath, 'dedupe')
}

/** Per-class cap rows (doc 7). */
export function readCapRows(filePath: string): AsyncIterable<CapRow> {
  return readLedgerRows<CapRow>(filePath, 'cap')
}
