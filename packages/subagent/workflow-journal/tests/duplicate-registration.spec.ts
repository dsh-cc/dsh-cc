/**
 * Two standing preset mounts (agent.cordis.yml / agent.vwa.cordis.yml) apply
 * this plugin in ONE runtime, sharing the host-plane subagent provider map.
 * Mirrors the harness SubagentRuntime API isomorphically with a fake:
 * getProvider returns the registered provider or undefined, and
 * registerProvider throws on a second registration of the same name (the
 * harness-level DUPLICATE_PROVIDER path is exercised through real boots).
 * Asserts the second apply registers nothing, logs the reuse line, and its
 * disposer leaves the owner's registration intact.
 */

import { describe, expect, it } from 'vitest'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import { apply } from '../src/index.ts'

/** Harness-isomorphic fake: map semantics + throw on duplicate registration. */
class FakeSubagentsService {
  readonly providers = new Map<string, SubagentProvider>()
  readonly registerCalls: SubagentProvider[] = []

  getProvider(name: string): SubagentProvider | undefined {
    return this.providers.get(name)
  }

  registerProvider(provider: SubagentProvider): () => void {
    if (this.providers.has(provider.name)) throw new Error(`a subagent provider named "${provider.name}" is already registered`)
    this.registerCalls.push(provider)
    this.providers.set(provider.name, provider)
    return () => this.providers.delete(provider.name)
  }
}

class FakeRegistry {}
class FakeLogger {
  readonly infos: string[] = []
  readonly warns: string[] = []
  info(message: string): void { this.infos.push(message) }
  warn(message: string): void { this.warns.push(message) }
}

/** Minimal foreign provider: same name, different class. */
class ForeignProvider implements SubagentProvider {
  readonly name = 'cc-workflow-journal'
  readonly capabilities = { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false }
  readonly inheritsParentContext = false
  async start(): Promise<never> { throw new Error('unused') }
}

function makeContext(subagents: FakeSubagentsService, logger: FakeLogger) {
  return {
    subagents,
    ccWorkflowRunRegistry: new FakeRegistry(),
    logger,
  } as never
}

describe('apply() against a shared provider map (two standing preset mounts)', () => {
  it('second apply does not throw, reuses the sibling provider, and its disposer leaves the map intact', async () => {
    const subagents = new FakeSubagentsService()
    const firstLogger = new FakeLogger()
    const secondLogger = new FakeLogger()

    const disposeFirst = await apply(makeContext(subagents, firstLogger), {})
    const first = subagents.providers.get('cc-workflow-journal')!
    expect(subagents.registerCalls).toHaveLength(1)

    const disposeSecond = await apply(makeContext(subagents, secondLogger), {})
    // No throw above; no second provider instance landed in the map.
    expect(subagents.registerCalls).toHaveLength(1)
    expect(subagents.providers.get('cc-workflow-journal')).toBe(first)
    expect(secondLogger.infos).toContain('cc-workflow-journal: provider already registered by a sibling preset mount; reusing it')
    expect(secondLogger.warns).toHaveLength(0)

    // Disposing the NON-owning apply leaves the owner's registration intact.
    disposeSecond()
    expect(subagents.providers.get('cc-workflow-journal')).toBe(first)

    // Disposing the OWNING apply removes the provider from the map.
    disposeFirst()
    expect(subagents.providers.has('cc-workflow-journal')).toBe(false)
  })

  it('a foreign provider holding the name defers with a warning and owns nothing', async () => {
    const subagents = new FakeSubagentsService()
    const logger = new FakeLogger()
    const foreign = new ForeignProvider()
    subagents.providers.set(foreign.name, foreign)

    const disposer = await apply(makeContext(subagents, logger), {})
    expect(logger.warns).toContain('cc-workflow-journal: provider name taken by a foreign provider; deferring')
    expect(subagents.providers.get('cc-workflow-journal')).toBe(foreign)
    disposer()
    expect(subagents.providers.get('cc-workflow-journal')).toBe(foreign)
  })
})
