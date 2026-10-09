/**
 * Integration (design docs/plans/2026-10-09-skill-lifecycle-usage-gates.md §5
 * step 6): a real cordis context with the REAL AgentLoop + tools dispatch and
 * a real JsonlSessionPersistence mounted (the in-memory test backend cannot
 * catch transcript writes — precedent
 * packages/compat/cc-model-aliases/tests/integration.spec.ts:24-67). A
 * `skill` tool call is driven through the real dispatch + emit path; the test
 * asserts exactly one sidecar ledger row AND — the negative tripwire guarding
 * the §3.6 boundary — zero `skill-usage/*` events in the REOPENED transcript.
 *
 * Tool mounting choice: a minimal tool NAMED `skill` registered at the real
 * `ctx.tools` seam (defineContentToolFixture), not the real @deepseek-ai
 * tool-skill — the real skill tool injects a catalog/`skills` service and a
 * loader stack this test does not need; what the tripwire exercises is the
 * real tools dispatch → `tools/result` emit path and the transcript
 * persistence boundary, not the tool's internals.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@dsh-cc/tools'
import { MockAdapter, textResponse, toolCallResponse } from '@dsh-cc/agent-loop-mock'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { cwdProjectKey } from '@dsh-cc/handoff-store'
import { apply as applySkillUsage } from '../src/index.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** Poll for a condition with a deadline (the ledger append is detached). */
async function waitFor(predicate: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function setup(): Promise<{ home: string; agent: Agent; adapter: MockAdapter; root: string }> {
  const home = mkdtempSync(join(tmpdir(), 'skill-usage-int-home-'))
  roots.push(home)
  const root = mkdtempSync(join(tmpdir(), 'skill-usage-int-sessions-'))
  roots.push(root)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  // Real JSONL persistence: the reopen tripwire (§3.6) is only meaningful
  // against the storage layer that hard-refuses unknown event types.
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  // dshHomePath seam: a real boot provides it; tests point it at a temp home.
  ;(ctx as unknown as { dshHomePath: (...segments: string[]) => string }).dshHomePath =
    (...segments: string[]) => join(home, ...segments)
  applySkillUsage(ctx)
  // Minimal tool NAMED `skill` at the real tools-registration seam (see file
  // header): the real dispatch layer produces the payload our listener sees.
  ctx.tools.register(defineContentToolFixture({
    name: 'skill',
    description: 'stub skill tool',
    parameters: { name: { type: 'string', required: true } },
    async execute(args) {
      return [{ type: 'text', text: `loaded skill ${args.name}` }]
    },
  }))
  const adapter = new MockAdapter([
    toolCallResponse('c1', 'skill', { name: 'learned-thing' }),
    textResponse('done'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('skill-usage-int'), { provider: 'mock', model: 'mock' })
  return { home, agent, adapter, root }
}

describe('cc-skill-usage integration (real loop + real JsonlSessionPersistence)', () => {
  it('one committed skill call lands exactly one ledger row and ZERO skill-usage/* transcript events on reopen', { timeout: 30_000 }, async () => {
    const { home, agent, adapter, root } = await setup()

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'load the skill' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    // §5 step 4 guard, at the real dispatch seam: the tool is still named
    // `skill` and its args still carry a string `name` (upstream-rename and
    // arg-shape failure modes).
    expect(adapter.requests).toHaveLength(2)
    // The ledger lives at the tool-form key resolved by the plugin itself
    // (live cwd of the owning agent).
    const projectKey = cwdProjectKey(agent)
    expect(projectKey).toBeDefined()
    const ledgerPath = join(home, 'skill-usage', `loads-${projectKey}.jsonl`)
    // The ledger append is awaited-then-detached (best-effort telemetry), so
    // poll for the flush instead of assuming it landed synchronously.
    await waitFor(() => existsSync(ledgerPath))
    expect(statSync(ledgerPath).isFile()).toBe(true)
    const lines = readFileSync(ledgerPath, 'utf8').split('\n').filter((line) => line.trim() !== '')
    // Exactly ONE ledger row for the one committed load.
    expect(lines).toHaveLength(1)
    const row = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(row).toMatchObject({
      v: 1,
      sessionId: String(agent.session.id),
      skill: 'learned-thing',
      via: 'tool',
    })
    expect(typeof row.ts).toBe('number')

    // Negative tripwire (§3.6): reopen the transcript through the REAL
    // persistence — the open path validates stored events and hard-refuses
    // unknown non-ignorable types, so a `skill-usage/*` append would make
    // this reopen throw; and the reopened event stream must contain zero
    // skill-usage/* rows either way.
    const reopenCtx = new Context()
    await mountAgentLoopTestDependencies(reopenCtx)
    await reopenCtx.plugin(JsonlSessionPersistence, { root })
    await reopenCtx.plugin(AgentLoop, { agents: [] })
    const reopened = await reopenCtx.agentLoop.create(SessionId('skill-usage-int'), { provider: 'mock', model: 'mock' })
    const eventTypes = [...reopened.session.snapshotEvents()].map((event) => event.type)
    expect(eventTypes.filter((type) => type.startsWith('skill-usage/'))).toEqual([])
  })

  it('the reopened transcript jsonl contains no skill-usage/* event type on disk', { timeout: 30_000 }, async () => {
    const { home, agent, root } = await setup()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    // Raw-disk second look: grep the stored log bytes for the prefix.
    const entries = readdirSync(root)
    let raw = ''
    for (const entry of entries) {
      const full = join(root, entry)
      if (statSync(full).isDirectory()) {
        for (const inner of readdirSync(full)) {
          if (inner.endsWith('.jsonl')) raw += readFileSync(join(full, inner), 'utf8')
        }
      } else if (entry.endsWith('.jsonl')) {
        raw += readFileSync(full, 'utf8')
      }
    }
    expect(raw).not.toContain('skill-usage/')
    await waitFor(() => existsSync(join(home, 'skill-usage', `loads-${cwdProjectKey(agent)}.jsonl`)))
  })
})
