/**
 * Review task-service seam and budget tracker (design
 * docs/plans/2026-10-16-vwa-evidence-argument.md §13, Appendix A):
 * background-task registration over the host jobs registry and reserved-
 * output budget accounting. Split from review-runner.ts for the file-size cap.
 *
 * @module @dsh-cc/vwa-argument/review-tasks
 */

import type { Id } from './types.ts'

/** Frozen §13 budget for one run (from settings at project time). */
export interface ReviewBudget {
  maxCallsPerRun: number
  maxInputTokensPerRun: number
  maxOutputTokensPerRun: number
  maxOutputTokensPerCall: number
  wallMs: number
  callTimeoutMs: number
  concurrency: number
}

/** Appendix A background task service (four behaviors). */
export interface ReviewTaskService {
  /** false → per-owner cap overflow (REVIEW_UNAVAILABLE). */
  start(taskId: string, label: string, run: (signal: AbortSignal) => Promise<void>): boolean
  cancel(taskId: string): void
  get(taskId: string): 'running' | 'settled' | 'unknown'
  emitProgress(event: { runId: Id; stage: string; message: string }): void
}

/**
 * Host mapping over the jobs registry (Appendix A). An undefined registry →
 * this throws; the semantic.review tool treats that as REVIEW_UNAVAILABLE
 * and stays disabled, never degrading into a synchronous long call.
 */
export function createHostTaskService(
  jobs:
    | {
      start(spec: {
        kind: string
        label: string
        owner?: unknown
        run(job: { id: string; updateProgress(line: string): void }): {
          cancel(reason?: string): void
          done: Promise<{ status: string; detail?: string }>
        }
      }): { id: string }
      kill(id: string, caller?: unknown, reason?: string): string
      get(id: string): { status: string }
      list(caller?: unknown): unknown[]
    }
    | undefined,
  owner?: unknown,
  onProgress?: (event: { runId: Id; stage: string; message: string }) => void,
): ReviewTaskService {
  if (jobs === undefined) throw new Error('REVIEW_UNAVAILABLE: no background task service is mounted')
  const handles = new Map<string, { updateProgress(line: string): void }>()
  return {
    start(taskId, label, run) {
      try {
        const ownerJobs = jobs.list?.(owner) as unknown[] | undefined
        if (Array.isArray(ownerJobs) && ownerJobs.length >= 10) return false // §13 per-owner cap
      } catch {
        // Owner enumeration is advisory; fall through to the start attempt.
      }
      let controller: AbortController | undefined
      try {
        jobs.start({
          kind: 'vwa-review',
          label,
          ...(owner === undefined ? {} : { owner }),
          run: (job) => {
            handles.set(taskId, job)
            controller = new AbortController()
            const done = run(controller.signal).then(
              () => ({ status: 'completed' as const }),
              (error: unknown) => ({ status: 'failed' as const, detail: String(error) }),
            )
            return { cancel: (reason?: string) => controller?.abort(reason), done }
          },
        })
        return true
      } catch {
        return false
      }
    },
    cancel(taskId) {
      // Cancellation travels through the host registry: jobs.kill(runId).
      try {
        jobs.kill(taskId, owner, 'review cancelled')
      } catch {
        // Already settled — kill is advisory.
      }
    },
    get(taskId) {
      try {
        const status = jobs.get(taskId)?.status
        return status === 'running' || status === 'stopping' ? 'running' : 'settled'
      } catch {
        return 'unknown'
      }
    },
    emitProgress(event) {
      onProgress?.(event)
      handles.get(event.runId)?.updateProgress(`${event.stage}: ${event.message}`)
    },
  }
}

/** §13 budget tracker with reserved-output accounting. */
export class BudgetTracker {
  calls = 0
  inputTokens = 0
  outputTokens = 0
  private readonly deadline: number

  constructor(readonly budget: ReviewBudget, private readonly now: () => number = Date.now) {
    this.deadline = now() + budget.wallMs
  }

  wallExceeded(): boolean {
    return this.now() >= this.deadline
  }

  /** Whether one more call fits; charges the full reserved output cap when true. */
  reserve(inputTokens: number): boolean {
    if (this.calls + 1 > this.budget.maxCallsPerRun) return false
    if (this.wallExceeded()) return false
    if (this.inputTokens + inputTokens > this.budget.maxInputTokensPerRun) return false
    if (this.outputTokens + this.budget.maxOutputTokensPerCall > this.budget.maxOutputTokensPerRun) return false
    this.calls += 1
    this.inputTokens += inputTokens
    this.outputTokens += this.budget.maxOutputTokensPerCall
    return true
  }

  /** Settle a reservation with actual usage when available, else the reserve (§13). */
  settle(reservedInput: number, actual?: { inputTokens?: number; outputTokens?: number }): void {
    this.inputTokens -= reservedInput
    this.outputTokens -= this.budget.maxOutputTokensPerCall
    this.inputTokens += actual?.inputTokens ?? reservedInput
    this.outputTokens += actual?.outputTokens ?? this.budget.maxOutputTokensPerCall
  }
}

