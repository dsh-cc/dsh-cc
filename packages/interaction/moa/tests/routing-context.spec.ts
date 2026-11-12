import { describe, expect, it } from 'vitest'
import { canonicalJson, estimateSystemOneTokens, S1_ENVELOPE_TOKENS, S1_MARGIN_TOKENS } from '@dsh-cc/systemone'
import {
  ASSISTANT_MAX_CODEPOINTS,
  buildRoutingContext,
  CURRENT_REQUEST_MAX_CODEPOINTS,
  fitRoutingContextToBudget,
  OMISSION_MARKER,
  PRIOR_USER_MAX_CODEPOINTS,
  type RoutingContext,
} from '../src/routing-context.ts'

type Block = { type: string; text?: string }
const blocks = (value: string): Block[] => [{ type: 'text', text: value }]

/** A genuine user source record (the log shape judge.ts folds). */
const user = (seq: number, value: string, kind = 'user'): Record<string, unknown> => ({
  seq,
  type: 'user/message',
  data: { source: { kind }, content: blocks(value) },
})
const assistant = (seq: number, value: string, turn = 1): Record<string, unknown> => ({
  seq,
  type: 'assistant/message',
  data: { turn, message: { content: blocks(value) } },
})
const tool = (seq: number, name: string, args = '{"path":"/secret/file"}', turn = 1): Record<string, unknown> => ({
  seq,
  type: 'tool/call',
  data: { turn, name, arguments: args },
})

const W = 1_000

function build(openingText: string, events: readonly unknown[], watermark = W, openingSeq?: number): RoutingContext | undefined {
  return buildRoutingContext({
    openingText,
    events,
    watermark,
    ...(openingSeq === undefined ? {} : { openingSeq }),
  })
}

function mustBuild(openingText: string, events: readonly unknown[], watermark = W, openingSeq?: number): RoutingContext {
  const context = build(openingText, events, watermark, openingSeq)
  if (context === undefined) throw new Error('expected a routing context')
  return context
}

describe('current request (rule 1)', () => {
  it('whitespace-only text is not classified', () => {
    expect(build('', [])).toBeUndefined()
    expect(build('   \n\t  ', [])).toBeUndefined()
  })

  it('exactly 8000 codepoints is accepted', () => {
    const context = mustBuild('a'.repeat(CURRENT_REQUEST_MAX_CODEPOINTS), [])
    expect(context.currentRequest).toHaveLength(CURRENT_REQUEST_MAX_CODEPOINTS)
  })

  it('8001 codepoints is not truncated, it is rejected', () => {
    expect(build('a'.repeat(CURRENT_REQUEST_MAX_CODEPOINTS + 1), [])).toBeUndefined()
  })

  it('counts Unicode codepoints, not UTF-16 units', () => {
    expect(build('\u{1f600}'.repeat(CURRENT_REQUEST_MAX_CODEPOINTS), [])).toBeDefined()
    expect(build('\u{1f600}'.repeat(CURRENT_REQUEST_MAX_CODEPOINTS + 1), [])).toBeUndefined()
  })

  it('uses the captured opening text, never the log tail', () => {
    // A multi-step turn can append notice rows; the opening is the capture.
    const context = mustBuild('migrate the multi-file module', [
      user(1, 'migrate the multi-file module'),
      user(2, 'a later injected notice'),
    ], W, 1)
    expect(context.currentRequest).toBe('migrate the multi-file module')
  })

  it('returns valid state with an empty history', () => {
    const context = mustBuild('do it', [])
    expect(context).toEqual({
      version: 1,
      currentRequest: 'do it',
      priorUserRequests: [],
      recentToolCalls: [],
      omitted: { user: 0, assistant: false, tools: 0 },
    })
    expect('priorAssistantAnswer' in context).toBe(false)
  })
})

describe('prior user requests (rule 2)', () => {
  it('keeps the three most recent genuine sources in ascending seq order', () => {
    const context = mustBuild('continue', [user(1, 'r1'), user(2, 'r2'), user(3, 'r3'), user(4, 'r4'), user(5, 'r5')])
    expect(context.priorUserRequests).toEqual([
      { seq: 3, text: 'r3' },
      { seq: 4, text: 'r4' },
      { seq: 5, text: 'r5' },
    ])
    expect(context.omitted.user).toBe(2)
  })

  it('never deduplicates identical texts', () => {
    const context = mustBuild('go on', [user(1, 'same text'), user(2, 'same text'), user(3, 'same text')])
    expect(context.priorUserRequests).toEqual([
      { seq: 1, text: 'same text' },
      { seq: 2, text: 'same text' },
      { seq: 3, text: 'same text' },
    ])
    expect(context.omitted.user).toBe(0)
  })

  it('excludes the record the opening seq points at without counting it as omitted', () => {
    const context = mustBuild('do the second option', [user(1, 'r1'), user(2, 'r2'), user(3, 'r3')], W, 2)
    expect(context.priorUserRequests).toEqual([
      { seq: 1, text: 'r1' },
      { seq: 3, text: 'r3' },
    ])
    expect(context.omitted.user).toBe(0)
  })

  it('an opening seq that matches no record excludes nothing', () => {
    const context = mustBuild('go', [user(1, 'r1'), user(2, 'r2')], W, 99)
    expect(context.priorUserRequests.map((entry) => entry.seq)).toEqual([1, 2])
  })

  it('ignores non-genuine sources', () => {
    const context = mustBuild('go', [
      user(1, 'genuine', 'user'),
      user(2, 'moa escalation notice', 'moa-escalation'),
      { seq: 3, type: 'user/message', data: { content: blocks('no source at all') } },
    ])
    expect(context.priorUserRequests).toEqual([{ seq: 1, text: 'genuine' }])
    expect(context.omitted.user).toBe(0)
  })

  it('caps each entry at 800 codepoints with the fixed marker', () => {
    const long = 'a'.repeat(400) + 'b'.repeat(500)
    const context = mustBuild('go', [user(1, long)])
    const capped = `${'a'.repeat(400)}${OMISSION_MARKER}${'b'.repeat(400)}`
    expect(context.priorUserRequests[0]?.text).toBe(capped)
    expect(context.priorUserRequests[0]?.text).toContain(OMISSION_MARKER)
    expect(Array.from(capped)).toHaveLength(PRIOR_USER_MAX_CODEPOINTS + Array.from(OMISSION_MARKER).length)
  })

  it('leaves a short entry verbatim', () => {
    expect(mustBuild('go', [user(1, 'short')]).priorUserRequests).toEqual([{ seq: 1, text: 'short' }])
  })

  it('reads only records at or before the watermark', () => {
    const context = mustBuild('go', [user(1, 'before'), user(50, 'after')], 10)
    expect(context.priorUserRequests).toEqual([{ seq: 1, text: 'before' }])
    expect(context.omitted.user).toBe(0)
  })

  it('orders out-of-order input by seq', () => {
    const context = mustBuild('go', [user(3, 'r3'), user(1, 'r1'), user(2, 'r2')])
    expect(context.priorUserRequests.map((entry) => entry.seq)).toEqual([1, 2, 3])
  })
})

describe('prior assistant answer (rule 3)', () => {
  it('keeps the most recent assistant text as background', () => {
    const context = mustBuild('go', [assistant(1, 'first answer'), assistant(2, 'second answer')])
    expect(context.priorAssistantAnswer).toEqual({ seq: 2, text: 'second answer' })
  })

  it('is omitted entirely when absent', () => {
    expect('priorAssistantAnswer' in mustBuild('go', [user(1, 'r1')])).toBe(false)
  })

  it('caps at 1200 codepoints with the fixed marker', () => {
    const long = 'x'.repeat(600) + 'y'.repeat(700)
    const context = mustBuild('go', [assistant(1, long)])
    expect(context.priorAssistantAnswer?.text).toBe(`${'x'.repeat(600)}${OMISSION_MARKER}${'y'.repeat(600)}`)
    expect(Array.from(context.priorAssistantAnswer?.text ?? '')).toHaveLength(
      ASSISTANT_MAX_CODEPOINTS + Array.from(OMISSION_MARKER).length,
    )
  })

  it('skips an empty-text answer in favour of the last non-empty one', () => {
    const context = mustBuild('go', [assistant(1, 'real answer'), assistant(2, '')])
    expect(context.priorAssistantAnswer).toEqual({ seq: 1, text: 'real answer' })
  })

  it('never reads past the watermark', () => {
    const context = mustBuild('go', [assistant(9, 'later')], 5)
    expect('priorAssistantAnswer' in context).toBe(false)
  })
})

describe('recent tool calls (rule 4)', () => {
  it('projects name and seq only', () => {
    const context = mustBuild('go', [tool(3, 'read_file')])
    expect(context.recentToolCalls).toEqual([{ seq: 3, name: 'read_file' }])
    expect(Object.keys(context.recentToolCalls[0] ?? {})).toEqual(['seq', 'name'])
    expect(JSON.stringify(context)).not.toContain('/secret/file')
  })

  it('keeps the last ten records in ascending seq order and counts the rest', () => {
    const events = Array.from({ length: 12 }, (_, index) => tool(index + 1, `tool_${index + 1}`))
    const context = mustBuild('go', events)
    expect(context.recentToolCalls.map((entry) => entry.seq)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(context.omitted.tools).toBe(2)
  })

  it('ignores records without a string tool name', () => {
    const context = mustBuild('go', [{ seq: 1, type: 'tool/call', data: { turn: 1 } }])
    expect(context.recentToolCalls).toEqual([])
    expect(context.omitted.tools).toBe(0)
  })

  it('never reads past the watermark', () => {
    const context = mustBuild('go', [tool(3, 'before'), tool(9, 'after')], 5)
    expect(context.recentToolCalls).toEqual([{ seq: 3, name: 'before' }])
  })
})

describe('structural recognition', () => {
  it('ignores unknown and non-record events without stringifying them', () => {
    const context = mustBuild('go', [null, 42, 'a string', { seq: 'x', type: 'user/message' }, { seq: 1, type: 'other/event', data: {} }])
    expect(context).toEqual({
      version: 1,
      currentRequest: 'go',
      priorUserRequests: [],
      recentToolCalls: [],
      omitted: { user: 0, assistant: false, tools: 0 },
    })
  })
})

describe('budget fit (rule 5)', () => {
  const QUESTION_JSON = JSON.stringify({
    route: {
      type: 'choice',
      instructions: 'Classify the minimum capability needed for currentRequest using the prior conversation only to resolve references.',
    },
  })

  const estimate = (context: RoutingContext): number =>
    S1_ENVELOPE_TOKENS +
    estimateSystemOneTokens(canonicalJson(context)) +
    estimateSystemOneTokens(QUESTION_JSON) +
    S1_MARGIN_TOKENS

  const events: unknown[] = [
    user(1, 'first request'),
    user(2, 'second request'),
    user(3, 'third request'),
    user(4, 'fourth request'),
    user(5, 'fifth request'),
    assistant(6, 'the previous answer'),
    ...Array.from({ length: 12 }, (_, index) => tool(7 + index, `tool_${index}`)),
  ]
  const fixture = (): RoutingContext => mustBuild('now continue the migration', events)

  const withoutAssistant = (context: RoutingContext): RoutingContext => {
    const { priorAssistantAnswer: _dropped, ...rest } = context
    return { ...rest, omitted: { ...context.omitted, assistant: true } }
  }
  const withoutOldestUser = (context: RoutingContext): RoutingContext => ({
    ...context,
    priorUserRequests: context.priorUserRequests.slice(1),
    omitted: { ...context.omitted, user: context.omitted.user + 1 },
  })
  const withoutOldestTool = (context: RoutingContext): RoutingContext => ({
    ...context,
    recentToolCalls: context.recentToolCalls.slice(1),
    omitted: { ...context.omitted, tools: context.omitted.tools + 1 },
  })

  it('returns the state unchanged when it already fits', () => {
    const context = fixture()
    const fitted = fitRoutingContextToBudget(context, QUESTION_JSON, estimate(context))
    expect(fitted).toEqual(context)
    expect(fitted).not.toBe(context)
  })

  it('drops the assistant entry first', () => {
    const context = fixture()
    expect(fitRoutingContextToBudget(context, QUESTION_JSON, estimate(context) - 1)).toEqual(withoutAssistant(context))
  })

  it('drops the oldest prior user second', () => {
    const context = fixture()
    const budget = estimate(withoutAssistant(context)) - 1
    expect(fitRoutingContextToBudget(context, QUESTION_JSON, budget)).toEqual(
      withoutOldestUser(withoutAssistant(context)),
    )
  })

  it('drops the oldest tool call third', () => {
    const context = fixture()
    const budget = estimate(withoutOldestUser(withoutAssistant(context))) - 1
    expect(fitRoutingContextToBudget(context, QUESTION_JSON, budget)).toEqual(
      withoutOldestTool(withoutOldestUser(withoutAssistant(context))),
    )
  })

  it('returns undefined when the third drop is still over budget', () => {
    const context = fixture()
    const budget = estimate(withoutOldestTool(withoutOldestUser(withoutAssistant(context)))) - 1
    expect(fitRoutingContextToBudget(context, QUESTION_JSON, budget)).toBeUndefined()
  })

  it('skips a missing assistant entry and drops a user first', () => {
    const context = mustBuild(
      'now continue the migration',
      events.filter((event) => (event as { type?: unknown }).type !== 'assistant/message'),
    )
    expect('priorAssistantAnswer' in context).toBe(false)
    expect(fitRoutingContextToBudget(context, QUESTION_JSON, estimate(context) - 1)).toEqual(withoutOldestUser(context))
  })

  it('removes whole objects and never truncates text', () => {
    const context = fixture()
    const fitted = fitRoutingContextToBudget(context, QUESTION_JSON, estimate(context) - 1)
    expect(fitted?.currentRequest).toBe(context.currentRequest)
    expect(fitted?.priorUserRequests).toEqual(context.priorUserRequests)
    expect(fitted?.recentToolCalls).toEqual(context.recentToolCalls)
    expect(JSON.stringify(fitted)).not.toContain(OMISSION_MARKER)
  })

  it('does not mutate the input state', () => {
    const context = fixture()
    const before = JSON.parse(JSON.stringify(context)) as RoutingContext
    fitRoutingContextToBudget(context, QUESTION_JSON, estimate(context) - 1)
    expect(context).toEqual(before)
  })

  it('treats a non-finite budget as unusable', () => {
    expect(fitRoutingContextToBudget(fixture(), QUESTION_JSON, Number.NaN)).toBeUndefined()
    expect(fitRoutingContextToBudget(fixture(), QUESTION_JSON, Number.POSITIVE_INFINITY)).toBeUndefined()
  })
})
