/**
 * The `/doctor`-facing load report for the hooks-claude-code bridge. Built once
 * in {@link ../index!apply | apply} and stored on the plugin's own context as
 * `hookBridgeStatus` (instance-scoped, no module-level singleton).
 * @module @dsh-cc/hooks-claude-code/status
 */

import { resolve } from 'node:path'
import type { ClaudeCodeHookConfig, SkippedHook } from './config.ts'

/** The live load report exposed as `ctx.get('hookBridgeStatus')`. */
export interface HookBridgeStatus {
  /** The `path.resolve`d config path, or `''` when no path was available. */
  readonly sourcePath: string
  /** Parsed events that have ≥1 group, with group and hook counts. */
  readonly events: readonly { name: string; groups: number; hooks: number }[]
  /** Malformed/unsupported hooks dropped at parse time. */
  readonly skipped: readonly SkippedHook[]
  /**
   * Loaded `command` hook strings (after substitution). `/doctor` scans these
   * for binaries such as `serena-hooks` — skipped rows do not count as loaded.
   */
  readonly commands: readonly string[]
  /** Set when loading failed (ENOENT / JSON.parse / matcher SyntaxError / no path). */
  readonly error?: string
  readonly enablePromptHooks: boolean
  readonly enableAgentHooks: boolean
}

/** The enable flags the status needs, a subset of the plugin {@link ../index!Config | Config}. */
export interface StatusEnableFlags {
  enablePromptHooks?: boolean
  enableAgentHooks?: boolean
}

/** A failed-load status: no events, no skipped rows, just the error. */
export function failedStatus(
  sourcePath: string,
  error: string,
  flags: StatusEnableFlags,
): HookBridgeStatus {
  return {
    sourcePath,
    events: [],
    skipped: [],
    commands: [],
    error,
    enablePromptHooks: flags.enablePromptHooks ?? false,
    enableAgentHooks: flags.enableAgentHooks ?? false,
  }
}

/** A successful-load status summarizing the parsed config. */
export function loadedStatus(
  sourcePath: string,
  config: ClaudeCodeHookConfig,
  skipped: readonly SkippedHook[],
  flags: StatusEnableFlags,
): HookBridgeStatus {
  const events = Object.entries(config).map(([name, groups]) => ({
    name,
    groups: groups.length,
    hooks: groups.reduce((sum, group) => sum + group.hooks.length, 0),
  }))
  return {
    sourcePath: resolve(sourcePath),
    events,
    skipped,
    commands: commandStrings(config),
    enablePromptHooks: flags.enablePromptHooks ?? false,
    enableAgentHooks: flags.enableAgentHooks ?? false,
  }
}

/** Collect loaded command-hook strings (the default executor, `type` omitted). */
function commandStrings(config: ClaudeCodeHookConfig): string[] {
  const commands: string[] = []
  for (const groups of Object.values(config)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        if ((hook.type === undefined || hook.type === 'command') && typeof hook.command === 'string') {
          commands.push(hook.command)
        }
      }
    }
  }
  return commands
}
