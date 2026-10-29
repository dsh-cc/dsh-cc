import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { createSandboxApprovalListener, type GrantEscalationFace } from '../src/approval-listener.ts'
import { SESSION_ALLOW_EVENT } from '../src/session-allowlist.ts'
import type { EscalationVerdict } from '../src/grant-escalation.ts'
import type { PermissionMode } from '../src/types.ts'

const REASON = 'escalate sandbox to workspace-write: ci needs the workspace'

function agentWithCwd(cwd: string | undefined): Agent {
  const session = Session.create(SessionId(`sbx-${Math.random()}`))
  return { id: 'agent-1', session, ...(cwd === undefined ? {} : { cwd }) } as unknown as Agent
}

function request(agent: Agent, reason: string = REASON): ApprovalRequest {
  return { agent, toolName: 'Bash', reason, callId: 'c1' } as unknown as ApprovalRequest
}

/** A fake grant face with scripted verdicts and an activity flag. */
function face(verdict: EscalationVerdict, active: boolean): { grants: GrantEscalationFace; calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    grants: {
      anyActive: () => active,
      consume: async (input) => {
        calls.push(input)
        return verdict
      },
    },
  }
}

function listener(
  grants: GrantEscalationFace | undefined,
  mode: PermissionMode = 'auto',
  workspace: string | undefined = '/work',
) {
  return createSandboxApprovalListener({
    modeOf: () => mode,
    workspaceOf: () => workspace,
    ...(grants === undefined ? {} : { grants }),
  })
}

describe('task-grant escalation fallback semantics (§3.5)', () => {
  it('a consumed registry hit auto-approves and audits the escalation', async () => {
    const agent = agentWithCwd('/work')
    const { grants } = face({ kind: 'allowed-once', grantId: 'grant_1', mode: 'workspace-write' }, true)
    const outcome = await listener(grants)(request(agent), async () => 'rejected')
    expect(outcome).toBe('allowed-once')
    const event = agent.session.snapshotEvents().at(-1) as unknown as { type: string; data: { scope: string } }
    expect(event.type).toBe(SESSION_ALLOW_EVENT)
    expect(event.data.scope).toBe('sandbox-auto')
  })

  it('with a grant live, a missed escalation falls back to the USER (not the baseline auto-approve)', async () => {
    const agent = agentWithCwd('/work')
    const { grants, calls } = face({ kind: 'fallback', why: 'no registered grant escalation for this call' }, true)
    let userAsked = 0
    const outcome = await listener(grants)(request(agent), async () => { userAsked += 1; return 'rejected' })
    expect(outcome).toBe('rejected')
    expect(userAsked).toBe(1)
    expect(calls).toHaveLength(1)
  })

  it('with no grant active, the baseline auto-approve is unchanged (grant never changes the no-grant baseline)', async () => {
    const agent = agentWithCwd('/work')
    const { grants } = face({ kind: 'fallback', why: 'no registered grant escalation for this call' }, false)
    let userAsked = 0
    const outcome = await listener(grants)(request(agent), async () => { userAsked += 1; return 'rejected' })
    expect(outcome).toBe('allowed-once')
    expect(userAsked).toBe(0)
  })

  it('rule ①: a grant created between the check and consumption is re-validated at consume time', async () => {
    const agent = agentWithCwd('/work')
    // The verdict is a miss, but the store says a grant is live NOW.
    const { grants } = face({ kind: 'fallback', why: 'no registered grant escalation for this call' }, true)
    const outcome = await listener(grants)(request(agent), async () => 'rejected')
    expect(outcome).toBe('rejected')
  })

  it('a revoked verdict never reaches the baseline auto-approve', async () => {
    const agent = agentWithCwd('/work')
    const { grants } = face({ kind: 'revoked', grantId: 'grant_1', why: 'M src/a.ts is not markdown' }, false)
    const outcome = await listener(grants)(request(agent), async () => 'rejected')
    expect(outcome).toBe('rejected')
  })

  it('grant logic never runs for a non-sandbox reason or an agent-less request', async () => {
    const agent = agentWithCwd('/work')
    const { grants, calls } = face({ kind: 'allowed-once', grantId: 'grant_1', mode: 'workspace-write' }, true)
    expect(await listener(grants)(request(agent, 'needs approval for Bash'), async () => 'rejected')).toBe('rejected')
    expect(calls).toHaveLength(0)
  })
})
