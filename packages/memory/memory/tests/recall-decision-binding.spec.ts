/**
 * Recall decision binding pins (issue #368): the memory plugin must resolve
 * the optional `systemoneDecisions` service PER USE, not once at apply time.
 *
 * The preset loader mounts a group's children concurrently (`EntryGroup.update`
 * uses `Promise.all`), and a strict `ctx.get` at apply time cannot see a sibling
 * whose fiber is not ACTIVE yet — a one-shot apply-time capture is therefore
 * structurally `undefined` in every real boot, which is why the recall decision
 * arm never dispatched (issue #368's four-layer evidence chain).
 *
 * The regression below reproduces that schedule deterministically: the
 * provider's fiber is gated behind a test-owned deferred that resolves only
 * after the consumer's apply has completed, so the apply-time strict `get` is
 * `undefined` BY CONSTRUCTION (the pinned mechanism is the strict non-ACTIVE
 * filter; in production the overlap comes from the loader's concurrent mount).
 *
 * The shared realm is built with `root.isolate('systemoneDecisions', …)`, which
 * mirrors the loader's shared-realm seeding (the same isolate symbol for
 * provider and consumer). Do not "simplify" this back to a bare root: without
 * the shared realm the provider's slot is invisible to the consumer and the
 * test degenerates.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply as applyMemory, recallDecisionsFor } from '../src/index.ts'
import { FakeMemoryFs } from './helpers.ts'

/** A valid shadow-mode settings section the fake settings service serves. */
const SETTINGS_SECTION: Record<string, unknown> = {
  mode: 'shadow',
  'include-probability': 0.75,
  'exclude-probability': 0.25,
  'max-candidates': 96,
  'batch-size': 24,
  'timeout-ms': 60000,
  'max-input-tokens': 6000,
  'fallback-max-candidates': 256,
  'fallback-max-bytes': 65536,
}

/** One session-log event face used by the origin lookup: the turn's own anchor. */
function turnStart(seq: number): unknown {
  return { type: 'turn/start', seq, time: 1_700_000_000_000 + seq, data: { turn: seq } }
}

/** A top-level agent whose log carries exactly one turn anchor (the #360 shape). */
function topLevelAgent(): Agent {
  return {
    session: {
      header: { cwd: '/work/repo' },
      snapshotEvents: () => [turnStart(9)],
    },
  } as unknown as Agent
}

/** The genuine claimed batch of a real pre-step: one true user message. */
const GENUINE_MESSAGES = [
  { content: [{ type: 'text', text: 'how do I use bash?' }], source: { kind: 'user' } },
]

/** A recording fake activation sink for the legacy branch. */
const subagentsSink = {
  startActivation: async () => ({
    childId: 'child',
    result: Promise.resolve({ stopReason: 'completed', structured: { files: [] } }),
    dispose: () => Promise.resolve(),
  }),
}

/** Drive one pre-step through the mounted wiring (the rig's discipline: same ctx). */
function drivePreStep(ctx: Context, agent: Agent): void {
  void ctx.emit('agent/pre-step', {
    agent,
    messages: GENUINE_MESSAGES,
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  } as never, async () => ({ kind: 'enter', messages: [] }) as never)
}

/** Poll until the predicate holds (the fire-and-forget sidecar settles async). */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('recall decision binding (issue #368)', () => {
  it('resolves the service per use after a concurrent mount where the apply-time capture reads undefined', async () => {
    const home = mkdtempSync(join(tmpdir(), 'recall-binding-'))
    const ctx = new Context()
    await ctx.plugin(FakeMemoryFs)
    ctx.provide('systemPrompt' as never, { section: () => {} } as never)
    ctx.provide('subagents' as never, subagentsSink as never)
    ctx.provide('settings' as never, {
      register: () => ({ get: () => SETTINGS_SECTION }),
      get: () => SETTINGS_SECTION,
    } as never)

    const realm = ctx.isolate('systemoneDecisions', Symbol('cc-services'))
    let openGate!: () => void
    const gate = new Promise<void>(resolve => { openGate = resolve })
    const agentsPassed: Agent[] = []
    let probeApplyTimeGet: unknown = 'not-run'
    let memoryCtx!: Context

    // The gated provider: its provide happens only after the gate opens, so its
    // fiber is provably not ACTIVE while the siblings' applies run.
    const provider = {
      name: 'decision-usage-fake',
      async apply(c: Context) {
        await gate
        c.provide('systemoneDecisions', {
          forAgent: (agent: Agent) => {
            agentsPassed.push(agent)
            return { identifyRoute: () => undefined, scope: () => ({}) }
          },
        } as never)
      },
    }
    const probe = {
      name: 'probe',
      apply(c: Context) {
        probeApplyTimeGet = c.get('systemoneDecisions')
      },
    }
    // The real wiring, mounted as a plugin the way the loader mounts a row.
    const memoryPlugin = {
      name: 'memory-under-test',
      apply: (c: Context) => {
        memoryCtx = c
        applyMemory(c, { sectionEnabled: false, memoryHome: home })
      },
    }

    const providerFiber = realm.plugin(provider as never)
    await Promise.all([realm.plugin(probe as never), realm.plugin(memoryPlugin as never)])

    // The mechanism pin: the probe's apply-time strict get is undefined BY
    // CONSTRUCTION (the provider's fiber is still gated). If this ever fails,
    // the gate leaked or cordis dropped the strict non-ACTIVE filter —
    // revisit the design before touching the fixture.
    expect(probeApplyTimeGet).toBeUndefined()

    // Open the gate: the provider activates; the wiring under test settles.
    openGate()
    await providerFiber

    // THE WIRING: one pre-step through the real mounted apply must reach the
    // provider's forAgent. With the old apply-time capture this never happens
    // (the capture read `undefined`, the sidecar skipped `no-service`).
    // The driven agent is marked: the event layer may wrap payloads in
    // diagnostics proxies, so identity is asserted through the marker.
    const marker = Symbol('driven-agent')
    const driven = topLevelAgent()
    ;(driven as unknown as { marker?: symbol }).marker = marker
    drivePreStep(memoryCtx, driven)
    await until(() => agentsPassed.length > 0, 'forAgent to receive the driven agent')
    expect((agentsPassed[0] as unknown as { marker?: symbol }).marker).toBe(marker)

    await ctx.fiber.dispose()
  })

  it('resolves fresh per invocation across provider replacement (same closure)', async () => {
    const ctx = new Context()
    const realm = ctx.isolate('systemoneDecisions', Symbol('reload'))
    const resolve = recallDecisionsFor(realm)
    const agent = topLevelAgent()

    expect(resolve(agent)).toBeUndefined()

    const first = await realm.plugin({
      name: 'provider-a',
      apply: (c: Context) => { c.provide('systemoneDecisions', { forAgent: () => 'binding-a' } as never) },
    } as never)
    expect(resolve(agent)).toBe('binding-a')

    await first.dispose()
    expect(resolve(agent)).toBeUndefined()

    await realm.plugin({
      name: 'provider-b',
      apply: (c: Context) => { c.provide('systemoneDecisions', { forAgent: () => 'binding-b' } as never) },
    } as never)
    expect(resolve(agent)).toBe('binding-b')

    await ctx.fiber.dispose()
  })

  it('a throwing forAgent reads as absent for that use, never rejects into the caller', async () => {
    const ctx = new Context()
    const realm = ctx.isolate('systemoneDecisions', Symbol('throwing'))
    await realm.plugin({
      name: 'provider-throwing',
      apply: (c: Context) => {
        c.provide('systemoneDecisions', {
          forAgent: () => { throw new Error('quota scope mint failed') },
        } as never)
      },
    } as never)
    expect(recallDecisionsFor(realm)(topLevelAgent())).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
