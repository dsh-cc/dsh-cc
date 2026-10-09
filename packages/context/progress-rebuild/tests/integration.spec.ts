/**
 * Integration (spec slice 2): the REAL plugin mounted on a testkit context
 * with a real AgentLoop agent. Synthetic session events (goal/change, todo
 * write, bash call/result with an `[exit code: 0]` marker, a genuine user
 * message) feed the firehose listener; a successful `compaction/end` injects
 * the brief into `agent.inbox.nextStep` with `source.kind
 * = 'progress-rebuild'` and lands one sidecar JSON line; an error-carrying
 * `compaction/end` injects nothing and writes no sidecar line.
 * Self-pollution: the brief's own user/message fed back through the reducer
 * leaves `lastUser*` unchanged.
 *
 * @module
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply } from '../src/index.ts'
import { applyEvent, createShadow } from '../src/shadow.ts'
import { BRIEF_TITLE, NOT_VERIFIED_WARNING } from '../src/brief.ts'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** Scratch under the repo workspace — never /tmp. */
async function workspace(): Promise<string> {
  const scratch = join(process.cwd(), '.scratch')
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, 'progress-rebuild-'))
  roots.push(root)
  return root
}

/** Boot the testkit with the real plugin mounted; $DSH_HOME → a temp dir. */
async function boot(id: string): Promise<{ agent: Agent; session: Session; home: string }> {
  const home = await workspace()
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  ;(ctx as unknown as { dshHomePath: (...segments: string[]) => string }).dshHomePath
    = (...segments: string[]) => join(home, ...segments)
  apply(ctx)
  const agent = await ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' }, { cwd: home })
  return { agent, session: agent.session, home }
}

/** Append a synthetic event whose type comes from a plugin augmentation not loaded here. */
function appendRaw(session: Session, type: string, data: unknown, opts?: unknown): SessionEvent {
  return (session.append as (...args: unknown[]) => SessionEvent)(type, data, ...(opts ? [opts] : []))
}

const GOAL_CREATE = { kind: 'goal/change', version: 1, operation: 'create', goal: { objective: 'ship slice 2', phase: 'active' } }

function feed(session: Session): void {
  appendRaw(session, 'goal/change', GOAL_CREATE)
  appendRaw(session, 'todo/write', { todos: [{ content: 'wire the plugin', status: 'in_progress' }, { content: 'add tests', status: 'pending' }] })
  appendRaw(session, 'tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: JSON.stringify({ command: 'node_modules/.bin/vitest run packages/context/progress-rebuild' }) })
  appendRaw(session, 'tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: 'call-1', content: [{ type: 'text', text: 'Test Files  3 passed\n[exit code: 0]' }], isError: false }) }, { surfaceOp: 'append' })
  appendRaw(session, 'user/message', createUserMessage({ content: [{ type: 'text', text: 'finish slice 2 and report the counts' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

function sidecarPath(home: string, id: string): string {
  return join(home, 'progress-rebuild', `${id}.jsonl`)
}

describe('@dsh-cc/progress-rebuild integration', () => {
  it('successful compaction/end injects the brief into inbox.nextStep and writes one sidecar line', async () => {
    const { agent, session, home } = await boot('progress-rebuild-it-1')
    feed(session)

    // Before the boundary: nothing pending.
    expect(agent.inbox.nextStep).toHaveLength(0)
    await expect(readFile(sidecarPath(home, 'progress-rebuild-it-1'), 'utf8')).rejects.toThrow()

    appendRaw(session, 'compaction/end', { compactionId: 'comp-1', turn: 1 })
    await vi.waitFor(async () => {
      expect(await sidecarLines(home, 'progress-rebuild-it-1')).toBe(1)
    }, { timeout: 5_000 })

    const brief = agent.inbox.nextStep.find((message) => (message.source as { kind?: string }).kind === 'progress-rebuild')
    expect(brief).toBeDefined()
    const text = (brief!.content.find((block) => block.type === 'text') as { text: string }).text
    expect(text).toContain(BRIEF_TITLE)
    expect(text).toContain('- Goal: ship slice 2')
    expect(text).toContain('tests green (vitest) [bash ok]')
    expect(text).toContain(NOT_VERIFIED_WARNING)

    // Exactly one sidecar line: one JSON object with ts/bytes/sections.
    const lines = (await readFile(sidecarPath(home, 'progress-rebuild-it-1'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(1)
    const entry = JSON.parse(lines[0]) as Record<string, unknown>
    expect(typeof entry.ts).toBe('number')
    expect(entry.bytes).toBe(Buffer.byteLength(text, 'utf8'))
    expect(entry.sections).toBe(text.split('\n').length)
  }, 15_000)

  it('an error-carrying compaction/end injects nothing and writes no sidecar line', async () => {
    const { agent, session, home } = await boot('progress-rebuild-it-2')
    feed(session)
    appendRaw(session, 'compaction/end', { compactionId: 'comp-2', turn: 1, error: 'boom' })
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(agent.inbox.nextStep).toHaveLength(0)
    await expect(readFile(sidecarPath(home, 'progress-rebuild-it-2'), 'utf8')).rejects.toThrow()
  }, 15_000)

  it('self-pollution: the injected brief kind is inert to the reducer', () => {
    const seed = createUserMessage({ content: [{ type: 'text', text: 'the real instruction' }], source: { kind: 'user' } })
    let shadow = applyEvent(createShadow(), { type: 'user/message', seq: 0, time: 1, data: seed } as unknown as SessionEvent)
    expect(shadow.lastUserText).toBe('the real instruction')

    const brief = createUserMessage({ content: [{ type: 'text', text: '## Resume after compaction …' }], source: { kind: 'progress-rebuild' } })
    const next = applyEvent(shadow, { type: 'user/message', seq: 1, time: 2, data: brief } as unknown as SessionEvent)
    expect(next.lastUserText).toBe('the real instruction')
    expect(next.lastUserTs).toBe(1)
    // Pure: the input shadow is untouched.
    expect(shadow.lastUserTs).toBe(1)
    shadow = next
  })
})

async function sidecarLines(home: string, id: string): Promise<number> {
  const { readFile } = await import('node:fs/promises')
  return (await readFile(sidecarPath(home, id), 'utf8')).trim().split('\n').length
}
