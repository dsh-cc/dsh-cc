/**
 * Production wiring of the review collaborators (design
 * docs/plans/2026-10-16-vwa-evidence-argument.md §13, Appendix A): turns
 * the host's `llm` and `jobs` services plus the `vwa-argument.review-alias`
 * setting into the `ToolDeps.review` bundle `argument.review` consumes.
 *
 * Resolution happens PER CALL, never at mount: services are read through the
 * guarded optional `ctx.get` path (a missing host service disables review
 * with REVIEW_UNAVAILABLE instead of blocking the plugin mount), settings are
 * hot-read, and the model route comes from the alias registry
 * (`resolveAlias` → ccModelRoutes / settings overlay), completed by the
 * calling agent's request header — the side-query precedent. No concrete
 * model id lives in this package (scripts/check-model-literals.mjs).
 *
 * @module @dsh-cc/vwa-argument/review-host
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolveAlias, toOneShotRoute } from '@dsh-cc/model-aliases'
import { createReviewAdapter, type ReviewLlmFace, type ReviewerRoute } from './review-adapter.ts'
import { createHostTaskService, type ReviewBudget } from './review-tasks.ts'
import { readUserSettingsSync, type VwaArgumentSettings } from './settings.ts'
import { fail, type Fail } from './store.ts'
import type { ReviewCollaborators } from './tools.ts'

/** The frozen §13 budget from the hot settings read. */
export function budgetFrom(settings: VwaArgumentSettings): ReviewBudget {
  return {
    maxCallsPerRun: settings['review-max-calls-per-run'],
    maxInputTokensPerRun: settings['review-max-input-tokens-per-run'],
    maxOutputTokensPerRun: settings['review-max-output-tokens-per-run'],
    maxOutputTokensPerCall: settings['review-max-output-tokens-per-call'],
    wallMs: settings['review-max-wall-ms'],
    callTimeoutMs: settings['review-call-timeout-ms'],
    concurrency: settings['review-concurrency'],
  }
}

/**
 * Resolve the reviewer route for one calling agent: the configured alias
 * through the alias registry, provider half filled from the agent's request
 * header; an unconfigured alias inherits the agent's own route. Undefined →
 * no route at all (REVIEW_UNAVAILABLE).
 */
export function resolveReviewerRoute(ctx: Context, alias: string, agent: unknown): ReviewerRoute | undefined {
  const parent = (agent as { session?: { requestHeader?(): { config?: { provider?: string; model?: string } } | undefined } } | undefined)
    ?.session?.requestHeader?.()?.config
  let filled: ReviewerRoute | undefined
  try {
    filled = toOneShotRoute(resolveAlias(ctx, alias), parent)
  } catch {
    // A non-chat (System One) target is not a reviewer route.
    return undefined
  }
  if (filled !== undefined) return filled
  if (parent?.provider !== undefined && parent.model !== undefined && parent.provider.length > 0 && parent.model.length > 0) {
    return { provider: parent.provider, model: parent.model }
  }
  return undefined
}

/**
 * Build the per-call review collaborator factory for `registerArgumentTools`.
 * @param ctx - the plugin context (services read via ctx.get at call time).
 * @param dshHome - the settings home (hot-read per call).
 */
export function createReviewFactory(ctx: Context, dshHome: string): (agent: unknown) => ReviewCollaborators | Fail {
  return (agent) => {
    const settings = readUserSettingsSync(dshHome)
    const llm = ctx.get('llm') as ReviewLlmFace | undefined
    if (llm === undefined || typeof llm.prepareCall !== 'function') {
      return fail('REVIEW_UNAVAILABLE', 'no llm service is mounted on the host', true)
    }
    const jobs = ctx.get('jobs') as Parameters<typeof createHostTaskService>[0]
    if (jobs === undefined) return fail('REVIEW_UNAVAILABLE', 'no background jobs service is mounted on the host', true)
    const route = resolveReviewerRoute(ctx, settings['review-alias'], agent)
    if (route === undefined) {
      return fail('REVIEW_UNAVAILABLE', `review alias "${settings['review-alias']}" resolves to no model route and the session has none to inherit`, true)
    }
    return {
      adapter: createReviewAdapter({ llm, route }),
      budget: budgetFrom(settings),
      tasks: createHostTaskService(jobs),
    }
  }
}
