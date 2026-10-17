/**
 * Real-boot variant of worktree-isolation.integration.spec.ts: the task
 * plugin is loaded through REAL cordis plugin loading (`ctx.plugin(module)`),
 * not `apply(ctx)` on the root context. Only a plugin context enforces the
 * inject guard: before `inject` listed 'shell', worktree-isolation's
 * `ctx.shell` read threw `cannot get property "shell" without inject` and the
 * isolated dispatch failed. Hand-built root contexts never exercise it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MockAdapter, textResponse, toolCallResponse } from '@dsh-cc/agent-loop-mock'
import { defineTool } from '@dsh-cc/tools'
import { getSessionCwd } from '@dsh-cc/session-cwd'
import * as TaskPlugin from '../src/index.ts'

// Hook-environment hermeticity (same strip as tool-git-worktree's integration).
for (const v of [
  'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE',
]) delete process.env[v]

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** Workspace root with a REAL git repo + an isolation: worktree definition. */
function workspace(): string {
  const root = roots[roots.length - 1]!
  const ws = join(root, 'workspace')
  mkdirSync(join(ws, '.claude', 'agents'), { recursive: true })
  writeFileSync(
    join(ws, '.claude', 'agents', 'isolated.md'),
    '---\nname: isolated\ndescription: isolated worker\nisolation: worktree\ntools:\n  - dirty-write\n---\nISOLATED PERSONA\n',
  )
  execSync('git init -q', { cwd: ws })
  execSync('git config user.email test@example.com && git config user.name Tester', { cwd: ws })
  writeFileSync(join(ws, 'file.txt'), 'hello\n')
  execSync('git add file.txt && git commit -qm initial', { cwd: ws })
  return ws
}

/** Register a tool that writes into the CALLING agent's session cwd. */
function registerDirtyWrite(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'dirty-write',
    description: 'writes a file into the current session cwd',
    parameters: {},
    output: { schema: { type: 'null' }, render: () => [] },
    async execute(_args, exec) {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(join(getSessionCwd(exec.agent as never), 'dirty.txt'), 'x')
      return null
    },
  }))
}

async function setup(script: ConstructorParameters<typeof MockAdapter>[0]) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-cc-task-isolation-int-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(SessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  // Real shell + fs so the isolation dispatch runs REAL git.
  const ws = workspace()
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { cwd: ws })
  await ctx.plugin(LocalFileSystem, { cwd: ws })
  registerDirtyWrite(ctx)
  // The production cc `tools` service keeps disabled-row names restrictable
  // via `reserve`; the testkit ToolRuntime lacks it — minimal equivalent.
  const tools = ctx.get('tools') as { reserve?(name: string): () => void }
  if (typeof tools.reserve !== 'function') {
    const reserved = new Set<string>()
    tools.reserve = (name: string) => {
      reserved.add(name)
      return () => { reserved.delete(name) }
    }
  }
  // Real cordis loading: the plugin context enforces `export const inject`.
  await ctx.plugin(TaskPlugin as never)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(
    SessionId('parent'),
    { provider: 'mock', model: 'mock' },
    { cwd: ws },
  )
  const started: string[] = []
  ctx.on('subagent/start', info => { started.push(String(info.id)) })
  const childIds = () => [...started]
  return { ctx, parent, ws, childIds }
}

let calls = 0
async function callTask(ctx: Context, name: string, args: unknown, agent: Agent) {
  return (await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`call-${++calls}`),
    name,
    arguments: args,
    agent: agent as never,
  })) as { isError: boolean; content: { type: string; text?: string }[] }
}

const text = (result: { content: { type: string; text?: string }[] }): string =>
  result.content.map(block => block.text ?? '').join('')

async function waitNoActivation(ctx: Context, childId: SessionId): Promise<void> {
  await vi.waitFor(() => {
    expect(ctx.agents.get(childId)).toBeUndefined()
  }, { timeout: 10_000 })
}

describe('isolation: worktree through real cordis plugin loading', () => {
  it('declares shell in inject (worktree-isolation reads ctx.shell)', () => {
    expect(TaskPlugin.inject).toContain('shell')
  })

  it('clean child: isolated dispatch runs real git on the plugin context', async () => {
    const { ctx, parent, ws, childIds } = await setup([textResponse('child done')])
    const result = await callTask(ctx, 'subagent_fork', {
      subagent_type: 'isolated',
      description: 'isolated work',
      prompt: 'do the isolated thing',
    }, parent)
    expect(text(result)).not.toContain('without inject')
    expect(result.isError).toBe(false)
    const worktreePath = /isolated worktree (\S+)/.exec(text(result))?.[1]
    expect(worktreePath).toBeDefined()
    expect(text(result)).toContain('removed after the child finished cleanly')
    await waitNoActivation(ctx, childIds()[0]!)
    const listing = execSync('git worktree list --porcelain', { cwd: ws }).toString()
    expect(listing).not.toContain('worktree-subagent-')
    expect(existsSync(worktreePath!)).toBe(false)
  }, 30_000)
})
