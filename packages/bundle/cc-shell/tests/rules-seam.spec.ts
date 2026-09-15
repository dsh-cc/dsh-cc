/**
 * The plugin rules seam (plan docs/plans/2026-09-15-cursor-plugin-dialect.md
 * §3.3, PR-B S5): the glue provides the `rules` guest seam from
 * @dsh-cc/plugin-loader via the SAME child-plugin provide idiom as the `mcp`
 * seam, and renders merged entries into a `cc:plugin-rules` system-prompt
 * section. Covers alwaysApply rendering, glob conditional rendering, the
 * generic-guidance + warning path, the copy-on-write disposer, the empty
 * state (no stray header), and the prompt-budget cap (§7).
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { MockAdapter, textResponse } from '@dsh-cc/agent-loop-mock'
import type { RuleEntry, RulesSeam } from '@dsh-cc/plugin-loader'
import { apply } from '../src/index.ts'

/**
 * The harness mirrors the hooks bridge seam spec
 * (packages/hooks/hooks-claude-code/tests/plugin-hooks-seam.spec.ts):
 * real agent-loop test dependencies (including the session projection
 * registry and the systemPrompt host), real loop + runtimes, the REAL
 * cc-shell-glue plugin (discovery disabled: pluginDirs/mcpConfigFiles empty),
 * and the mock adapter registered on llm.
 */
async function mountGlue(adapter: MockAdapter): Promise<{ ctx: Context; seam: RulesSeam }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  await ctx.plugin({ name: 'cc-shell-glue', apply }, { pluginDirs: [], mcpConfigFiles: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  const seam = ctx.get('rules') as RulesSeam | undefined
  expect(seam).toBeDefined()
  return { ctx, seam: seam as RulesSeam }
}

function entry(overrides: Partial<RuleEntry> = {}): RuleEntry {
  return {
    path: 'rules/r.mdc',
    description: undefined,
    alwaysApply: false,
    globs: [],
    body: 'Use tabs.',
    ...overrides,
  }
}

/** Assemble the top-level prompt and return the rendered text. */
async function rendered(ctx: Context, agent?: Agent): Promise<string> {
  const assembly = await ctx.systemPrompt.assemble(agent === undefined ? {} : { scope: agent })
  return renderPrompt(assembly)
}

describe('plugin rules seam', () => {
  it('adds NO section content when no plugin contributes rules (no stray header)', async () => {
    const adapter = new MockAdapter([textResponse('done')])
    const { ctx } = await mountGlue(adapter)
    const text = await rendered(ctx)
    expect(text).not.toContain('Rules from plugin')
    expect(text).not.toContain('When editing files matching')
  })

  it('renders alwaysApply entries verbatim under "Rules from plugin <name>"', async () => {
    const adapter = new MockAdapter([textResponse('done')])
    const { ctx, seam } = await mountGlue(adapter)
    seam.mergePluginRules('alpha', [
      entry({ alwaysApply: true, body: 'Always lint before commit.' }),
      entry({ alwaysApply: true, path: 'rules/b.mdc', body: 'Never force push.' }),
    ])
    const text = await rendered(ctx)
    expect(text).toContain('Rules from plugin alpha')
    expect(text).toContain('Always lint before commit.')
    expect(text).toContain('Never force push.')
    // Not framed as conditional guidance.
    expect(text).not.toContain('When editing files matching')
  })

  it('renders glob-scoped entries as conditional instructions', async () => {
    const adapter = new MockAdapter([textResponse('done')])
    const { ctx, seam } = await mountGlue(adapter)
    seam.mergePluginRules('beta', [
      entry({ alwaysApply: false, globs: ['src/**/*.ts', '*.md'], body: 'Prefer named exports.' }),
    ])
    const text = await rendered(ctx)
    expect(text).toContain('When editing files matching `src/**/*.ts, *.md`:')
    expect(text).toContain('Prefer named exports.')
  })

  it('renders scopeless entries as generic guidance AND warns', async () => {
    const adapter = new MockAdapter([textResponse('done')])
    const { ctx, seam } = await mountGlue(adapter)
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    seam.mergePluginRules('gamma', [entry({ alwaysApply: false, globs: [], body: 'Be concise.' })])
    const text = await rendered(ctx)
    expect(text).toContain('Be concise.')
    expect(warn.mock.calls.some(args => String(args[0]).includes('gamma'))).toBe(true)
  })

  it('disposer removes exactly that plugin\'s contributions (copy-on-write)', async () => {
    const adapter = new MockAdapter([textResponse('done')])
    const { ctx, seam } = await mountGlue(adapter)
    const disposeA = seam.mergePluginRules('pa', [entry({ alwaysApply: true, body: 'Rule A.' })])
    seam.mergePluginRules('pb', [entry({ alwaysApply: true, body: 'Rule B.' })])
    disposeA()
    const text = await rendered(ctx)
    expect(text).not.toContain('Rule A.')
    expect(text).not.toContain('Rules from plugin pa')
    expect(text).toContain('Rule B.')
    expect(text).toContain('Rules from plugin pb')
  })

  it('truncates a plugin contribution beyond the budget cap with an explicit tail and warning', async () => {
    const adapter = new MockAdapter([textResponse('done')])
    const { ctx, seam } = await mountGlue(adapter)
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    seam.mergePluginRules('huge', [entry({ alwaysApply: true, body: 'x'.repeat(5000) })])
    const text = await rendered(ctx)
    expect(text).toContain('Rules from plugin huge')
    expect(text).toContain('... (truncated)')
    expect(text.length).toBeLessThan(5000 + 2000)
    expect(warn.mock.calls.some(args => String(args[0]).includes('huge'))).toBe(true)
  })

  it('a merged message still flows through the real loop (harness smoke)', async () => {
    const adapter = new MockAdapter([textResponse('done')])
    const { ctx, seam } = await mountGlue(adapter)
    seam.mergePluginRules('delta', [entry({ alwaysApply: true, body: 'Rule D.' })])
    const agent: Agent = await ctx.agentLoop.create(SessionId('rules'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(await rendered(ctx)).toContain('Rule D.')
  })
})
