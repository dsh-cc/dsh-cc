/** Every model attempt, including audit and repair, shares reservation, timeout and cancellation. */
import { BudgetTracker, type ReviewBudget } from './review-tasks.ts'
import {
  ReviewConfigDriftError, ReviewInvalidError, ReviewTruncatedError,
  type ReviewMessages, type ReviewModelAdapter,
} from './review-adapter.ts'
import type { UsageRow } from './review-run-store.ts'

const REPAIR_PREFIX = 'The previous response was invalid: '
const REPAIR_SUFFIX = '. Return a corrected respond call using the same task inputs.'
const MAX_REPAIR_ERROR_CHARS = 512
/** Maximum added message size; source windows reserve this space for repair. */
export const REVIEW_REPAIR_CONTEXT_CHARS = REPAIR_PREFIX.length + MAX_REPAIR_ERROR_CHARS + REPAIR_SUFFIX.length

export class ReviewBudgetError extends Error {
  readonly code = 'BUDGET_EXHAUSTED'
}
/** F1.4: the run's retry pool is empty — no further extra attempts are allowed. */
export class ReviewRetryBudgetError extends Error {
  readonly code = 'REVIEW_RETRY_BUDGET'
}
/** F1.4 precise recovery advice for REVIEW_RETRY_BUDGET. */
export const RETRY_BUDGET_ADVICE =
  'retry headroom exhausted; completed records are kept. If the cycle still has budget, retry with `continue: true` on a new requestId (same cycle, completed records are reused across runs); if the cycle is spent, a fresh request opens a new cycle with a full budget but re-executes the semantic stages (a second opinion).'
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
  if (error instanceof ReviewBudgetError || error instanceof ReviewContextError || error instanceof ReviewRetryBudgetError) return 'permanent'
  // Audit extraction uses its own error class with the same validation code.
  if (error instanceof ReviewInvalidError || (error as { code?: string })?.code === 'REVIEW_INVALID') return 'invalid'
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
    /** F1.4 per-run retry pool; undefined = legacy unlimited (absent request field). */
    readonly retryAllowance?: number,
  ) {
    this.poolUnits = retryAllowance
  }

  /** Remaining pool units; undefined = legacy unlimited. */
  private poolUnits: number | undefined

  /** Abortable backoff sleep (B.2.4). */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.signal.aborted) {
        reject(this.signal.reason ?? new Error('review cancelled'))
        return
      }
      const abort = () => {
        clearTimeout(timer)
        this.signal.removeEventListener('abort', abort)
        reject(this.signal.reason ?? new Error('review cancelled'))
      }
      const timer = setTimeout(() => {
        this.signal.removeEventListener('abort', abort)
        resolve()
      }, ms)
      this.signal.addEventListener('abort', abort, { once: true })
    })
  }

  async call<T>(
    taskId: string,
    messages: ReviewMessages,
    schema: object,
    parse: (raw: string) => T,
  ): Promise<CallResult<T>> {
    let request = messages
    let attempts = 0
    let firstSeq = -1
    // F1.4 correction: a retry unit is charged at the retry DECISION but is
    // only earned when the retry actually reserves and dispatches. Every exit
    // between the charge and that reservation refunds the unit — a retry that
    // never went out (context overflow, counting failure, budget/wall refusal,
    // abort during backoff) must not starve peer tasks of the pool.
    let chargedRetryUnit = false
    const refundRetryUnit = () => {
      if (chargedRetryUnit) {
        if (this.poolUnits !== undefined) this.poolUnits += 1
        chargedRetryUnit = false
      }
    }
    for (;;) {
      if (chargedRetryUnit && this.signal.aborted) refundRetryUnit()
      this.signal.throwIfAborted()
      // Repairs append a message: validate the actual attempt before counting
      // or reserving spend, while preserving the completed-attempt count.
      if (request.reduce((n, m) => n + m.content.length, 0) > this.maxContextChars) {
        refundRetryUnit()
        throw this.attach(new ReviewContextError('review context exceeds the configured limit; no evidence was truncated'), attempts)
      }
      let counted: Awaited<ReturnType<ReviewModelAdapter['countInput']>>
      try {
        counted = await this.adapter.countInput([...request, { role: 'user', content: JSON.stringify(schema) }])
      } catch (error) {
        // Counting failed before reservation or dispatch; only earlier attempts count.
        refundRetryUnit()
        throw this.attach(error, attempts)
      }
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
      if (!(this.reserveShared ? this.reserveShared(counted.tokens, reserve) : reserve())) {
        refundRetryUnit()
        throw this.attach(new ReviewBudgetError('review budget exhausted'), attempts)
      }
      // The attempt is committed (reserved, dispatch follows): the charged unit is earned.
      chargedRetryUnit = false
      const seq = this.tracker.calls
      const timeout = new AbortController()
      const signal = AbortSignal.any([this.signal, timeout.signal])
      let timer: ReturnType<typeof setTimeout> | undefined
      let result: { raw: string; inputTokens?: number; outputTokens?: number } | undefined
      let retry: { error: unknown; backoff: number } | undefined
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
        // F1.4: the pool is checked and debited synchronously (same tick, before
        // the retry dispatch, no await between check and debit) so concurrent
        // tasks in a Promise.allSettled batch cannot both claim the last unit.
        if (this.poolUnits !== undefined) {
          if (this.poolUnits <= 0)
            throw this.attach(new ReviewRetryBudgetError(RETRY_BUDGET_ADVICE), attempts)
          this.poolUnits -= 1
          chargedRetryUnit = true
        }
        retry = { error, backoff }
        if (cls === 'invalid') {
          request = [
            ...messages,
            {
              role: 'user',
              content: REPAIR_PREFIX + String(error).slice(0, MAX_REPAIR_ERROR_CHARS) + REPAIR_SUFFIX,
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
      // Settle usage and persist the ledger before yielding to backoff, so peers
      // can reserve against actual spend rather than this completed call's cap.
      if (retry) {
        const remaining = this.tracker.remainingMs()
        if (remaining <= 0) {
          refundRetryUnit()
          throw this.attach(retry.error, attempts)
        }
        if (remaining >= retry.backoff) {
          try {
            await this.sleep(retry.backoff)
          } catch {
            refundRetryUnit()
            throw this.attach(retry.error, attempts)
          }
        }
      }
    }
  }

  /** Attach the attempt count so the runner can populate errorDetail.retryAttempts. */
  private attach(error: unknown, attempts: number): unknown {
    try {
      (error as { retryAttempts?: number }).retryAttempts = attempts
      return error
    } catch {
      // Host cancellation may throw a string; frozen errors cannot be enriched in place.
      const wrapped = new Error(String((error as { message?: string })?.message ?? error), { cause: error })
      if (error instanceof Error) Object.setPrototypeOf(wrapped, Object.getPrototypeOf(error))
      if (typeof error === 'object' && error !== null) Object.assign(wrapped, error)
      return Object.assign(wrapped, { retryAttempts: attempts })
    }
  }
}
