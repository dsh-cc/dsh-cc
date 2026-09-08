import { afterEach, describe, expect, it } from 'vitest'
import {
  cacheTrajectoryReportSchema,
  loadStandardTrajectory,
  runCacheTrajectory,
} from '@dsh-cc/cache-trajectory'
import {
  startKeylessTrajectoryStack,
  type KeylessTrajectoryStack,
} from '@dsh-cc/cache-trajectory/testing'

/**
 * cc bundle trajectory e2e: the standard cache trajectory booted the way the
 * cc-tui bundle consumes the agent plane — CC plugin surface mounted, NO
 * terminal rendering — and folded through the shared runner.
 *
 * Composition scope (deliberate): the full bundle patch (preset roster +
 * TUI rows over a dsh profile) resolves plugin packages through a deployed
 * dsh installation and cannot boot in-process from this workspace — that path
 * is exercised by deploying (`scripts/sync-cc-preset.sh`) and running
 * `cache-trajectory/src/bin.ts` there. In-process, this spec mounts the
 * mountable cc agent-plane plugins — the token meter plus the cc
 * microcompactor (passive, `auto: false` default) — so the trajectory runs
 * with the cc compaction plugin genuinely in the loop while asserting it never
 * rewrote history (append-only scope guard).
 *
 * Keyless: the real DeepSeek adapter points at a local scripted mock server.
 */

let stack: KeylessTrajectoryStack | undefined

afterEach(async () => {
  await stack?.close()
  stack = undefined
})

describe('cc bundle cache trajectory e2e', () => {
  it('runs the standard trajectory with the cc agent-plane plugins mounted', async () => {
    const trajectory = loadStandardTrajectory()
    stack = await startKeylessTrajectoryStack({
      persona: trajectory.persona,
      ccPlugins: true,
      toolName: trajectory.tools[0]!.name,
      toolArguments: '{"key":"deploy-color"}',
      successText: 'azure-falcon-42 confirmed.',
    })
    const result = await runCacheTrajectory(stack.ctx, trajectory, {
      cacheHitsExpected: false,
      model: 'mock-model',
    })

    // The cc plugins are genuinely in the composition (not terminal surface).
    expect(stack.ctx.get('tokenMeter')).toBeDefined()
    expect(stack.ctx.get('microcompactor')).toBeDefined()

    const report = result.report
    expect(() => cacheTrajectoryReportSchema.parse(report)).not.toThrow()
    expect(report.totals.requests).toBeGreaterThanOrEqual(trajectory.minRequests)
    expect(result.firstTurnToolCalls).toBeGreaterThanOrEqual(1)
    expect(report.verdict).toBe('pass')
    expect(report.failures).toEqual([])
  }, 60_000)

  it('keeps the request prefix append-only with the cc compaction plugin present', async () => {
    const trajectory = loadStandardTrajectory()
    stack = await startKeylessTrajectoryStack({
      persona: trajectory.persona,
      ccPlugins: true,
      toolName: trajectory.tools[0]!.name,
      toolArguments: '{"key":"deploy-color"}',
      successText: 'azure-falcon-42 confirmed.',
    })
    const result = await runCacheTrajectory(stack.ctx, trajectory, {
      cacheHitsExpected: false,
      model: 'mock-model',
    })

    // Passive microcompactor: no compaction events may land on the session.
    const compactionEvents = [...result.agent.session.snapshotEvents()]
      .filter(event => event.type.startsWith('compaction/'))
    expect(compactionEvents).toEqual([])

    // And the wire surface stays a strict prefix-extension.
    const messages = stack.server.requests.map(request => {
      const body = request.body as { messages?: unknown } | undefined
      if (body === undefined || !Array.isArray(body.messages)) {
        throw new Error('mock server captured a chat request without a messages array')
      }
      return body.messages as unknown[]
    })
    expect(messages.length).toBeGreaterThanOrEqual(result.report.totals.requests)
    for (let i = 1; i < messages.length; i += 1) {
      const previous = messages[i - 1]!
      const next = messages[i]!
      expect(next.length, `request ${i + 1} vs ${i}: count`).toBeGreaterThan(previous.length)
      expect(next.slice(0, previous.length), `request ${i + 1} vs ${i}: prefix`).toEqual(previous)
    }
  }, 60_000)
})
