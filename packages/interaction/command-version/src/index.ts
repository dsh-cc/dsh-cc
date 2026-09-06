/**
 * Human-facing `/version` command: prints the plugin bundle version and, when
 * the host surfaces one, the harness version. Deterministic and offline-safe.
 * @module @dsh-cc/command-version
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { formatVersion, readOwnVersion } from './version.ts'

export const name = 'command-version'
export const inject = ['commands']

/** Read a host-surfaced harness version, if any, without failing the command. */
function harnessVersion(ctx: Context): string | undefined {
  const value = ctx.get('harnessVersion')
  if (value === undefined) return undefined
  if (typeof value === 'object' && value !== null) {
    const record = value as { version?: unknown }
    if (typeof record.version === 'string') return record.version
  }
  if (typeof value === 'string') return value
  return undefined
}

/** Execute `/version`. */
async function executeVersion(ctx: Context): Promise<CommandResult> {
  const own = await readOwnVersion()
  return { kind: 'success', text: formatVersion(own, harnessVersion(ctx)) }
}

/**
 * Register the `/version` command for every composed command adapter.
 * @param ctx - context carrying the command registry.
 */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'version',
    description: 'print the plugin bundle and harness versions',
    handler: (_invocation: CommandInvocation) => executeVersion(ctx),
  })
}
