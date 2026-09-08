import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as HooksClaude from '@dsh-cc/hooks-claude-code'
import type { HookBridgeStatus } from '@dsh-cc/hooks-claude-code/src/index.ts'

/**
 * `hookBridgeStatus` tests: the plugin exposes its live load report on its own
 * context (`ctx.get('hookBridgeStatus')`) so /doctor can render it without a
 * module-level singleton. Each test mounts the real plugin pointed at a real
 * temp `hooks.json` and reads the status back.
 */

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function writeConfigFile(dir: string, contents: string): string {
  dirs.push(dir)
  const path = join(dir, 'hooks.json')
  writeFileSync(path, contents)
  return path
}

async function mountStatusCtx(pluginConfig: Record<string, unknown>): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  await ctx.plugin(HooksClaude, pluginConfig)
  return ctx
}

function statusOf(ctx: Context): HookBridgeStatus {
  return ctx.get('hookBridgeStatus') as unknown as HookBridgeStatus
}

describe('hooks-claude-code — hookBridgeStatus', () => {
  it('reports parsed events, skipped malformed hooks, and an absolute sourcePath', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-status-'))
    const configPath = writeConfigFile(dir, JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }, { type: 'mcp_tool' }] }],
      },
    }))
    const ctx = await mountStatusCtx({ configPath })
    const status = statusOf(ctx)
    expect(status.error).toBeUndefined()
    expect(status.sourcePath).toBe(configPath)
    expect(status.events).toEqual([{ name: 'PreToolUse', groups: 1, hooks: 1 }])
    expect(status.skipped).toEqual([{ event: 'PreToolUse', type: 'mcp_tool', reason: 'unknown hook type' }])
    expect(status.commands).toEqual(['echo hi'])
    expect(status.enablePromptHooks).toBe(false)
    expect(status.enableAgentHooks).toBe(false)
  })

  it('reports an error and empty events for a broken JSON file without throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-status-'))
    const configPath = writeConfigFile(dir, '{not json')
    const ctx = await mountStatusCtx({ configPath })
    const status = statusOf(ctx)
    expect(status.error).toContain('JSON')
    expect(status.events).toEqual([])
    expect(status.skipped).toEqual([])
    expect(status.commands).toEqual([])
    expect(status.sourcePath).toBe(configPath)
  })

  it('carries enablePromptHooks / enableAgentHooks from the plugin config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-status-'))
    const configPath = writeConfigFile(dir, JSON.stringify({ hooks: {} }))
    const ctx = await mountStatusCtx({ configPath, enablePromptHooks: true })
    const status = statusOf(ctx)
    expect(status.enablePromptHooks).toBe(true)
    expect(status.enableAgentHooks).toBe(false)
  })
})
