/**
 * The RETIRED tool-append-order contract, pinned as a documented contract of
 * the past.
 *
 * Until harness 0.2.2-rc.1 the `@dsh-cc/tool-append-order` plugin owned tool
 * ordering: it hooked the public `system-prompt/assemble` waterfall and, per
 * scope, kept each surviving tool at its remembered position while appending
 * newly appeared tools (ToolSearch activations, MCP registrations)
 * lexicographically at the tail — so an activation extended the request prefix
 * instead of shifting every tool after the insertion point.
 *
 * Upstream 0.2.2-rc.1 deleted that seam: `PromptPresentation` carries no
 * `tools` array and `orderTools` canonicalizes the collected catalog BEFORE the
 * waterfall. Ordering moved to host `SystemPrompt` constructor state
 * (`toolOrder`, configured in `packages/bundle/cc-shell/cordis.patch.yml`), and
 * the plugin was retired. `appendStable` + the per-scope memory survive in
 * `@dsh-cc/tools/test-support` as executable documentation.
 *
 * The accepted delta (§8.2 of the migration design): the unlisted rest bucket
 * is re-sorted lexicographically on every assembly, so a newly visible unlisted
 * tool INSERTS into the rest bucket — where the retired plugin appended at the
 * tail. The static prefix (the configured `toolOrder` names) is byte-stable.
 */
import { describe, expect, it } from 'vitest'
import { AppendStableMemory, appendStable } from '@dsh-cc/tools/test-support'

interface Schema {
  readonly name: string
  readonly description?: string
}

/** The harness baseline: lexicographic (what `orderTools` emits with no list). */
function baseline(...names: string[]): Schema[] {
  return [...names].sort().map(name => ({ name }))
}

function names(schemas: readonly Schema[]): string[] {
  return schemas.map(schema => schema.name)
}

describe('appendStable (retired plugin algorithm)', () => {
  it('passes the harness baseline through on the first ordering', () => {
    expect(names(appendStable([], baseline('zeta', 'alpha', 'mike')))).toEqual(['alpha', 'mike', 'zeta'])
  })

  it('appends a newly visible tool at the tail without moving the established order', () => {
    // 'beta' sorts before 'mike'/'zeta': plain harness order would shift both.
    const after = appendStable(['alpha', 'mike', 'zeta'], baseline('alpha', 'beta', 'mike', 'zeta'))
    expect(names(after)).toEqual(['alpha', 'mike', 'zeta', 'beta'])
  })

  it('filters removed tools out while keeping the surviving order', () => {
    const after = appendStable(['alpha', 'mike', 'zeta', 'beta'], baseline('alpha', 'beta', 'zeta'))
    expect(names(after)).toEqual(['alpha', 'zeta', 'beta'])
  })

  it('keeps the first schema when a name is duplicated', () => {
    const incoming: Schema[] = [
      { name: 'alpha', description: 'first' },
      { name: 'alpha', description: 'second' },
    ]
    expect(appendStable([], incoming)).toEqual([{ name: 'alpha', description: 'first' }])
  })

  it('emits byte-identical tools for repeated orderings over the same input', () => {
    const scope = { id: 'scope' }
    const memory = new AppendStableMemory<{ id: string }>()
    const first = memory.order(scope, baseline('echo', 'bravo'))
    const second = memory.order(scope, baseline('echo', 'bravo'))
    expect(names(first)).toEqual(['bravo', 'echo'])
    expect(names(second)).toEqual(['bravo', 'echo'])
    expect(JSON.stringify(second)).toEqual(JSON.stringify(first))
  })
})

describe('AppendStableMemory (the retired per-scope memory)', () => {
  it('remembers each scope independently', () => {
    // Scope keys are objects at runtime (the retired plugin keyed a
    // `WeakMap<ScopeKey, …>`); two distinct keys stand in for two agents.
    const scopeA = { id: 'agent-a' }
    const scopeB = { id: 'agent-b' }
    const memory = new AppendStableMemory<{ id: string }>()
    expect(names(memory.order(scopeA, baseline('alpha', 'zeta')))).toEqual(['alpha', 'zeta'])
    expect(names(memory.order(scopeA, baseline('alpha', 'beta', 'zeta')))).toEqual(['alpha', 'zeta', 'beta'])

    // B's first ordering takes its OWN baseline, not A's sequence.
    expect(names(memory.order(scopeB, baseline('alpha', 'beta')))).toEqual(['alpha', 'beta'])
    // B appends relative to B's own sequence — leaked A state would emit
    // ['alpha', 'zeta', 'beta'] here.
    expect(names(memory.order(scopeB, baseline('alpha', 'beta', 'zeta')))).toEqual(['alpha', 'beta', 'zeta'])
    expect(memory.emitted(scopeA)).toEqual(['alpha', 'zeta', 'beta'])
  })

  it('appends at the tail — the behavior the configured toolOrder no longer reproduces', () => {
    const scope = { id: 'scope' }
    const memory = new AppendStableMemory<{ id: string }>()
    memory.order(scope, baseline('alpha', 'mike', 'zeta'))
    // The retired contract: tail append.
    expect(names(memory.order(scope, baseline('alpha', 'beta', 'mike', 'zeta'))))
      .toEqual(['alpha', 'mike', 'zeta', 'beta'])
    // Accepted 0.2.2-rc.1 delta: `orderTools` re-sorts the unlisted rest bucket
    // on every assembly, so the same activation INSERTS lexicographically.
    expect(names(baseline('alpha', 'beta', 'mike', 'zeta'))).toEqual(['alpha', 'beta', 'mike', 'zeta'])
  })
})
