/**
 * Runtime-level singleton semantics for the cc-shell MCP helpers:
 * one `mcpConnections` registry per root realm and one mounted mcp-client
 * fiber per `serverName`. Both preset standing mounts share a root, so the
 * second mount must become a no-op instead of tripping the mcp-client
 * `serverName` reservation.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ensureMcpConnections, mountMcpServerOnce } from '../src/mcpSingleton.ts'

const roots: Context[] = []

afterEach(async () => {
  for (const root of roots) await root.fiber.dispose()
  roots.length = 0
})

/** A bare runtime root, torn down after the test. */
function makeRoot(): Context {
  const root = new Context()
  roots.push(root)
  return root
}

/** Config-capturing fake of the mcp-client namespace plugin (no real server). */
function fakeClient(options: { failTimes?: number } = {}): {
  plugin: object
  mounts: string[]
  state: { attempts: number }
} {
  const mounts: string[] = []
  const state = { attempts: 0 }
  const plugin = {
    name: 'fake-mcp-client',
    apply(c: Context, config: { serverName: string }) {
      state.attempts++
      if (options.failTimes !== undefined && state.attempts <= options.failTimes) throw new Error('boom')
      mounts.push(config.serverName)
      c.fiber.effect(() => () => {})
    },
  }
  return { plugin, mounts, state }
}

describe('ensureMcpConnections', () => {
  it('returns the same root-published instance on repeated calls', async () => {
    const root = makeRoot()
    const first = await ensureMcpConnections(root)
    const second = await ensureMcpConnections(root)

    expect(Object.is(second, first)).toBe(true)
    expect(root.get('mcpConnections')).toBeDefined()
    expect(Array.isArray(first.entries())).toBe(true)
  })
})

describe('mountMcpServerOnce', () => {
  it('mounts a given serverName at most once', async () => {
    const root = makeRoot()
    const { plugin, mounts } = fakeClient()
    const config = { serverName: 'alpha' }

    await mountMcpServerOnce(root, plugin, config)
    await mountMcpServerOnce(root, plugin, config)

    expect(mounts).toEqual(['alpha'])
  })

  it('dedupes concurrent mounts of the same serverName (one shared in-flight mount)', async () => {
    const root = makeRoot()
    const { plugin, mounts } = fakeClient()
    const config = { serverName: 'beta' }

    await Promise.all([
      mountMcpServerOnce(root, plugin, config),
      mountMcpServerOnce(root, plugin, config),
    ])

    expect(mounts).toEqual(['beta'])
  })

  it('clears the dedupe entry on failure so a retry can re-attempt', async () => {
    const root = makeRoot()
    const { plugin, mounts, state } = fakeClient({ failTimes: 1 })
    const config = { serverName: 'gamma' }

    await expect(mountMcpServerOnce(root, plugin, config)).rejects.toThrow('boom')
    await expect(mountMcpServerOnce(root, plugin, config)).resolves.toBeUndefined()

    expect(state.attempts).toBe(2)
    expect(mounts).toEqual(['gamma'])
  })
})
