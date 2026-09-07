import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import CommandRuntime, { type CommandResult } from '@deepseek-ai/dsh-commands'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import * as commandExport from '@dsh-cc/command-export'
import {
  contentText,
  renderJson,
  renderMarkdown,
  renderTranscript,
} from '@dsh-cc/command-export/transcript'
import { parseExport, resolveOutput } from '@dsh-cc/command-export'

let tempDir: string | undefined

afterAll(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
})

function ev(type: string, data: unknown, seq: number): SessionEvent {
  return Object.freeze({ seq, time: seq * 10, type, data }) as SessionEvent
}

function user(seq: number, text: string): SessionEvent {
  return ev('user/message', {
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
    surfaceOp: 'append',
  }, seq)
}

function assistant(seq: number, text: string): SessionEvent {
  return ev('assistant/message', {
    turn: 1, step: 1,
    message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text }] },
    surfaceOp: 'append',
  }, seq)
}

function toolResult(seq: number, name: string): SessionEvent {
  return ev('tool/result', {
    turn: 1, step: 1,
    message: { role: 'tool', source: { name, callId: `call-${seq}` }, content: [{ type: 'tool-result', text: 'ok', value: {} }] },
    surfaceOp: 'append',
  }, seq)
}

function boundary(seq: number): SessionEvent {
  return ev('turn/start', { turn: 0 }, seq)
}

/** Mount the real command registry, local filesystem, and session store. */
async function harness(overrides: unknown): Promise<{
  ctx: Context
  agent: Agent
  session: Session
  plugin: Awaited<ReturnType<Context['plugin']>>
  config: { defaultDir: string }
}> {
  tempDir = await mkdtemp(join(tmpdir(), 'command-export-'))
  const config = { defaultDir: tempDir, ...(overrides as object) }
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  const plugin = await ctx.plugin(commandExport, config)
  const session = ctx.sessions.create(SessionId(`command-export-${Math.random()}`))
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
  return { ctx, agent, session, plugin, config }
}

async function run(test: Awaited<ReturnType<typeof harness>>, suffix = ''): Promise<CommandResult> {
  const execution = await test.ctx.commands.execute(
    test.agent,
    `/export${suffix}`,
    [],
    new AbortController().signal,
  )
  if (execution === undefined) throw new Error('export command was not registered')
  return execution.result
}

describe('@dsh-cc/command-export registration', () => {
  it('registers one global command with Loader-safe exports and disposes it', async () => {
    expect(commandExport.name).toBe('command-export')
    expect(commandExport.inject).toEqual(['commands', 'fs'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandExport)).toBe(commandExport)
    const test = await harness({})
    expect(test.ctx.commands.find(test.agent, 'export')).toBeDefined()
    await test.plugin.dispose()
    expect(test.ctx.commands.find(test.agent, 'export')).toBeUndefined()
  })
})

describe('/export argument parsing', () => {
  it('defaults to markdown with no path', () => {
    expect(parseExport('')).toEqual({ format: 'markdown', path: undefined })
    expect(parseExport('  json ')).toEqual({ format: 'json', path: undefined })
    expect(parseExport('json /tmp/out')).toEqual({ format: 'json', path: '/tmp/out' })
    expect(parseExport('/tmp/out.json')).toEqual({ format: 'markdown', path: '/tmp/out.json' })
  })
  it('resolves default dir and file name when no path is supplied', () => {
    const out = resolveOutput({ defaultDir: '/a/b' }, { format: 'markdown', path: undefined }, 'sess-1')
    expect(out).toEqual({ dir: '/a/b', name: 'transcript-sess-1.md' })
  })
  it('appends the format extension and honors an existing directory part', () => {
    expect(resolveOutput({ defaultDir: '/def' }, { format: 'json', path: '/x/y' }, 's'))
      .toEqual({ dir: '/x', name: 'y.json' })
    expect(resolveOutput({ defaultDir: '/def' }, { format: 'markdown', path: '/x/f.md' }, 's'))
      .toEqual({ dir: '/x', name: 'f.md' })
    expect(resolveOutput({ defaultDir: '/def' }, { format: 'markdown', path: '/x/' }, 's'))
      .toEqual({ dir: '/x', name: 'transcript-s.md' })
  })
})

describe('/export transcript rendering', () => {
  it('renders an empty session with the no-events placeholder', () => {
    const md = renderMarkdown([boundary(1)], 's1')
    expect(md).toContain('# Session transcript: s1')
    expect(md).toContain('_No conversation events recorded yet._')
  })
  it('renders markdown sections for user, assistant, and tool events', () => {
    const events = [user(1, 'hello'), assistant(2, 'hi there'), toolResult(3, 'read_file')]
    const md = renderMarkdown(events, 's1')
    expect(md).toContain('## User\n\nhello')
    expect(md).toContain('## Assistant\n\nhi there')
    expect(md).toContain('## Tool')
    expect(md).not.toContain('No conversation events')
  })
  it('renders lossless JSON of the raw event log', () => {
    const events = [user(1, 'hello')]
    const json = renderJson(events)
    const parsed = JSON.parse(json) as readonly SessionEvent[]
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.type).toBe('user/message')
  })
  it('switches format through the combined renderer', () => {
    const events = [user(1, 'hello')]
    expect(renderTranscript(events, 'json', 's').startsWith('[')).toBe(true)
    expect(renderTranscript(events, 'markdown', 's')).toContain('# Session transcript')
  })
  it('extracts text from content blocks and falls back to JSON for opaque blocks', () => {
    expect(contentText([{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'b' }])).toBe('a\nb')
    expect(contentText([{ type: 'image', attachment: {} as never }])).toContain('{')
  })
})

describe('/export human command', () => {
  it('writes a markdown transcript to the default directory and reports the path', async () => {
    const test = await harness({})
    test.session.append('user/message', {
      id: MessageId('m1'),
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'hi' }],
    }, { surfaceOp: 'append' })
    const result = await run(test)
    expect(result.kind).toBe('success')
    expect(result.text).toContain('transcript-')
    const file = join(test.config.defaultDir, `transcript-${test.session.id}.md`)
    const content = await readFile(file, 'utf8')
    expect(content).toContain('## User\n\nhi')
    const info = await stat(file)
    expect(info.size).toBeGreaterThan(0)
  })
  it('writes a json transcript to a supplied explicit path', async () => {
    const test = await harness({})
    test.session.append('user/message', {
      id: MessageId('m1'),
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'hi' }],
    }, { surfaceOp: 'append' })
    const result = await run(test, ' json custom-export')
    expect(result.kind).toBe('success')
    const parsed = JSON.parse(await readFile(join(test.config.defaultDir, 'custom-export.json'), 'utf8')) as readonly SessionEvent[]
    const userEvents = parsed.filter(event => event.type === 'user/message')
    expect(userEvents).toHaveLength(1)
    expect(userEvents[0]).toMatchObject({ type: 'user/message' })
  })
})


describe('/export trailing help request', () => {
  it('answers `/export help` with the rendered usage text, not a model turn', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(commandExport)
  const session = ctx.sessions.create(SessionId(`export-${Math.random()}`))
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
  return agent
    const execution = await ctx.commands.execute(agent, '/export help', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('/export')
    expect(text).toContain('Usage:')
    expect(text).toContain('json')
    expect(text).toContain('path')
  })
})
