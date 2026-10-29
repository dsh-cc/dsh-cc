/** Project exhaustion is a budget stop with its own persisted refusal. */
import { ReviewBudgetError, ReviewRetryBudgetError, RETRY_BUDGET_ADVICE } from './review-call.ts'
import { fail, VwaFail, type Fail } from './store.ts'

export class ProjectReviewBudgetError extends ReviewBudgetError {}

export function reviewRunRefusal(error: unknown): Fail | undefined {
  if (error instanceof ProjectReviewBudgetError)
    return fail('PROJECT_BUDGET_EXHAUSTED', 'The current project-cumulative review budget cannot reserve another call; raise reviewSettings.projectBudget to continue.', false)
  if (error instanceof VwaFail) return error.fail
  if (error instanceof ReviewRetryBudgetError) return fail('REVIEW_RETRY_BUDGET', RETRY_BUDGET_ADVICE, false)
  return undefined
}
