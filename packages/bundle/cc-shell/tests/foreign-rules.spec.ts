/**
 * Foreign rules import (plan docs/plans/2026-09-23-small-picks-batch.md
 * §C7): cline/windsurf/copilot rule files under the session cwd render into
 * a `cc:foreign-rules` section (order 107, after `cc:plugin-rules`). Covers
 * the 3-provider/5-glob table, per-file/provider/total caps, the literal
 * ignore list + no-symlink rule, the `cc-foreign-rules.disabled` opt-out,
 * the empty state, and the one-line debug noise rule.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { MockAdapter, textResponse } from '@dsh-cc/agent-loop-mock'
import type { RulesSeam } from '@dsh-cc/plugin-loader'
import {
  discoverForeignRules,
  FOREIGN_SECTION_CAP_CHARS,
  renderForeignRules,
  type ForeignRuleFile,
} from '../src/foreign-rules.ts'
import { apply } from '../src/index.ts'

let tmp: string | undefined

afterEach(() => {
  vi.restoreAllMocks()
  if (tmp !== undefined) {
    rmSync(tmp, { recursive: true, force: true })
    tmp = undefined
  }
})

/** Build a fixture workspace containing all five globs' files. */
function fixture(): string {
  tmp = mkdtempSync(join(tmpdir(), 'cc-foreign-rules-'))
  writeFileSync(join(tmp, '.clinerules'), 'Cline root rule.\n')
  writeFileSync(join(tmp, '.windsurfrules'), 'Windsurf root rule.\n')
  mkdirSync(join(tmp, '.windsurf/rules'), { recursive: true })
  writeFileSync(join(tmp, '.windsurf/rules/a.md'), 'Windsurf dir rule.\n')
  mkdirSync(join(tmp, '.github/instructions'), { recursive: true })
  writeFileSync(join(tmp, '.github/copilot-instructions.md'), 'Copilot instructions.\n')
  writeFileSync(join(tmp, '.github/instructions/x.instructions.md'), 'Copilot glob rule.\n')
  return tmp
}

/** Count occurrences of a needle in a haystack. */
function count(text: string, needle: string): number {
  return text.split(needle).length - 1
}

/** Minimal ctx double for the unit-level discovery/render tests. */
function fakeCtx(): { ctx: Context; debug: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } {
  const ctx = new Context()
  const debug = vi.fn()
  const warn = vi.fn()
  ctx.logger.debug = debug as never
  ctx.logger.warn = warn as never
  return { ctx, debug, warn }
}

/**
 * Same harness shape as rules-seam.spec.ts: real test dependencies, the real
 * cc-shell-glue plugin (discovery disabled), mock adapter. `settings` seeds a
 * minimal provider double so the live `cc-foreign-rules` read resolves.
 */
async function mountGlue(
  adapter: MockAdapter,
  settings?: Record<string, unknown>,
): Promise<Context> {
  const ctx = new Context()
  if (settings !== undefined) {
    ctx.provide('settings', {
      register: () => ({}),
      get: (ns: string) => (ns === 'cc-foreign-rules' ? structuredClone(settings) : undefined),
    })
  }
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  await ctx.plugin({ name: 'cc-shell-glue', apply }, { pluginDirs: [], mcpConfigFiles: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

/** Assemble the top-level prompt and return the rendered text. */
async function rendered(ctx: Context): Promise<string> {
  return renderPrompt(await ctx.systemPrompt.assemble({}))
}

describe('foreign rules discovery + render (unit)', () => {
  it('discovers all five globs under the fixture root', () => {
    const root = fixture()
    const { ctx } = fakeCtx()
    const files = discoverForeignRules(root, ctx)
    const byProvider = (p: string) => files.filter(f => f.provider === p).map(f => f.relPath)
    expect(byProvider('cline')).toEqual(['.clinerules'])
    expect(byProvider('windsurf')).toEqual(['.windsurfrules', '.windsurf/rules/a.md'])
    expect(byProvider('copilot')).toEqual(['.github/copilot-instructions.md', '.github/instructions/x.instructions.md'])
  })

  it('never matches ignored directories or symlinks', () => {
    const root = fixture()
    mkdirSync(join(root, 'node_modules/.windsurf/rules'), { recursive: true })
    writeFileSync(join(root, 'node_modules/.windsurf/rules/n.md'), 'Nope.\n')
    writeFileSync(join(root, '.clinerules'), 'Real.\n')
    const { ctx } = fakeCtx()
    const files = discoverForeignRules(root, ctx)
    expect(files.some(f => f.relPath.includes('node_modules'))).toBe(false)
  })

  it('truncates a file beyond the per-file cap with the explicit tail', () => {
    const root = fixture()
    writeFileSync(join(root, '.clinerules'), 'x'.repeat(5000))
    const { ctx, warn } = fakeCtx()
    const files = discoverForeignRules(root, ctx)
    expect(files.filter(f => f.provider === 'cline')).toHaveLength(1)
    const cline = files.find(f => f.provider === 'cline')!
    expect(cline.body.endsWith('... (truncated)')).toBe(true)
    expect(cline.body.length).toBeLessThanOrEqual(4000)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('caps files per provider at 8', () => {
    const root = fixture()
    for (let i = 0; i < 10; i += 1) {
      writeFileSync(join(root, `.windsurf/rules/f${i}.md`), `Rule ${i}.\n`)
    }
    const { ctx } = fakeCtx()
    const files = discoverForeignRules(root, ctx)
    expect(files.filter(f => f.provider === 'windsurf')).toHaveLength(8)
  })

  it('caps the whole section at 12000 chars', () => {
    const files: ForeignRuleFile[] = []
    for (let i = 0; i < 10; i += 1) {
      files.push({ provider: 'cline', relPath: `f${i}`, body: 'y'.repeat(2000) })
    }
    const text = renderForeignRules(files)
    expect(text.length).toBeLessThanOrEqual(FOREIGN_SECTION_CAP_CHARS)
    expect(text.endsWith('... (truncated)')).toBe(true)
  })

  it('renders one header block per file with a relative path and verbatim body', () => {
    const text = renderForeignRules([
      { provider: 'cline', relPath: '.clinerules', body: 'Cline root rule.\n' },
    ])
    expect(text).toBe('## cline rules (.clinerules)\nCline root rule.\n')
  })
})

describe('foreign rules section (composed through cc-shell-glue)', () => {
  it('renders each provider block exactly once, with one debug line', async () => {
    const root = fixture()
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root)
    const adapter = new MockAdapter([textResponse('done')])
    const ctx = await mountGlue(adapter)
    const debug = vi.fn()
    ctx.logger.debug = debug as never
    const text = await rendered(ctx)
    expect(cwd).toHaveBeenCalled()
    expect(count(text, '## cline rules (.clinerules)')).toBe(1)
    expect(count(text, '## windsurf rules (.windsurfrules)')).toBe(1)
    expect(count(text, '## windsurf rules (.windsurf/rules/a.md)')).toBe(1)
    expect(count(text, '## copilot rules (.github/copilot-instructions.md)')).toBe(1)
    expect(count(text, '## copilot rules (.github/instructions/x.instructions.md)')).toBe(1)
    expect(text).toContain('Cline root rule.')
    expect(text).toContain('Copilot glob rule.')
    expect(debug).toHaveBeenCalledTimes(1)
    expect(String(debug.mock.calls[0][0])).toContain('cline=1')
  })

  it('renders after the cc:plugin-rules section', async () => {
    const root = fixture()
    vi.spyOn(process, 'cwd').mockReturnValue(root)
    const adapter = new MockAdapter([textResponse('done')])
    const ctx = await mountGlue(adapter)
    const seam = ctx.get('rules') as RulesSeam | undefined
    expect(seam).toBeDefined()
    seam!.mergePluginRules('alpha', [{ path: 'r.mdc', description: undefined, alwaysApply: true, globs: [], body: 'Plugin rule.' }])
    const text = await rendered(ctx)
    expect(text.indexOf('Rules from plugin alpha')).toBeLessThan(text.indexOf('## cline rules'))
  })

  it('honors cc-foreign-rules.disabled providers', async () => {
    const root = fixture()
    vi.spyOn(process, 'cwd').mockReturnValue(root)
    const adapter = new MockAdapter([textResponse('done')])
    const ctx = await mountGlue(adapter, { disabled: ['copilot'] })
    const text = await rendered(ctx)
    expect(text).toContain('## cline rules')
    expect(text).not.toContain('## copilot rules')
  })

  it('emits no section content for an empty fixture', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'cc-foreign-rules-empty-'))
    vi.spyOn(process, 'cwd').mockReturnValue(tmp)
    const adapter = new MockAdapter([textResponse('done')])
    const ctx = await mountGlue(adapter)
    const debug = vi.fn()
    ctx.logger.debug = debug as never
    const text = await rendered(ctx)
    expect(text).not.toContain('rules (')
    expect(debug).not.toHaveBeenCalled()
  })

  it('the discovered rules flow through the real loop (harness smoke)', async () => {
    const root = fixture()
    vi.spyOn(process, 'cwd').mockReturnValue(root)
    const adapter = new MockAdapter([textResponse('done')])
    const ctx = await mountGlue(adapter)
    const agent = await ctx.agentLoop.create(SessionId('foreign'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(await rendered(ctx)).toContain('## cline rules')
  })
})
