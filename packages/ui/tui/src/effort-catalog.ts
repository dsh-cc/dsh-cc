/**
 * Pure reasoning-effort choice parsing and picker formatting for `/effort`.
 * Mirrors model-catalog.ts; levels always come from the resolved model's
 * advertised efforts — never a hard-coded universal list.
 * @module @dsh-cc/tui/effort-catalog
 */

/** Trailing picker/status entry that resets effort to the provider default. */
const DEFAULT_ENTRY = 'default (provider)'

export type EffortChoice = { kind: 'default' } | { kind: 'level'; level: string }

/**
 * Resolve an `/effort` argument. `default` is a reserved keyword — it wins
 * even when a model advertises an effort literally named `default`. Anything
 * else must exactly match one of the model's efforts.
 * @param input - the raw argument (trimmed here).
 * @param efforts - the resolved model's advertised effort levels.
 */
export function parseEffortChoice(input: string, efforts: readonly string[]): EffortChoice | undefined {
  const token = input.trim()
  if (token.length === 0) return undefined
  if (token === 'default') return { kind: 'default' }
  if (efforts.includes(token)) return { kind: 'level', level: token }
  return undefined
}

/**
 * Render the effort picker rows: the model's levels plus a trailing
 * `default (provider)` entry, starring the live effort. No effort set means
 * the provider default is live, so the default entry carries the star.
 */
export function formatEffortList(efforts: readonly string[], current: string | undefined): string {
  return [...efforts, DEFAULT_ENTRY]
    .map(row => `${(row === current || (current === undefined && row === DEFAULT_ENTRY)) ? '*' : ' '} ${row}`)
    .join('\n')
}
