import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as permissionRulesInvariant from '@dsh-cc/permission-rules/invariant'
import { name, inject } from '@dsh-cc/permission-rules/invariant'
import { assertPermissionModeEvent } from '../src/invariant.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

function modeEvent(data: unknown): SessionEvent {
  return { type: 'permission/mode', data } as unknown as SessionEvent
}

describe('permission-rules invariant companion', () => {
  it('declares the loader-safe companion exports', () => {
    expect(name).toBe('cc-permission-rules-invariant')
    expect(inject).toContain('invariants')
    expect('default' in permissionRulesInvariant).toBe(false)
  })

  it('registers and disposes through the invariant service', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const dispose = await permissionRulesInvariant.apply(ctx)
    expect(typeof dispose).toBe('function')
    dispose()
  })
})

describe('permission/mode event validation', () => {
  it('accepts a switchable mode without resumeSandbox', () => {
    const fail = vi.fn()
    assertPermissionModeEvent(modeEvent({ mode: 'acceptEdits' }), fail)
    expect(fail).not.toHaveBeenCalled()
  })

  it('accepts a switchable mode with a valid resumeSandbox', () => {
    const fail = vi.fn()
    assertPermissionModeEvent(modeEvent({ mode: 'bypassPermissions', resumeSandbox: 'workspace-write' }), fail)
    expect(fail).not.toHaveBeenCalled()
  })

  it('rejects a mode outside the switchable vocabulary (including plan)', () => {
    const fail = vi.fn()
    assertPermissionModeEvent(modeEvent({ mode: 'nope' }), fail)
    expect(fail).toHaveBeenCalledTimes(1)
  })

  it('rejects plan as a written permission/mode', () => {
    const fail = vi.fn()
    assertPermissionModeEvent(modeEvent({ mode: 'plan' }), fail)
    expect(fail).toHaveBeenCalledTimes(1)
  })

  it('rejects an unknown resumeSandbox', () => {
    const fail = vi.fn()
    assertPermissionModeEvent(modeEvent({ mode: 'default', resumeSandbox: 'full-nuclear' }), fail)
    expect(fail).toHaveBeenCalledTimes(1)
  })

  it('ignores non permission/mode events', () => {
    const fail = vi.fn()
    assertPermissionModeEvent({ type: 'turn/start', data: { turn: 1 } } as unknown as SessionEvent, fail)
    expect(fail).not.toHaveBeenCalled()
  })
})
