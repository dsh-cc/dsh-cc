/**
 * D12 trusted scope (auto-mode CC-parity program): the `permissions.autoMode`
 * key is assembled from TRUSTED layers ONLY — user settings, the --settings
 * flag file (plus inline flag settings), and managed/policy — skipping the
 * project and local (repo-carried) layers, so a cloned repo can never teach
 * the classifier its own trust boundary. The trusted subset replicates the
 * normal in-subset merge order (user → flag → policy) with ordinary merge
 * semantics; every other `permissions` key keeps the full merge. The merged
 * document is provenance-lossy, so this must run at assembly time here —
 * a post-merge filter cannot distinguish sources.
 *
 * The same trusted-only rule generalizes to whole top-level namespaces
 * (`systemone-decisions` and later keys): see {@link reassembleTrustedKey}.
 * @module @dsh-cc/settings-cascade/trusted-scope
 */

import { mergeValue } from './merge.ts'
import { isPlainObject } from './shared-guards.ts'

/**
 * Whole top-level settings namespaces assembled from TRUSTED layers only —
 * user settings, the explicit --settings file (plus inline flag settings), and
 * managed/policy — ignoring the project and local (repo-carried) layers.
 * Opting a namespace in is a one-line addition here and nothing else: this
 * package carries the raw section, so the consumer package keeps ownership of
 * its schema, defaults and validation (`ctx.settings.register(ns, schema)`).
 * @see reassembleTrustedKey for the reassembly rule.
 */
export const TRUSTED_SOURCE_KEYS = ['systemone-decisions'] as const

/**
 * Recompute one top-level settings `key` from the trusted layers, mutating
 * `merged` in place. Trusted values deep-merge in merge order (a plain-object
 * namespace keeps lower-layer keys the higher layer does not override; any
 * other value is taken from the highest trusted layer that carries it). When
 * no trusted layer carries the key, it is deleted — project/local
 * contributions vanish and nothing is materialized.
 * @param merged - the object to reassemble in place (the whole document, or a
 * nested section such as `permissions`).
 * @param trustedLayers - layers holding the key, in merge order (user, flag, policy).
 * @param key - the top-level settings key to reassemble.
 */
export function reassembleTrustedKey(
  merged: Record<string, unknown>,
  trustedLayers: readonly Record<string, unknown>[],
  key: string,
): void {
  const trusted = trustedLayers
    .map(layer => layer[key])
    .filter(value => value !== undefined)
    .reduce<unknown>((acc, value) => mergeValue(acc, value), undefined)
  if (trusted === undefined) delete merged[key]
  else merged[key] = trusted
}

/**
 * Recompute the `autoMode` key of the merged `permissions` section from the
 * trusted layers, mutating `merged` in place. When no trusted layer carries
 * autoMode, the key is deleted (project/local contributions vanish).
 * @param merged - the fully merged settings document (pre-alias-application).
 * @param trustedLayers - trusted layers in merge order (user, flag, policy).
 */
export function reassembleTrustedAutoMode(
  merged: Record<string, unknown>,
  trustedLayers: readonly Record<string, unknown>[],
): void {
  const permissions = isPlainObject(merged['permissions'])
    ? merged['permissions']
    : undefined
  if (permissions === undefined) return
  reassembleTrustedKey(
    permissions,
    trustedLayers.map(layer => (isPlainObject(layer['permissions']) ? layer['permissions'] : {})),
    'autoMode',
  )
}
