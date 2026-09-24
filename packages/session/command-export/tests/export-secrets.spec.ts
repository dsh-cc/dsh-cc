/**
 * C2 canary spec: /export output always carries one-way secret redaction —
 * built-in patterns and hot-reloaded `cc-secrets` extraPatterns. Real
 * composition: the real command-export plugin over the real command runtime
 * and local filesystem; only settings are a provider double.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, Session } from '@deepseek-ai/dsh-session'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import * as commandExport from '../src/index.ts'

const CANARY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJ'

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir) { await rm(tempDir, { recursive: true, force: true }); tempDir = undefined }
})

/** Minimal settings provider double (settings-ns unit.spec shape). */
function fakeProvider(resolved: Record<string, unknown>) {
  const registrations = new Set<string>()
  return {
    register(ns: string) { registrations.add(ns) },
    get(ns: string) { return registrations.has(ns) ? structuredClone(resolved) : undefined },
  }
}

/** Mount the real command registry, local filesystem, and session store. */
async function harness(settings?: Record<string, unknown>): Promise<{
  ctx: Context
  session: Session
  defaultDir: string
}> {
  tempDir = await mkdtemp(join(tmpdir(), 'command-export-secrets-'))
  const ctx = new Context()
  if (settings !== undefined) ctx.provide('settings', fakeProvider(settings))
  await ctx.plugin(SessionStore)
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(commandExport, { defaultDir: tempDir })
  const session = ctx.sessions.create(SessionId(`export-secrets-${Math.random()}`))
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
  ctx.agents.register(agent)
  void ctx.agents
  return { ctx, session, defaultDir: tempDir }
}

async function run(test: { ctx: Context; session: Session }, suffix = ''): Promise<CommandResult> {
  const agent: Agent = {
    id: test.session.id,
    options: {},
    session: test.session,
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
  const execution = await test.ctx.commands.execute(
    agent,
    `/export${suffix}`,
    [],
    new AbortController().signal,
  )
  if (execution === undefined) throw new Error('export command was not registered')
  return execution.result
}

describe('/export secret redaction (C2 canary)', () => {
  it('redacts a pasted Anthropic key from the exported markdown file', async () => {
    const test = await harness()
    test.session.append('user/message', {
      id: MessageId('m1'),
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: `my key ${CANARY} keep this` }],
    }, { surfaceOp: 'append' })
    const result = await run(test)
    expect(result.kind).toBe('success')
    const content = await readFile(join(test.defaultDir, `transcript-${test.session.id}.md`), 'utf8')
    expect(content).toContain('my key [REDACTED] keep this')
    expect(content).not.toContain(CANARY)
  })

  it('applies live cc-secrets extraPatterns on every export (hot reload)', async () => {
    const test = await harness({ extraPatterns: ['x-cust-[a-j]{10}'], redactCrusherStore: true })
    test.session.append('user/message', {
      id: MessageId('m1'),
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'id x-cust-abcdefghij' }],
    }, { surfaceOp: 'append' })
    await run(test)
    const content = await readFile(join(test.defaultDir, `transcript-${test.session.id}.md`), 'utf8')
    expect(content).toContain('id [REDACTED]')
  })
})
