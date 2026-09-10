import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import * as cacheHealth from '@dsh-cc/cache-health'

/** Real preset-style composition: real session store + command runtime, a stub
 * dshHomePath pointing into a temp DSH_HOME, and llm/stream waterfall dispatch
 * standing in for the (provider-ful) llm runtime. */
async function composed() {
  const home = mkdtempSync(join(tmpdir(), 'cache-health-'))
  const ctx = new Context()
  ctx.dshHomePath = (...segments: string[]) => join(home, ...segments)
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  const plugin = await ctx.plugin(cacheHealth, { enabled: true })
  const session = ctx.sessions.create(SessionId(`cache-health-${Math.random()}`), {
    meta: { cwd: home },
  })
  return { ctx, plugin, session, home }
}

function callOptions(sessionId: string, system: string): GenerateOptions {
  return {
    provider: 'deepseek',
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hi' }] as GenerateOptions['messages'],
    system,
    sessionId: sessionId as GenerateOptions['sessionId'],
  } as GenerateOptions
}

/** Dispatch llm/stream the way the harness llm runtime does (waterfall). */
async function drive(ctx: Context, options: GenerateOptions): Promise<void> {
  const next = () => (async function* generated() { /* stub adapter: no chunks needed */ })() as never
  await (ctx as any).waterfall(null, 'llm/stream', options, next)
}

/** Poll until the floating ledger append lands (max ~2s). */
async function settle(projectDir: string, sessionId: string, minLines: number): Promise<string[]> {
  const file = join(projectDir, `${String(sessionId)}.jsonl`)
  for (let i = 0; i < 100; i++) {
    try {
      const lines = readFileSync(file, 'utf8').trim().split('\n')
      if (lines.length >= minLines && lines[0] !== '') return lines
    } catch {
      // not written yet
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`ledger file ${file} never reached ${minLines} rows`)
}

/** The ledger's project dir: shortHash(session cwd) — the plugin's own keying. */
function projectDirOf(home: string): string {
  const key = createHash('sha256').update(home, 'utf8').digest('hex').slice(0, 16)
  return join(home, 'cache-health', key)
}

describe('@dsh-cc/cache-health composition', () => {
  it('registers the /cache-health command and writes ledger rows across two calls', async () => {
    const { ctx, plugin, session, home } = await composed()
    await drive(ctx, callOptions(String(session.id), 'sys-a'))
    await drive(ctx, callOptions(String(session.id), 'sys-b'))

    const projectDir = projectDirOf(home)
    const lines = await settle(projectDir, session.id, 2)
    const rows = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(rows.prefixChanged).toBe(false) // first row: no prior
    const second = JSON.parse(lines[1]!) as Record<string, unknown>
    expect(second.prefixChanged).toBe(true)
    expect(second.driftSegmentIndex).toBe(0)
    expect(second.driftExcerpt).toContain('sys-b')
    expect(rows.provider).toBe('deepseek')
    await plugin.dispose()
  })

  it('skips purpose:compaction calls entirely', async () => {
    const { ctx, plugin, session, home } = await composed()
    await drive(ctx, callOptions(String(session.id), 'sys-a'))
    await drive(ctx, { ...callOptions(String(session.id), 'compacted'), purpose: 'compaction' })

    const projectDir = projectDirOf(home)
    const lines = await settle(projectDir, session.id, 1)
    expect(lines).toHaveLength(1)
    await plugin.dispose()
  })

  it('answers /cache-health through the real command runtime', async () => {
    const { ctx, plugin, session, home } = await composed()
    await drive(ctx, callOptions(String(session.id), 'sys-a'))
    await settle(projectDirOf(home), session.id, 1)
    const agent = {
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
      runMaintenance: (task: (signal: AbortSignal) => void) => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    ctx.agents.register(agent as never)
    const execution = await ctx.commands.execute(agent as never, '/cache-health', [], new AbortController().signal)
    expect(execution?.result).toMatchObject({ kind: 'success' })
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('Current stable prefix')

    await plugin.dispose()
  })
})
