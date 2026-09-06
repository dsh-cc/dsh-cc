/**
 * Human-facing `/release-notes` command: prints the bundle's bundled changelog
 * (offline-safe, deterministic). An optional arg renders only the first N lines.
 * @module @dsh-cc/command-release-notes
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { renderReleaseNotes } from './release-notes.ts'

export const name = 'command-release-notes'
export const inject = ['commands']

/** Parse an optional positive line-count argument from the raw input. */
function parseLineLimit(rawInput: string): number | undefined {
  const token = rawInput.trim()
  const count = Number.parseInt(token, 10)
  if (token.length === 0 || !Number.isFinite(count) || count <= 0) return undefined
  return count
}

/** Execute `/release-notes [lines]`. */
function executeReleaseNotes(invocation: CommandInvocation): CommandResult {
  const limit = parseLineLimit(invocation.rawInput)
  return { kind: 'success', text: renderReleaseNotes(undefined, limit) }
}

/**
 * Register the `/release-notes` command for every composed command adapter.
 * @param ctx - context carrying the command registry.
 */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'release-notes',
    description: 'print the bundled release notes (changelog)',
    input: { hint: '[lines]' },
    handler: (invocation: CommandInvocation) => executeReleaseNotes(invocation),
  })
}
