/**
 * Human-facing `/rename <title>` command: pin an explicit user title on the
 * current session through the optional host `sessionTitle` service. When no
 * session-title service is mounted the command reports the seam gracefully;
 * rename validation failures (e.g. an empty title) pass through as errors.
 * @module @dsh-cc/command-rename
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

export const name = 'command-rename'
export const inject = ['commands']

/**
 * The minimal structural face of the optional `sessionTitle` service. Only
 * {@link rename} is needed here; acceptance/pinning semantics stay host-owned.
 */
export interface SessionTitleSeam {
  rename(session: unknown, title: string): { title: string }
}

/** Execute `/rename <title>`: pin a user title on the receiving agent's session. */
function executeRename(ctx: Context, invocation: CommandInvocation): CommandResult {
  const titles = ctx.get('sessionTitle') as SessionTitleSeam | undefined
  if (titles === undefined) {
    return { kind: 'error', text: 'renaming is unavailable: this deployment mounts no session-title service' }
  }
  const raw = invocation.rawInput.trim()
  if (raw.length === 0) {
    return { kind: 'error', text: 'Usage: /rename <title>' }
  }
  try {
    const accepted = titles.rename(invocation.agent.session, raw)
    return { kind: 'success', text: `Renamed to: ${accepted.title}` }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Register the `/rename` command for every composed command adapter.
 * @param ctx - context carrying the command registry.
 */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'rename',
    description: 'rename the current session',
    handler: (invocation: CommandInvocation) => executeRename(ctx, invocation),
  })
}
