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
 * @module @dsh-cc/settings-cascade/trusted-scope
 */

import { mergeSettingsSection } from './merge.ts'
import { isPlainObject } from './shared-guards.ts'

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
    ? merged['permissions'] as Record<string, unknown>
    : undefined
  if (permissions === undefined) return
  const trusted = trustedLayers
    .map(layer => (isPlainObject(layer['permissions']) ? layer['permissions']['autoMode'] : undefined))
    .filter((value): value is Record<string, unknown> => value !== undefined)
    .reduce<Record<string, unknown>>(
      (acc, layer) => mergeSettingsSection(acc, { autoMode: layer }),
      {},
    )
  if (trusted['autoMode'] === undefined) delete permissions['autoMode']
  else permissions['autoMode'] = trusted['autoMode']
}
