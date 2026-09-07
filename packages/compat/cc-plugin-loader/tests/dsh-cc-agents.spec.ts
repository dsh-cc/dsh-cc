/**
 * The REAL first-party plugin (`packages/plugin/dsh-cc-agents`) mounted
 * through `mountCcPlugin` — end-to-end pinning of the official
 * deep-reasoner/fast-worker distribution (plan
 * docs/plans/2026-09-07-official-agents-plugin.md §5.1):
 *
 * - providers register as branded, scoped `dsh-cc-agents:*` ids;
 * - the background pin folds for deep-reasoner only (fast-worker ships none);
 * - the shipped `tools:` lists sanitize cleanly against a minimal built-in
 *   known-names set (no drop warnings fired);
 * - an unconfigured model alias resolves to inherit (no agentOptions);
 * - the skills component LOADS (not skipped) and the skill is visible in a
 *   REAL skill registry (`@deepseek-ai/dsh-skill`) with model invocation on.
 */
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import type { AgentDefinition } from '@dsh-cc/claude-code-agents'
import { sanitizeToolFilter } from '../../../subagent/task/src/sanitize-filter.ts'
import { mountCcPlugin, isPluginAgentProvider } from '../src/index.ts'

/** The real plugin dir, resolved from this test file to the repo root. */
const REAL_PLUGIN_DIR = resolve(import.meta.dirname, '../../../plugin/dsh-cc-agents')

const BUILTIN_KNOWN_NAMES = new Set([
  // The harness-side names the shipped CC names translate into
  // (@dsh-cc/tools CC_TO_HARNESS_TOOLS) — a minimal built-in-only set.
  'bash', 'read', 'read_image', 'grep', 'glob', 'write', 'edit',
  'job_output', 'job_kill', 'todo_write', 'NotebookEdit',
])

/** A capture-only subagent seam (records providers, resolves no backend). */
function subagentsSeam(): {
  subagents: { registerProvider(p: unknown): () => void; getProvider(): undefined }
  providers: Array<{ name: string; definition: AgentDefinition; start(r: unknown): Promise<unknown> }>
} {
  const providers: Array<{ name: string; definition: AgentDefinition; start(r: unknown): Promise<unknown> }> = []
  return {
    subagents: {
      registerProvider: (p) => { providers.push(p as never); return () => {} },
      // Only the `fork` backend resolves (AgentProvider.start's default), and
      // it echoes the delegation request so tests can inspect the overlay.
      getProvider: (name: string) => (name === 'fork' ? { start: async (r: unknown) => ({ forwarded: r }) } : undefined),
    },
    providers,
  }
}

describe('mountCcPlugin on the real dsh-cc-agents plugin', () => {
  it('registers both agents as branded providers under scoped dsh-cc-agents ids', async () => {
    const ctx = new Context()
    const { subagents, providers } = subagentsSeam()
    const mount = await mountCcPlugin(ctx, {
      root: REAL_PLUGIN_DIR,
      seams: { subagents },
    })
    try {
      expect(mount.report.name).toBe('dsh-cc-agents')
      const agents = mount.report.components.find(c => c.kind === 'agents')
      expect(agents?.loaded).toBe(2)
      expect(agents?.failed).toBe(0)
      expect(providers.map(p => p.name).sort()).toEqual([
        'dsh-cc-agents:deep-reasoner',
        'dsh-cc-agents:fast-worker',
      ])
      for (const provider of providers) {
        expect(isPluginAgentProvider(provider)).toBe(true)
        // The definition stays bare; only the registered name is scoped.
        expect(provider.definition.agentType).not.toContain(':')
        expect(provider.definition.systemPrompt.length).toBeGreaterThan(0)
      }
      expect(providers.map(p => p.definition.agentType).sort()).toEqual(['deep-reasoner', 'fast-worker'])
    } finally {
      mount.dispose()
    }
  })

  it('pins background: true on deep-reasoner only; fast-worker carries no pin', async () => {
    const ctx = new Context()
    const { subagents, providers } = subagentsSeam()
    const mount = await mountCcPlugin(ctx, { root: REAL_PLUGIN_DIR, seams: { subagents } })
    try {
      const byAgent = new Map(providers.map(p => [p.definition.agentType, p.definition]))
      expect(byName(byAgent, 'deep-reasoner').background).toBe(true)
      expect('background' in byName(byAgent, 'fast-worker')).toBe(false)
    } finally {
      mount.dispose()
    }
  })

  it('sanitizes both shipped tool lists cleanly against a minimal built-in known set (no warnings)', async () => {
    const ctx = new Context()
    const { subagents, providers } = subagentsSeam()
    const mount = await mountCcPlugin(ctx, { root: REAL_PLUGIN_DIR, seams: { subagents } })
    try {
      const warnings: string[] = []
      const warn = (message: string) => { warnings.push(message) }
      for (const provider of providers) {
        const raw = provider.definition.toolRestriction
        expect(raw, `${provider.name} ships a tools list`).toBeDefined()
        expect(raw?.allow?.length ?? 0).toBeGreaterThan(0)
        const sanitized = sanitizeToolFilter(raw!, warn, BUILTIN_KNOWN_NAMES)
        // Nothing dropped: the sanitized filter keeps the full shipped list.
        expect(sanitized).toEqual(raw)
      }
      expect(warnings).toEqual([])
    } finally {
      mount.dispose()
    }
  })

  it('with an unconfigured alias (resolver yields inherit), start adds no agentOptions', async () => {
    const ctx = new Context()
    const { subagents, providers } = subagentsSeam()
    const mount = await mountCcPlugin(ctx, {
      root: REAL_PLUGIN_DIR,
      seams: { subagents },
      // No routes service: an unconfigured alias resolves to inherit.
      resolveModel: () => undefined,
    })
    try {
      const reasoner = providers.find(p => p.definition.agentType === 'deep-reasoner')!
      const forwarded = (await reasoner.start({ prompt: 'x' })) as { forwarded?: Record<string, unknown> }
      const delegation = (forwarded['forwarded'] ?? forwarded) as Record<string, unknown>
      expect(delegation['agentOptions']).toBeUndefined()
      // The persona still folds into the delegation.
      expect(String(delegation['prompt'])).toContain('Staff Engineer')
    } finally {
      mount.dispose()
    }
  })

  it('the skills component LOADS (not skipped) and the skill is visible in a real registry', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const { subagents } = subagentsSeam()
    const mount = await mountCcPlugin(ctx, { root: REAL_PLUGIN_DIR, seams: { subagents } })
    try {
      const skills = mount.report.components.find(c => c.kind === 'skills')
      expect(skills?.loaded).toBe(1)
      expect(skills?.skipped).toBe(0)
      expect(skills?.failed).toBe(0)
      // Real-registry visibility (a tally alone cannot prove it — a duplicate
      // name would register as a silent no-op).
      const listed = await ctx.skills.list()
      expect(listed.map(s => s.name)).toContain('dsh-cc-agents-orchestration')
      const loaded = await ctx.skills.get('dsh-cc-agents-orchestration')
      expect(loaded).toBeDefined()
      expect(loaded?.invocation.modelInvocable).toBe(true)
    } finally {
      mount.dispose()
    }
  })
})

function byName(
  byAgent: Map<string, AgentDefinition>,
  agentType: string,
): AgentDefinition & { background?: boolean } {
  const def = byAgent.get(agentType)
  expect(def, `agent "${agentType}" mounted`).toBeDefined()
  return def as AgentDefinition & { background?: boolean }
}
