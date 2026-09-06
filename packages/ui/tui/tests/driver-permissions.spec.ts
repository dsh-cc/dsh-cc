import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PERMISSION_MODE_OPTIONS, type PlanUnitStateLike } from '@dsh-cc/command-permissions'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'

/**
 * Driver-level contract tests for the TUI `/permissions` picker: bare
 * invocation opens the overlay (does not execute the host command), argued
 * `/permissions <mode>` stays scriptable through `commands.execute`, submit
 * closes then writes `/permissions ${id}` through the host command, and
 * bypassPermissions requires an in-overlay confirmation first.
 */

interface ExecuteCall {
  line: string
}

interface FakeSession {
  id: string
  header: Record<string, never>
  events: unknown[]
}

function makeCtx(opts: {
  execute?: (line: string) => Promise<{ result?: { kind: string; text?: string } } | undefined>
  events?: unknown[]
  rules?: boolean
  planState?: PlanUnitStateLike
} = {}): {
  ctx: Record<string, unknown>
  executed: ExecuteCall[]
  calls: string[]
  session: FakeSession
  fire: (type: string, event: unknown) => void
} {
  const executed: ExecuteCall[] = []
  // Shared write-order log across the fake command registry and the fake
  // rules engine, so tests can assert '/plan off' precedes setMode.
  const calls: string[] = []
  const session: FakeSession = { id: 's-perm', header: {}, events: opts.events ?? [] }
  const listeners = new Map<string, ((session: FakeSession, event: unknown) => void)[]>()
  const ctx: Record<string, unknown> = {
    get(key: string) {
      if (key === 'agentPresets') {
        return {
          defaultId: 'cc',
          resolve: async () => ({ id: 'cc' }),
          mount: async () => ({ id: 'cc' }),
        }
      }
      if (key === 'commands') {
        return {
          list: () => [
            { name: 'permissions', description: 'show or switch the permission mode', input: { hint: '[mode]' } },
          ],
          execute: async (_agent: unknown, line: string) => {
            executed.push({ line })
            calls.push(`cmd:${line}`)
            if (opts.execute !== undefined) return opts.execute(line)
            if (line === '/permissions') {
              return { result: { kind: 'success', text: 'Permission rules (read-only)' } }
            }
            const match = /^\/permissions\s+(\S+)$/.exec(line)
            if (match !== null) {
              return { result: { kind: 'success', text: `Permission mode is now "${match[1]}".` } }
            }
            return { result: { kind: 'error', text: 'unknown command' } }
          },
        }
      }
      if (key === 'permissionRules') {
        return opts.rules === true
          ? { setMode: (_agent: unknown, mode: string) => { calls.push(`rules:${mode}`) } }
          : undefined
      }
      if (key === 'sessionProjections') {
        return opts.planState === undefined
          ? undefined
          : { stateOf: () => opts.planState, onChanged: () => () => {} }
      }
      return undefined
    },
    on: (type: string, fn: (session: FakeSession, event: unknown) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn])
      return () => {}
    },
    agents: {
      create: async () => ({
        agent: {
          options: {},
          session,
          id: 'a-perm',
          status: 'idle',
          followup() {},
          cancel() {},
        },
        dispose: async () => {},
      }),
    },
  }
  const fire = (type: string, event: unknown): void => {
    for (const fn of listeners.get(type) ?? []) fn(session, event)
  }
  return { ctx, executed, calls, session, fire }
}

function statusTexts(driver: { state: { rows: readonly { kind: string; text?: string }[] } }): string[] {
  return driver.state.rows.filter(row => row.kind === 'status').map(row => row.text ?? '')
}

describe('createDriver /permissions picker overlay', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-perm-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('bare /permissions opens the picker and does not execute the host command', async () => {
    const { ctx, executed } = makeCtx()
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/permissions')
    const picker = driver.state.permissionPicker
    expect(picker).toBeDefined()
    expect(picker!.entries.map(entry => entry.id)).toEqual(PERMISSION_MODE_OPTIONS.map(option => option.id))
    expect(picker!.current).toBe('default')
    expect(picker!.focused).toBe(0)
    expect(picker!.confirmingBypass).toBeUndefined()
    expect(executed).toEqual([])
    expect(statusTexts(driver).some(text => text.includes('Permission rules'))).toBe(false)
  })

  it('bare /PERMISSIONS (case-insensitive) also opens the picker', async () => {
    const { ctx, executed } = makeCtx()
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/PERMISSIONS')
    expect(driver.state.permissionPicker).toBeDefined()
    expect(executed).toEqual([])
  })

  it('opens focused on the live permission mode', async () => {
    const { ctx } = makeCtx({
      events: [{ type: 'permission/mode', data: { mode: 'auto' } }],
    })
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/permissions')
    const picker = driver.state.permissionPicker
    expect(picker?.current).toBe('auto')
    expect(picker?.focused).toBe(PERMISSION_MODE_OPTIONS.findIndex(option => option.id === 'auto'))
  })

  it('/permissions <mode> bypasses the overlay and executes the host command', async () => {
    const { ctx, executed } = makeCtx()
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/permissions acceptEdits')
    expect(driver.state.permissionPicker).toBeUndefined()
    expect(executed).toEqual([{ line: '/permissions acceptEdits' }])
    expect(statusTexts(driver).at(-1)).toBe('Permission mode is now "acceptEdits".')
  })

  it('move clamps at the bounds (no wrap)', async () => {
    const { ctx } = makeCtx()
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/permissions')
    driver.permissionPickerMove(-1)
    expect(driver.state.permissionPicker?.focused).toBe(0)
    driver.permissionPickerMove(1)
    driver.permissionPickerMove(1)
    driver.permissionPickerMove(1)
    driver.permissionPickerMove(1)
    expect(driver.state.permissionPicker?.focused).toBe(4)
    driver.permissionPickerMove(1)
    expect(driver.state.permissionPicker?.focused).toBe(4)
  })

  it('submit closes synchronously, then executes /permissions ${id} through the host command', async () => {
    const { ctx, executed } = makeCtx()
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/permissions')
    driver.permissionPickerMove(1) // acceptEdits
    const pending = driver.permissionPickerSubmit()
    // Overlay is gone before the host-command write settles.
    expect(driver.state.permissionPicker).toBeUndefined()
    await pending
    expect(executed).toEqual([{ line: '/permissions acceptEdits' }])
    expect(statusTexts(driver).at(-1)).toBe('Permission mode is now "acceptEdits".')
  })

  it('cancel closes the overlay without executing', async () => {
    const { ctx, executed } = makeCtx()
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/permissions')
    driver.permissionPickerMove(1)
    driver.permissionPickerCancel()
    expect(driver.state.permissionPicker).toBeUndefined()
    expect(executed).toEqual([])
  })

  it('bypassPermissions requires a confirmation enter before executing', async () => {
    const { ctx, executed } = makeCtx()
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/permissions')
    // default → acceptEdits → plan → auto → bypassPermissions
    driver.permissionPickerMove(1)
    driver.permissionPickerMove(1)
    driver.permissionPickerMove(1)
    driver.permissionPickerMove(1)
    expect(driver.state.permissionPicker?.entries[driver.state.permissionPicker.focused]?.id).toBe('bypassPermissions')

    await driver.permissionPickerSubmit()
    expect(driver.state.permissionPicker?.confirmingBypass).toBe(true)
    expect(executed).toEqual([])

    const pending = driver.permissionPickerSubmit()
    expect(driver.state.permissionPicker).toBeUndefined()
    await pending
    expect(executed).toEqual([{ line: '/permissions bypassPermissions' }])
    expect(statusTexts(driver).at(-1)).toBe('Permission mode is now "bypassPermissions".')
  })

  it('escape while confirming bypass returns to the list without executing', async () => {
    const { ctx, executed } = makeCtx()
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/permissions')
    driver.permissionPickerMove(1)
    driver.permissionPickerMove(1)
    driver.permissionPickerMove(1)
    driver.permissionPickerMove(1)
    await driver.permissionPickerSubmit()
    expect(driver.state.permissionPicker?.confirmingBypass).toBe(true)

    driver.permissionPickerCancel()
    expect(driver.state.permissionPicker).toBeDefined()
    expect(driver.state.permissionPicker?.confirmingBypass).toBeUndefined()
    expect(driver.state.permissionPicker?.focused).toBe(4)
    expect(executed).toEqual([])
  })

  it('moving while confirming bypass clears the confirmation flag', async () => {
    const { ctx } = makeCtx()
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/permissions')
    driver.permissionPickerMove(1)
    driver.permissionPickerMove(1)
    driver.permissionPickerMove(1)
    driver.permissionPickerMove(1)
    await driver.permissionPickerSubmit()
    expect(driver.state.permissionPicker?.confirmingBypass).toBe(true)

    driver.permissionPickerMove(-1)
    expect(driver.state.permissionPicker?.confirmingBypass).toBeUndefined()
    expect(driver.state.permissionPicker?.focused).toBe(3)
  })

  it('surfaces the host command error when execute fails after submit', async () => {
    const { ctx } = makeCtx({
      execute: async () => ({ result: { kind: 'error', text: 'The permission-rules engine is not mounted in this composition.' } }),
    })
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/permissions')
    driver.permissionPickerMove(1)
    await driver.permissionPickerSubmit()
    expect(statusTexts(driver).at(-1)).toBe('The permission-rules engine is not mounted in this composition.')
  })
})

describe('createDriver Shift+Tab plan switching via the /plan channel', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-plan-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('cycling into plan dispatches bare /plan and waits for the plan/mode event to flip the display', async () => {
    const { ctx, executed, session, fire } = makeCtx({
      events: [{ type: 'permission/mode', data: { mode: 'acceptEdits' } }],
      execute: async line => line === '/plan'
        ? { result: { kind: 'success', text: 'Plan mode on. Use /plan off to leave.' } }
        : { result: { kind: 'error', text: 'unknown command' } },
    })
    const driver = await createDriver(ctx as never, {})
    await driver.cyclePermissionMode()
    expect(executed).toEqual([{ line: '/plan' }])
    // No optimistic flip: the display follows plan-mode's committed event.
    expect(driver.state.permissionMode).not.toBe('plan')
    expect(statusTexts(driver).at(-1)).toBe('Plan mode on. Use /plan off to leave.')
    // Production ordering: the event is in the log before it is dispatched.
    const committed = { type: 'plan/mode', data: { active: true } }
    session.events.push(committed)
    fire('session/event', committed)
    expect(driver.state.permissionMode).toBe('plan')
  })

  it('leaving plan dispatches /plan off before the engine setMode', async () => {
    const { ctx, calls } = makeCtx({
      events: [{ type: 'plan/mode', data: { active: true } }],
      rules: true,
      execute: async line => line === '/plan off'
        ? { result: { kind: 'success', text: 'Plan mode off.' } }
        : { result: { kind: 'error', text: 'unknown command' } },
    })
    const driver = await createDriver(ctx as never, {})
    await driver.cyclePermissionMode()
    expect(calls).toEqual(['cmd:/plan off', 'rules:auto'])
    expect(driver.state.permissionMode).toBe('auto')
  })

  it('cancels a queued plan entry when cycling away (projection entering, fold still off)', async () => {
    const { ctx, calls } = makeCtx({
      rules: true,
      planState: { active: false, wanted: true, running: null },
      execute: async () => ({ result: { kind: 'success', text: 'Plan mode entry cancelled.' } }),
    })
    const driver = await createDriver(ctx as never, {})
    await driver.cyclePermissionMode()
    expect(calls).toEqual(['cmd:/plan off', 'rules:acceptEdits'])
  })

  it('a failing /plan off aborts the switch', async () => {
    const { ctx, calls } = makeCtx({
      events: [{ type: 'plan/mode', data: { active: true } }],
      rules: true,
      execute: async line => line === '/plan off'
        ? { result: { kind: 'error', text: 'cannot leave now' } }
        : { result: { kind: 'error', text: 'unknown command' } },
    })
    const driver = await createDriver(ctx as never, {})
    await driver.cyclePermissionMode()
    expect(calls).toEqual(['cmd:/plan off'])
    expect(driver.state.permissionMode).not.toBe('auto')
    expect(statusTexts(driver).at(-1)).toBe('cannot leave now')
  })

  it('notices when /plan is not mounted in the composition', async () => {
    const { ctx } = makeCtx({
      events: [{ type: 'permission/mode', data: { mode: 'acceptEdits' } }],
      execute: async () => undefined,
    })
    const driver = await createDriver(ctx as never, {})
    await driver.cyclePermissionMode()
    expect(driver.state.notice).toBe('plan mode is not mounted in this composition')
  })

  it('surfaces a rejected /plan execution as a notice', async () => {
    const { ctx } = makeCtx({
      events: [{ type: 'permission/mode', data: { mode: 'acceptEdits' } }],
      execute: async () => { throw new Error('boom') },
    })
    const driver = await createDriver(ctx as never, {})
    await driver.cyclePermissionMode()
    expect(driver.state.notice).toBe('boom')
  })

  it('serializes rapid cycles: the second write starts after the first settles', async () => {
    let callCount = 0
    let firstSettled = false
    let secondStartedEarly = false
    let resolveFirst!: () => void
    const { ctx } = makeCtx({
      events: [{ type: 'permission/mode', data: { mode: 'acceptEdits' } }],
      execute: line => {
        callCount += 1
        if (callCount === 1) {
          return new Promise<{ result?: { kind: string; text?: string } } | undefined>(resolve => {
            resolveFirst = () => {
              firstSettled = true
              resolve({ result: { kind: 'success', text: 'Plan mode on.' } })
            }
          })
        }
        if (!firstSettled) secondStartedEarly = true
        return Promise.resolve({ result: { kind: 'success', text: 'Plan mode on.' } })
      },
    })
    const driver = await createDriver(ctx as never, {})
    const first = driver.cyclePermissionMode()
    const second = driver.cyclePermissionMode()
    await vi.waitFor(() => expect(callCount).toBe(1))
    resolveFirst()
    await Promise.all([first, second])
    expect(callCount).toBe(2)
    expect(secondStartedEarly).toBe(false)
  })
})
