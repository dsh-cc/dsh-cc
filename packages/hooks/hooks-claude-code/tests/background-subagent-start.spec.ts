/**
 * §4.14 — the `SubagentStart` hook fires for a background (continuable) start,
 * once per Activation epoch (initial start = one epoch; a cold resume opens a
 * second epoch with a fresh runId). Mirrors the foreground bridge coverage in
 * bridge.spec.ts, composed over a real continuable background start.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime, { type SubagentRunId } from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '@dsh-cc/agent-loop-mock'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import * as HooksClaude from '@dsh-cc/hooks-claude-code'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

interface StartInfo {
  runId: SubagentRunId
  id: SessionId
}

/**
 * Boot the harness stack plus the hooks-claude-code bridge. One command hook
 * on `SubagentStart` appends a line to a marker file, so the number of hook
 * PROCESSES is observable (the bridge runs hooks detached).
 */
async function setup(script: ConstructorParameters<typeof MockAdapter>[0]) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-background-'))
  dirs.push(dir)
  const marker = join(dir, 'start-marker')
  const startHook = join(dir, 'start.sh')
  writeFileSync(startHook, `#!/usr/bin/env bash\necho run >> "${marker}"\n`)
  chmodSync(startHook, 0o755)
  writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: {
    SubagentStart: [{ hooks: [{ type: 'command', command: startHook }] }],
  } }))

  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const persistRoot = mkdtempSync(join(tmpdir(), 'dsh-hooks-background-persist-'))
  dirs.push(persistRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: persistRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  // Keep the stand-in parent out of the scripted corpus.
  ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
    if (subject !== parent) return next()
    return { kind: 'reject' as const }
  })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  const hooksFiber: Fiber = await ctx.plugin(HooksClaude, { configPath: join(dir, 'hooks.json') })

  const starts: StartInfo[] = []
  ctx.on('subagent/start', info => void starts.push({ runId: info.runId, id: info.id }))

  return { ctx, parent, marker, starts, hooksFiber }
}

/** Poll a predicate to a deadline (the bridge's hook runs are detached).
 *  20s: cold resume + detached hook subprocess must fit a fully loaded CI
 *  runner (the whole-suite presubmit), not just a warm local machine. */
async function waitFor(predicate: () => boolean, timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met before deadline')
    await new Promise(r => setTimeout(r, 10))
  }
}

function lineCount(path: string): number {
  return readFileSync(path, 'utf8').split('\n').filter(line => line.trim().length > 0).length
}

describe('hooks-claude-code — SubagentStart on background starts (§4.14)', () => {
  it('fires once for the initial epoch of a background start, once more per cold-resume epoch', async () => {
    const { ctx, parent, marker, starts } = await setup(
      [textResponse('background answer'), textResponse('resumed answer')],
    )

    // Background start through the harness continuable entry the Task tool
    // dispatches to (`startContinuable`, provider 'spawn').
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'background probe',
      request: { prompt: [{ type: 'text', text: 'slow work' }], parent },
      signal: new AbortController().signal,
    })

    // Initial epoch: exactly one SubagentStart event, and the hook process ran
    // exactly once for it.
    await waitFor(() => starts.length >= 1)
    await waitFor(() => existsSync(marker) && lineCount(marker) === 1)
    expect(starts).toHaveLength(1)
    expect(String(starts[0]!.id)).toBe(String(started.childId))
    expect(lineCount(marker)).toBe(1)

    // A cold resume opens a SECOND epoch: a fresh start event with a new runId,
    // and the hook fires once for that epoch too (not per step or per turn).
    //
    // Wait for the first epoch's Activation to be released first: a followup
    // delivered while an Activation is still resident parks as the SAME
    // epoch's next FIFO turn (no new start event — the CI flake this guards).
    // Mirrors waitNoActivation in packages/subagent/task/tests/integration.spec.ts.
    await waitFor(() => ctx.agents.get(started.childId) === undefined)
    await ctx.subagents.followup(parent, started.childId,
      [{ type: 'text' as const, text: 'keep going' }],
      { source: { kind: 'user' as const }, signal: new AbortController().signal })
    await waitFor(() => starts.length >= 2 && lineCount(marker) >= 2)
    expect(starts).toHaveLength(2)
    expect(String(starts[1]!.id)).toBe(String(started.childId))
    expect(starts[1]!.runId).not.toBe(starts[0]!.runId)
    expect(lineCount(marker)).toBe(2)

    await ctx.fiber.dispose()
  }, 60_000)
})
