import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { canonicalMemoryRoot, projectSlug } from '@dsh-cc/memory'
import * as commandLearn from '@dsh-cc/command-learn'
import { LEARN_SETTINGS_NAMESPACE, parseLearn, renderBlock, resolveOptions, sessionsProjectKey } from '@dsh-cc/command-learn'
import type { ForensicsResult } from '@dsh-cc/session-forensics'

// --- fixture helpers -------------------------------------------------------

const HAS_ZSTD = (() => {
  try {
    execFileSync('zstd', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

let homeDir: string

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'command-learn-'))
  process.env.DSH_HOME = homeDir
})

afterAll(async () => {
  delete process.env.DSH_HOME
  if (homeDir) rmSync(homeDir, { recursive: true, force: true })
})

/** One session stream: a failed read then a corrected read (path-correlation fuel). */
function findingLines(): string {
  const call = (callId: string, path: string) => JSON.stringify({
    type: 'tool/call',
    data: { turn: 1, step: 1, callId, name: 'read', arguments: JSON.stringify({ file_path: path }) },
  })
  const result = (callId: string, text: string, isError: boolean) => JSON.stringify({
    type: 'tool/result',
    data: { message: { source: { callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError }] } },
  })
  return [
    JSON.stringify({ type: 'session', ts: Date.now(), data: { origin: 'user', delegationDepth: 0 } }),
    call('c1', '/a/config.json'), result('c1', 'ENOENT: no such file or directory', true),
    call('c2', '/b/config.json'), result('c2', `read /b/config.json ok`, false),
  ].join('\n')
}

/** Seed a fixture project session (zstd-compressed real JSONL) and return its dir. */
function seedSession(project: string, id: string, lines: string): string {
  const dir = join(homeDir, 'sessions', project, id)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.jsonl.zstd')
  if (HAS_ZSTD) execFileSync('zstd', ['-f', '-o', file], { input: lines })
  else writeFileSync(file, lines)
  return dir
}

class MemorySettings extends SettingsProvider {
  readonly doc: Record<string, unknown> = {}
  readonly writable = true
  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }
  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

async function harness(withSettings = false): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  if (withSettings) await ctx.plugin(MemorySettings)
  await ctx.plugin(commandLearn)
  const session = ctx.sessions.create(SessionId(`command-learn-${Math.random()}`))
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
  return { ctx, agent }
}

async function run(test: Awaited<ReturnType<typeof harness>>, suffix = ''): Promise<string> {
  const execution = await test.ctx.commands.execute(test.agent, `/learn${suffix}`, [], new AbortController().signal)
  if (execution === undefined) throw new Error('learn command was not registered')
  const result = execution.result
  expect(result.kind).toBe('success')
  return result.text ?? ''
}

// Two sessions in the current project, one elsewhere, all with the same
// corrected-path pattern → 2 aggregate occurrences (meets default threshold).
const PROJECT = sessionsProjectKey(process.cwd())

describe('@dsh-cc/command-learn registration', () => {
  it('registers one global command with Loader-safe exports', async () => {
    expect(commandLearn.name).toBe('command-learn')
    expect(commandLearn.inject).toEqual(['commands', 'fs'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandLearn)).toBe(commandLearn)
    const test = await harness()
    expect(test.ctx.commands.find(test.agent, 'learn')).toBeDefined()
  })
  it('answers /learn help without running forensics', async () => {
    const test = await harness()
    const text = await run(test, ' help')
    expect(text).toContain('/learn')
    expect(text).toContain('apply')
    expect(existsSync(join(homeDir, 'sessions'))).toBe(false)
  })
})

describe('/learn argument parsing', () => {
  it('parses bare as dry-run, current project only', () => {
    expect(parseLearn('')).toEqual({ apply: false, all: false, days: undefined, invalid: undefined })
  })
  it('parses apply / all / days=N and flags unknown tokens', () => {
    expect(parseLearn('apply all days=30')).toEqual({ apply: true, all: true, days: 30, invalid: undefined })
    expect(parseLearn('bogus')).toEqual({ apply: false, all: false, days: undefined, invalid: 'bogus' })
    expect(parseLearn('days=x').invalid).toBe('days=x')
  })
  it('derives the harness project key with the --slug-- wrapper', () => {
    expect(sessionsProjectKey('/a/b')).toMatch(/^--.+--$/)
  })
})

describe('/learn dry-run', () => {
  it('renders ranked findings and the proposed block, writing nothing', async () => {
    const project = PROJECT
    seedSession(project, 's1', findingLines())
    seedSession(project, 's2', findingLines())
    const test = await harness()
    const text = await run(test)
    expect(text).toContain('1 finding(s)')
    expect(text).toContain('prefer /b/ over /a for config.json (2 occurrences)')
    expect(text).toContain('<!-- dsh-cc:learn:start -->')
    expect(text).toContain('Proposed session-learnings.md block')
    expect(existsSync(join(homeDir, 'memory'))).toBe(false)
  })
  it('reports an empty store cleanly', async () => {
    const test = await harness()
    const text = await run(test)
    expect(text).toContain('0 session(s)')
  })
})

describe('/learn apply', () => {
  it('writes the topic file and MEMORY.md pointer through the real writeback path', async () => {
    const project = PROJECT
    seedSession(project, 's1', findingLines())
    seedSession(project, 's2', findingLines())
    const test = await harness()
    const text = await run(test, ' apply')
    expect(text).toContain('Wrote 1 learning(s)')
    // The memory directory is keyed by the canonical GIT root slug (worktree
    // collapse), not the sessions-store project key.
    const memoryDir = join(homeDir, 'memory', 'projects', projectSlug(canonicalMemoryRoot(process.cwd())))
    const topic = readFileSync(join(memoryDir, 'session-learnings.md'), 'utf8')
    expect(topic).toContain('name: session-learnings')
    expect(topic).toContain('<!-- dsh-cc:learn:start -->')
    expect(topic).toContain('prefer /b/ over /a for config.json')
    const pointer = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8')
    expect(pointer).toContain('[session-learnings](session-learnings.md)')
  })
  it('no-ops (writes nothing) when findings are empty', async () => {
    seedSession(PROJECT, 's1', findingLines())
    const test = await harness()
    const text = await run(test, ' apply')
    expect(text).toContain('no findings — existing session-learnings.md left untouched')
    expect(existsSync(join(homeDir, 'memory'))).toBe(false)
  })
  it('`all` scans other projects too; default filter excludes them', async () => {
    seedSession(PROJECT, 's1', findingLines())
    seedSession('--elsewhere--', 's1', findingLines())
    const test = await harness()
    expect(await run(test, ' apply')).toContain('no findings')
    const text = await run(test, ' apply all')
    expect(text).toContain('Wrote 1 learning(s)')
  })
})

describe('settings integration (cc-learn)', () => {
  it('respects enabled=false with a notice and no write', async () => {
    seedSession(PROJECT, 's1', findingLines())
    seedSession(PROJECT, 's2', findingLines())
    const test = await harness(true)
    await test.ctx.settings.update(LEARN_SETTINGS_NAMESPACE, { enabled: false })
    const text = await run(test, ' apply')
    expect(text).toContain('disabled')
    expect(existsSync(join(homeDir, 'memory'))).toBe(false)
  })
  it('applies min-occurrences from settings (3 hides 2-occurrence findings, 1 shows 1)', async () => {
    seedSession(PROJECT, 's1', findingLines())
    seedSession(PROJECT, 's2', findingLines())
    const test = await harness(true)
    await test.ctx.settings.update(LEARN_SETTINGS_NAMESPACE, { 'min-occurrences': 5 })
    expect(await run(test, ' apply')).toContain('no findings')
    await test.ctx.settings.update(LEARN_SETTINGS_NAMESPACE, { 'min-occurrences': 1 })
    expect(await run(test, ' apply')).toContain('Wrote 1 learning(s)')
  })
})

describe('block renderer', () => {
  const result: ForensicsResult = {
    findings: [{
      kind: 'path-correlation',
      title: 'prefer /b/ over /a for config.json',
      detail: 'read /b/config.json instead',
      occurrences: 3,
      evidence: ['session:s1#turn=2'],
    }],
    stats: { sessionsScanned: 2, linesParsed: 10, corruptLinesSkipped: 0, truncatedTails: 0, sessionsByPolicyNever: 0 },
  }
  it('is deterministic and keeps the description stable (no count/date churn)', async () => {
    const one = renderBlock(result, '2026-09-10')
    expect(one).toBe(renderBlock(result, '2026-09-10'))
    expect(one).toContain('_Last run: 2026-09-10 — 2 session(s) scanned._')
    expect(one).toContain('- **prefer /b/ over /a for config.json** (3 occurrences)')
    const { LEARNING_DESCRIPTION } = await import('@dsh-cc/command-learn')
    expect(LEARNING_DESCRIPTION).not.toMatch(/\d/)
  })
  it('resolves options with CLI override winning over settings', () => {
    expect(resolveOptions(undefined, parseLearn(''))).toEqual({ days: 14, minOccurrences: 2 })
    expect(resolveOptions({ days: 7 }, parseLearn(''))).toEqual({ days: 7, minOccurrences: 2 })
    expect(resolveOptions({ days: 7, 'min-occurrences': 3 }, parseLearn('days=30')))
      .toEqual({ days: 30, minOccurrences: 3 })
  })
})
