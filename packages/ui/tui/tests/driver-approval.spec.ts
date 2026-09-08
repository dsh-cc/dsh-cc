import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'

/**
 * Driver-level contract tests for the approval modal queue: concurrent
 * requests park in a FIFO, answering resolves the head and promotes the next,
 * aborts remove their entry, tracked subagent requests queue instead of
 * passing through, and approvals/questions share one modal pipeline (the
 * renderer shows exactly one modal — the head — at any time).
 */

interface FakeApprovalRequest {
  agent: { id: string; session: { id: string; events: unknown[] } }
  toolName: string
  callId?: string
  reason?: string
  signal?: AbortSignal
}

interface FakeQuestionRequest {
  questions: { id: string; options?: { label: string }[] }[]
  signal?: AbortSignal
}

function makeQueueCtx(): {
  ctx: Record<string, unknown>
  agent: { id: string; session: { id: string; events: unknown[] } }
  request(req: FakeApprovalRequest): Promise<string>
  ask(req: FakeQuestionRequest): Promise<{ answers: { id: string; selected: string[] }[] }>
  emitSubagent(info: { runId: string; provider: string; id: string }): void
  nextCalls: () => number
} {
  const approvalHandlers = new Set<(req: FakeApprovalRequest, next: () => unknown) => unknown>()
  const subagentStartHandlers = new Set<(info: { runId: string; provider: string; id: string }) => void>()
  let questionProvider: { ask(req: FakeQuestionRequest): Promise<unknown> } | undefined
  let nextCount = 0
  const agent = {
    id: 'a-queue',
    session: { id: 's-queue', header: {}, events: [], snapshotEvents() { return this.events } },
    options: {},
    status: 'idle',
  }
  const ctx: Record<string, unknown> = {
    get(key: string) {
      if (key === 'agentPresets') {
        return {
          defaultId: 'cc',
          resolve: async () => ({ id: 'cc' }),
          mount: async () => ({ id: 'cc' }),
        }
      }
      if (key === 'userQuestions') {
        return {
          registerProvider(provider: { ask(req: FakeQuestionRequest): Promise<unknown> }) {
            questionProvider = provider
            return () => {}
          },
        }
      }
      return undefined
    },
    on(event: string, handler: (...args: unknown[]) => unknown) {
      if (event === 'approval/request') {
        approvalHandlers.add(handler as (req: FakeApprovalRequest, next: () => unknown) => unknown)
      } else if (event === 'subagent/start') {
        subagentStartHandlers.add(handler as (info: { runId: string; provider: string; id: string }) => void)
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
      for (const handler of approvalHandlers) result = handler(req, () => { nextCount += 1 })
      return Promise.resolve(result as Promise<string>)
    },
    ask(req) {
      return questionProvider!.ask(req) as Promise<{ answers: { id: string; selected: string[] }[] }>
    },
    emitSubagent(info) {
      for (const handler of subagentStartHandlers) handler(info)
    },
    nextCalls: () => nextCount,
  }
}

/** Fire `count` concurrent approval requests with distinct tool names. */
function fireRequests(
  ctx: ReturnType<typeof makeQueueCtx>,
  count: number,
  signalOf?: (index: number) => AbortSignal | undefined,
): Promise<string>[] {
  return Array.from({ length: count }, (_, index) => ctx.request({
    agent: ctx.agent,
    toolName: `Tool${index}`,
    signal: signalOf?.(index),
  }))
}

describe('approval modal queue', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-approval-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('parks concurrent requests in a FIFO and shows the head with a pending count', async () => {
    const queue = makeQueueCtx()
    const driver = await createDriver(queue.ctx as never, {})
    const pending = fireRequests(queue, 3)

    expect(driver.state.approval?.toolName).toBe('Tool0')
    expect(driver.state.approval?.pendingCount).toBe(2)

    driver.answerApproval('once')
    await expect(pending[0]).resolves.toBe('allowed-once')
    expect(driver.state.approval?.toolName).toBe('Tool1')
    expect(driver.state.approval?.pendingCount).toBe(1)

    driver.answerApproval('reject')
    await expect(pending[1]).resolves.toBe('rejected')
    expect(driver.state.approval?.toolName).toBe('Tool2')
    // A lone head carries no pending count.
    expect(driver.state.approval?.pendingCount).toBeUndefined()

    driver.answerApproval('once')
    await expect(pending[2]).resolves.toBe('allowed-once')
    expect(driver.state.approval).toBeUndefined()
  })

  it("the session answer resolves the call and routes the derived rule to the permission engine's session allowlist", async () => {
    const queue = makeQueueCtx()
    const driver = await createDriver(queue.ctx as never, {})

    // The 'session' answer grants through the permission engine's session
    // allowlist (WS4-PR-B) — the settings provider is never consulted.
    const sessionRules: { agent: unknown; rule: string }[] = []
    const engine = {
      addSessionAllow(agent: unknown, rule: string) {
        sessionRules.push({ agent, rule })
      },
    }
    const prevGet = queue.ctx.get.bind(queue.ctx)
    queue.ctx.get = (key: string) => (key === 'permissionRules' ? engine : prevGet(key))

    const pending = fireRequests(queue, 1)
    driver.answerApproval('session')
    // No preview payload: the derivation falls back to a whole-tool rule
    // for the requested tool name (`Tool0` from fireRequests).
    await expect(pending[0]).resolves.toBe('allowed-once')
    expect(sessionRules).toHaveLength(1)
    expect(sessionRules[0]!.rule).toBe('Tool0')
    expect(sessionRules[0]!.agent).toBe(queue.agent)
  })

  it('aborting a queued (non-head) request removes it and updates the count', async () => {
    const queue = makeQueueCtx()
    const driver = await createDriver(queue.ctx as never, {})
    const controllers = [new AbortController(), new AbortController(), new AbortController()]
    const pending = fireRequests(queue, 3, index => controllers[index]!.signal)

    expect(driver.state.approval?.toolName).toBe('Tool0')
    expect(driver.state.approval?.pendingCount).toBe(2)

    controllers[1]!.abort()
    await expect(pending[1]).resolves.toBe('cancelled')
    // The head is untouched; the count dropped with the removed entry.
    expect(driver.state.approval?.toolName).toBe('Tool0')
    expect(driver.state.approval?.pendingCount).toBe(1)

    driver.answerApproval('reject')
    await expect(pending[0]).resolves.toBe('rejected')
    // Tool1 was removed, so Tool2 is next.
    expect(driver.state.approval?.toolName).toBe('Tool2')

    driver.answerApproval('once')
    await pending[2]
  })

  it('aborting the head resolves it cancelled and promotes the next entry', async () => {
    const queue = makeQueueCtx()
    const driver = await createDriver(queue.ctx as never, {})
    const controllers = [new AbortController(), new AbortController()]
    const pending = fireRequests(queue, 2, index => controllers[index]!.signal)

    controllers[0]!.abort()
    await expect(pending[0]).resolves.toBe('cancelled')
    expect(driver.state.approval?.toolName).toBe('Tool1')
    expect(driver.state.approval?.pendingCount).toBeUndefined()

    driver.answerApproval('once')
    await pending[1]
  })

  it('queues a tracked subagent approval instead of passing it through', async () => {
    const queue = makeQueueCtx()
    const driver = await createDriver(queue.ctx as never, {})
    // subagent/start lands before the subagent's first approval request.
    queue.emitSubagent({ runId: 'r1', provider: 'test', id: 'sub-s1' })
    expect(driver.state.subagents.map(run => run.sessionId)).toContain('sub-s1')

    const pending = queue.request({
      agent: { id: 'a-sub', session: { id: 'sub-s1', events: [], snapshotEvents() { return this.events } } },
      toolName: 'Bash',
    })
    expect(driver.state.approval?.toolName).toBe('Bash')
    expect(queue.nextCalls()).toBe(0)

    driver.answerApproval('once')
    await expect(pending).resolves.toBe('allowed-once')
    expect(driver.state.approval).toBeUndefined()
  })

  it('passes through an approval from an untracked session (fail-closed downstream)', async () => {
    const queue = makeQueueCtx()
    const driver = await createDriver(queue.ctx as never, {})

    const pending = queue.request({
      agent: { id: 'a-stranger', session: { id: 's-stranger', events: [], snapshotEvents() { return this.events } } },
      toolName: 'Bash',
    })
    expect(driver.state.approval).toBeUndefined()
    expect(queue.nextCalls()).toBe(1)

    // The pass-through promise never settles via the driver; it is not ours.
    void pending.catch(() => {})
  })
})

describe('unified modal pipeline (approvals + questions share one FIFO)', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-modal-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('a question arriving during an approval waits and shows once the approval resolves', async () => {
    const queue = makeQueueCtx()
    const driver = await createDriver(queue.ctx as never, {})
    const approval = queue.request({ agent: queue.agent, toolName: 'Bash' })
    expect(driver.state.approval).toBeDefined()

    const question = queue.ask({ questions: [{ id: 'q1' }] })
    // The question is queued, not rendered — one modal at a time.
    expect(driver.state.question).toBeUndefined()
    expect(driver.state.approval?.toolName).toBe('Bash')

    driver.answerApproval('once')
    await approval
    // The queued question is now the head.
    expect(driver.state.question?.header).toBeDefined()

    driver.questionCancel()
    await question
    expect(driver.state.question).toBeUndefined()
  })

  it('an approval arriving during a question queues behind it', async () => {
    const queue = makeQueueCtx()
    const driver = await createDriver(queue.ctx as never, {})
    const question = queue.ask({ questions: [{ id: 'q1', options: [{ label: 'one' }] }] })
    expect(driver.state.question).toBeDefined()

    const approval = queue.request({ agent: queue.agent, toolName: 'Write' })
    // The approval waits; the question stays the sole rendered modal.
    expect(driver.state.approval).toBeUndefined()

    driver.questionPick(0)
    const answer = await question
    expect(answer.answers[0]!.id).toBe('q1')
    // The approval is now the head.
    expect(driver.state.approval?.toolName).toBe('Write')

    driver.answerApproval('once')
    await approval
    expect(driver.state.approval).toBeUndefined()
  })

  it('an approval head shows the queued question in its pending count', async () => {
    const queue = makeQueueCtx()
    const driver = await createDriver(queue.ctx as never, {})
    const approval = queue.request({ agent: queue.agent, toolName: 'Bash' })
    const question = queue.ask({ questions: [{ id: 'q1' }] })

    expect(driver.state.approval?.pendingCount).toBe(1)
    driver.answerApproval('once')
    await approval
    driver.questionCancel()
    await question
  })

  it('a queued question aborted by its request leaves the queue without dangling state', async () => {
    const queue = makeQueueCtx()
    const driver = await createDriver(queue.ctx as never, {})
    const approval = queue.request({ agent: queue.agent, toolName: 'Bash' })
    const controller = new AbortController()
    const question = queue.ask({ questions: [{ id: 'q1' }], signal: controller.signal })

    expect(driver.state.question).toBeUndefined()
    controller.abort()
    await expect(question).rejects.toBeInstanceOf(UserQuestionError)
    // The approval head is unaffected.
    expect(driver.state.approval?.toolName).toBe('Bash')
    expect(driver.state.question).toBeUndefined()

    driver.answerApproval('once')
    await approval
    expect(driver.state.approval).toBeUndefined()
  })

  it('an open head question aborted by its request rejects cancelled and clears the modal', async () => {
    const queue = makeQueueCtx()
    const driver = await createDriver(queue.ctx as never, {})
    const controller = new AbortController()
    const question = queue.ask({ questions: [{ id: 'q1' }], signal: controller.signal })
    expect(driver.state.question).toBeDefined()

    controller.abort()
    await expect(question).rejects.toBeInstanceOf(UserQuestionError)
    expect(driver.state.question).toBeUndefined()
  })
})
