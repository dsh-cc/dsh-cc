/**
 * Cordis/settings glue for the pure Ctrl+P model-cycling section (plan C6).
 * Kept under src/harness/ because check:tui-boundary confines @deepseek-ai
 * imports to this subtree; src/model-cycling.ts stays harness-free.
 * @module @dsh-cc/tui/harness/model-cycling-binding
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { registerNamespaceSafe, type SettingsReader } from '@dsh-cc/settings-ns'
import { resolveAlias } from '@dsh-cc/model-aliases'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  createModelCyclingSection,
  type ModelCyclingDeps,
} from '../model-cycling.ts'

/** The `cc-model-cycling` settings shape. */
export interface ModelCyclingSettings {
  /** Aliases to cycle through, in order. Empty → cycling is inert. */
  readonly cycleOrder: readonly string[]
}

/** Schema for the `cc-model-cycling` settings namespace. */
export const ModelCyclingSettingsSchema = z.object({
  cycleOrder: z.array(z.string()).default([]),
})

const SETTINGS_NAMESPACE = 'cc-model-cycling' as SettingsNamespace

/**
 * Bind the pure cycling section to cordis: the `cc-model-cycling` namespace
 * (idempotent, and registered lazily on first read — the namespace is only
 * needed when cycling is actually used, keeping driver boot inert for
 * settings-less contexts) plus the cc-model-aliases resolver, both read live
 * per keypress so settings hot reload applies without re-boot.
 */
export function bindModelCycling(
  ctx: Context,
  deps: Omit<ModelCyclingDeps, 'readCycleOrder' | 'resolveAlias'>,
): ReturnType<typeof createModelCyclingSection> {
  let read: SettingsReader<ModelCyclingSettings> | undefined
  const readCycleOrder = (): readonly string[] =>
    (read ??= registerNamespaceSafe<ModelCyclingSettings>(
      ctx,
      SETTINGS_NAMESPACE,
      // The schema's structural type uses mutable arrays; the public surface
      // is the readonly ModelCyclingSettings view. Cast through unknown once.
      ModelCyclingSettingsSchema as unknown as z<ModelCyclingSettings>,
    ))()?.cycleOrder ?? []
  return createModelCyclingSection({
    ...deps,
    readCycleOrder,
    resolveAlias: (alias) => resolveAlias(ctx, alias),
  })
}
