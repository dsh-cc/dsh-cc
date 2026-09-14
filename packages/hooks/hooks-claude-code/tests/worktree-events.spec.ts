/**
 * WS-6 invoke-seam coverage: the bridge provides `hookRun` on the context,
 * a WorktreeCreate command hook that exits 0 with a stdout path surfaces that
 * path in `outputs`, and a non-matching event yields empty outputs.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as HooksClaude from '@dsh-cc/hooks-claude-code'
import type { ShellExecutor as ShellExecutorT } from '@deepseek-ai/dsh-shell'

/** A fake shell whose command hooks always "exit 0" with the script's stdout. */
const FakeShell = {
  name: 'fake-hook-shell',
  apply(ctx: Context): void {
    ctx.provide('shell', {
      resolve: (r: unknown) => r,
      run: async (spec: { command: string }) => ({
        exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 1000,
        stdout: { text: spec.command === 'adopt.sh' ? '/hook/created/tree\n' : '', truncated: false },
        stderr: { text: '', truncated: false },
      }),
      start: () => { throw new Error('never') },
    } satisfies Partial<ShellExecutorT>)
  },
}

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

async function mount(hooks: unknown): Promise<Context> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wt-events-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks }))
  const script = join(dir, 'adopt.sh')
  writeFileSync(script, '#!/bin/sh\necho /hook/created/tree\n')
  chmodSync(script, 0o755)
  const ctx = new Context()
  await ctx.plugin(FakeShell)
  await ctx.plugin(HooksClaude, { configPath: join(dir, 'hooks.json') })
  return ctx
}

describe('WorktreeCreate/WorktreeRemove invoke seam', () => {
  it('provides hookRun and surfaces a stdout path from a WorktreeCreate hook', async () => {
    const ctx = await mount({
      WorktreeCreate: [{ hooks: [{ type: 'command', command: 'adopt.sh' }] }],
    })
    const hookRun = ctx.get('hookRun')
    expect(typeof hookRun).toBe('function')
    const result = await hookRun!('WorktreeCreate', {
      sessionId: 's', cwd: '/x', name: 'demo', worktree_path: '/planned', branch: 'worktree-demo', source: 'enter-worktree',
    }, { signal: new AbortController().signal })
    expect(result.outputs).toHaveLength(1)
    expect(result.outputs[0]!.exitCode).toBe(0)
    expect(result.outputs[0]!.stdout).toContain('/hook/created/tree')
    // A point with no configured hooks yields empty outputs → the caller
    // treats it as "no hook ran" and proceeds with its default behavior.
    const none = await hookRun!('WorktreeRemove', { worktree_path: '/x', reason: 'exit' }, { signal: new AbortController().signal })
    expect(none.outputs).toEqual([])
  })

  it('does not warn on the two new event keys (they are supported)', async () => {
    const ctx = await mount({
      WorktreeCreate: [{ hooks: [{ type: 'command', command: 'true' }] }],
      WorktreeRemove: [{ hooks: [{ type: 'command', command: 'true' }] }],
    })
    const status = ctx.get('hookBridgeStatus') as { warnings?: unknown[]; loaded?: boolean } | undefined
    expect(status).toBeDefined()
    expect(status?.warnings ?? []).toEqual([])
  })
})
