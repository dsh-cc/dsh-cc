import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderPermissions } from '@dsh-cc/command-permissions/permissions'
import type { PermissionRuleSet } from '@dsh-cc/permission-rules/types'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'

describe('TUI /permissions listing', () => {
  it('reuses the command renderer so the TUI and /permissions stay aligned', () => {
    const rules: PermissionRuleSet = {
      allow: [{ toolName: 'Read', behavior: 'allow', source: 'userSettings' }],
      deny: [{ toolName: 'Bash', behavior: 'deny', source: 'projectSettings' }],
      ask: [],
      bypassImmune: [],
    }
    const text = renderPermissions(rules, 0)
    expect(text).toContain('Permission rules (read-only)')
    expect(text).toContain('userSettings: allow=1 deny=0 ask=0')
    expect(text).toContain('projectSettings: allow=0 deny=1 ask=0')
    expect(text).toContain('bypassImmune=0')
  })
})

/** Minimal approval request the driver's approval/request handler accepts. */
interface FakeApprovalRequest {
  agent: { id: string }
  toolName: string
  callId?: string | number
  reason?: string
  signal?: AbortSignal
}

/**
 * ctx stub whose agent carries a durable event log and whose
 * approval/request handler is captured so tests can park approvals.
 */
function makeApprovalCtx(events: unknown[]): {
  ctx: Record<string, unknown>
  agent: { id: string }
  request(req: FakeApprovalRequest): Promise<string>
} {
  const handlers = new Set<(req: FakeApprovalRequest, next: () => unknown) => unknown>()
  const agent = { options: {}, session: { id: 's-appr', header: {}, events }, id: 'a-appr', status: 'idle' }
  const ctx = {
    get(key: string) {
      if (key === 'agentPresets') {
        return {
          defaultId: 'cc',
          resolve: async () => ({ id: 'cc' }),
          mount: async () => ({ id: 'cc' }),
        }
      }
      return undefined
    },
    on(event: string, handler: (req: FakeApprovalRequest, next: () => unknown) => unknown) {
      if (event === 'approval/request') {
        handlers.add(handler)
        return () => { handlers.delete(handler) }
      }
      return () => {}
    },
    agents: {
      create: async () => ({ agent, dispose: async () => {} }),
    },
  }
  return {
    ctx,
    agent,
    request(req) {
      let result: unknown
      for (const handler of handlers) result = handler(req, () => undefined)
      return Promise.resolve(result as Promise<string>)
    },
  }
}

describe('createDriver approval dialog contract', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-appr-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('parks an approval carrying the command preview folded from the paired tool/call event', async () => {
    const { ctx, agent, request } = makeApprovalCtx([
      { type: 'tool/call', data: { callId: 'c1', arguments: JSON.stringify({ command: 'git push --force origin main' }) } },
    ])
    const driver = await createDriver(ctx as never, {})

    const pending = request({
      agent: agent as { id: string },
      toolName: 'Bash',
      callId: 'c1',
      reason: 'destructive git operation',
    })
    expect(driver.state.approval).toEqual({
      toolName: 'Bash',
      reason: 'destructive git operation',
      preview: { kind: 'command', command: 'git push --force origin main' },
    })

    driver.answerApproval('once')
    await expect(pending).resolves.toBe('allowed-once')
    expect(driver.state.approval).toBeUndefined()
  })

  it('parks without a preview when the callId has no paired tool/call (no throw)', async () => {
    const { ctx, agent, request } = makeApprovalCtx([
      { type: 'tool/call', data: { callId: 'other', arguments: JSON.stringify({ command: 'ls' }) } },
    ])
    const driver = await createDriver(ctx as never, {})

    const pending = request({ agent: agent as { id: string }, toolName: 'Bash', callId: 'missing' })
    expect(driver.state.approval).toEqual({ toolName: 'Bash' })
    expect(driver.state.approval?.preview).toBeUndefined()

    driver.answerApproval('reject')
    await expect(pending).resolves.toBe('rejected')
    expect(driver.state.approval).toBeUndefined()
  })

  it('resolves cancelled and clears the box when the request signal aborts', async () => {
    const { ctx, agent, request } = makeApprovalCtx([])
    const driver = await createDriver(ctx as never, {})

    const controller = new AbortController()
    const pending = request({
      agent: agent as { id: string },
      toolName: 'Bash',
      callId: 'c9',
      signal: controller.signal,
    })
    expect(driver.state.approval).toBeDefined()

    controller.abort()
    await expect(pending).resolves.toBe('cancelled')
    expect(driver.state.approval).toBeUndefined()
  })
})
