/**
 * Trusted-view helper for provenance-preserving consumer reads: reassembles
 * one top-level settings key from the TRUSTED layers only (user → flag →
 * policy), skipping the project and local (repo-carried) layers. Extracted
 * from {@link SettingsCascadeProvider} so the provider stays within the
 * file-size budget; the rule is {@link reassembleTrustedKey}.
 *
 * Consumers that must not honor repo-carried sections (the SystemOne decision
 * lane reading `llm-pi-ai` connection facts) duck-type the reader interface
 * (`settings?.trustedSection?.(key)`) and MUST fail closed (treat the section
 * as unresolvable) when the provider lacks the API — never fall back to the
 * provenance-lossy merged read.
 * @module @dsh-cc/settings-cascade/trusted-section
 */

import { reassembleTrustedKey } from './trusted-scope.ts'
import { isPlainObject } from './shared-guards.ts'

/** A provider exposing a trusted-only view of one top-level settings key. */
export interface TrustedSectionReader {
  /**
   * Trusted-only reassembly of one top-level settings `key` under the
   * {@link reassembleTrustedKey} rule — `undefined` when no trusted layer
   * carries the key.
   */
  trustedSection(key: string): Record<string, unknown> | undefined
}

/**
 * Reassemble one top-level key from the trusted layers (in merge order) into a
 * detached plain-object value. Total: junk shapes, a missing key, or a
 * non-object reassembly result all yield `undefined`; never throws, never
 * mutates any input.
 * @param trustedLayers - trusted layers in merge order (user, flag, policy).
 * @param key - the top-level settings key to reassemble.
 */
export function reassembleTrustedView(
  trustedLayers: readonly Record<string, unknown>[],
  key: string,
): Record<string, unknown> | undefined {
  try {
    const scratch: Record<string, unknown> = {}
    reassembleTrustedKey(scratch, trustedLayers, key)
    const value = Object.hasOwn(scratch, key) ? scratch[key] : undefined
    return isPlainObject(value) ? structuredClone(value) : undefined
  } catch {
    return undefined
  }
}
