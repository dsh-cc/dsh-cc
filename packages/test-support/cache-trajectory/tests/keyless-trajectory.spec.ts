import { afterEach, describe, expect, it } from 'vitest'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TrajectoryRunResult } from '../src/index.ts'
import {
  cacheTrajectoryReportSchema,
  loadStandardTrajectory,
  runCacheTrajectory,
} from '../src/index.ts'
import { startKeylessTrajectoryStack, type KeylessTrajectoryStack } from '../src/testing.ts'

/**
 * Keyless e2e: the standard trajectory driven over the real agent loop with
 * the DeepSeek adapter pointed at a local scripted mock server (no network,
 * no credentials). Two layers:
 *
 * 1. Wiring — the runner boots, drives every turn, and folds a schema-valid
 *    report whose shape invariants hold (request floor, forced first-turn
 *    tool call, per-request usage).
 * 2. L0 prefix stability — from the mock server's capturedRequests: request
 *    N+1's messages array is a strict prefix-extension of request N's. This
 *    makes a broken request prefix a deterministic failure, decoupled from
 *    provider cache hits. Scope: append-only surface — this composition mounts
 *    NO compaction plugin, so any mid-history rewrite is a regression by
 *    definition.
 *
 * Each test boots a fresh stack so captured requests and session state never
 * leak across tests.
 */

let stack: KeylessTrajectoryStack | undefined

async function bootKeylessStack(options: { toolOrder?: readonly string[] } = {}): Promise<void> {
  const trajectory = loadStandardTrajectory()
  stack = await startKeylessTrajectoryStack({
    persona: trajectory.persona,
    ...(options.toolOrder === undefined ? {} : { toolOrder: options.toolOrder }),
    toolName: trajectory.tools[0]!.name,
    toolArguments: '{"key":"deploy-color"}',
    successText: 'azure-falcon-42 confirmed.',
  })
}

async function runStandardTrajectory(): Promise<TrajectoryRunResult> {
  return runCacheTrajectory(stack!.ctx, loadStandardTrajectory(), {
    cacheHitsExpected: false,
    model: 'mock-model',
  })
}

/** Captured wire bodies (messages arrays) in arrival order. */
function capturedMessages(): unknown[][] {
  return stack!.server.requests.map(request => {
    const body = request.body as { messages?: unknown } | undefined
    if (body === undefined || !Array.isArray(body.messages)) {
      throw new Error('mock server captured a chat request without a messages array')
    }
    return body.messages as unknown[]
  })
}

/** Captured wire tool arrays (the assembled catalog) in arrival order. */
function capturedTools(): { name: string }[][] {
  return stack!.server.requests.map((request) => {
    const body = request.body as { tools?: { name: string }[] } | undefined
    if (body === undefined || !Array.isArray(body.tools)) {
      throw new Error('mock server captured a chat request without a tools array')
    }
    return body.tools
  })
}

afterEach(async () => {
  await stack?.close()
  stack = undefined
})

describe('keyless trajectory wiring', () => {
  it('runs the standard trajectory to a schema-valid, shape-clean report', async () => {
    await bootKeylessStack()
    const trajectory = loadStandardTrajectory()
    const result = await runStandardTrajectory()

    const report = result.report
    expect(() => cacheTrajectoryReportSchema.parse(report)).not.toThrow()
    // Shape floor, never a ceiling.
    expect(report.totals.requests).toBeGreaterThanOrEqual(trajectory.minRequests)
    // The forced first turn really called the tool.
    expect(result.firstTurnToolCalls).toBeGreaterThanOrEqual(1)
    // Mock usage has no cache buckets: rates stay null, verdict is shape-only.
    expect(report.totals.cacheReadTokens).toBe(0)
    expect(report.totals.hitRate).toBeNull()
    expect(report.thresholds.cacheHitsExpected).toBe(false)
    expect(report.verdict).toBe('pass')
    expect(report.failures).toEqual([])
    // Requests arrive in turn order; turn 1 spans at least two requests.
    const turns = report.requests.map(request => request.turn)
    expect(turns).toHaveLength(report.totals.requests)
    expect(turns[0]).toBe(turns[1])
  }, 60_000)
})

describe('L0 prefix stability (compaction off)', () => {
  it('extends each request messages as a strict prefix of the previous one', async () => {
    await bootKeylessStack()
    const result = await runStandardTrajectory()

    const messages = capturedMessages()
    expect(messages.length).toBeGreaterThanOrEqual(result.report.totals.requests)
    for (let i = 1; i < messages.length; i += 1) {
      const previous = messages[i - 1]!
      const next = messages[i]!
      const context = `request ${i + 1} vs request ${i}`
      expect(next.length, `${context}: count`).toBeGreaterThan(previous.length)
      expect(next.slice(0, previous.length), `${context}: prefix`).toEqual(previous)
    }
  }, 60_000)

  it('runs in the guarded append-only scope: no compaction ever fired', async () => {
    await bootKeylessStack()
    const result = await runStandardTrajectory()

    const compactionEvents = [...result.agent.session.snapshotEvents()]
      .filter(event => event.type.startsWith('compaction/'))
    expect(compactionEvents).toEqual([])
  }, 60_000)
})

/**
 * D5.3 (harness 0.2.2-rc.1): tool ordering moved from the retired append-order
 * waterfall plugin to host `SystemPrompt.toolOrder`. The sentinel keeps its
 * cache-stability job with the accepted delta spelled out:
 *
 * (a) the configured static prefix is byte-stable across activations, and
 * (b) the unlisted rest bucket follows lexicographic insertion — a newly
 *     visible unlisted tool INSERTS by name order there, where the retired
 *     plugin appended at the tail.
 */
describe('L0 tool order (systemPrompt.toolOrder, D5)', () => {
  /** The configured static prefix: the trajectory's own catalog, in order. */
  const STATIC_PREFIX = ['lookup'] as const

  it('keeps the configured static prefix byte-identical across every request', async () => {
    await bootKeylessStack({ toolOrder: [...STATIC_PREFIX, '<unlisted-tools>'] })
    await runStandardTrajectory()

    const tools = capturedTools()
    expect(tools.length).toBeGreaterThanOrEqual(2)
    for (const [index, requestTools] of tools.entries()) {
      expect(requestTools.map(tool => tool.name), `request ${index + 1}`)
        .toEqual([...STATIC_PREFIX, ...requestTools.map(tool => tool.name).slice(STATIC_PREFIX.length)])
      // Byte-stability of the promised prefix: the listed schemas never change.
      expect(JSON.stringify(requestTools.slice(0, STATIC_PREFIX.length)), `request ${index + 1}`)
        .toEqual(JSON.stringify(tools[0]!.slice(0, STATIC_PREFIX.length)))
    }
  }, 60_000)

  it('inserts an unlisted activation lexicographically into the rest bucket', async () => {
    await bootKeylessStack({ toolOrder: [...STATIC_PREFIX, '<unlisted-tools>'] })
    const result = await runStandardTrajectory()

    const register = (name: string): void => {
      stack!.ctx.tools.register(defineTool({
        name,
        description: `${name} probe.`,
        parameters: {},
        output: { schema: { type: 'object', additionalProperties: false } },
        execute: async () => ({}),
      }))
    }
    // 'aaa_probe' sorts before the listed 'lookup' and before 'zzz_probe'.
    register('aaa_probe')
    register('zzz_probe')

    const systemPrompt = (stack!.ctx as unknown as {
      systemPrompt: { assemble(context: { scope: unknown }): Promise<{ tools: { name: string }[] }> }
    }).systemPrompt
    const assembly = await systemPrompt.assemble({ scope: result.agent })

    // (a) the listed prefix stays put — the activation did not shift it.
    expect(assembly.tools[0]!.name).toBe(STATIC_PREFIX[0])
    // (b) the rest bucket is lexicographic, NOT tail-append order: 'aaa_probe'
    // precedes 'zzz_probe' and both follow the listed prefix.
    expect(assembly.tools.map(tool => tool.name)).toEqual([...STATIC_PREFIX, 'aaa_probe', 'zzz_probe'])
  }, 60_000)
})
