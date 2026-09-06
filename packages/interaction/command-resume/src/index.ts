/**
 * Human-facing `/resume` command: list the recent sessions (id, title, cwd,
 * availability, start time) so a user can pick one to resume. It reads the
 * optional `sessionQuery` service mounted by session-query; when that service
 * is absent it reports the seam gracefully. Resume/switching is host-owned —
 * the command only lists and points the user at `dsh --resume <id>`.
 * @module @dsh-cc/command-resume
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRecord, SessionTitleObservationResult } from '@deepseek-ai/dsh-session-query'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { formatResumeIndex, type SessionLine } from './resume.ts'

export const name = 'command-resume'
export const inject = ['commands']

/**
 * The minimal structural face of the optional `sessionQuery` service. Two
 * concrete methods — {@link listSessions} and {@link readTitleSnapshots} — are
 * enough for this command; the rest of the engine is out of scope.
 */
export interface SessionQuerySeam {
  listSessions(signal?: AbortSignal): Promise<SessionRecord[]>
  readTitleSnapshots(
    sessionIds: readonly SessionId[],
    signal?: AbortSignal,
  ): Promise<SessionTitleObservationResult[]>
}

/** Resolve the optional sessionQuery seam, or undefined when not composed. */
function seam(ctx: Context): SessionQuerySeam | undefined {
  return ctx.get('sessionQuery') as SessionQuerySeam | undefined
}

/** Fold the latest title for one session from a batch observation, if any. */
function foldTitle(observations: readonly SessionTitleObservationResult[], id: SessionId): string | undefined {
  for (const observation of observations) {
    if (observation.sessionId !== id) continue
    if (observation.status === 'fulfilled' && observation.value.title !== undefined) {
      return observation.value.title.title
    }
    return undefined
  }
  return undefined
}

/** Execute `/resume`: list recent sessions with their titles. */
async function executeResume(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const sessionQuery = seam(ctx)
  if (sessionQuery === undefined) {
    return { kind: 'success', text: 'No session-query service is mounted in this composition.' }
  }
  const signal = invocation.signal
  const records = await sessionQuery.listSessions(signal)
  const ids = records.map(record => record.header.id)
  const observations = await sessionQuery.readTitleSnapshots(ids, signal)
  const lines: SessionLine[] = records.map(record => {
    const title = foldTitle(observations, record.header.id)
    return {
      id: record.header.id,
      createdAt: record.header.createdAt,
      live: record.live,
      persisted: record.persisted,
      ...record.header.cwd !== undefined ? { cwd: record.header.cwd } : {},
      ...record.header.parentSession !== undefined ? { parent: record.header.parentSession } : {},
      ...title !== undefined ? { title } : {},
    }
  })
  return { kind: 'success', text: formatResumeIndex(lines) }
}

/**
 * Register the `/resume` command for every composed command adapter.
 * @param ctx - context carrying the command registry.
 */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'resume',
    description: 'list recent sessions (id, title, cwd, availability) for resuming',
    handler: (invocation: CommandInvocation) => executeResume(ctx, invocation),
  })
}
