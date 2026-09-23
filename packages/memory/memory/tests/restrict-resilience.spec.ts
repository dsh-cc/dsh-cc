/**
 * Fail-soft unit spec for the restrict resilience helper (§5.2): pass-through
 * on success, warn-once + single reduced retry on the host's unknown-tool
 * throw, no retry loop on repeat failure, untouched propagation of unrelated
 * errors, and the reset hook re-arming the warn gate.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { harvestUnknownToolNames, resetRestrictWarnState, startWithFilterResilience } from '../src/restrict-resilience.ts'

const PROD_MESSAGE = 'tools.restrict() names unknown global tool "structured_output"; known global tools: read, grep, glob, read_image'

type Request = { toolFilter?: { allow?: readonly string[] } }

function fakeStart(impl: (request: Request) => Promise<unknown>): { start(name: string, request: Request): Promise<{ result: Promise<{ stopReason: string }> }>; calls: Request[] } {
  const calls: Request[] = []
  return {
    calls,
    async start(_name, request) {
      calls.push(request)
      return await impl(request) as { result: Promise<{ stopReason: string }> }
    },
  }
}

const logger = { warn: vi.fn() }

beforeEach(() => {
  resetRestrictWarnState()
  logger.warn.mockClear()
})

describe('harvestUnknownToolNames', () => {
  it('harvests every quoted name before the semicolon', () => {
    expect(harvestUnknownToolNames(PROD_MESSAGE)).toEqual(['structured_output'])
    expect(harvestUnknownToolNames('tools.restrict() names unknown global tools "a", "b"; known: x')).toEqual(['a', 'b'])
    expect(harvestUnknownToolNames('some other error')).toEqual([])
  })
})

describe('startWithFilterResilience', () => {
  it('(a) passes through untouched when start succeeds', async () => {
    const subagents = fakeStart(async () => ({ result: Promise.resolve({ stopReason: 'completed' }) }))
    const run = await startWithFilterResilience(subagents, 'fork', { toolFilter: { allow: ['read', 'structured_output'] } }, logger)
    expect(run).toEqual({ result: expect.any(Promise) })
    expect(subagents.calls).toHaveLength(1)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('(b) warns once and retries once with the dropped name removed', async () => {
    const subagents = fakeStart(async (request) => {
      if (request.toolFilter?.allow.includes('structured_output')) throw new Error(PROD_MESSAGE)
      return { result: Promise.resolve({ stopReason: 'completed' }) }
    })
    const run = await startWithFilterResilience(subagents, 'fork', { toolFilter: { allow: ['read', 'structured_output'] } }, logger)
    expect(run).toEqual({ result: expect.any(Promise) })
    expect(subagents.calls).toHaveLength(2)
    expect(subagents.calls[1]!.toolFilter).toEqual({ allow: ['read'] })
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('(c) propagates when the retry also fails (no retry loop)', async () => {
    const subagents = fakeStart(async () => { throw new Error('tools.restrict() names unknown global tool "ghost"; known: x') })
    await expect(startWithFilterResilience(subagents, 'fork', { toolFilter: { allow: ['ghost'] } }, logger)).rejects.toThrow('ghost')
    expect(subagents.calls).toHaveLength(2)
  })

  it('(d) propagates non-matching errors untouched, without retry', async () => {
    const subagents = fakeStart(async () => { throw new Error('provider "fork" not registered') })
    await expect(startWithFilterResilience(subagents, 'fork', { toolFilter: { allow: ['read'] } }, logger)).rejects.toThrow('not registered')
    expect(subagents.calls).toHaveLength(1)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('(e) the warn gate is once per name per process and re-arms after reset', async () => {
    const subagents = fakeStart(async (request) => {
      if (request.toolFilter?.allow.includes('structured_output')) throw new Error(PROD_MESSAGE)
      return { result: Promise.resolve({ stopReason: 'completed' }) }
    })
    const request: Request = { toolFilter: { allow: ['read', 'structured_output'] } }
    await startWithFilterResilience(subagents, 'fork', request, logger)
    await startWithFilterResilience(subagents, 'fork', request, logger)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    resetRestrictWarnState()
    await startWithFilterResilience(subagents, 'fork', request, logger)
    expect(logger.warn).toHaveBeenCalledTimes(2)
  })
})
