/**
 * Real-loop integration + plugin-face pins: the apply() mount through the
 * REAL JsonlSessionPersistence backend (repo lesson: testkits without the
 * real backend fake greens), the pending-replay path across a reopen, and
 * the `inject` regression pin (§4.3 gate C seam).
 *
 * @module
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse, toolCallResponse } from '@dsh-cc/agent-loop-mock'
import { defineTool } from '@dsh-cc/tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { receiptLedgerPath } from '../src/receipt.ts'
import { DEFAULT_VWA_EVIDENCE_SETTINGS } from '../src/settings.ts'
import { apply } from '../src/index.ts'
import { evaluateTurnStopping, createEvaluatorState, type EvalEvent } from '../src/evaluator.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function userText(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

async function turn(agent: Agent, text: string): Promise<void> {
  agent.followup(userText(text))
  await agent.whenIdle()
}

/** Mount the REAL loop stack + the plugin on a shared persistence root. */
async function mount(root: string, responses: ReturnType<typeof textResponse>[]): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.tools.register(defineTool({
    name: 'write',
    description: 'write',
    parameters: {},
    output: { schema: { type: 'null' }, render: () => [] },
    async execute(args: { file_path: string; content: string }) {
      await writeFile(args.file_path, args.content, 'utf8')
      return null
    },
  }))
  const mock = new MockAdapter(responses)
  ctx.llm.registerAdapter(['mock'], mock)
  ;(ctx as unknown as { dshHomePath: (...s: string[]) => string }).dshHomePath =
    (...segments: string[]) => join(root, 'home', ...segments)
  ctx.provide('settings', { get: () => undefined, register: () => ({ get: () => undefined }) })
  apply(ctx)
  return ctx
}

const DOC = 'ships 42 files 〔src:ws:docs/b.md#L1-L2〕 per run.'

describe('@dsh-cc/vwa-evidence real-loop mount (§4.5)', () => {
  it('inject pin: the plugin declares every cordis service it touches (shell, §4.3)', async () => {
    const mod = await import('../src/index.ts')
    expect(mod.inject).toContain('shell')
    expect(mod.name).toBe('vwa-evidence')
  })

  it('a real edit turn writes the receipt through the live listener; the reopened log replays pending recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vwa-live-'))
    roots.push(root)
    await mkdir(join(root, 'home'), { recursive: true })
    await writeFile(join(root, 'home', 'settings.json'), JSON.stringify({ 'vwa-evidence': { enabled: true } }), 'utf8')
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'docs', 'b.md'), '# Beta\nsource line\n', 'utf8')
    await writeFile(join(root, 'docs', 'a.md'), 'placeholder', 'utf8')

    // Turn: the model writes the doc through the REAL loop, the listener
    // fires at agent/turn-stopping and appends the receipt to the ledger.
    const ctx = await mount(root, [
      toolCallResponse('call_w', 'write', { file_path: join(root, 'docs', 'a.md'), content: DOC }) as unknown as ReturnType<typeof textResponse>,
      textResponse('updated the doc'),
    ])
    const agent = await ctx.agentLoop.create(SessionId('vwa-live-1'), { provider: 'mock', model: 'mock' }, { cwd: root })
    await turn(agent, 'update docs/a.md please')
    await ctx.sessions.flush(agent.session)
    const ledger = receiptLedgerPath(join(root, 'home'), 'vwa-live-1')
    const text = await readFile(ledger, 'utf8')
    const rows = text.trim().split('\n').map(line => JSON.parse(line))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.artifactId).toBe('docs/a.md')
    expect(rows[0]!.gates).toHaveLength(3)

    // Reopen the REAL log (fresh persistence stack) and replay it into a
    // FRESH evaluator state (a restart): the replayed session events plus
    // the on-disk ledger drive pending recovery — a post-restart edit to the
    // artifact (stale hash) re-enters evaluation and a second receipt lands.
    const ctx2 = new Context()
    await ctx2.plugin(JsonlSessionPersistence, { root })
    const reader = await ctx2.sessionPersistence.open(SessionId('vwa-live-1'), 'read')
    let replayed: EvalEvent[]
    try {
      replayed = (await reader.read()).events as EvalEvent[]
    } finally {
      await reader.close()
    }
    const replayAgent = { session: { header: { id: 'vwa-live-1' }, snapshotEvents: () => replayed } }
    await writeFile(join(root, 'docs', 'a.md'), `${DOC} updated again.`, 'utf8')
    expect(await evaluateTurnStopping({
      agent: replayAgent as never, turn: 1, settings: DEFAULT_VWA_EVIDENCE_SETTINGS,
      workspaceRoot: root, exec: async () => ({ code: 0, stdout: '', stderr: '' }),
      dshHome: join(root, 'home'), state: createEvaluatorState(), debug: () => {},
    })).toEqual({ action: 'receipts', receipts: 1 })
    const rowsAfter = (await readFile(ledger, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(rowsAfter).toHaveLength(2)
    expect(rowsAfter[1]!.artifactHash).not.toBe(rowsAfter[0]!.artifactHash)
  }, 30_000)
})
