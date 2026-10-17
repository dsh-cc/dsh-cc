/** Every model attempt, including audit and repair, shares reservation, timeout and cancellation. */
import { BudgetTracker, type ReviewBudget } from './review-tasks.ts'
import { ReviewInvalidError, type ReviewMessages, type ReviewModelAdapter } from './review-adapter.ts'
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
export class ReviewCaller {
  constructor(
    readonly adapter: ReviewModelAdapter,
    readonly tracker: BudgetTracker,
    readonly budget: ReviewBudget,
    readonly signal: AbortSignal,
    readonly usage: (row: Omit<UsageRow, 'runId'>) => void,
    readonly maxContextChars = 48_000,
  ) {}

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
    for (let attempt = 0; attempt < 2; attempt++) {
      this.signal.throwIfAborted()
      const counted = await this.adapter.countInput([...request, { role: 'user', content: JSON.stringify(schema) }])
      if (!this.tracker.reserve(counted.tokens)) throw new ReviewBudgetError('review budget exhausted')
      const seq = this.tracker.calls
      // Persist the reserve BEFORE dispatch, so a process crash cannot make an in-flight call free.
      this.usage({
        taskId,
        seq,
        kind: 'reserved',
        inputTokens: counted.tokens,
        outputTokens: this.budget.maxOutputTokensPerCall,
        method: counted.method,
      })
      const timeout = new AbortController()
      const signal = AbortSignal.any([this.signal, timeout.signal])
      let timer: ReturnType<typeof setTimeout> | undefined
      let result: { raw: string; inputTokens?: number; outputTokens?: number } | undefined
      try {
        const deadline = new Promise<never>((_, reject) => {
          const abort = () => reject(signal.reason ?? new Error('review cancelled'))
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
          timer = setTimeout(
            () => timeout.abort(new Error('review call timeout')),
            Math.min(this.budget.callTimeoutMs, this.tracker.remainingMs()),
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
        if (this.signal.aborted) throw error
        if (attempt === 1 || this.tracker.wallExceeded()) throw error
        const invalid = error instanceof ReviewInvalidError || (error as { code?: string })?.code === 'REVIEW_INVALID'
        if (invalid)
          request = [
            ...messages,
            {
              role: 'user',
              content: `The previous response was invalid: ${String(error)}. Return a corrected respond call using the same task inputs.`,
            },
          ]
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
        })
      }
    }
    throw new Error('unreachable')
  }
}
