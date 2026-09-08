import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  loadStandardTrajectory,
  runCacheTrajectory,
  thresholdsFromEnv,
  CACHE_E2E_MIN_HIT_RATE_ENV,
} from '../src/index.ts'
import { mountTrajectoryTestStack } from '../src/testing.ts'

/**
 * L1 with-key regression: the standard trajectory against the live DeepSeek
 * API over the minimal cc-plugin composition (token meter + passive
 * microcompactor mounted, no terminal rendering). Mirrors the harness
 * request-cache e2e's multi-step tool trajectory, but drives it through the
 * shared runner and asserts the dsh-cc regression gates:
 *
 * - every request after the first reports cacheReadTokens > 0 and clears the
 *   per-request soft floor (default 0.3);
 * - the session aggregate excluding the first request clears the session
 *   floor (default 0.6);
 * - both floors are adjustable via DSH_CACHE_E2E_MIN_HIT_RATE.
 *
 * Skipped without DEEPSEEK_API_KEY (same convention as the harness e2e).
 */

let ctx: Context | undefined

beforeEach(async () => {
  const trajectory = loadStandardTrajectory()
  ctx = new Context()
  await mountTrajectoryTestStack(ctx, { persona: trajectory.persona, ccPlugins: true })
})

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('provider cache regression (real API)', () => {
  it(`every request after the first hits the provider prefix cache (tune with ${CACHE_E2E_MIN_HIT_RATE_ENV})`, async () => {
    const trajectory = loadStandardTrajectory()
    const thresholds = thresholdsFromEnv(
      trajectory.thresholds,
      process.env[CACHE_E2E_MIN_HIT_RATE_ENV],
    )
    const result = await runCacheTrajectory(ctx!, trajectory, { thresholds })

    const report = result.report
    expect(report.thresholds.cacheHitsExpected).toBe(true)
    expect(report.totals.requests).toBeGreaterThanOrEqual(trajectory.minRequests)
    expect(result.firstTurnToolCalls).toBeGreaterThanOrEqual(1)

    // Hard, flake-resistant gate: cached tokens strictly present from request 2 on.
    for (const request of report.requests.slice(1)) {
      expect(request.cacheReadTokens ?? 0, `request ${request.index + 1} cached tokens`).toBeGreaterThan(0)
    }

    // Soft floors — conservative; loosen/tighten via the env knob.
    expect(report.failures).toEqual([])
    expect(report.verdict).toBe('pass')

    // Session aggregate (excluding the first request) is the primary gate.
    expect(report.totals.hitRateExcludingFirst).not.toBeNull()
    expect(report.totals.hitRateExcludingFirst!).toBeGreaterThanOrEqual(thresholds.sessionMinRate)

    // World-check of the conversation itself: the tool value reached the answer.
    const finalText = [...result.agent.session.snapshotEvents()]
      .reverse()
      .find(event => event.type === 'assistant/message')
    const text = finalText?.type === 'assistant/message'
      ? finalText.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      : ''
    expect(text).toContain('azure-falcon-42')
  }, 600_000)
})
