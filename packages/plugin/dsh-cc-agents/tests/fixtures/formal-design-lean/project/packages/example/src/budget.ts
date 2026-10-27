// Fixture implementation bound by the budget-reservation conformance adapter.
// Erasable TypeScript only, so Node imports it directly (design section 7).
// Numeric JSON values are canonical decimal strings converted to BigInt under
// the reviewed grammar `^(0|[1-9][0-9]*)$` (design section 15).
const DECIMAL = /^(0|[1-9][0-9]*)$/

export type Reservation = { ok: string } | { error: { code: string } }

function decode(value: unknown): bigint | null {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return null
  return BigInt(value)
}

export function reserve(request: unknown): Reservation {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) return { error: { code: 'invalid-amount' } }
  const fields = request as { budget?: unknown; reserved?: unknown; amount?: unknown }
  if (Object.keys(fields).length !== 3) return { error: { code: 'invalid-amount' } }
  const budget = decode(fields.budget)
  const reserved = decode(fields.reserved)
  const amount = decode(fields.amount)
  if (budget === null || reserved === null || amount === null) return { error: { code: 'invalid-amount' } }
  if (reserved > budget) return { error: { code: 'invalid-state' } }
  if (amount > budget - reserved) return { error: { code: 'insufficient-budget' } }
  return { ok: (reserved + amount).toString() }
}
