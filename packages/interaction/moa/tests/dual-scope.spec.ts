/**
 * Dual-scope wiring (design §2.3, harness-0.2.2 D3.2 form): two REAL preset
 * scopes, each with the plugin applied, and agent-scoped dispatch through
 * production-shaped carriers. The wiring split (§2.2) stands: the shared
 * core is created once, and every apply registers its own LISTENERS on its
 * own scope (claimed bind, pre-step rows, judge) — the agent bound to the
 * tree STILL reaches exactly one registration. What changed: classification
 * moved out of the waterfall into the entry-point admission seam, which a
 * DRIVER calls directly (no scope dispatch — the apply()-registered entry
 * delegates to the live router). Production composes ONE TUI tree, so the
 * last-apply-wins admission entry is the live one; the residual cross-tree
 * mix (treeA-parented batch claims bind nothing when treeB's router holds
 * the pending admission) is pinned here as documented behavior.
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
import { apply, getMoaCore, resetMoaCore, routeBeforeAdmission } from '../src/index.ts'
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
  // route row at its claim bind (the row COUNT is the "which registrations
  // served this event" probe).
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

/**
 * Poll the ledger until it holds `count` rows (the claim bind's append is
 * fire-scheduled behind the synchronous dispatch — same race pollJsonl
 * covers in judge-loop).
 */
async function pollLedgerRows(count: number): Promise<{ type?: string; tier?: string }[]> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const rows = ledgerRows()
    if (rows.length >= count) return rows
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return ledgerRows()
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
function fakeAgent(): {
  options: { provider: string; model: string }
  model: { current(): { provider: string; model: string } | undefined; select(s: { provider: string; model: string }): void }
  session: { requestHeader(): undefined }
  inject: () => void
} {
  const selected: { provider: string; model: string }[] = []
  return {
    options: { ...BOOT_PAIR },
    model: {
      current: () => selected.at(-1) ?? { ...BOOT_PAIR },
      select: (s) => selected.push(s),
    },
    session: { requestHeader: () => undefined },
    inject: () => {},
  }
}

/** Drive one full D3.2 turn through a production-shaped carrier. */
async function fireTurn(
  root: Context,
  agent: ReturnType<typeof fakeAgent>,
  turn: number,
): Promise<void> {
  const opening = userOpening('dual-scope turn')
  // The driver contract: classify BEFORE the followup equivalent (the claim
  // below). The admission entry is the apply()-registered one.
  await routeBeforeAdmission(agent as never, opening)
  const dispatch = agentEvents(root, agent as never)
  dispatch.emit('agent/inbox/claimed', { message: opening, turn } as never)
  await dispatch.waterfall(
    'agent/pre-step',
    { agent, turn, step: 1, messages: [], signal: new AbortController().signal } as never,
    async () => ({ kind: 'enter', messages: [] }) as never,
  )
}

describe('moa dual-scope wiring (§2.3, D3.2 form)', () => {
  it('serves an agent bound to the SECOND tree through exactly one registration', async () => {
    const root = makeRoot()
    const treeA = mountTree(root, 'cc')
    const coreAfterFirstApply = getMoaCore()
    const treeB = mountTree(root, 'vwa')

    // §2.2: the shared core is created once, listeners are per tree.
    expect(getMoaCore()).toBe(coreAfterFirstApply)
    expect(getMoaCore().arming.isArmed()).toBe(true)

    // Per-tree probes: whichever tree's scope tag the carrier admits is the
    // tree whose registration runs.
    const hits = { cc: 0, vwa: 0 }
    treeA.scope.ctx.on('agent/inbox/claimed' as never, (() => void hits.cc++) as never)
    treeB.scope.ctx.on('agent/inbox/claimed' as never, (() => void hits.vwa++) as never)

    // The main agent lives in the SECOND tree. On the scope-blind code no
    // listener would fire for it at all: no bind, no ledger row.
    const agent = fakeAgent()
    bindScopeParent(agent, treeB.key)
    await fireTurn(root, agent, 1)

    // The keyB registration ran; the keyA one did not.
    expect(hits).toEqual({ cc: 0, vwa: 1 })

    // The admission select landed (tier-draft) and exactly ONE registration
    // bound the turn (two trees running the bind would log two rows).
    expect(agent.model.current()).toEqual({ provider: 'mock', model: 'tier-draft' })
    const rows = await pollLedgerRows(1)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.tier).toBe('draft')

    await treeA.scope.dispose()
    await treeB.scope.dispose()
  })

  it('an agent parented to the FIRST tree: its claimed events run the FIRST tree only (documented cross-tree residual: the single live admission entry is the last-applied router)', async () => {
    const root = makeRoot()
    const treeA = mountTree(root, 'cc')
    const treeB = mountTree(root, 'vwa')

    const hits = { cc: 0, vwa: 0 }
    treeA.scope.ctx.on('agent/inbox/claimed' as never, (() => void hits.cc++) as never)
    treeB.scope.ctx.on('agent/inbox/claimed' as never, (() => void hits.vwa++) as never)

    const agent = fakeAgent()
    bindScopeParent(agent, treeA.key)
    await fireTurn(root, agent, 2)

    // Dispatch honors the scope tag: only treeA's listeners ran.
    expect(hits).toEqual({ cc: 1, vwa: 0 })
    // Residual (documented): the module-global admission entry delegates to
    // the LAST applied tree's router, so treeA's claim finds no pending
    // admission to bind — no ledger row, even though the scope-tagged
    // listeners fired correctly. Production composes ONE TUI tree.
    expect(await pollLedgerRows(0)).toEqual([])

    await treeA.scope.dispose()
    await treeB.scope.dispose()
  })

  it('reaches NEITHER tree for an agent parented to a third, unmounted scope', async () => {
    const root = makeRoot()
    const treeA = mountTree(root, 'cc')
    const treeB = mountTree(root, 'vwa')

    const agent = fakeAgent()
    bindScopeParent(agent, { preset: 'unmounted' })
    await fireTurn(root, agent, 3)

    // No listener anywhere binds the turn: a root/untagged registration —
    // the rejected alternative fix — would fail exactly here.
    expect(await pollLedgerRows(0)).toEqual([])

    await treeA.scope.dispose()
    await treeB.scope.dispose()
  })
})
