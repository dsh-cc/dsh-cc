import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as commandCost from '@dsh-cc/command-cost'
import { foldDecisionUsage, type DecisionCostRow } from '@dsh-cc/command-cost'
import { formatCostReport, type CostReport, type ModelPrice } from '@dsh-cc/command-cost/cost'
import { appendDecisionRow, decisionUsageDir, usageFilePath } from '@dsh-cc/decision-usage'

/** Report-merge regressions: the generative section's own rendering is untouched. */

const TABLE: readonly ModelPrice[] = [
  { model: 'model-a', provider: 'deepseek', inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0.5, cacheWritePerMTok: 0 },
  { model: 'deepseek-chat', provider: 'deepseek', inputPerMTok: 0.27, outputPerMTok: 1.10, cacheReadPerMTok: 0.07, cacheWritePerMTok: 0.07 },
]

const SCOPE = { projectKey: 'pk-merge', sessionId: 'session-merge', agentId: 'agent-merge', originSeq: 0 }

/** One statement-bounded reserve → dispatch → settle(actual) attempt. */
function settledRows(): DecisionCostRow[] {
  const base = {
    schemaVersion: 1 as const,
    decisionId: 'decision-1',
    attempt: 0,
    time: 1_700_000_000_000,
    scope: SCOPE,
    feature: 'memory-recall' as const,
    mode: 'active' as const,
    provider: 'deepseek',
    requestedModel: 'model-a',
    routeRevision: 'rev-1',
    questionVersion: 'q-1',
    policyVersion: 'p-1',
    inputHash: 'hash-1',
    latencyMs: 5,
  }
  return [
    { ...base, eventId: 'r', phase: 'reserve', outcome: 'reserved', actualModel: null, reservedInputTokens: 1000, reservedOutputTokens: 100 },
    { ...base, eventId: 'd', phase: 'dispatch', outcome: 'dispatched', actualModel: null },
    {
      ...base,
      eventId: 's',
      phase: 'settle',
      outcome: 'actual',
      actualModel: 'model-a',
      reservedInputTokens: 1000,
      reservedOutputTokens: 100,
      actualInputTokens: 500,
      actualOutputTokens: 50,
    },
  ]
}

const created: string[] = []

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'command-cost-merge-'))
  created.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('/cost report merge', () => {
  it('leaves the generative section byte-identical and appends the decision section after it', () => {
    const generative: CostReport = {
      perModel: [{
        provider: 'deepseek',
        model: 'deepseek-chat',
        messages: 1,
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.38,
        priced: true,
      }],
      totalUsd: 0.38,
    }
    const generativeText = formatCostReport(generative)
    expect(generativeText).toBe([
      'Usage and cost by model',
      '',
      'deepseek/deepseek-chat',
      '  Calls: 1',
      '  Input: 1000000 (uncached) + 0 (cache-read) + 0 (cache-write)',
      '  Output: 100000',
      '  Cost: $0.38',
      '',
      'Total: 1100000 tokens, $0.38',
    ].join('\n'))

    const decisions = foldDecisionUsage({ rows: settledRows(), tornTail: false, corruptLines: [] }, TABLE)
    expect(decisions).toBeDefined()
    const merged = formatCostReport({ ...generative, decisions })
    // The original algorithm's block, including its own total, is unchanged.
    expect(merged.startsWith(generativeText)).toBe(true)
    expect(merged).toContain('SystemOne decisions')
    // model-a: (500*1 + 50*2)/1e6; the grand total adds both confirmed sides.
    expect(merged).toContain('Confirmed subtotal (SystemOne decisions): $0.00')
    expect(merged).toContain('Grand total (confirmed): $0.38')
    expect(merged).toContain('generative $0.38 + SystemOne decisions $0.00')
  })

  it('renders no decision section when the session has no recorded working directory', async () => {
    const home = await tempHome()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    ctx.provide('dshHomePath', (...segments: string[]) => join(home, ...segments))
    const plugin = await ctx.plugin(commandCost, { modelTable: TABLE })
    const session = ctx.sessions.create(SessionId(`decision-cost-nocwd-${Math.random()}`))
    const agent: Agent = {
      id: session.id,
      options: {},
      session,
      inbox: null as never,
      ctx: new Context(),
      get status(): 'idle' { return 'idle' },
      send: () => {},
      followup: () => {},
      steer: () => {},
      inject: () => {},
      cancel: () => {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    await ctx.agents.register(agent)

    // A ledger exists for this session id, but the invocation has no cwd to key
    // it: /cost must not guess process.cwd() and must not throw.
    const file = usageFilePath(decisionUsageDir(home, SCOPE.projectKey, String(session.id)))
    for (const row of settledRows()) await appendDecisionRow(file, row)

    const execution = await ctx.commands.execute(agent, '/cost', [], new AbortController().signal)
    const text = (execution?.result as { text: string }).text
    expect(text).toBe('No usage data yet; no model calls have recorded token accounting.')
    await plugin.dispose()
  })
})
