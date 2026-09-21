import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecutionResult } from '@dsh-cc/tools'
import { buildVerifyBlock, composeVerifyBlock } from '../src/compose.ts'

const text = (t: string): ContentBlock => ({ type: 'text', text: t })

const result: ToolExecutionResult = {
  content: [text('edited file')],
} as unknown as ToolExecutionResult

const block = text('[auto-verify] tsc -b — exit 1 (10ms)')

describe('composeVerifyBlock', () => {
  it('appends to a content-bearing accept', () => {
    const downstream: PostToolDecision = { kind: 'accept', content: [text('own output')] }
    const { decision, skipped } = composeVerifyBlock(downstream, result, block)
    expect(skipped).toBe(false)
    expect(decision).toEqual({ kind: 'accept', content: [text('own output'), block] })
  })

  it('falls back to result.content for a bare accept', () => {
    const downstream: PostToolDecision = { kind: 'accept' }
    const { decision, skipped } = composeVerifyBlock(downstream, result, block)
    expect(skipped).toBe(false)
    expect(decision).toEqual({ kind: 'accept', content: [text('edited file'), block] })
  })

  it('keeps additionalContexts when composing', () => {
    const downstream: PostToolDecision = { kind: 'accept', additionalContexts: [] }
    const { decision } = composeVerifyBlock(downstream, result, block)
    expect(decision).toEqual({ kind: 'accept', content: [text('edited file'), block], additionalContexts: [] })
  })

  it('passes the value-accept variant through untouched and signals skipped', () => {
    const downstream: PostToolDecision = { kind: 'accept', value: { ok: 1 } }
    const { decision, skipped } = composeVerifyBlock(downstream, result, block)
    expect(skipped).toBe(true)
    expect(decision).toBe(downstream)
  })

  it('passes a block decision through untouched', () => {
    const downstream: PostToolDecision = { kind: 'block', feedback: [text('no')] }
    const { decision, skipped } = composeVerifyBlock(downstream, result, block)
    expect(skipped).toBe(true)
    expect(decision).toBe(downstream)
  })
})

describe('buildVerifyBlock', () => {
  it('one-lines success unless verbose', () => {
    expect(buildVerifyBlock('tsc -b', 0, 1234, 'all good', false)).toEqual(
      text('[auto-verify] tsc -b — ok (1234ms)'),
    )
  })

  it('emits header plus output on verbose success', () => {
    expect(buildVerifyBlock('tsc -b', 0, 5, 'all good', true)).toEqual(
      text('[auto-verify] tsc -b — exit 0 (5ms)\nall good'),
    )
  })

  it('emits header plus kept output on failure', () => {
    expect(buildVerifyBlock('tsc -b', 2, 10, 'error TS1', false)).toEqual(
      text('[auto-verify] tsc -b — exit 2 (10ms)\nerror TS1'),
    )
  })

  it("emits 'no output' when the command produced nothing", () => {
    expect(buildVerifyBlock('tsc -b', 1, 10, '', false)).toEqual(
      text('[auto-verify] tsc -b — exit 1 (10ms)\nno output'),
    )
  })
})
