/**
 * WS-6 hook wiring for subagent isolation: WorktreeCreate fires with source
 * 'subagent-isolation' at creation (a hook-provided path is adopted, a
 * failing hook falls back to git-direct), and WorktreeRemove fires with
 * reason 'subagent-finished' at settle ('replaced' marks the entry removed,
 * 'kept' keeps the tree).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { HookOutput, HookRunResult } from '@dsh-cc/hook-protocol'
import { createIsolationWorktree, settleIsolationWorktree } from '../src/worktree-isolation.ts'

const signal = new AbortController().signal

class ScriptedShell extends ShellExecutor {
  requests: ShellExecRequest[] = []
  script: Array<{ match: RegExp; result?: Partial<ShellRunResult> }> = []
  resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? process.cwd(),
      timeoutMs: 1000,
      stdoutMaxBytes: 64_000,
      sandboxPolicy: undefined,
      ...(request.signal ? { signal: request.signal } : {}),
    }
  }
  private outcome(spec: ShellExecSpec): ShellRunResult {
    const hit = this.script.find(entry => entry.match.test(spec.command))
    return {
      exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1,
      stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false },
      ...hit?.result,    } as ShellRunResult
  }
  run(spec: ShellExecSpec): Promise<ShellRunResult> {
    this.requests.push({ command: spec.command, workdir: spec.workdir })
    return Promise.resolve(this.outcome(spec))
  }
  start(_spec: ShellExecSpec): ShellProcess { throw new Error('never') }
}

interface HookCall { point: string; payload: Record<string, unknown> }

async function mount(hookOutputs: HookOutput[]): Promise<{ ctx: Context; calls: HookCall[]; shell: ScriptedShell; ws: string }> {
  const ws = mkdtempSync(join(tmpdir(), 'dsh-sub-hook-'))
  const ctx = new Context()
  await ctx.plugin(ScriptedShell)
  const shell = ctx.shell as ScriptedShell
  const calls: HookCall[] = []
  ctx.provide('hookRun', async (point: string, payload: unknown): Promise<HookRunResult> => {
    calls.push({ point, payload: payload as Record<string, unknown> })
    return { decision: 'none', stop: false, additionalContext: [], systemMessages: [], outputs: hookOutputs }
  })
  return { ctx, calls, shell, ws }
}

const out = (partial: Partial<HookOutput>): HookOutput => ({ exitCode: 0, stderr: '', stdout: '', ...partial })

const tmpRoots: string[] = []
afterEach(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('subagent isolation hook wiring (WS-6)', () => {
  it('fires WorktreeCreate with source subagent-isolation and falls back to git-direct on hook failure', async () => {
    const m = await mount([out({ exitCode: 1 })])
    tmpRoots.push(m.ws)
    m.shell.script = [
      { match: /rev-parse --git-common-dir/, result: { stdout: { text: `${m.ws}/.git` } } },
      { match: /config --local --list/, result: { stdout: { text: '\0' } } },
      { match: /rev-parse HEAD/, result: { stdout: { text: 'abc123' } } },
      { match: /worktree add/, result: {} },
      { match: /worktree lock/, result: {} },
    ]
    const record = await createIsolationWorktree(m.ctx, { parentCwd: m.ws, childId: 'child-1', signal })
    expect(m.calls).toHaveLength(1)
    expect(m.calls[0].point).toBe('WorktreeCreate')
    expect(m.calls[0].payload['source']).toBe('subagent-isolation')
    expect(m.calls[0].payload['name']).toBe(record.worktreePath.split('/').pop())
    // Hook failed (exit 1) → git-direct creation still ran.
    expect(m.shell.requests.some(r => r.command.includes('worktree add'))).toBe(true)
  })

  it('fires WorktreeRemove with reason subagent-finished; replaced marks removed, kept keeps the tree', async () => {
    const m = await mount([out({})])
    tmpRoots.push(m.ws)
    m.shell.script = [
      { match: /worktree status|git status/, result: {} },
      { match: /commitsAhead|rev-list/, result: { stdout: { text: '0' } } },
    ]
    const entry = {
      repoRoot: m.ws, worktreePath: join(m.ws, '.claude', 'worktrees', 'x'), branch: 'worktree-x',
      baseHead: 'abc123', lockReason: 'dsh-cc subagent child-1', parentCwd: m.ws, removed: false,
    }
    const outcome = await settleIsolationWorktree(m.ctx, entry)
    expect(outcome).toBe('removed')
    expect(entry.removed).toBe(true)
    expect(m.calls).toHaveLength(1)
    expect(m.calls[0].point).toBe('WorktreeRemove')
    expect(m.calls[0].payload['reason']).toBe('subagent-finished')
    // 'replaced': the hooks own removal — no git-direct remove ran.
    expect(m.shell.requests.some(r => r.command.includes('worktree remove'))).toBe(false)

    const kept = await mount([out({ exitCode: 2 })])
    tmpRoots.push(kept.ws)
    kept.shell.script = [
      { match: /git status/, result: {} },
      { match: /rev-list/, result: { stdout: { text: '0' } } },
    ]
    const entry2 = { ...entry, removed: false }
    expect(await settleIsolationWorktree(kept.ctx, entry2)).toBe('kept')
    expect(entry2.removed).toBe(false)
  })
})
