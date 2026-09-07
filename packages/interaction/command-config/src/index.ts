/**
 * Human-facing `/config` command: render the effective configuration from the
 * settings service, or write an allowlisted key/value into a namespace scope.
 * Invalid keys or scopes produce a friendly message, never a thrown error.
 * @module @dsh-cc/command-config
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { helpable } from '@dsh-cc/command-usage'
import { keyAllowed, parseConfigArgs, renderConfig, type AllowEntry } from './config.ts'

export const name = 'command-config'
export const inject = ['commands', 'settings']

/** Default namespace when a `/config` update omits its scope token. */
export const DEFAULT_SCOPE = 'ui-theme'

/**
 * Restricted write allowlist: `namespace` (any key) or `namespace.key` pairs.
 * Only these explicit, theme-ish safe keys may be written; everything else is
 * refused. (A bare `namespace` entry would open every key in that scope, so
 * the default lists each writable key explicitly.)
 */
export const DEFAULT_ALLOWLIST: readonly AllowEntry[] = ['ui-theme.theme', 'ui-theme.fontSize']

/** `/config` configuration. */
export interface Config {
  /** Namespace used when an update omits its scope token. */
  readonly defaultScope?: string
  /** Write allowlist of `namespace` or `namespace.key` entries. */
  readonly allowlist?: readonly AllowEntry[]
}

/** Execute `/config [key] [value] [scope]`. */
async function executeConfig(
  ctx: Context,
  config: Config,
  invocation: CommandInvocation,
): Promise<CommandResult> {
  const defaultScope = config.defaultScope ?? DEFAULT_SCOPE
  const allowlist = config.allowlist ?? DEFAULT_ALLOWLIST
  const descriptors = ctx.settings.describe()

  const rawInput = invocation.rawInput.trim()
  if (rawInput.length === 0) {
    return { kind: 'success', text: renderConfig(descriptors) }
  }

  const args = parseConfigArgs(invocation.rawInput, defaultScope)
  if (args === undefined) {
    return { kind: 'success', text: 'Usage: /config [key] [value] [scope].' }
  }

  const known = descriptors.some(desc => desc.ns === args.scope)
  if (!known) {
    return { kind: 'success', text: `Unknown configuration scope "${args.scope}". Use /config to list scopes.` }
  }
  if (!keyAllowed(args.scope, args.key, allowlist)) {
    const scoped = allowlist.filter(entry => entry.startsWith(`${args.scope}.`))
    const hint = scoped.length === 0 ? 'no writable keys' : scoped.map(e => e.slice(args.scope.length + 1)).join(', ')
    return { kind: 'success', text: `Key "${args.key}" is not writable in scope "${args.scope}" (writable: ${hint}).` }
  }

  try {
    await ctx.settings.update(settingsNamespace(args.scope), { [args.key]: args.value })
  } catch (error) {
    return { kind: 'success', text: `Could not update ${args.scope}.${args.key}: ${String(error)}` }
  }
  return { kind: 'success', text: `Set ${args.scope}.${args.key} = ${JSON.stringify(args.value)}.` }
}

/**
 * Register the `/config` command for every composed command adapter.
 * @param ctx - context carrying the command registry and settings service.
 * @param config - default scope and write allowlist.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.commands.register(helpable({
    name: 'config',
    description: 'show effective configuration, or set an allowlisted key (e.g. /config theme dark ui-theme)',
    input: { hint: '[key] [value] [scope]' },
    handler: (invocation: CommandInvocation) => executeConfig(ctx, config, invocation),
  }, {
    notes: ['Run /config with no arguments to list scopes and current values.'],
  }))
}
