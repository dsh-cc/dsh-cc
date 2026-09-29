/**
 * Namespace parsing and its compile-time literal guards.
 *
 * Vendored verbatim from harness `@deepseek-ai/dsh-settings` at pin
 * `1ef9c1fa9a` (0.1.5-rc.1), `packages/settings/settings/src/index.ts`
 * (module header region).
 *
 * @module @dsh-cc/settings-provider/namespace
 */

import type { SettingsNamespace } from './types.ts'

const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/
type LowercaseLetter = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l' | 'm'
  | 'n' | 'o' | 'p' | 'q' | 'r' | 's' | 't' | 'u' | 'v' | 'w' | 'x' | 'y' | 'z'
type DecimalDigit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'
type NamespaceCharacter = LowercaseLetter | DecimalDigit | '-'
type ValidNamespaceTail<Value extends string> = Value extends ''
  ? true
  : Value extends `${NamespaceCharacter}${infer Rest}`
    ? ValidNamespaceTail<Rest>
    : false
export type SettingsNamespaceInput<Value extends string> = Value extends SettingsNamespace
  ? Value
  : string extends Value
    ? string
    : Value extends `${LowercaseLetter}${infer Rest}`
      ? ValidNamespaceTail<Rest> extends true ? Value : never
      : never

/**
 * Parse and brand a settings namespace id.
 * @param value - the raw namespace id.
 * @returns the branded namespace.
 * @throws {TypeError} when the id is not a lowercase hyphenated identifier.
 */
export function parseSettingsNamespace(value: string): SettingsNamespace {
  if (!NAMESPACE_PATTERN.test(value)) {
    throw new TypeError(`settings namespace "${value}" must match ${String(NAMESPACE_PATTERN)}`)
  }
  return value as SettingsNamespace
}
