/**
 * CC-key aliasing for the settings cascade: recognized Claude Code camelCase
 * top-level keys are aliased onto dsh-native kebab-case namespaces so a
 * `settings.json` shared verbatim with a real CC checkout resolves through
 * `settingsNamespace`. The whitelist map is the contract — no fuzzy matching.
 * @module @dsh-cc/settings-cascade/cc-key-aliases
 */

/**
 * Explicit whitelist of CC camelCase top-level keys → dsh-native kebab-case
 * namespaces. Unknown camelCase keys are never auto-aliased.
 */
export const CC_KEY_ALIASES: Readonly<Record<string, string>> = {
  statusLine: 'statusline',
}

/** Whether a value is a plain data object (not an array, null, or instance). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Inject aliases for recognized CC keys into a merged settings document.
 * Mutates and returns the document: a whitelisted CC key whose value is a
 * plain object is copied onto its kebab namespace ONLY when that namespace
 * key is absent — a dsh-native key already present wins untouched.
 * @param document - merged settings document (aliased in place).
 * @returns the same document, with aliases injected.
 */
export function applyCcKeyAliases(document: Record<string, unknown>): Record<string, unknown> {
  for (const [ccKey, namespace] of Object.entries(CC_KEY_ALIASES)) {
    if (!(ccKey in document)) continue
    if (namespace in document) continue
    const value = document[ccKey]
    if (!isPlainObject(value)) continue
    document[namespace] = structuredClone(value)
  }
  return document
}
