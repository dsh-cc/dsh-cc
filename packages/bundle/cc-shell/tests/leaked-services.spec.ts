/**
 * Glue-only leakedServices boot: the yaml isolate-map pin would not catch a
 * new `c.provide('foo')` landing without a matching isolate key. Mount the
 * glue under the cc-services isolate map and assert the same gate the preset
 * mount uses — empty pluginDirs/mcpConfigFiles is enough to fire the four
 * child provides (`mcpConnections`, `mcp`, plus host-realm `ccPlugins` /
 * `ccPluginManager`).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import * as HooksClaude from '@dsh-cc/hooks-claude-code'

/** cc-services isolate keys from packages/preset/cc/agent.cordis.yml. */
const CC_SERVICES_ISOLATE = [
  'toolSearch',
  'microcompactor',
  'ccModelRoutes',
  'resumePinStore',
  'mcpConnections',
  'hookBridgeStatus',
  'mcp',
  'hooks',
] as const

interface FiberLike {
  parent: { fiber: FiberLike }
}

/**
 * Local copy of `@deepseek-ai/dsh-agent-presets` `leakedServices` +
 * `withinFiber` (cc-shell has no agent-presets dependency). Keep in lockstep
 * with harness `packages/preset/agent-presets/src/mount.ts`.
 */
function leakedServices(ctx: Context, mount: FiberLike): string[] {
  const store = ctx.reflect.store
  const rootIsolate = ctx.root[Context.isolate]
  const leaked: string[] = []
  for (const key of Object.getOwnPropertySymbols(store)) {
    const impl = store[key]
    if (impl === undefined) continue
    if (!withinFiber(impl.fiber, mount)) continue
    if (rootIsolate[impl.name] === key) leaked.push(impl.name)
  }
  return leaked.sort((left, right) => left.localeCompare(right))
}

function withinFiber(fiber: FiberLike, root: FiberLike): boolean {
  let current = fiber
  while (true) {
    if (current === root) return true
    const parent = current.parent.fiber
    if (parent === current) return false
    current = parent
  }
}

function isolateGroup(root: Context, names: readonly string[]): Context {
  let group = root
  for (const name of names) group = group.isolate(name)
  return group
}

let tmp: string
let previous: Record<'DSH_HOME' | 'CLAUDE_CONFIG_DIR' | 'HOME', string | undefined>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cc-shell-leaked-'))
  previous = {
    DSH_HOME: process.env.DSH_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    HOME: process.env.HOME,
  }
  mkdirSync(join(tmp, 'dsh'), { recursive: true })
  mkdirSync(join(tmp, 'claude'), { recursive: true })
  mkdirSync(join(tmp, 'home'), { recursive: true })
  process.env.DSH_HOME = join(tmp, 'dsh')
  process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude')
  process.env.HOME = join(tmp, 'home')
})

afterEach(() => {
  for (const key of ['DSH_HOME', 'CLAUDE_CONFIG_DIR', 'HOME'] as const) {
    if (previous[key] === undefined) delete process.env[key]
    else process.env[key] = previous[key]
  }
  rmSync(tmp, { recursive: true, force: true })
})

describe('cc-shell glue leakedServices (cc-services isolate map)', () => {
  it('publishes no process-global services when the seven isolate keys are set', async () => {
    const root = new Context()
    root.provide('commands', { register: () => () => {} })
    const group = isolateGroup(root, CC_SERVICES_ISOLATE)
    const glue = group.plugin({ name: 'cc-shell-glue', apply }, { pluginDirs: [], mcpConfigFiles: [] })
    const fiber = await glue
    expect(leakedServices(root, fiber)).toEqual([])
    expect(group.get('mcp')).toBeDefined()
    expect(group.get('mcpConnections')).toBeDefined()
    await fiber.dispose()
    await root.fiber.dispose()
  })

  it('flags mcp when that isolate key is missing (the #8 leak)', async () => {
    const root = new Context()
    root.provide('commands', { register: () => () => {} })
    const group = isolateGroup(root, CC_SERVICES_ISOLATE.filter(name => name !== 'mcp'))
    const glue = group.plugin({ name: 'cc-shell-glue', apply }, { pluginDirs: [], mcpConfigFiles: [] })
    const fiber = await glue
    expect(leakedServices(root, fiber)).toEqual(['mcp'])
    await fiber.dispose()
    await root.fiber.dispose()
  })

  it('flags hooks when that isolate key is missing and the bridge mounts inside the group', async () => {
    const root = new Context()
    root.provide('commands', { register: () => () => {} })
    // The bridge injects ['shell']; a stub is enough for a mount-only probe.
    root.provide('shell', {})
    // The hooks bridge (the `hooks` seam provider) mounts inside cc-services
    // in the preset; mounting it here reproduces the leak the missing key
    // would cause at preset time. No configPath → no boot hooks, but the
    // bridge still provides `hooks` (unconditionally) and `hookBridgeStatus`.
    const group = isolateGroup(root, CC_SERVICES_ISOLATE.filter(name => name !== 'hooks'))
    const bridge = group.plugin(HooksClaude, { configPath: join(tmp, 'nonexistent-hooks.json') })
    const fiber = await bridge
    expect(leakedServices(root, fiber)).toEqual(['hooks'])
    await fiber.dispose()
    // With the full isolate map, the same mount leaks nothing.
    const okGroup = isolateGroup(root, CC_SERVICES_ISOLATE)
    const ok = okGroup.plugin(HooksClaude, { configPath: join(tmp, 'nonexistent-hooks.json') })
    const okFiber = await ok
    expect(leakedServices(root, okFiber)).toEqual([])
    await okFiber.dispose()
    await root.fiber.dispose()
  })
})
