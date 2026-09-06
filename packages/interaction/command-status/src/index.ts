/**
 * Human-facing `/status` command: a session status summary showing the current
 * model, permission preset, session id, and working directory. Lines whose
 * source is absent are omitted, so each adapter reports only what it can know.
 * @module @dsh-cc/command-status
 */

import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { Session } from '@deepseek-ai/dsh-session'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { formatStatus, lastModel, type StatusFields } from './status.ts'

export const name = 'command-status'
export const inject = ['commands']

/** Gather every line the current composition can report. */
function gather(ctx: Context, session: Session): StatusFields {
  const events = session.events
  const modelRef = lastModel(events)
  let preset: string | undefined
  const presets = ctx.get('permissionPresets')
  if (presets !== undefined) {
    try {
      preset = presets.current(events)
    } catch {
      // The permission service may be mounted without its shell/approval
      // dependencies; omit the line rather than failing the whole status.
    }
  }
  return {
    ...modelRef === undefined ? {} : { model: `${modelRef.provider}/${modelRef.model}` },
    ...preset === undefined ? {} : { preset },
    sessionId: session.id,
    cwd: session.header.cwd ?? process.cwd(),
  }
}

/** Execute `/status` against the invocation's own agent session. */
function executeStatus(ctx: Context, invocation: CommandInvocation): CommandResult {
  const fields = gather(ctx, invocation.agent.session)
  return { kind: 'success', text: formatStatus(fields) }
}

/**
 * Register the `/status` command for every composed command adapter.
 * @param ctx - context carrying the command registry.
 */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'status',
    description: 'show current model, permission preset, session, and working directory',
    handler: (invocation: CommandInvocation) => executeStatus(ctx, invocation),
  })
}
