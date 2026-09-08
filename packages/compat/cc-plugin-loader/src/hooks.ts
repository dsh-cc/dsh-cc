/**
 * Mount a Claude Code plugin's hooks.
 *
 * Reads the plugin's `hooks/hooks.json` (or an inline manifest `hooks`
 * declaration), validates the structure, and injects the hooks into the
 * hooks-claude-code bridge through the optional `hooks` guest seam. When the
 * seam is absent the component is reported skipped, never failed, so a
 * deployment without the bridge keeps loading the rest of the plugin.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { CcPluginManifest } from './types.ts'
import { ComponentTally } from './seams.ts'

/** The hooks seam: accepts a plugin's translated per-event hooks. */
export interface HooksSeam {
  /**
   * Merge a plugin's hooks into the bridge.
   * @param pluginName - the plugin that owns the hooks.
   * @param config - the per-event hook map (`ClaudeCodeHookConfig` shape).
   * @param pluginRoot - the plugin's root dir, used to substitute
   *   `${CLAUDE_PLUGIN_ROOT}` in command strings.
   * @returns the exact disposer that removes the injected hooks.
   */
  mergePluginHooks(pluginName: string, config: unknown, pluginRoot?: string): () => void
}

/** Hooks live under this file in a plugin root, when present. */
export const STANDARD_HOOKS_FILE = 'hooks/hooks.json'

/** Options for mounting one plugin's hooks. */
export interface MountHooksOptions {
  /** The plugin root directory; the standard hooks file resolves against it. */
  readonly pluginRoot: string
  /** The parsed manifest; `hooks` supplies an inline or file reference. */
  readonly manifest: CcPluginManifest
  /** The hooks seam (probed; `undefined` to skip hooks). */
  readonly hooks: HooksSeam | undefined
}

/**
 * Read and inject a plugin's hooks through the optional seam.
 * @param options - plugin root, manifest, and the hooks seam.
 * @returns mounted disposers and per-component counts.
 */
export function mountHooks(options: MountHooksOptions): { disposers: (() => void)[]; tally: ComponentTally } {
  const tally = new ComponentTally('hooks')
  const disposers: (() => void)[] = []
  if (options.hooks === undefined) {
    tally.addSkipped('hooks seam "hooks" is not mounted')
    return { disposers, tally }
  }
  const hooks = resolveHooks(options.pluginRoot, options.manifest)
  if (hooks.error !== undefined) {
    tally.addFailed(hooks.error)
    return { disposers, tally }
  }
  if (hooks.value === undefined) {
    tally.addSkipped('plugin declares no hooks')
    return { disposers, tally }
  }
  disposers.push(options.hooks.mergePluginHooks(options.manifest.name, hooks.value, options.pluginRoot))
  tally.addLoaded()
  return { disposers, tally }
}

/** Resolve the plugin's hooks map, or a failure reason. */
function resolveHooks(pluginRoot: string, manifest: CcPluginManifest): { value?: unknown; error?: string } {
  const inline = manifest.hooks
  if (typeof inline === 'string') {
    return readHooksFile(resolve(pluginRoot, inline), `manifest hooks path "${inline}"`)
  }
  if (inline !== undefined) {
    if (!isRecord(inline)) {
      return { error: 'manifest "hooks" must be an object or a hooks file path' }
    }
    const fromInline = inline['hooks'] !== undefined ? inline['hooks'] : inline
    return validateHooks(fromInline)
  }
  return readHooksFile(join(pluginRoot, STANDARD_HOOKS_FILE), 'hooks/hooks.json')
}

/** Read and validate a hooks JSON file (absent file means no hooks). */
function readHooksFile(path: string, label: string): { value?: unknown; error?: string } {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { value: undefined } // absent standard hooks file is valid empty state
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { error: `could not parse ${label}` }
  }
  return validateHooks(parsed)
}

/** Validate a hooks value into a per-event map. */
function validateHooks(value: unknown): { value?: unknown; error?: string } {
  if (!isRecord(value)) {
    return { error: 'hooks must be an object keyed by event name' }
  }
  const hooks = (value['hooks'] !== undefined ? value['hooks'] : value) as Record<string, unknown>
  if (!isRecord(hooks)) {
    return { error: 'hooks "hooks" field must be an object keyed by event name' }
  }
  return { value: hooks }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
