/** Every model attempt, including audit and repair, shares reservation, timeout and cancellation. */
import { BudgetTracker, type ReviewBudget } from './review-tasks.ts'
import {
  ReviewConfigDriftError, ReviewInvalidError, ReviewTruncatedError,
  type ReviewMessages, type ReviewModelAdapter,
} from './review-adapter.ts'
import type { UsageRow } from './review-run-store.ts'

export class ReviewBudgetError extends Error {
  readonly code = 'BUDGET_EXHAUSTED'
}
export class ReviewContextError extends Error {
  readonly code = 'CONTEXT_TOO_LARGE'
}
export interface CallResult<T> {
  raw: T
  inputTokens: number
  outputTokens: number
}

/** B.2.4 retry classes. */
type RetryClass = 'invalid' | 'transient' | 'truncation' | 'permanent'

function classify(error: unknown): RetryClass {
  if (error instanceof ReviewTruncatedError) return 'truncation'
  if (error instanceof ReviewConfigDriftError) return 'permanent'
  if (error instanceof ReviewBudgetError || error instanceof ReviewContextError) return 'permanent'
  if (error instanceof ReviewInvalidError) return 'invalid'
  // Timeout deadline rejection and dispatch/transport errors (carrying `detail`) are transient.
  return 'transient'
}

function detailOf(error: unknown): { httpStatus?: number; providerCode?: string; providerRetryAfterMs?: number } | undefined {
  return (error as { detail?: { httpStatus?: number; providerCode?: string; providerRetryAfterMs?: number } })?.detail
}

export class ReviewCaller {
  constructor(
    readonly adapter: ReviewModelAdapter,
    readonly tracker: BudgetTracker,
    readonly budget: ReviewBudget,
    readonly signal: AbortSignal,
    readonly usage: (row: Omit<UsageRow, 'runId'>) => void,
    readonly maxContextChars = 48_000,
    readonly reserveShared?: (inputTokens: number, reserve: () => boolean) => boolean,
  ) {}

  /** Abortable backoff sleep (B.2.4). */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(this.signal.reason ?? new Error('review cancelled'))
      if (this.signal.aborted) return abort()
      const timer = setTimeout(() => {
        this.signal.removeEventListener('abort', abort)
        resolve()
      }, ms)
      this.signal.addEventListener('abort', () => {
        clearTimeout(timer)
        abort()
      }, { once: true })
    })
  }

  async call<T>(
    taskId: string,
    messages: ReviewMessages,
    schema: object,
    parse: (raw: string) => T,
  ): Promise<CallResult<T>> {
    if (messages.reduce((n, m) => n + m.content.length, 0) > this.maxContextChars) {
      throw new ReviewContextError('review context exceeds the configured limit; no evidence was truncated')
    }
    let request = messages
    let attempts = 0
    let firstSeq = -1
    for (;;) {
      this.signal.throwIfAborted()
      const counted = await this.adapter.countInput([...request, { role: 'user', content: JSON.stringify(schema) }])
      // Local counters and the durable ledger row must be updated inside the
      // shared cycle lock, before another run can observe the available spend.
      const reserve = () => {
        if (!this.tracker.reserve(counted.tokens)) return false
        const seq = this.tracker.calls
        if (firstSeq < 0) firstSeq = seq
        this.usage({
          taskId,
          seq,
          kind: 'reserved',
          inputTokens: counted.tokens,
          outputTokens: this.budget.maxOutputTokensPerCall,
          method: counted.method,
          ...(seq !== firstSeq ? { retryOf: `${taskId}:${firstSeq}` } : {}),
        })
        return true
      }
      if (!(this.reserveShared ? this.reserveShared(counted.tokens, reserve) : reserve()))
        throw new ReviewBudgetError('review budget exhausted')
      const seq = this.tracker.calls

      const timeout = new AbortController()
      const signal = AbortSignal.any([this.signal, timeout.signal])
      let timer: ReturnType<typeof setTimeout> | undefined
      let result: { raw: string; inputTokens?: number; outputTokens?: number } | undefined
      try {
        // B.2.3: scale with input size (2ms/token), floored at the setting, capped at 4x.
        // counted.tokens may be a byte upper bound when no tokenizer — still the safe direction.
        const computedTimeoutMs = Math.max(
          this.budget.callTimeoutMs,
          Math.min(this.budget.callTimeoutMs * 4, this.budget.callTimeoutMs + counted.tokens * 2),
        )
        const deadline = new Promise<never>((_, reject) => {
          const abort = () => reject(signal.reason ?? new Error('review cancelled'))
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
          timer = setTimeout(
            () => timeout.abort(new Error('review call timeout')),
            Math.min(computedTimeoutMs, this.tracker.remainingMs()),
          )
        })
        result = await Promise.race([
          (async () => {
            const call = await this.adapter.prepareReviewCall({
              messages: request,
              responseSchema: schema,
              maxOutputTokens: this.budget.maxOutputTokensPerCall,
              signal,
            })
            return call.dispatch()
          })(),
          deadline,
        ])
        const parsed = parse(result.raw)
        return {
          raw: parsed,
          inputTokens: result.inputTokens ?? counted.tokens,
          outputTokens: result.outputTokens ?? this.budget.maxOutputTokensPerCall,
        }
      } catch (error) {
        attempts += 1
        if (this.signal.aborted) throw this.attach(error, attempts)
        const cls = classify(error)
        const maxAttempts = cls === 'invalid' ? 3 : cls === 'transient' ? 2 : 1
        const backoff = cls === 'invalid'
          ? (attempts === 1 ? 1_000 : 4_000)
          : (detailOf(error)?.providerRetryAfterMs ?? 5_000)
        if (cls === 'truncation' || cls === 'permanent' || attempts >= maxAttempts || this.tracker.wallExceeded()) {
          throw this.attach(error, attempts)
        }
        // Backoff respects the wall clock: skip the sleep when the remaining wall is shorter,
        // skip the retry entirely when no wall remains.
        if (this.tracker.remainingMs() > 0 && this.tracker.remainingMs() < backoff) {
          // proceed immediately without sleeping
        } else {
          try {
            await this.sleep(backoff)
          } catch {
            throw this.attach(error, attempts) // aborted during backoff — surface the attempt's error
          }
        }
        if (cls === 'invalid') {
          request = [
            ...messages,
            {
              role: 'user',
              content: `The previous response was invalid: ${String(error)}. Return a corrected respond call using the same task inputs.`,
            },
          ]
        }
      } finally {
        if (timer) clearTimeout(timer)
        this.tracker.settle(counted.tokens, result)
        this.usage({
          taskId,
          seq,
          kind: result ? 'actual' : 'error',
          inputTokens: result?.inputTokens ?? counted.tokens,
          outputTokens: result?.outputTokens ?? this.budget.maxOutputTokensPerCall,
          method: counted.method,
          ...(seq !== firstSeq ? { retryOf: `${taskId}:${firstSeq}` } : {}),
        })
      }
    }
  }

  /** Attach the attempt count so the runner can populate errorDetail.retryAttempts. */
  private attach(error: unknown, attempts: number): unknown {
    try {
      (error as { retryAttempts?: number }).retryAttempts = attempts
    } catch { /* frozen exotic error — best effort */ }
    return error
  }
}
