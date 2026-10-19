/** Separate process used to prove cycle reservations share a filesystem lock. */
import { reserveCycleCall } from '../../src/review-cycle.ts'
import { ReviewRunStore } from '../../src/review-run-store.ts'
import type { ReviewBudget } from '../../src/review-budget.ts'

const [root, projectId, runId, cycleId, budgetJson] = process.argv.slice(2) as [string, string, string, string, string]
const budget = JSON.parse(budgetJson) as ReviewBudget
process.once('message', () => {
  try {
    const allowed = reserveCycleCall(root, projectId, cycleId, budget, 10, () => {
      new ReviewRunStore(root, projectId).appendUsage(runId, {
        runId, taskId: 'task', seq: 1, kind: 'reserved', inputTokens: 10, outputTokens: 20, method: 'tokenizer',
      })
      return true
    })
    process.send!({ allowed }, () => process.disconnect())
  } catch (error) {
    process.send!({ error: String(error) }, () => process.disconnect())
  }
})
process.send!({ ready: true })
