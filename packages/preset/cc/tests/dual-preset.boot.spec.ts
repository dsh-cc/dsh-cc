/**
 * Dual-preset real boot (mixed-MCP-singleton plan
 * docs/plans/2026-10-23-mcp-mount-singleton.md §F): both `preset-cc` and
 * `preset-vwa` standing-mount the shared `cc-services` body, hence the
 * `cc-shell-glue` row, twice in one runtime. This spec mounts that row twice
 * in two separate isolate realms (the per-preset mount shape) on ONE root and
 * asserts the MCP singleton contract:
 *
 * 1. both trees resolve the SAME `mcpConnections` registry (same entry
 *    objects — the service lookup returns per-context proxies, so identity is
 *    observed through the registry contents), and
 * 2. one `.mcp.json` server is mounted exactly ONCE (a single mcp-client
 *    fiber under the root; the second tree's mount is a no-op), and
 * 3. the shared registry is populated after boot.
 *
 * The isolate keys are read from the real `agent.shared.cordis.yml` group so
 * the boot shape tracks the composition instead of a hand-copied list.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply } from '@dsh-cc/bundle-shell/src/index.ts'

const req = createRequire(import.meta.url)
const includePkg = req.resolve('@deepseek-ai/cordis-plugin-include/package.json')
const yaml = createRequire(includePkg)('js-yaml') as typeof import('js-yaml')
const sharedRows = yaml.load(readFileSync(new URL('../agent.shared.cordis.yml', import.meta.url), 'utf8'), {
  schema: entryListSchema,
}) as any[]

/** The cc-services group isolate realm, as the preset declares it. */
const CC_SERVICES_ISOLATE: string[] = Object.keys(
  sharedRows.find((row) => row.id === 'cc-services')?.isolate ?? {},
)

// A real stdio MCP server (self-executing fixture), same one mcp-client's own
// e2e suite uses — no npx/uv spawn.
const fixtureServerPath = new URL('../../../../packages/mcp/mcp-client/tests/fixture-server.ts', import.meta.url).pathname

let tmp: string
let mcpConfigFile: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'preset-dual-boot-'))
  mcpConfigFile = join(tmp, '.mcp.json')
  writeFileSync(
    mcpConfigFile,
    JSON.stringify({
      mcpServers: {
        probe: { type: 'stdio', command: process.execPath, args: [fixtureServerPath] },
      },
    }),
  )
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function isolateGroup(root: Context, names: readonly string[]): Context {
  let group = root
  for (const name of names) group = group.isolate(name)
  return group
}

/** The slice of the root-published registry this test reads. */
interface RegistryLike {
  entries(): { name: string; state: string }[]
}

function registry(ctx: Context): RegistryLike {
  return ctx.get('mcpConnections') as RegistryLike
}

/** Live mcp-client fibers under the root — the process-mount count. */
function mcpClientFibers(root: Context): number {
  let count = 0
  for (const runtime of root.registry.values()) {
    if (runtime.name !== 'mcp-client') continue
    count += runtime.fibers.length
  }
  return count
}

describe('dual-preset boot: MCP singleton', () => {
  it('both preset trees share one mcpConnections registry and mount one .mcp.json server once', async () => {
    const root = new Context()
    root.provide('commands', { register: () => () => {} })
    // ToolRuntime injects `systemPrompt`; a section-registering stub is all it
    // needs, and mcp-client only requires the `tools` service.
    root.provide('systemPrompt', {
      tools: () => () => {},
      section: () => () => {},
      getSectionOrder: () => 0,
    })
    await root.plugin(ToolRuntime)

    // Two preset trees: the same shared body row in two isolate realms.
    const ccTree = isolateGroup(root, CC_SERVICES_ISOLATE)
    const vwaTree = isolateGroup(root, CC_SERVICES_ISOLATE)
    const config = { pluginDirs: [], mcpConfigFiles: [mcpConfigFile] }
    const ccFiber = await ccTree.plugin({ name: 'cc-shell-glue', apply }, config)
    const vwaFiber = await vwaTree.plugin({ name: 'cc-shell-glue', apply }, config)

    // 1. Same registry in both trees. `entries()` returns snapshot copies, so
    // identity is observed through both realms seeing the same entry (a
    // per-tree registry would leave the second one empty — the design's
    // original bug) and through the single mcp-client fiber below.
    expect(registry(ccTree)).toBeDefined()
    expect(registry(vwaTree)).toBeDefined()
    await vi.waitFor(() => {
      expect(registry(ccTree).entries().map((e) => e.name)).toEqual(['probe'])
      expect(registry(vwaTree).entries().map((e) => e.name)).toEqual(['probe'])
    })

    // 2. One server, one fiber: the second tree's mount was a no-op.
    expect(mcpClientFibers(root)).toBe(1)

    // 3. Non-empty registry, and the fixture server is actually connected.
    await vi.waitFor(() => {
      expect(registry(ccTree).entries().find((e) => e.name === 'probe')?.state).toBe('ready')
    })
    await vi.waitFor(() => {
      expect((root.tools.schemas() as { name: string }[]).map((s) => s.name)).toContain('mcp__probe__add')
    })

    await vwaFiber.dispose()
    await ccFiber.dispose()
    await root.fiber.dispose()
  })
})
