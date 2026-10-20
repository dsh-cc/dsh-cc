/** Drain retry backoffs without spending real time in continuation fixtures. */
import { vi } from 'vitest'
import { executeReviewRun } from '../src/review-runner.ts'

export async function runReviewWithTimers(input: Parameters<typeof executeReviewRun>[0]) {
  // Keep Date real: persisted continuation ordering uses wall-clock timestamps.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const pending = executeReviewRun(input)
    await vi.runAllTimersAsync()
    return await pending
  } finally {
    vi.useRealTimers()
  }
}
