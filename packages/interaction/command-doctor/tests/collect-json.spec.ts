import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as commandDoctor from '@dsh-cc/command-doctor'
import { doctorJsonPath } from '../src/json.ts'

const savedHome = process.env.DSH_HOME

function makeAgent(ctx: Context): Agent {
  const session = ctx.sessions.create(SessionId(`doctor-json-${Math.random()}`))
  return {
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
}

async function run(flags: string): Promise<{ kind: string; text: string }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(commandDoctor)
  const agent = makeAgent(ctx)
  ctx.agents.register(agent)
  const line = flags.length === 0 ? '/doctor' : `/doctor ${flags}`
  const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
  return execution?.result as { kind: string; text: string }
}

afterEach(() => {
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
})

describe('doctor --json', () => {
  it('writes an isolated, overwriting report and prints only the ack', async () => {
    const home = mkdtempSync(join(tmpdir(), 'doctor-json-'))
    process.env.DSH_HOME = home
    const path = doctorJsonPath(process.env)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, 'stale contents', 'utf8')
    const result = await run('--json')
    expect(result.kind).toBe('success')
    expect(result.text).toContain(`doctor report written: ${path}`)
    expect(result.text).toMatch(/summary: \d+ ok/)
    expect(result.text).not.toContain('"schemaVersion"')
    const body = JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion: number; checks: unknown[] }
    expect(body.schemaVersion).toBe(1)
    expect(Array.isArray(body.checks)).toBe(true)
  })

  it('collects verbose and reports a write failure without throwing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'doctor-json-'))
    process.env.DSH_HOME = home
    // Occupy the target path with a directory so writeFile fails.
    const path = doctorJsonPath(process.env)
    mkdirSync(path, { recursive: true })
    const result = await run('--json')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('failed to write')
    expect(result.text).toMatch(/summary: \d+ ok/)
  })

  it('writes into tui/ when the directory does not exist yet', async () => {
    const home = mkdtempSync(join(tmpdir(), 'doctor-json-'))
    process.env.DSH_HOME = home
    const result = await run('--json --verbose')
    const path = doctorJsonPath(process.env)
    expect(result.text).toContain(path)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveProperty('schemaVersion', 1)
  })
})
