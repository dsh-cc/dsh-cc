import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'

/**
 * Driver-level contract tests for the ask-user-question overlay: full item
 * mapping into state, the plan-review approve-label round-trip (BAD_INTENT
 * guard), multi-select + free-text answers, and quick-pick digits.
 */

interface FakeRequest {
  questions: {
    id: string
    question: string
    detail?: string
    header?: string
    options?: { label: string; description?: string }[]
    multiSelect?: boolean
    intent?: { kind: 'plan-review'; approve: string }
  }[]
}

interface FakeAnswer {
  answers: { id: string; selected: string[]; custom?: string }[]
}

function makeQuestionCtx(): {
  ctx: Record<string, unknown>
  provider: () => { ask(request: FakeRequest): Promise<FakeAnswer> } | undefined
} {
  // Waterfall-shaped fake (harness >=0.1.3): the answerer is a
  // `user-questions/request` listener, not a registerProvider slot.
  const questionListeners: ((req: FakeRequest, next: () => Promise<FakeAnswer>) => unknown)[] = []
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
    on(event: string, handler: (...args: unknown[]) => unknown) {
      if (event === 'user-questions/request') {
        questionListeners.push(handler as (req: FakeRequest, next: () => Promise<FakeAnswer>) => unknown)
      }
      return () => {}
    },
    agents: {
      create: async () => ({
        agent: {
          options: {},
          session: { id: 's-test', header: {}, events: [], snapshotEvents() { return this.events } },
          id: 'a-test',
          status: 'idle',
          followup() {},
          cancel() {},
        },
        dispose: async () => {},
      }),
    },
  }
  return {
    ctx,
    provider() {
      if (questionListeners.length === 0) return undefined
      return {
        ask(request: FakeRequest): Promise<FakeAnswer> {
          const noAnswerer = () => Promise.reject(new Error('NO_PROVIDER'))
          let result: Promise<FakeAnswer> | undefined
          for (const listener of questionListeners) {
            result = (listener(request, noAnswerer) as Promise<FakeAnswer>) ?? result
          }
          // Created lazily so an unanswered dispatch does not leave a rejected
          // promise unhandled when a listener claims the request.
          return result ?? noAnswerer()
        },
      }
    },
  }
}

describe('createDriver ask-user-question overlay', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-q-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('maps the full first question item into state.question', async () => {
    const { ctx, provider } = makeQuestionCtx()
    const driver = await createDriver(ctx as never, {})
    const ask = provider()
    expect(ask).toBeDefined()

    const pending = ask!.ask({
      questions: [{
        id: 'q1',
        question: 'Ship the plan?',
        detail: '## The plan\n\n- do the thing',
        header: 'Decision',
        options: [
          { label: 'Ship it', description: 'merge now' },
          { label: 'Keep iterating', description: 'more work' },
        ],
        multiSelect: true,
        intent: { kind: 'plan-review', approve: 'Ship it' },
      }],
    })
    const q = driver.state.question
    expect(q).toBeDefined()
    expect(q!.header).toBe('Decision')
    expect(q!.question).toBe('Ship the plan?')
    expect(q!.detail).toBe('## The plan\n\n- do the thing')
    expect(q!.options).toEqual([
      { label: 'Ship it', description: 'merge now' },
      { label: 'Keep iterating', description: 'more work' },
    ])
    expect(q!.multiSelect).toBe(true)
    expect(q!.intent).toEqual({ kind: 'plan-review', approve: 'Ship it' })
    expect(q!.focused).toBe(0)
    expect(q!.selected).toEqual([])
    expect(q!.custom).toBe('')

    driver.questionCancel()
    await pending
  })

  it("round-trips the plan-review approve label byte-identically (BAD_INTENT guard)", async () => {
    const { ctx, provider } = makeQuestionCtx()
    const driver = await createDriver(ctx as never, {})
    const request: FakeRequest = {
      questions: [{
        id: 'plan-1',
        question: 'Approve the plan?',
        detail: 'plan body',
        options: [{ label: 'Ship it' }, { label: 'Keep iterating' }],
        intent: { kind: 'plan-review', approve: 'Ship it' },
      }],
    }

    // Focus starts on option 0 ('Ship it'); submit resolves that label.
    const pending = provider()!.ask(request)
    driver.questionSubmit()
    const answer = await pending
    expect(answer.answers[0]!.selected).toEqual(['Ship it'])
    expect(answer.answers[0]!.selected[0]).toBe(request.questions[0]!.intent!.approve)
    expect(answer.answers[0]!.id).toBe('plan-1')
    expect(driver.state.question).toBeUndefined()
  })

  it('answers with a non-approve option when the focus is elsewhere (label verbatim)', async () => {
    const { ctx, provider } = makeQuestionCtx()
    const driver = await createDriver(ctx as never, {})
    const request: FakeRequest = {
      questions: [{
        id: 'plan-2',
        question: 'Approve the plan?',
        options: [{ label: 'Ship it' }, { label: 'Keep iterating' }],
        intent: { kind: 'plan-review', approve: 'Ship it' },
      }],
    }
    const pending = provider()!.ask(request)
    driver.questionMove(1) // focus 'Keep iterating'
    driver.questionSubmit()
    const answer = await pending
    expect(answer.answers[0]!.selected).toEqual(['Keep iterating'])
    expect(answer.answers[0]!.selected[0]).not.toBe(request.questions[0]!.intent!.approve)
  })

  it('multi-select: toggles two options and sends custom free text together', async () => {
    const { ctx, provider } = makeQuestionCtx()
    const driver = await createDriver(ctx as never, {})
    const pending = provider()!.ask({
      questions: [{
        id: 'multi-1',
        question: 'Which areas?',
        options: [{ label: 'ui' }, { label: 'api' }, { label: 'docs' }],
        multiSelect: true,
      }],
    })

    driver.questionMove(1) // focus 'api'
    driver.questionToggle() // toggle 'api' on
    driver.questionPick(0) // toggle 'ui' on
    driver.questionType('also the cli')
    driver.questionSubmit()

    const answer = await pending
    expect(answer.answers[0]!.selected).toEqual(['api', 'ui'])
    expect(answer.answers[0]!.custom).toBe('also the cli')
  })

  it('single-select: a digit pick resolves the option immediately (quick pick preserved)', async () => {
    const { ctx, provider } = makeQuestionCtx()
    const driver = await createDriver(ctx as never, {})
    const pending = provider()!.ask({
      questions: [{
        id: 'quick-1',
        question: 'Pick one',
        options: [{ label: 'first' }, { label: 'second' }, { label: 'third' }],
      }],
    })

    driver.questionPick(1) // digit '2'
    const answer = await pending
    expect(answer.answers[0]!.selected).toEqual(['second'])
    expect(driver.state.question).toBeUndefined()
  })

  it('an out-of-range digit pick is ignored (question stays open)', async () => {
    const { ctx, provider } = makeQuestionCtx()
    const driver = await createDriver(ctx as never, {})
    const pending = provider()!.ask({
      questions: [{
        id: 'oob-1',
        question: 'Pick one',
        options: [{ label: 'first' }, { label: 'second' }],
      }],
    })

    driver.questionPick(8) // digit '9' — only two options
    expect(driver.state.question).toBeDefined()
    driver.questionCancel()
    await pending
  })

  it('submit with nothing chosen resolves the focused option; escape cancels with the first', async () => {
    const { ctx, provider } = makeQuestionCtx()
    const driver = await createDriver(ctx as never, {})

    const first = provider()!.ask({
      questions: [{ id: 'e1', question: 'Pick', options: [{ label: 'one' }, { label: 'two' }] }],
    })
    driver.questionMove(1)
    driver.questionSubmit()
    expect((await first).answers[0]!.selected).toEqual(['two'])

    const second = provider()!.ask({
      questions: [{ id: 'e2', question: 'Pick', options: [{ label: 'one' }, { label: 'two' }] }],
    })
    driver.questionCancel()
    expect((await second).answers[0]!.selected).toEqual(['one'])
  })

  it('free-text only answer sends selected: [] plus custom, without options', async () => {
    const { ctx, provider } = makeQuestionCtx()
    const driver = await createDriver(ctx as never, {})
    const pending = provider()!.ask({
      questions: [{
        id: 'free-1',
        question: 'Name it',
        options: [{ label: 'alpha' }, { label: 'beta' }],
      }],
    })
    driver.questionType('zeta')
    driver.questionBackspace() // 'zet'
    driver.questionSubmit()
    const answer = await pending
    expect(answer.answers[0]!.selected).toEqual([])
    expect(answer.answers[0]!.custom).toBe('zet')
  })

  it('interaction state updates emit and stay visible before submit', async () => {
    const { ctx, provider } = makeQuestionCtx()
    const driver = await createDriver(ctx as never, {})
    const pending = provider()!.ask({
      questions: [{
        id: 'live-1',
        question: 'Pick many',
        options: [{ label: 'x' }, { label: 'y' }],
        multiSelect: true,
      }],
    })

    driver.questionToggle() // toggle 'x' (focused 0)
    expect(driver.state.question?.selected).toEqual(['x'])
    driver.questionType(' note')
    expect(driver.state.question?.custom).toBe(' note')
    expect(driver.state.question?.focused).toBe(2) // custom row
    driver.questionBackspace()
    expect(driver.state.question?.custom).toBe(' not')

    driver.questionCancel()
    await pending
  })
})
