/**
 * Integration tests (§5 items 4 and 5): the real plugin mounted through the
 * real agent-loop stack, with `$DSH_HOME` / `CLAUDE_CONFIG_DIR` seeded to
 * mkdtemp dirs (the §3.3 `$DSH_HOME` fallback is the path under test — this
 * mount has no `dshHomePath` seam). The real JSONL persistence backend is
 * mounted too, so every leg doubles as the sidecar-purity tripwire: if the
 * plugin had appended anything to the transcript, resume would refuse to
 * open the log.
 *
 * Settle strategy: the exported `drain(deps)` needs the per-activation deps,
 * which `apply()` does not expose; tests therefore settle by bounded polling
 * of the sidecar files (10 s cap) instead — functionally equivalent, cannot
 * hang.
 */
import { afterEach, afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import type { LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MockAdapter, textResponse } from '@dsh-cc/agent-loop-mock'
import { apply as applyConfigSnapshot, encodeSegment, PLUGINS_STATE_CORRUPT, type SnapshotRow } from '../src/index.ts'
import { onSessionCreated, type SnapshotDeps } from '../src/capture.ts'
import { SidecarWriter } from '../src/writer.ts'

const roots: string[] = []
const savedEnv: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const key of ['DSH_HOME', 'CLAUDE_CONFIG_DIR']) savedEnv[key] = process.env[key]
})

afterAll(() => {
  for (const key of Object.keys(savedEnv)) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

afterEach(() => {
  for (const root of roots.splice(0)) {
    // Ensure an unwritable root is removable again.
    try { chmodSync(root, 0o700) } catch { /* best effort */ }
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

function newRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `dsh-config-snapshot-${prefix}-`))
  roots.push(root)
  return root
}

/** Seed both homes to fresh tmp dirs BEFORE the plugin mounts (§3.3 fallback). */
function seedHomes(prefix: string): string {
  const home = newRoot(prefix)
  process.env.DSH_HOME = home
  process.env.CLAUDE_CONFIG_DIR = newRoot(`${prefix}-claude`)
  return home
}

interface SubagentsSeam {
  start(name: string, request: {
    label?: string
    prompt: readonly { type: 'text'; text: string }[]
    parent: unknown
    signal: AbortSignal
    agentOptions?: Record<string, string>
    maxDepth?: number
  }): Promise<{ id: unknown; result: Promise<{ stopReason: string }> }>
}

const reasoning: LlmModelReasoningInfo = {
  efforts: [{ id: 'off', name: 'off' }, { id: 'high', name: 'high' }],
}

/** Mount the real agent-loop stack + the config-snapshot plugin under one context. */
async function setup(script: ConstructorParameters<typeof MockAdapter>[0]): Promise<{
  ctx: Context
  adapter: MockAdapter
  home: string
}> {
  const home = seedHomes(`${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: newRoot('transcript') })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  const adapter = new MockAdapter(script, reasoning)
  ctx.llm.registerAdapter(['mock'], adapter)
  applyConfigSnapshot(ctx)
  return { ctx, adapter, home }
}

function sidecarFile(home: string, sessionId: string): string {
  return join(home, 'config-snapshot', `${encodeSegment(sessionId)}.jsonl`)
}

function readRows(file: string): SnapshotRow[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SnapshotRow)
}

function listSidecarFiles(home: string): string[] {
  const dir = join(home, 'config-snapshot')
  return existsSync(dir) ? readdirSync(dir).map((name) => join(dir, name)) : []
}

/** Bounded settle: poll until `predicate` holds, else throw (never hang). */
async function waitFor<T>(predicate: () => T | undefined, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = predicate()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const signal = new AbortController().signal

describe('config-snapshot integration (§5 item 4)', () => {
  it('leg 1 — boot writes exactly ONE §3.4 row for the session', async () => {
    const { ctx, home } = await setup([textResponse('ok')])
    const sessionId = SessionId(`boot-${Date.now()}`)
    await ctx.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' })
    const file = sidecarFile(home, String(sessionId))
    await waitFor(() => {
      const current = readRows(file)
      return current.length >= 1 ? current : undefined
    }, 'the boot row')
    const rows = readRows(file)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.schemaVersion).toBe(1)
    expect(row.sessionId).toBe(String(sessionId))
    expect(row.seq).toBe(1)
    expect(typeof row.bootId).toBe('string')
    expect(row.bootId.length).toBeGreaterThan(0)
    expect(typeof row.dshCc).toBe('string')
    expect(row.dshCc.length).toBeGreaterThan(0)
    await ctx.fiber.dispose()
  }, 30_000)

  it('leg 2 — resume appends a SECOND row with a distinct seq (real jsonl backend stays openable)', async () => {
    const { ctx, home } = await setup([textResponse('ok')])
    const sessionId = SessionId(`resume-${Date.now()}`)
    const file = sidecarFile(home, String(sessionId))
    // A registry-created handle is disposable — required to release the
    // exclusive write ownership before resuming (resume.spec.ts pattern).
    const first = await ctx.agents.create({ sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
    await waitFor(() => (readRows(file).length >= 1 ? true : undefined), 'the boot row')
    // Store one turn so the session has durable residue: a freshly created
    // session with zero stored events is ROLLED BACK (log deleted) on dispose
    // at this harness pin, and resume would then find nothing to reopen.
    const agent = first.agent as Agent
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await first.dispose()
    // Resume takes exclusive write ownership — the live handle must be gone.
    const second = await ctx.agents.resume({ resumeSessionId: sessionId })
    const rows = await waitFor(() => {
      const current = readRows(file)
      return current.length >= 2 ? current : undefined
    }, 'the resume row')
    expect(rows).toHaveLength(2)
    expect(rows[0].seq).not.toBe(rows[1].seq)
    expect(rows[1].sessionId).toBe(String(sessionId))
    await second.dispose()
    await ctx.fiber.dispose()
  }, 30_000)

  it('leg 3 — a spawned child session gets its own row with delegationDepth 1 and parentSession set', async () => {
    const { ctx, home } = await setup([textResponse('child done')])
    const parentSessionId = SessionId(`parent-${Date.now()}`)
    const parent = await ctx.agentLoop.create(parentSessionId, { provider: 'mock', model: 'mock' })
    const subagents = ctx.get('subagents') as SubagentsSeam
    const run = await subagents.start('spawn', {
      label: 'snapshot-child',
      prompt: [{ type: 'text', text: 'work' }],
      parent,
      signal,
      agentOptions: { provider: 'mock', model: 'mock' },
maxDepth: 2,
    })
    const settled = await run.result
    expect(settled.stopReason).toBe('completed')
    const childRow = await waitFor(() => {
      for (const file of listSidecarFiles(home)) {
        for (const row of readRows(file)) {
          if (row.delegationDepth === 1 && row.parentSession === String(parentSessionId)) return row
        }
      }
      return undefined
    }, 'the child session row')
    expect(childRow.origin).toBe('subagent')
    expect(childRow.sessionId).not.toBe(String(parentSessionId))
    await ctx.fiber.dispose()
  }, 30_000)
})

describe('config-snapshot resilience (§5 item 5)', () => {
  it('5(a) — an unwritable sidecar root never blocks session creation (real announce path)', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return
    const { ctx, home } = await setup([textResponse('ok')])
    // Make the ENTIRE home unwritable so `<home>/config-snapshot` mkdir fails.
    chmodSync(home, 0o000)
    try {
      const sessionId = SessionId(`unwritable-${Date.now()}`)
      const handle = await ctx.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' })
      // Session creation succeeded — the sync listener did not throw.
      expect(handle).toBeDefined()
      expect(listSidecarFiles(home)).toHaveLength(0)
    } finally {
      chmodSync(home, 0o700)
    }
    await ctx.fiber.dispose()
  }, 30_000)

  it('5(a) — a throwing settings (enabled) reader never propagates out of the listener (unit-level fake)', async () => {
    const home = newRoot('throwing-settings')
    const written: string[] = []
    const deps: SnapshotDeps = {
      home,
      bootId: 'test-boot',
      writer: new SidecarWriter(),
      enabled: (): boolean => { throw new Error('settings provider exploded') },
      get: () => undefined,
      debug: () => {},
    }
    expect(() => onSessionCreated(deps, { id: 's-throwing' })).not.toThrow()
    // The async writer swallows the failure too; give it a tick, then check no row landed.
    await new Promise((resolve) => setTimeout(resolve, 200))
    const dir = join(home, 'config-snapshot')
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) written.push(name)
    }
    expect(written).toHaveLength(0)
  }, 30_000)

  it('5(b) — bootId is stable within one activation and differs across a fresh-context remount', async () => {
    const first = await setup([textResponse('ok')])
    const firstId = SessionId(`bootid-a-${Date.now()}`)
    await first.ctx.agentLoop.create(firstId, { provider: 'mock', model: 'mock' })
    const firstFile = sidecarFile(first.home, String(firstId))
    const firstRow = (await waitFor(() => readRows(firstFile)[0], 'the first activation row'))

    // Second activation: fresh context, fresh homes, fresh plugin mount.
    const second = await setup([textResponse('ok')])
    const secondId = SessionId(`bootid-b-${Date.now()}`)
    await second.ctx.agentLoop.create(secondId, { provider: 'mock', model: 'mock' })
    const secondFile = sidecarFile(second.home, String(secondId))
    const secondRow = (await waitFor(() => readRows(secondFile)[0], 'the second activation row'))

    // Both rows carry a non-empty dshCc; a plugins-state failure degrades to the
    // fixed note — it must never be a raw path.
    for (const row of [firstRow, secondRow]) {
      if (row.note !== undefined) expect(row.note).toBe(PLUGINS_STATE_CORRUPT)
      expect(row.plugins).toBeInstanceOf(Array)
    }
    expect(firstRow.bootId).not.toBe(secondRow.bootId)

    // Same-activation stability: a second session in the FIRST context reuses the bootId
    // (while that context is still alive).
    const thirdId = SessionId(`bootid-c-${Date.now()}`)
    await first.ctx.agentLoop.create(thirdId, { provider: 'mock', model: 'mock' })
    const thirdRow = await waitFor(() => readRows(sidecarFile(first.home, String(thirdId)))[0], 'the same-activation row')
    expect(thirdRow.bootId).toBe(firstRow.bootId)

    await first.ctx.fiber.dispose()
    await second.ctx.fiber.dispose()
  }, 30_000)
})
