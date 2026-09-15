import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import Microcompactor, { DEFAULTS, resolveConfig } from '@dsh-cc/compaction-micro'
import type { MicrocompactConfig } from '@dsh-cc/compaction-micro'

// Change B (error-recovery parity plan §3): the auto pre-step pass caps
// consecutive failures per session, pauses after the cap, and injects ONE
// model-visible durable notice via `agent.inject`.

const NOTICE_PATTERN = /^microcompact failed \d+ consecutive time\(s\) \(last: .+\); auto-microcompact paused for this session — run \/compact manually to compress context$/

function service(config: MicrocompactConfig): { micro: Microcompactor; ctx: Context } {
  const ctx = new Context()
  void new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  return { micro: new Microcompactor(ctx, config), ctx }
}

/** Minimal agent stub: the auto pass needs the session plus `inject`. */
function stubAgent(session: Session): { session: Session; inject: ReturnType<typeof vi.fn> } {
  return { session, inject: vi.fn() }
}

async function next(): Promise<never> {
  return undefined as never
}

/** Drive one auto pre-step pass against a stub agent. */
function preStep(micro: Microcompactor, agent: { session: Session; inject: ReturnType<typeof vi.fn> }): Promise<void> {
  return micro.autoMicrocompactPass(agent as never, new AbortController().signal)
}

function failingPass(error: Error): () => never {
  return () => {
    throw error
  }
}

describe('failureCap configuration', () => {
  it('defaults to 3', () => {
    expect(DEFAULTS.failureCap).toBe(3)
    expect(resolveConfig().failureCap).toBe(3)
  })

  it('rejects non-positive and fractional values', () => {
    expect(() => resolveConfig({ failureCap: 0 })).toThrow(/failureCap .* positive integer/)
    expect(() => resolveConfig({ failureCap: 1.5 })).toThrow(/failureCap .* positive integer/)
  })
})

describe('auto pre-step failure cap', () => {
  it('keeps attempting the pass while below the cap', async () => {
    const { micro } = service({ auto: true, failureCap: 3 })
    const agent = stubAgent(Session.create(SessionId('cap-below')))
    const spy = vi.spyOn(micro, 'microcompactSession').mockImplementation(failingPass(new Error('boom')))

    await preStep(micro, agent)
    await preStep(micro, agent)

    expect(spy).toHaveBeenCalledTimes(2)
    expect(agent.inject).not.toHaveBeenCalled()
  })

  it('pauses at the cap, freezes the pass, and injects exactly one notice', async () => {
    const { micro } = service({ auto: true, failureCap: 3 })
    const agent = stubAgent(Session.create(SessionId('cap-at')))
    const spy = vi.spyOn(micro, 'microcompactSession').mockImplementation(failingPass(new Error('disk full')))

    for (let i = 0; i < 3; i++) await preStep(micro, agent)
    expect(spy).toHaveBeenCalledTimes(3)
    expect(agent.inject).toHaveBeenCalledTimes(1)

    const notice = agent.inject.mock.calls[0]![0] as {
      role: string
      content: Array<{ type: string; text: string }>
      source: { kind: string; plugin: string }
    }
    expect(notice.role).toBe('user')
    expect(notice.source).toEqual({ kind: 'plugin', plugin: 'compaction-micro' })
    expect(notice.content).toHaveLength(1)
    expect(notice.content[0]!.text).toBe(
      'microcompact failed 3 consecutive time(s) (last: disk full); '
      + 'auto-microcompact paused for this session — run /compact manually to compress context',
    )
    expect(notice.content[0]!.text).toMatch(NOTICE_PATTERN)

    // Paused: further pre-steps skip the pass entirely.
    await preStep(micro, agent)
    await preStep(micro, agent)
    expect(spy).toHaveBeenCalledTimes(3)
    expect(agent.inject).toHaveBeenCalledTimes(1)
  })

  it('an explicit failureCap of 1 pauses after the first failure', async () => {
    const { micro } = service({ auto: true, failureCap: 1 })
    const agent = stubAgent(Session.create(SessionId('cap-one')))
    const spy = vi.spyOn(micro, 'microcompactSession').mockImplementation(failingPass(new Error('nope')))

    await preStep(micro, agent)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(agent.inject).toHaveBeenCalledTimes(1)

    await preStep(micro, agent)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('a success resets the count and re-arms the notice latch', async () => {
    const { micro } = service({ auto: true, failureCap: 2 })
    const agent = stubAgent(Session.create(SessionId('cap-reset')))
    const spy = vi.spyOn(micro, 'microcompactSession')
    spy.mockImplementation(failingPass(new Error('first')))
    await preStep(micro, agent)
    expect(agent.inject).not.toHaveBeenCalled()

    // Success resets the count: the next two failures stay below the cap.
    spy.mockImplementation(() => ({ replaced: [], stable: true }))
    await preStep(micro, agent)
    spy.mockImplementation(failingPass(new Error('second')))
    await preStep(micro, agent)
    expect(spy).toHaveBeenCalledTimes(3)
    expect(agent.inject).not.toHaveBeenCalled()

    // Reaching the cap again after the reset injects a fresh notice (latch re-armed).
    await preStep(micro, agent)
    expect(agent.inject).toHaveBeenCalledTimes(1)
    expect((agent.inject.mock.calls[0]![0] as { content: Array<{ text: string }> }).content[0]!.text)
      .toContain('(last: second)')
  })

  it('session/disposed frees the failure state (a fresh session id starts clean)', async () => {
    const { micro, ctx } = service({ auto: true, failureCap: 2 })
    const session = Session.create(SessionId('cap-dispose'))
    const agent = stubAgent(session)
    const spy = vi.spyOn(micro, 'microcompactSession').mockImplementation(failingPass(new Error('err')))

    await preStep(micro, agent)
    expect(spy).toHaveBeenCalledTimes(1)

    // Without disposal, this second failure would pause and inject.
    await ctx.emit('session/disposed', session)
    await preStep(micro, agent)
    expect(spy).toHaveBeenCalledTimes(2)
    expect(agent.inject).not.toHaveBeenCalled()
  })
})
