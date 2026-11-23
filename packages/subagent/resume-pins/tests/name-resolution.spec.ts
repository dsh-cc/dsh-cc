/**
 * Fail-soft service reads for the rc.5 name seam.
 *
 * The production bug (2026-11-21): `ctx.subagents` read as a PROPERTY from a
 * foreign isolate realm throws `cannot get property "subagents" without
 * inject` instead of returning undefined. Both reads sit outside the helpers'
 * try blocks, so the throw escaped the documented fail-soft contract and
 * replaced the whole `list_agents` / `send_message` tool result with an error.
 * These pins keep every lookup — including the `ctx.get` accessor lookup and
 * the service method invocation — inside the fail-soft region.
 */
import { describe, expect, it } from 'vitest'
import { agentsOf, renderedAgentAddresses, resolveSendTarget } from '../src/name-resolution.ts'

const SIGNAL = new AbortController().signal
const PARENT = { id: 'parent' }

function fakeSubagents() {
  return {
    resolveName: async (_caller: unknown, agent: string) => `sid:${agent}`,
    rootOf: () => ({ id: 'root' }),
    listDescendants: async () => [{ id: 'child-77', path: 'lead/researcher' }],
  }
}

/** A realm-guarded ctx: the service property throws, the method form works. */
function realmGuardedCtx(service: unknown): Record<string, unknown> {
  const ctx: Record<string, unknown> = {
    get(name: string) { return name === 'subagents' ? service : undefined },
  }
  Object.defineProperty(ctx, 'subagents', {
    configurable: true,
    get() { throw new Error('cannot get property "subagents" without inject') },
  })
  return ctx
}

describe('subagentsOf via resolveSendTarget / renderedAgentAddresses', () => {
  it('rescues a realm-guarded property read through the ctx.get method form', async () => {
    const ctx = realmGuardedCtx(fakeSubagents())
    await expect(resolveSendTarget(ctx, PARENT, 'researcher', SIGNAL)).resolves.toBe('sid:researcher')
    const addresses = await renderedAgentAddresses(ctx, PARENT, SIGNAL)
    expect(addresses?.get('child-77')).toEqual(['child-77', 'lead/researcher'])
  })

  it('degrades to undefined when the property throws and no method form exists', async () => {
    const ctx: Record<string, unknown> = {}
    Object.defineProperty(ctx, 'subagents', {
      configurable: true,
      get() { throw new Error('cannot get property "subagents" without inject') },
    })
    await expect(resolveSendTarget(ctx, PARENT, 'researcher', SIGNAL)).resolves.toBeUndefined()
    await expect(renderedAgentAddresses(ctx, PARENT, SIGNAL)).resolves.toBeUndefined()
  })

  it('reads the property form on a plain literal rig that has no ctx.get', async () => {
    const ctx = { subagents: fakeSubagents() }
    await expect(resolveSendTarget(ctx, PARENT, 'researcher', SIGNAL)).resolves.toBe('sid:researcher')
  })

  it('never lets a throwing ctx.get accessor escape the fail-soft contract', async () => {
    const ctx: Record<string, unknown> = {}
    Object.defineProperty(ctx, 'get', {
      configurable: true,
      get() { throw new Error('hostile proxy') },
    })
    Object.defineProperty(ctx, 'subagents', {
      configurable: true,
      get() { throw new Error('cannot get property "subagents" without inject') },
    })
    await expect(resolveSendTarget(ctx, PARENT, 'researcher', SIGNAL)).resolves.toBeUndefined()
    await expect(renderedAgentAddresses(ctx, PARENT, SIGNAL)).resolves.toBeUndefined()
  })

  it('prefers a defined method result over an undefined property member', async () => {
    const service = fakeSubagents()
    const ctx = {
      subagents: undefined,
      get: (name: string) => name === 'subagents' ? service : undefined,
    }
    await expect(resolveSendTarget(ctx, PARENT, 'researcher', SIGNAL)).resolves.toBe('sid:researcher')
  })

  it('falls back to a stamped member when the real-Context form of get resolves nothing', async () => {
    // Mirrors gate-persistence.spec.ts: a real cordis Context with the service
    // stamped as a plain member is invisible to ctx.get, so the property form
    // must keep working (method-first must not lose those rigs).
    const ctx = { get: () => undefined, subagents: fakeSubagents() }
    await expect(resolveSendTarget(ctx, PARENT, 'researcher', SIGNAL)).resolves.toBe('sid:researcher')
  })
})

describe('agentsOf (resume-gate liveness registry)', () => {
  it('rescues a realm-guarded registry read through the ctx.get method form', () => {
    const registry = { get: () => ({ status: 'running' }) }
    const ctx: Record<string, unknown> = {
      get(name: string) { return name === 'agents' ? registry : undefined },
    }
    Object.defineProperty(ctx, 'agents', {
      configurable: true,
      get() { throw new Error('cannot get property "agents" without inject') },
    })
    expect(agentsOf(ctx)).toBe(registry)
  })

  it('returns undefined when neither form can produce the registry', () => {
    const ctx: Record<string, unknown> = {}
    Object.defineProperty(ctx, 'agents', {
      configurable: true,
      get() { throw new Error('cannot get property "agents" without inject') },
    })
    expect(agentsOf(ctx)).toBeUndefined()
  })
})
