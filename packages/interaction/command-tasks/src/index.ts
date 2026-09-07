/**
 * Human-facing `/tasks` command: list the caller-visible background jobs (id,
 * kind, status, start time, and producer label). It reads the injected `jobs`
 * service; an empty visible set renders a friendly placeholder. (Todo-style
 * items are out of scope — they live outside the background-job registry.)
 * @module @dsh-cc/command-tasks
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { formatAgentsFooter, formatJobs, type JobLine } from './tasks.ts'
import { helpable } from '@dsh-cc/command-usage'

export const name = 'command-tasks'
export const inject = ['commands', 'jobs']

/**
 * Duck-typed read-only snapshot surface published by command-agents on the
 * root realm (`ccAgents`). Optional: absent service or a failed listing
 * degrades to no footer, never a failed /tasks.
 */
interface AgentsSnapshotLike {
  list(parentSessionId: string): Promise<readonly unknown[]>
}

/** Map a background-job snapshot to the fields this command renders. */
function toLine(job: JobSnapshot): JobLine {
  return {
    id: String(job.id),
    kind: job.kind,
    status: job.status,
    startedAt: job.startedAt,
    ...job.label.length > 0 ? { label: job.label } : {},
  }
}

/** Execute `/tasks`: list the caller-visible background jobs. */
async function executeTasks(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const jobs = ctx.jobs.list(invocation.agent)
  const lines = [formatJobs(jobs.map(toLine))]
  // Cross-link footer: count this session's background agents from the same
  // read-only snapshot /agents consumes (plan §3.2). Best-effort.
  const snapshot = (ctx as unknown as { get(key: string, optional?: boolean): unknown })
    .get('ccAgents', true) as AgentsSnapshotLike | undefined
  if (snapshot !== undefined && typeof snapshot.list === 'function') {
    try {
      const agents = await snapshot.list(String(invocation.agent.session.id))
      if (agents.length > 0) lines.push(formatAgentsFooter(agents.length))
    } catch {
      // No footer on a snapshot failure — /tasks must still list jobs.
    }
  }
  return { kind: 'success', text: lines.join('\n') }
}

/**
 * Register the `/tasks` command for every composed command adapter.
 * @param ctx - context carrying the command registry and jobs service.
 */
export function apply(ctx: Context): void {
  ctx.commands.register(helpable({
    name: 'tasks',
    description: 'list background jobs and their status',
    handler: (invocation: CommandInvocation) => executeTasks(ctx, invocation),
  }))
}
