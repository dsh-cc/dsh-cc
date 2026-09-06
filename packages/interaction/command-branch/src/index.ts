/**
 * Human-facing `/branch [note]` command: fork the current session into a new
 * child branch and report the child id. Session switching is host-owned, so
 * the command lists the resume entry point (`dsh --resume <childId>`) but does
 * not switch. Accepts an optional note rendered back to the user; the note is
 * not persisted by this command.
 * @module @dsh-cc/command-branch
 */

import { Context } from '@deepseek-ai/cordis'
import type { SessionStore, Session } from '@deepseek-ai/dsh-session'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { formatBranchError, formatBranchSuccess } from './branch.ts'

export const name = 'command-branch'
export const inject = ['commands']

/** Resolve the session store, or undefined when not composed. */
function store(ctx: Context): SessionStore | undefined {
  return ctx.get('sessions') as SessionStore | undefined
}

/** Execute `/branch [note]`: fork the current session. */
function executeBranch(ctx: Context, invocation: CommandInvocation): CommandResult {
  const sessions = store(ctx)
  if (sessions === undefined) {
    return { kind: 'success', text: 'No session store is mounted in this composition.' }
  }
  let child: Session
  try {
    child = sessions.fork(invocation.agent.session)
  } catch (error) {
    return { kind: 'success', text: formatBranchError(String(error)) }
  }
  const note = invocation.rawInput.trim()
  return { kind: 'success', text: formatBranchSuccess(String(child.id), note) }
}

/**
 * Register the `/branch` command for every composed command adapter.
 * @param ctx - context carrying the command registry.
 */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'branch',
    description: 'fork the current session into a new child branch',
    input: { hint: '[note]' },
    handler: (invocation: CommandInvocation) => executeBranch(ctx, invocation),
  })
}
