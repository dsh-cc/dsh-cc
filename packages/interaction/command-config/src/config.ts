/**
 * Pure `/config` logic: parse a `[key] [value] [scope]` update into an args
 * tuple, render the effective config from settings descriptors, and enforce the
 * restricted write allowlist. No cordis imports.
 * @module @dsh-cc/command-config/config
 */

import type { SettingsDescriptor } from '@deepseek-ai/dsh-settings'

/** A parsed `/config` update request. */
export interface ConfigArgs {
  /** Destination settings namespace. */
  readonly scope: string
  /** Key within the namespace section. */
  readonly key: string
  /** Parsed value (string fallback when not JSON). */
  readonly value: unknown
}

/**
 * Parse a `/config` argument line in the order `[key] [value] [scope]`.
 * `scope` defaults to the supplied default namespace when omitted. Returns
 * `undefined` when the line is not a two- or three-token update.
 * @param rawInput - exact text following the command name.
 * @param defaultScope - namespace used when no scope token is supplied.
 * @returns the parsed update, or `undefined`.
 */
export function parseConfigArgs(rawInput: string, defaultScope: string): ConfigArgs | undefined {
  const tokens = rawInput.trim().split(/\s+/u).filter(token => token.length > 0)
  if (tokens.length < 2 || tokens.length > 3) return undefined
  const [key, raw, scope] = tokens as [string, string] & string[]
  return {
    scope: scope ?? defaultScope,
    key: key!,
    value: parseValue(raw!),
  }
}

/** Parse a value token as JSON when it looks structured, else as a string. */
export function parseValue(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null
  const number = Number(trimmed)
  if (trimmed.length > 0 && Number.isFinite(number)) return number
  if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed === '"') {
    try { return JSON.parse(trimmed) } catch { /* fall through to string */ }
  }
  return trimmed
}

/**
 * Render the effective configuration from the registered namespace descriptors.
 * @param descriptors - the `describe()` result.
 * @returns one `namespace = value (applies)` line per descriptor, or a
 *   placeholder when no namespaces are registered.
 */
export function renderConfig(descriptors: readonly SettingsDescriptor[]): string {
  if (descriptors.length === 0) return 'No configuration namespaces registered.'
  return descriptors.map(desc =>
    `${desc.ns} = ${JSON.stringify(desc.value)} (${desc.applies})`).join('\n')
}

/** One allowlist entry: a bare namespace (any key) or a `namespace.key` pair. */
export type AllowEntry = string

/**
 * Whether a `scope.key` write is permitted by the allowlist.
 * @param scope - destination namespace.
 * @param key - key within the namespace.
 * @param allowlist - `scope` or `scope.key` entries.
 * @returns whether the pair is allowed.
 */
export function keyAllowed(scope: string, key: string, allowlist: readonly AllowEntry[]): boolean {
  return allowlist.includes(scope) || allowlist.includes(`${scope}.${key}`)
}
