/**
 * Mount a Claude Code plugin's hooks.
 *
 * Reads the plugin's `hooks/hooks.json` (or an inline manifest `hooks`
 * declaration), validates the structure, and injects the hooks into the
 * hooks-claude-code bridge through the optional `hooks` guest seam. When the
 * seam is absent the component is reported skipped, never failed, so a
 * deployment without the bridge keeps loading the rest of the plugin.
 *
 * Cursor-flavored plugins go through the verified dialect mapping table
 * (plan §3.5, S0 probe verdict DIVERGENT): camelCase cursor events map onto
 * their CC equivalents, cursor wire entries (`{command, matcher?, loop_limit?}`)
 * become CC matcher groups, `${CURSOR_PLUGIN_ROOT}` expands to the plugin root,
 * unmapped events skip with a warning, and `loop_limit` warns. CC-flavored
 * plugins pass through untouched.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { CcPluginManifest } from './types.ts'
import { ComponentTally } from './seams.ts'

/**
 * Cursor → CC hooks event mapping (plan §3.5, verified table). Cursor events
 * absent here have no CC equivalent and skip with a warning.
 */
const CURSOR_HOOK_EVENT_MAP: Readonly<Record<string, string>> = {
  sessionStart: 'SessionStart',
  sessionEnd: 'SessionEnd',
  preToolUse: 'PreToolUse',
  postToolUse: 'PostToolUse',
  postToolUseFailure: 'PostToolUseFailure',
  subagentStart: 'SubagentStart',
  subagentStop: 'SubagentStop',
  beforeSubmitPrompt: 'UserPromptSubmit',
  preCompact: 'PreCompact',
  stop: 'Stop',
}

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
export function mountHooks(options: MountHooksOptions): { disposers: (() => void)[]; tally: ComponentTally; warnings: string[] } {
  const tally = new ComponentTally('hooks')
  const disposers: (() => void)[] = []
  const warnings: string[] = []
  if (options.hooks === undefined) {
    tally.addSkipped('hooks seam "hooks" is not mounted')
    return { disposers, tally, warnings }
  }
  const hooks = resolveHooks(options.pluginRoot, options.manifest)
  if (hooks.error !== undefined) {
    tally.addFailed(hooks.error)
    return { disposers, tally, warnings }
  }
  if (hooks.value === undefined) {
    tally.addSkipped('plugin declares no hooks')
    return { disposers, tally, warnings }
  }
  let value: unknown = hooks.value
  if (options.manifest.flavor === 'cursor') {
    const translated = translateCursorHooks(hooks.value, options.pluginRoot, tally, warnings)
    value = translated
  }
  disposers.push(options.hooks.mergePluginHooks(options.manifest.name, value, options.pluginRoot))
  tally.addLoaded()
  return { disposers, tally, warnings }
}

/**
 * Translate a cursor hooks map (plan §3.5) into the CC `ClaudeCodeHookConfig`
 * shape: camelCase event keys map through {@link CURSOR_HOOK_EVENT_MAP}, flat
 * `{command, matcher?, loop_limit?}` entries become matcher groups,
 * `${CURSOR_PLUGIN_ROOT}` expands to the plugin root, unmapped events tally as
 * skipped, and unsupported entry fields surface as warnings.
 */
function translateCursorHooks(value: unknown, pluginRoot: string, tally: ComponentTally, warnings: string[]): Record<string, unknown> {
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [event, entries] of Object.entries(source)) {
    const ccEvent = CURSOR_HOOK_EVENT_MAP[event]
    if (ccEvent === undefined) {
      tally.addSkipped(`skipped hook event "${event}": no Claude Code equivalent`)
      continue
    }
    if (!Array.isArray(entries)) continue
    const groups: unknown[] = []
    for (const raw of entries) {
      if (typeof raw !== 'object' || raw === null) continue
      const entry = raw as Record<string, unknown>
      if (typeof entry['command'] !== 'string') continue
      const unsupported = Object.keys(entry).filter(key => !['command', 'matcher', 'loop_limit'].includes(key))
      if (unsupported.length > 0 || entry['loop_limit'] !== undefined) {
        const reason = `hook event "${event}": unsupported hook fields ignored (${entry['loop_limit'] !== undefined ? 'loop_limit' : unsupported.join(', ')})`
        warnings.push(reason)
      }
      groups.push({
        ...typeof entry['matcher'] === 'string' ? { matcher: entry['matcher'] } : {},
        hooks: [{ type: 'command', command: entry['command'].split('${CURSOR_PLUGIN_ROOT}').join(pluginRoot) }],
      })
    }
    if (groups.length > 0) out[ccEvent] = groups
  }
  return out
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
