/**
 * Drives every shared fixture-table row (scripts/lib/argv.mjs — the
 * one-shared-parser-source suite PR-2's hook tests reuse) through the
 * matcher pipeline: positives parse to their pinned normalized shape,
 * negatives fail closed with the labeled rule.
 */
import { describe, expect, it } from 'vitest'
import { CANONICAL_LAUNCHER, CANONICAL_NODE, FIXTURES, matchInvocation } from '../scripts/lib/argv.mjs'
import { LANE } from '../scripts/lib/lane.mjs'

interface Fixture {
  name: string
  layer: 'lexer' | 'argv'
  input: string
  node?: string
  launcher?: string
  ok: boolean
  reason?: string
  value?: { last: boolean; prompt: { kind: 'inline' | 'prompt-file'; text?: string; path?: string } }
}

const fixtures = FIXTURES as Fixture[]

describe('cc-codex-bridge shared argv/lexer fixture table', () => {
  for (const fixture of fixtures) {
    it(fixture.name, () => {
      const result = matchInvocation(fixture.input, {
        node: fixture.node ?? CANONICAL_NODE,
        launcher: fixture.launcher ?? CANONICAL_LAUNCHER,
      }) as { ok: boolean; value?: unknown; reason?: string }
      if (fixture.ok) {
        expect(result, `expected ${fixture.name} to parse`).toMatchObject({ ok: true })
        expect(result.value).toEqual(fixture.value)
      } else {
        expect(result, `expected ${fixture.name} to fail closed`).toMatchObject({ ok: false })
        expect(result.reason).toBe(fixture.reason)
      }
    })
  }

  it('the fixture table covers both layers', () => {
    const layers = new Set(fixtures.map((f) => f.layer))
    expect(layers.has('lexer')).toBe(true)
    expect(layers.has('argv')).toBe(true)
  })

  // The shared table is lane-neutral by construction; these two rows depend on
  // THIS lane's transport flags and live here instead (grok's spec pins the
  // opposite expectations for the same inputs).
  it('accepts a dash-leading inline prompt (stdin transport makes it data, never a flag)', () => {
    expect(LANE.rejectDashLeadingInlinePrompt).toBe(false)
    expect(matchInvocation(`${CANONICAL_NODE} ${CANONICAL_LAUNCHER} -- -restart-from-scratch`))
      .toMatchObject({ ok: true, value: { prompt: { kind: 'inline', text: '-restart-from-scratch' } } })
  })

  it('accepts a carriage return in the inline prompt (stdin transport, no line re-parse)', () => {
    expect(LANE.rejectCarriageReturnInPrompt).toBe(false)
    expect(matchInvocation(`${CANONICAL_NODE} ${CANONICAL_LAUNCHER} -- "line one\rline two"`))
      .toMatchObject({ ok: true, value: { prompt: { kind: 'inline', text: 'line one\rline two' } } })
  })

  it('still rejects a newline, under this lane\'s reason string', () => {
    expect(LANE.lineBreakReason).toBe('prompt-newline')
    expect(matchInvocation(`${CANONICAL_NODE} ${CANONICAL_LAUNCHER} -- "line one\nline two"`))
      .toMatchObject({ ok: false, reason: 'prompt-newline' })
  })

  it('every negative row carries a violated-rule label', () => {
    for (const fixture of fixtures) {
      if (!fixture.ok) expect(fixture.reason, fixture.name).toBeTruthy()
      else expect(fixture.value, fixture.name).toBeTruthy()
    }
  })
})
