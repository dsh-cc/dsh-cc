// Known-bad implementation mutant (design section 15): it omits the
// `reserved > budget` admission guard, so an already invalid prior state is
// accepted instead of rejected as `invalid-state`.
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
  if (amount > budget - reserved) return { error: { code: 'insufficient-budget' } }
  return { ok: (reserved + amount).toString() }
}
