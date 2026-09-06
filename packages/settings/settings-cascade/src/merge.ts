/**
 * Deep-merge semantics for the settings cascade. Plain objects merge
 * recursively; permission objects (`allow`/`deny`/`ask`) union their rule
 * arrays with `deny` taking precedence over `allow`; every other array and
 * scalar value from a higher layer replaces the lower layer wholesale.
 * @module @dsh-cc/settings-cascade/merge
 */

/** The permission rule arrays that merge by union across layers. */
const PERMISSION_KEYS = ['allow', 'deny', 'ask'] as const

/** Whether a value is a plain data object (not an array, null, or instance). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Whether an object holds at least one permission rule array. */
function isPermissionObject(value: Record<string, unknown>): boolean {
  return PERMISSION_KEYS.some(key => key in value)
}

/** Concatenate string arrays and deduplicate, preserving first-seen order. */
function unionStrings(...lists: Array<Array<string> | undefined>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    if (list === undefined) continue
    for (const entry of list) {
      if (!seen.has(entry)) {
        seen.add(entry)
        out.push(entry)
      }
    }
  }
  return out
}

/**
 * Merge one permission object over a lower one. `allow`, `deny`, and `ask`
 * union across layers, and the unioned `deny` set is removed from `allow` so a
 * higher-layer deny always wins over a lower-layer allow. Other keys deep-merge
 * with ordinary rules (arrays override).
 * @param lower - the lower-priority permission object.
 * @param higher - the higher-priority permission object.
 * @returns the merged permission object.
 */
export function mergePermissionObject(
  lower: Record<string, unknown>,
  higher: Record<string, unknown>,
): Record<string, unknown> {
  const lowerAllow = lower['allow'] as Array<string> | undefined
  const lowerDeny = lower['deny'] as Array<string> | undefined
  const lowerAsk = lower['ask'] as Array<string> | undefined
  const higherAllow = higher['allow'] as Array<string> | undefined
  const higherDeny = higher['deny'] as Array<string> | undefined
  const higherAsk = higher['ask'] as Array<string> | undefined

  const deny = unionStrings(lowerDeny, higherDeny)
  const denied = new Set(deny)
  const allow = unionStrings(lowerAllow, higherAllow).filter(rule => !denied.has(rule))
  const ask = unionStrings(lowerAsk, higherAsk)

  // Start from both layers' non-permission keys; the derived allow/deny/ask
  // replace the lower layer's originals below, and empty permission arrays are
  // omitted — an empty `allow` after deny filtering means "nothing allowed",
  // and JSON settings conventionally drop empty lists.
  const merged: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(lower)) {
    if (PERMISSION_KEYS.includes(key as (typeof PERMISSION_KEYS)[number])) continue
    merged[key] = value
  }
  for (const [key, value] of Object.entries(higher)) {
    if (PERMISSION_KEYS.includes(key as (typeof PERMISSION_KEYS)[number])) continue
    merged[key] = key in merged ? mergeValue(merged[key], value) : value
  }
  return {
    ...merged,
    ...(allow.length > 0 ? { allow } : {}),
    ...(deny.length > 0 ? { deny } : {}),
    ...(ask.length > 0 ? { ask } : {}),
  }
}

/**
 * Compute the unioned deny set and the allow set that excludes it — the
 * `deny`-precedence rule applied to one lower and one higher permission object.
 * @param lower - the lower-priority permission object.
 * @param higher - the higher-priority permission object.
 * @returns the unioned `deny` and deduped `allow` with denied rules removed.
 */
export function unionDenyPrecedence(
  lower: { allow?: string[]; deny?: string[] },
  higher: { allow?: string[]; deny?: string[] },
): { allow: string[]; deny: string[] } {
  const deny = unionStrings(lower.deny, higher.deny)
  const denied = new Set(deny)
  const allow = unionStrings(lower.allow, higher.allow).filter(rule => !denied.has(rule))
  return { allow, deny }
}

/**
 * Merge one JSON-compatible value over a lower one. When both are plain
 * objects the merge recurses — through the permission rule for permission
 * objects and per-key otherwise; any other pair lets the higher value replace
 * the lower wholesale. Neither input is mutated.
 * @param lower - the lower-priority value.
 * @param higher - the higher-priority value; `undefined` keeps the lower value.
 * @returns the merged value.
 */
export function mergeValue<T = unknown>(lower: T, higher: unknown): T {
  if (higher === undefined) return lower
  if (isPlainObject(lower) && isPlainObject(higher)) {
    if (isPermissionObject(lower) || isPermissionObject(higher)) {
      return mergePermissionObject(lower, higher) as T
    }
    const merged: Record<string, unknown> = { ...(lower as Record<string, unknown>) }
    for (const [key, value] of Object.entries(higher)) {
      merged[key] = key in merged ? mergeValue(merged[key], value) : value
    }
    return merged as T
  }
  return higher as T
}

/**
 * Merge one whole namespace section over a lower section (recursive deep
 * merge with the permission array rules and higher-array-override semantics).
 * @param lower - the lower-priority raw section.
 * @param higher - the higher-priority raw section.
 * @returns the merged raw section.
 */
export function mergeSettingsSection(
  lower: Record<string, unknown>,
  higher: Record<string, unknown>,
): Record<string, unknown> {
  return mergeValue(lower, higher) as Record<string, unknown>
}
