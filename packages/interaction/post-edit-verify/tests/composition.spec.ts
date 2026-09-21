/**
 * REAL composition specs (context-crusher / compaction-cost-gate pattern):
 * the REAL post-edit-verify plugin runs against the REAL agent loop with a
 * scripted mock MODEL — only the model is mocked. The verify command itself
 * runs through the REAL ShellExecutor rig (@deepseek-ai/dsh-bash-local +
 * dsh-subprocess-local, same as tests/runner.spec.ts's timeout probe).
 *
 * Doc docs/plans/2026-09-20-post-edit-auto-verify.md §5: an edit's own result
 * and the `[auto-verify]` outcome arrive in ONE observation (no extra model
 * round-trip); blocked and value-accept downstream skip the verify entirely;
 * a bare-accept downstream composes onto result.content; a disabled setting
 * leaves the observation byte-untouched.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, SessionEvent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { defineContentToolFixture, type PostToolDecision } from '@dsh-cc/tools'
import { MockAdapter, textResponse, toolCallResponse } from '@dsh-cc/agent-loop-mock'
import { setSessionCwd } from '@dsh-cc/session-cwd'
import * as PostEditVerify from '../src/index.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

interface Built {
  agent: Agent
  home: string
  proj: string
}

async function build(
  adapter: MockAdapter,
  opts: { settings?: Record<string, unknown>; proj?: string } = {},
): Promise<Built> {
  const home = mkdtempSync(join(tmpdir(), 'pev-comp-home-'))
  const proj = opts.proj ?? mkdtempSync(join(tmpdir(), 'pev-comp-proj-'))
  dirs.push(home, ...(opts.proj ? [] : [proj]))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({
    'cc-post-edit-verify': opts.settings ?? {
      enabled: true,
      rules: [{ glob: '**/*.ts', command: 'node -e "console.log(\'verify tail line\');process.exit(1)"' }],
      'debounce-ms': 5000,
      'max-output-bytes': 4096,
      'verbose-on-success': false,
    },
  }))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  void new TokenMeter(ctx)
  ;(ctx as unknown as { dshHomePath: (...s: string[]) => string }).dshHomePath =
    (...segments: string[]) => join(home, ...segments)
  await ctx.plugin(PostEditVerify)
  ctx.tools.register(defineContentToolFixture({
    name: 'edit',
    description: 'edit a file',
    parameters: {},
    async execute(input: { file_path?: string }) {
      return [{ type: 'text', text: `edit ok: ${input.file_path}` }]
    },
  }))
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('pev-comp'), { provider: 'mock', model: 'mock' })
  // Real session-cwd seam: the runner uses it as the verify command's workdir.
  setSessionCwd(agent, proj)
  return { agent, home, proj }
}

async function run(agent: Agent, prompt = 'edit the file'): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

function events(agent: Agent): SessionEvent[] {
  return [...agent.session.snapshotEvents()]
}

/** All committed tool/result text (context-crusher composition pattern). */
function resultTexts(agent: Agent): string[] {
  return events(agent)
    .filter((e) => e.type === 'tool/result')
    .map((e) => {
      const content = (e.data as { message: { content: { type: string; content?: { type: string; text?: string }[]; text?: string }[] } }).message.content
      return content.map((b) =>
        b.type === 'tool-result'
          ? (b.content ?? []).map((x) => x.text ?? '').join('\n')
          : b.text ?? '',
      ).join('\n')
    })
}

describe('post-edit-verify composition (real boot, real shell)', () => {
  it('ROUND TRIP: an accepted edit with a failing rule yields ONE observation carrying both the edit result and the [auto-verify] failure tail', async () => {
    const proj = mkdtempSync(join(tmpdir(), 'pev-comp-proj-'))
    dirs.push(proj)
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'edit', { file_path: join(proj, 'a.ts') }),
      textResponse('acknowledged'),
    ])
    const { agent } = await build(adapter, { proj })
    await run(agent)
    const texts = resultTexts(agent)
    expect(texts.some((t) => t.includes('edit ok:') && t.includes('[auto-verify]') && t.includes('verify tail line'))).toBe(true)
  })

  it('BLOCKED downstream: a listener returning a block decision means NO verify run (marker file absent)', async () => {
    const marker = join(tmpdir(), `pev-marker-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'edit', { file_path: '/tmp/pev-block/a.ts' }),
      textResponse('done'),
    ])
    const home = mkdtempSync(join(tmpdir(), 'pev-comp-home-'))
    const proj = mkdtempSync(join(tmpdir(), 'pev-comp-proj-'))
    dirs.push(home, proj)
    writeFileSync(join(home, 'settings.json'), JSON.stringify({
      'cc-post-edit-verify': { enabled: true, rules: [{ glob: '**/*.ts', command: `echo spawned >> ${marker}` }] },
    }))
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
    void new TokenMeter(ctx)
    ;(ctx as unknown as { dshHomePath: (...s: string[]) => string }).dshHomePath =
      (...segments: string[]) => join(home, ...segments)
    await ctx.plugin(PostEditVerify)
    // Downstream listener (registered AFTER the plugin → inner) blocks the result.
    ctx.on('tools/post-execute', async (exec, result, next) => {
      await next()
      return { kind: 'block', feedback: [{ type: 'text', text: 'blocked by policy' }] } as PostToolDecision
    })
    ctx.tools.register(defineContentToolFixture({
      name: 'edit', description: 'e', parameters: {},
      async execute(input: { file_path?: string }) {
        return [{ type: 'text', text: `edit ok: ${input.file_path}` }]
      },
    }))
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('pev-block'), { provider: 'mock', model: 'mock' })
    setSessionCwd(agent, proj)
    await run(agent)
    expect(() => readFileSync(marker)).toThrow()
  })

  it('BARE-ACCEPT downstream: the verify block is appended on top of the tool result content', async () => {
    const proj = mkdtempSync(join(tmpdir(), 'pev-comp-proj-'))
    dirs.push(proj)
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'edit', { file_path: join(proj, 'a.ts') }),
      textResponse('done'),
    ])
    const home = mkdtempSync(join(tmpdir(), 'pev-comp-home-'))
    dirs.push(home)
    writeFileSync(join(home, 'settings.json'), JSON.stringify({
      'cc-post-edit-verify': { enabled: true, rules: [{ glob: '**/*.ts', command: 'node -e "process.exit(7)"' }] },
    }))
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
    void new TokenMeter(ctx)
    ;(ctx as unknown as { dshHomePath: (...s: string[]) => string }).dshHomePath =
      (...segments: string[]) => join(home, ...segments)
    await ctx.plugin(PostEditVerify)
    // Downstream listener (inner) drops the tool result and accepts bare, so
    // compose must fall back to result.content (doc §2 idiom).
    ctx.on('tools/post-execute', async (exec, result, next) => {
      await next()
      return { kind: 'accept' } as PostToolDecision
    })
    ctx.tools.register(defineContentToolFixture({
      name: 'edit',
      description: 'edit a file',
      parameters: {},
      async execute(input: { file_path?: string }) {
        return [{ type: 'text', text: `edit ok: ${input.file_path}` }]
      },
    }))
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('pev-bare'), { provider: 'mock', model: 'mock' })
    setSessionCwd(agent, proj)
    await run(agent)
    const texts = resultTexts(agent)
    expect(texts.some((t) => t.includes('edit ok:') && t.includes('[auto-verify]') && t.includes('exit 7'))).toBe(true)
  })

  it('DISABLED: the observation is untouched (no [auto-verify] text anywhere)', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'edit', {}),
      textResponse('done'),
    ])
    const { agent } = await build(adapter, { settings: { enabled: false, rules: [{ glob: '**/*.ts', command: 'node -e "process.exit(1)"' }] } })
    await run(agent)
    const texts = resultTexts(agent)
    expect(texts.some((t) => t.includes('[auto-verify]'))).toBe(false)
  })
})
