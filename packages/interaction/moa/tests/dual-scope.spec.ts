/**
 * Dual-scope wiring (design §2.3): two REAL preset scopes, each with the
 * plugin applied, and agent-scoped dispatch through production-shaped
 * carriers. The point is the wiring split (§2.2): the shared core is created
 * once, but every apply registers its own listeners on its own scope, so an
 * agent bound to the SECOND tree still reaches moa — and an agent bound to
 * a tree moa was never mounted in reaches nothing.
 *
 * Real machinery on purpose: `isolate()`-only realms never call `createScope`,
 * their contexts are untagged, and an untagged listener is admitted to every
 * carrier — which would make this spec pass on the scope-blind code.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { bindScopeParent, createScope, type Scope } from '@deepseek-ai/dsh-scope'
import type { ModelRoutes } from '@dsh-cc/model-aliases'
import { apply, getMoaCore, resetMoaCore } from '../src/index.ts'
import { resetRuntimeCore } from '../src/runtime-state.ts'
import { BOOT_PAIR, DRAFT_PROBABILITIES, GAUGE_ROUTE, routes as tierRoutes, userOpening } from './rig.ts'

const dirs: string[] = []
/** Set by {@link makeRoot}: the shared dsh home (one ledger, §2.2.6). */
let home = ''

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  vi.unstubAllGlobals()
  resetMoaCore()
  resetRuntimeCore()
})

beforeEach(() => {
  resetMoaCore()
  resetRuntimeCore()
  home = mkdtempSync(join(tmpdir(), 'moa-dual-'))
  dirs.push(home)
  // Canned System One: `draft` is the argmax, so every routed turn logs one
  // route row (the row COUNT is the "which registrations served this event"
  // probe).
  vi.stubGlobal('fetch', async () =>
    new Response(
      JSON.stringify({
        model: GAUGE_ROUTE.model,
        answers: { route: { type: 'choice', choice: 'draft', probabilities: DRAFT_PROBABILITIES } },
        usage: { input_tokens: 100, output_tokens: 5 },
      }),
      { status: 200 },
    ),
  )
})

/** A tree: a real scope key plus the scoped context moa was applied on. */
interface Tree {
  key: object
  scope: Scope
}

/** Apply moa on a fresh preset scope (the standing-mount shape). */
function mountTree(root: Context, label: string): Tree {
  const key = { preset: label }
  const scope = createScope(root, key)
  apply(scope.ctx as never)
  return { key, scope }
}

/** The routing ledger rows written so far (side-car JSONL, one file/process). */
function ledgerRows(): { type?: string; tier?: string }[] {
  const path = join(home, 'moa', 'routing.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { type?: string; tier?: string })
}

/** The describe-shaped settings double the seams read (llm-pi-ai backend). */
function settingsProvider(): object {
  const section = { enabled: true }
  return {
    get: (ns: string) => (ns === 'moa' ? section : undefined),
    register: () => ({ get: () => section }),
    describe: () => [{ ns: 'llm-pi-ai', user: { providers: { gw: { baseURL: 'http://127.0.0.1:9' } } } }],
  }
}

/** A root context with the shared app-level services moa's seams resolve. */
function makeRoot(): Context {
  const root = new Context()
  root.provide('settings', settingsProvider() as never)
  root.provide('ccModelRoutes', tierRoutes() as ModelRoutes as never)
  root.provide('dshHomePath', (...parts: string[]) => join(home, ...parts))
  return root
}

/** A fake main-conversation agent (no session header ⇒ not a subagent). */
function fakeAgent(): { session: { requestHeader: () => { config: typeof BOOT_PAIR } }; inject: () => void } {
  return { session: { requestHeader: () => ({ config: { ...BOOT_PAIR } }) }, inject: () => {} }
}

/** Drive one full routed step through a production-shaped carrier. */
async function fireTurn(
  root: Context,
  agent: ReturnType<typeof fakeAgent>,
  turn: number,
): Promise<{ provider?: string; model?: string }> {
  const dispatch = agentEvents(root, agent as never)
  dispatch.emit('agent/inbox/claimed', { message: userOpening('dual-scope turn'), turn } as never)
  const assembled = { variables: { provider: BOOT_PAIR.provider, model: BOOT_PAIR.model } }
  await dispatch.waterfall(
    'system-prompt/assemble',
    { ...assembled } as never,
    { agent, signal: new AbortController().signal } as never,
    async () => assembled,
  )
  return (await dispatch.waterfall(
    'agent/request',
    { turn, step: 1, signal: new AbortController().signal } as never,
    async () => ({ provider: BOOT_PAIR.provider, model: BOOT_PAIR.model, messages: [] }),
  )) as { provider?: string; model?: string }
}

describe('moa dual-scope wiring (§2.3)', () => {
  it('serves an agent bound to the SECOND tree through exactly one registration', async () => {
    const root = makeRoot()
    const treeA = mountTree(root, 'cc')
    const coreAfterFirstApply = getMoaCore()
    const treeB = mountTree(root, 'vwa')

    // §2.2: the shared core is created once, wiring is per tree.
    expect(getMoaCore()).toBe(coreAfterFirstApply)
    expect(getMoaCore().arming.isArmed()).toBe(true)

    // Per-tree probes on the same event moa wires: whichever tree's scope tag
    // the carrier admits is the tree whose registration runs.
    const hits = { cc: 0, vwa: 0 }
    treeA.scope.ctx.on('agent/inbox/claimed' as never, (() => void hits.cc++) as never)
    treeB.scope.ctx.on('agent/inbox/claimed' as never, (() => void hits.vwa++) as never)

    // The main agent lives in the SECOND tree (the live regression). On the
    // scope-blind code the second apply returned before registering anything,
    // so this carrier reaches no listener at all: no overlay, no ledger row.
    const agent = fakeAgent()
    bindScopeParent(agent, treeB.key)
    const resolved = await fireTurn(root, agent, 1)

    // The keyB registration ran; the keyA one did not.
    expect(hits).toEqual({ cc: 0, vwa: 1 })

    expect(resolved.model).toBe('tier-draft')
    // Exactly ONE registration served the event (two trees running it would
    // log two rows; a first-tree-only registration would log none).
    const rows = ledgerRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.tier).toBe('draft')

    await treeA.scope.dispose()
    await treeB.scope.dispose()
  })

  it('wires BOTH trees: a keyA-parented agent is served by the first one', async () => {
    const root = makeRoot()
    const treeA = mountTree(root, 'cc')
    const treeB = mountTree(root, 'vwa')

    const agent = fakeAgent()
    bindScopeParent(agent, treeA.key)
    const resolved = await fireTurn(root, agent, 2)

    expect(resolved.model).toBe('tier-draft')
    expect(ledgerRows()).toHaveLength(1)

    await treeA.scope.dispose()
    await treeB.scope.dispose()
  })

  it('reaches NEITHER tree for an agent parented to a third, unmounted scope', async () => {
    const root = makeRoot()
    const treeA = mountTree(root, 'cc')
    const treeB = mountTree(root, 'vwa')

    const agent = fakeAgent()
    bindScopeParent(agent, { preset: 'unmounted' })
    const resolved = await fireTurn(root, agent, 3)

    // No overlay, no ledger row anywhere: a root/untagged registration — the
    // rejected alternative fix — would fail exactly here.
    expect(resolved.model).toBe(BOOT_PAIR.model)
    expect(ledgerRows()).toEqual([])

    await treeA.scope.dispose()
    await treeB.scope.dispose()
  })
})
