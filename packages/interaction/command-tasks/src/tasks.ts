/**
 * Pure `/tasks` rendering helpers: background-job line and index formatting.
 * The `jobs` service lives in the harness; these functions only shape already
 * loaded snapshots, so they are unit-testable without cordis.
 * @module @dsh-cc/command-tasks/tasks
 */

/** A job's lifecycle state as rendered by `/tasks`. */
export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'

/** The subset of a background-job snapshot that `/tasks` renders. */
export interface JobLine {
  /** The registry-issued id (`<kind>-N`). */
  id: string
  /** The producer kind the job was registered with. */
  kind: string
  /** Current lifecycle state. */
  status: JobStatus
  /** Epoch ms when the job was registered. */
  startedAt: number
  /** The producer-supplied one-line label, when present. */
  label?: string
}

/** Format the `startedAt` epoch as a narrow non-ambiguous label. */
export function formatStartedAt(startedAt: number): string {
  return new Date(startedAt).toISOString()
}

/** Render one background job line. */
export function formatJobLine(job: JobLine): string {
  const parts: string[] = [`${job.id} [${job.kind}] ${job.status}`]
  parts.push(`started: ${formatStartedAt(job.startedAt)}`)
  if (job.label !== undefined) parts.push(`— ${job.label}`)
  return `- ${parts.join(' ')}`
}

/**
 * Render the caller-visible background jobs, or a friendly placeholder when
 * there are none.
 * @param jobs - the caller-visible job rows, in registry order.
 */
export function formatJobs(jobs: readonly JobLine[]): string {
  if (jobs.length === 0) return 'No background jobs are running.'
  const lines: string[] = ['Background jobs:']
  for (const job of jobs) lines.push(formatJobLine(job))
  return lines.join('\n')
}

/**
 * `/tasks` footer cross-link to `/agents` (plan §3.2 Slice 0): one line
 * pointing at the background-agents surface. Rendered only when the count is
 * known (a resolvable snapshot service) and non-zero.
 */
export function formatAgentsFooter(count: number): string {
  return `${count} background agents — /agents for details`
}
