/**
 * Tests for the Slice 3 promotion-registry publication (collector doc §6 /
 * UX plan §4 Slice 3 item 4): the cc-subagent-task plugin publishes the
 * collector registry as the ROOT-realm `ccCollectorRegistry` service
 * (command-agents `ccAgents` pattern), reclaiming the slot after an unload
 * and clearing it on unload so host-plane consumers (the TUI) degrade to
 * "nothing promotable" instead of holding a dead registry.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import * as taskPlugin from '../src/index.ts'
import { registerCollector, unregisterCollector, collectorKey } from '../src/epoch-collector.ts'

interface RegistryService {
  collectorFor(key: string): { childId: string } | undefined
  collectorsForSession(parentSessionId: string): { childId: string }[]
  registeredCollectorCount(): number
}

async function mounted(): Promise<{ ctx: Context; fiber: Fiber }> {
  const ctx = new Context()
  const fiber = ctx.plugin(taskPlugin)
  await fiber.await()
  return { ctx, fiber }
}

describe('ccCollectorRegistry root-realm publication', () => {
  it('publishes the registry service on the root context, resolving live collectors', async () => {
    const { ctx, fiber } = await mounted()
    const service = ctx.get('ccCollectorRegistry') as RegistryService | undefined
    expect(service).toBeDefined()
    expect(service!.collectorsForSession('parent-1')).toEqual([])
    const handle = { childId: 'c-1', promote: () => {}, abort: () => {} }
    registerCollector(collectorKey('parent-1', 'call-1'), handle)
    try {
      expect(service!.collectorsForSession('parent-1').map(h => h.childId)).toEqual(['c-1'])
      expect(service!.collectorFor(collectorKey('parent-1', 'call-1'))?.childId).toBe('c-1')
      expect(service!.registeredCollectorCount()).toBe(1)
    } finally {
      // Restore the module-global map for later tests.
      const { unregisterCollector } = await import('../src/epoch-collector.ts')
      unregisterCollector(collectorKey('parent-1', 'call-1'))
    }
    await fiber.dispose()
  })

  it('the unload effect clears the root publication so consumers degrade to undefined', async () => {
    const { ctx, fiber } = await mounted()
    expect(ctx.get('ccCollectorRegistry')).toBeDefined()
    await fiber.dispose()
    expect((ctx as unknown as { root: Context }).root.get('ccCollectorRegistry', false)).toBeUndefined()
  })
})

describe('ccOneShotLedger root-realm publication (/resume filter seam)', () => {
  it('publishes the one-shot ledger face; with no runs the one-shot set is empty', async () => {
    const { ctx, fiber } = await mounted()
    const service = ctx.get('ccOneShotLedger') as { oneShotChildIds(): ReadonlySet<string> } | undefined
    expect(service).toBeDefined()
    expect(service!.oneShotChildIds().size).toBe(0)
    await fiber.dispose()
  })
})
