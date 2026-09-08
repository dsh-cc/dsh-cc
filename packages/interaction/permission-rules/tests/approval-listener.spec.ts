import { describe, expect, it, vi } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { SESSION_ALLOW_EVENT } from '../src/session-allowlist.ts'
import {
  createSandboxApprovalListener,
  isSandboxEscalation,
} from '../src/approval-listener.ts'
import type { PermissionMode } from '../src/types.ts'

const SANDBOX_REASON = 'sandbox escalation: operation outside the per-call policy'

function agentWithCwd(cwd: string | undefined): Agent {
  const session = Session.create(SessionId(`sbx-${Math.random()}`))
  return {
    id: 'agent-1',
    session,
    ...(cwd === undefined ? {} : { cwd }),
  } as unknown as Agent
}

function request(agent: Agent, reason?: string): ApprovalRequest {
  return {
    agent,
    toolName: 'Bash',
    ...(reason === undefined ? {} : { reason }),
  } as unknown as ApprovalRequest
}

function listenerConfig(overrides: {
  modeOf?: (agent: Agent) => PermissionMode
  workspaceOf?: (agent: Agent) => string | undefined
} = {}) {
  return {
    modeOf: overrides.modeOf ?? (() => 'auto' as PermissionMode),
    workspaceOf: overrides.workspaceOf ?? (() => '/work'),
    ...overrides,
  }
}

describe('isSandboxEscalation', () => {
  it('matches case-insensitive sandbox reasons', () => {
    expect(isSandboxEscalation(SANDBOX_REASON)).toBe(true)
    expect(isSandboxEscalation('Sandbox denied the write')).toBe(true)
    expect(isSandboxEscalation('network sandbox blocked egress')).toBe(true)
  })

  it('rejects non-sandbox and missing reasons', () => {
    expect(isSandboxEscalation('user rule requires approval')).toBe(false)
    expect(isSandboxEscalation(undefined)).toBe(false)
  })
})

describe('sandbox approval-seam listener', () => {
  it('auto-approves a sandbox escalation in auto mode with a known workspace', async () => {
    const agent = agentWithCwd('/work')
    const listener = createSandboxApprovalListener(listenerConfig())
    const outcome = await listener(request(agent, SANDBOX_REASON), async () => 'rejected' as const)
    expect(outcome).toBe('allowed-once')
  })

  it('falls through to next in non-auto modes', async () => {
    for (const mode of ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const) {
      const agent = agentWithCwd('/work')
      const listener = createSandboxApprovalListener(listenerConfig({ modeOf: () => mode }))
      const next = vi.fn(async () => 'rejected' as const)
      const outcome = await listener(request(agent, SANDBOX_REASON), next)
      expect(outcome).toBe('rejected')
      expect(next).toHaveBeenCalledOnce()
    }
  })

  it('falls through when the reason is not a sandbox escalation', async () => {
    const agent = agentWithCwd('/work')
    const listener = createSandboxApprovalListener(listenerConfig())
    const next = vi.fn(async () => 'allowed-once' as const)
    const outcome = await listener(request(agent, 'whole-tool ask rule'), next)
    expect(outcome).toBe('allowed-once')
    expect(next).toHaveBeenCalledOnce()
  })

  it('falls through when no workspace root is known (cannot verify scope)', async () => {
    const agent = agentWithCwd(undefined)
    const listener = createSandboxApprovalListener(listenerConfig({ workspaceOf: () => undefined }))
    const next = vi.fn(async () => 'rejected' as const)
    const outcome = await listener(request(agent, SANDBOX_REASON), next)
    expect(outcome).toBe('rejected')
    expect(next).toHaveBeenCalledOnce()
  })

  it('audit-logs every auto-approval to the session log with timestamp and reason', async () => {
    const agent = agentWithCwd('/work')
    const listener = createSandboxApprovalListener(listenerConfig())
    const before = Date.now()
    await listener(request(agent, SANDBOX_REASON), async () => 'rejected' as const)
    const event = agent.session.snapshotEvents()[agent.session.seq - 1] as unknown as {
      type: string
      data: Record<string, unknown>
    }
    expect(event.type).toBe(SESSION_ALLOW_EVENT)
    expect(event.data.scope).toBe('sandbox-auto')
    expect(event.data.toolName).toBe('Bash')
    expect(event.data.reason).toBe(SANDBOX_REASON)
    expect(event.data.timestamp as number).toBeGreaterThanOrEqual(before)
  })

  it('does not audit-log a fall-through', async () => {
    const agent = agentWithCwd(undefined)
    const listener = createSandboxApprovalListener(listenerConfig({ workspaceOf: () => undefined }))
    const before = agent.session.seq
    await listener(request(agent, SANDBOX_REASON), async () => 'rejected' as const)
    expect(agent.session.snapshotEvents()).toHaveLength(before)
  })
})
