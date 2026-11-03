// Conformance fixture for the S1-02 quota arithmetic.
//
// This is a model-local reference implementation, NOT production code: the
// `packages/observability/decision-usage` module does not exist yet. When the
// feature lands, the adapter must be re-pointed at its `quota.ts` projection
// and this fixture removed.
//
// Semantics mirror Model.lean exactly: an attempt keeps its full reservation
// while unsettled or unknown, is refunded only by a durable not-dispatched
// entry, and settles at actual usage otherwise (a valid settlement never
// exceeds its reservation; an overrun is the surrounding protocol's freeze).

export type Term =
  | { readonly kind: 'unsettled' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'not-dispatched' }
  | { readonly kind: 'actual'; readonly usage: number }

export interface Row {
  readonly reserved: number
  readonly term: Term
}

function retained(row: Row): number {
  switch (row.term.kind) {
    case 'unsettled':
    case 'unknown':
      return row.reserved
    case 'not-dispatched':
      return 0
    case 'actual':
      return Math.min(row.term.usage, row.reserved)
  }
}

export function retainedTotal(ledger: readonly Row[]): number {
  return ledger.reduce((sum, row) => sum + retained(row), 0)
}

export function reservedTotal(ledger: readonly Row[]): number {
  return ledger.reduce((sum, row) => sum + row.reserved, 0)
}
