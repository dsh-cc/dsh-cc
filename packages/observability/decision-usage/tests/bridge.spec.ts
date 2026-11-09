/**
 * Root-realm bridge pins (design
 * docs/plans/2026-11-02-systemone-04-memory-extraction-gate.md §"Preset wiring
 * (root-realm bridge)"): `decision-usage` is mounted inside the `cc-services`
 * group with `isolate: { systemoneDecisions: true }`, and a consumer mounted
 * OUTSIDE that group (memory-consolidation, which must stay outside so its forks
 * keep inheriting the parent route) can only reach the service through the root
 * publication `ccSystemoneDecisions`.
 *
 * This is the real plugin mount against a real cordis context — no preset boot,
 * no fakes for the publication path itself. The consumer realm is a sibling
 * plugin fiber directly under root, the same topology the composition uses.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ROOT_BRIDGE_NAME, apply } from '../src/index.ts'
import type { SystemOneDecisionsService } from '../src/service.ts'

const roots: Context[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await root.fiber.dispose()
})

/**
 * Mount one preset-tree stand-in: the decision-usage row inside its isolated
 * `systemoneDecisions` realm, plus a sibling consumer fiber under root.
 */
async function mount(input: { label: string; withConsumer?: boolean }): Promise<{
  root: Context
  group: Context
  fiber: { dispose(): Promise<void> }
  consumer?: Context
}> {
  const root = new Context()
  roots.push(root)
  let consumer: Context | undefined
  if (input.withConsumer === true) {
    await root.plugin({
      name: `consumer-${input.label}`,
      apply(c: Context) {
        consumer = c
      },
    })
  }
  // The cc-services group realm: the decision-usage row is mounted INSIDE it.
  // `isolate()` mints a fresh realm per call, so the context must be kept.
  const group = root.isolate('systemoneDecisions')
  const fiber = await group.plugin({ name: `decision-usage-${input.label}`, apply })
  return { root, group, fiber, ...(consumer === undefined ? {} : { consumer }) }
}

describe('ccSystemoneDecisions root-realm bridge', () => {
  it('a consumer outside the isolate group resolves ccSystemoneDecisions', async () => {
    const { group, consumer } = await mount({ label: 'a', withConsumer: true })
    const groupService = group.get('systemoneDecisions') as SystemOneDecisionsService | undefined
    expect(groupService).toBeDefined()

    // The isolated name is invisible from the consumer's realm — the bridge is
    // the only reachable path, so this test fails if the publication regresses.
    expect(consumer!.get('systemoneDecisions')).toBeUndefined()
    const bridged = consumer!.get(ROOT_BRIDGE_NAME) as SystemOneDecisionsService | undefined
    expect(bridged).toBeDefined()
    expect(bridged).toBe(groupService)
    expect(typeof bridged!.forAgent).toBe('function')

    // Property access works for every realm too (the bridge is a root provide).
    expect((consumer as { ccSystemoneDecisions?: SystemOneDecisionsService }).ccSystemoneDecisions).toBe(bridged)
  })

  it('unload clears the publication only while it points at this tree', async () => {
    // First tree publishes and is the current owner.
    const first = await mount({ label: 'a', withConsumer: true })
    const firstService = first.consumer!.get(ROOT_BRIDGE_NAME) as SystemOneDecisionsService
    expect(firstService).toBeDefined()

    // A second tree takes the root slot over (register-if-absent: set).
    const second = await mount({ label: 'b', withConsumer: true })
    const secondService = second.consumer!.get(ROOT_BRIDGE_NAME) as SystemOneDecisionsService
    expect(secondService).toBeDefined()
    expect(secondService).not.toBe(firstService)

    // The now non-owning tree's unload must NOT clear the live publication.
    await first.fiber.dispose()
    expect(second.consumer!.get(ROOT_BRIDGE_NAME)).toBe(secondService)

    // The owner's unload clears it: the optional contract reads absence as
    // unavailable/unconfigured, never as a fallback route.
    await second.fiber.dispose()
    expect(second.consumer!.get(ROOT_BRIDGE_NAME)).toBeUndefined()
  })
})
