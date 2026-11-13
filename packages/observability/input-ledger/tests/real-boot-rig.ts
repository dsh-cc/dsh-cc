/**
 * Shared real-boot rig for the input-ledger integration legs: the real agent
 * loop (`JsonlSessionPersistence` + MockAdapter) behind a temp `DSH_HOME`,
 * cache-health mounted as the co-tenant `llm/stream` observer, and the input
 * ledger mounted through its public `mountInputLedger` entry point.
 *
 * Kept out of `tests/**\/*.spec.ts` on purpose: the vitest `include` globs
 * collect only `*.spec.ts`, so this module is a plain helper, never a suite.
 *
 * Settle strategy: the sink append is detached by contract, so every leg
 * settles by bounded polling of the sidecar files (10 s cap) — it cannot hang.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type GenerateOptions, type LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse } from '@dsh-cc/agent-loop-mock'
import * as cacheHealth from '@dsh-cc/cache-health'
import {
  mountInputLedger,
  readAssembleRows,
  readRequestRows,
  type AssembleRow,
  type LedgerRow,
  type RequestRow,
} from '../src/index.ts'

const reasoning: LlmModelReasoningInfo = {
  efforts: [{ id: 'off', name: 'off' }, { id: 'high', name: 'high' }],
}

/** Temp roots created by the calling spec, removed by {@link cleanupRoots}. */
const roots: string[] = []

/** Remove every temp root this rig created (spec `afterEach`). */
export function cleanupRoots(): void {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

function newRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `dsh-input-ledger-${prefix}-`))
  roots.push(root)
  return root
}

/**
 * One home + workdir pair. The A/B leg renders the same system prompt twice,
 * and that prompt embeds the workspace path, so the pair must be shared.
 */
export interface SharedRoots {
  home: string
  workdir: string
}

/** A fresh home with its own workspace subdirectory. */
export function newSharedRoots(): SharedRoots {
  const home = newRoot('home')
  return { home, workdir: mkdtempSync(join(home, 'work-')) }
}

/** Bounded settle: poll until `predicate` returns a value, else throw (never hang). */
export async function waitFor<T>(
  predicate: () => T | undefined | Promise<T | undefined>,
  what: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** Every JSONL file under one sidecar directory, recursing into project buckets. */
export function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(full))
    else if (entry.name.endsWith('.jsonl')) out.push(full)
  }
  return out
}

/** Parse one JSONL file, skipping a torn final line (sidecar-io contract). */
export function readJsonl(file: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.length === 0) continue
    try {
      out.push(JSON.parse(line) as Record<string, unknown>)
    } catch {
      // torn final write; readers tolerate it
    }
  }
  return out
}

/** One booted agent loop plus the handles a leg asserts on. */
export interface Boot {
  ctx: Context
  home: string
  workdir: string
  sessionId: SessionId
  agent: Agent
  /** The adapter's own record of every request the loop actually issued. */
  requests: GenerateOptions[]
  /** Release handle of the ledger mount (only when the ledger was mounted). */
  release?: () => void
}

/**
 * Boot the real agent loop with the JSONL persistence backend, cache-health,
 * and (optionally) the input ledger, then run three user turns through the
 * MockAdapter — three main-loop model requests plus the assemble steps that
 * precede them.
 *
 * @param withLedger - mount the input ledger before the first request.
 * @param shared - home + workspace pair; pass the same one to A/B legs.
 * @param turns - number of user turns to run before returning.
 */
export async function bootAndRun(
  withLedger: boolean,
  shared: SharedRoots = newSharedRoots(),
  turns = 3,
): Promise<Boot> {
  const { home, workdir } = shared
  const ctx = new Context()
  // The boot-provided resolver: `mountInputLedger` reads it for the ledger
  // root and for the hot re-read of <home>/settings.json.
  ctx.dshHomePath = (...segments: string[]) => join(home, ...segments)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(JsonlSessionPersistence, { root: newRoot('transcript') })
  // cache-health injects ['commands', 'sessions']: the session store comes
  // from the agent-loop dependency set, the command runtime is mounted here.
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(cacheHealth, { enabled: true })
  const release = withLedger ? mountInputLedger(ctx) : undefined
  // Script a few spare responses: a leg may drive further turns after the
  // boot (e.g. to prove that a released mount emits nothing).
  const script = ['one', 'two', 'three', 'four', 'five'].map(text => textResponse(text))
  const adapter = new MockAdapter(script, reasoning)
  ctx.llm.registerAdapter(['mock'], adapter)

  const sessionId = SessionId(`input-ledger-${withLedger ? 'on' : 'off'}-${Date.now()}`)
  const agent = await ctx.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' }, { cwd: workdir })
  for (let index = 0; index < turns; index++) {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: `turn ${index}` }], source: { kind: 'user' } }))
    await agent.whenIdle()
  }
  return { ctx, home, workdir, sessionId, agent, requests: adapter.requests, release }
}

/** One session's ledger rows, read back through the package's own readers. */
export async function ledgerRowsOf(home: string): Promise<{
  requests: RequestRow[]
  assembles: AssembleRow[]
  all: LedgerRow[]
}> {
  const dir = join(home, 'input-ledger')
  const files = await waitFor(
    () => (filesUnder(dir).length > 0 ? filesUnder(dir) : undefined),
    'an input-ledger file',
  )
  const requests: RequestRow[] = []
  const assembles: AssembleRow[] = []
  for (const file of files) {
    for await (const row of readRequestRows(file)) requests.push(row)
    for await (const row of readAssembleRows(file)) assembles.push(row)
  }
  // Reader output is per-type; the file also holds rows of other types (docs
  // 1/7 share it), so `all` is only the two types this package emits today.
  return { requests, assembles, all: [...requests, ...assembles] }
}

/** cache-health rows of one session, flattened over its project buckets. */
export function cacheHealthRowsOf(home: string, sessionId: SessionId): Array<Record<string, unknown>> {
  const dir = join(home, 'cache-health')
  const rows: Array<Record<string, unknown>> = []
  for (const file of filesUnder(dir)) {
    if (!file.endsWith(`${String(sessionId)}.jsonl`)) continue
    rows.push(...readJsonl(file))
  }
  return rows
}
