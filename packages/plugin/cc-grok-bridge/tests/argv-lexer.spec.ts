/**
 * Drives every shared fixture-table row (scripts/lib/argv.mjs — the
 * one-shared-parser-source suite the hook tests reuse) through the
 * matcher pipeline: positives parse to their pinned normalized shape,
 * negatives fail closed with the labeled rule. Plus the D9/D13 pins and
 * the lexer byte-identity row against cc-codex-bridge's copy.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CANONICAL_LAUNCHER, CANONICAL_NODE, FIXTURES, matchInvocation } from '../scripts/lib/argv.mjs'

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

const CODEX_LEXER = join(import.meta.dirname, '..', '..', 'cc-codex-bridge', 'scripts', 'lib', 'lexer.mjs')
const GROK_LEXER = join(import.meta.dirname, '..', 'scripts', 'lib', 'lexer.mjs')

describe('cc-grok-bridge shared argv/lexer fixture table', () => {
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

  it('every negative row carries a violated-rule label', () => {
    for (const fixture of fixtures) {
      if (!fixture.ok) expect(fixture.reason, fixture.name).toBeTruthy()
      else expect(fixture.value, fixture.name).toBeTruthy()
    }
  })

  it('D9: a dash-leading inline prompt is rejected with dash-leading-inline-prompt (use --prompt-file)', () => {
    const res = matchInvocation(`${CANONICAL_NODE} ${CANONICAL_LAUNCHER} -- -restart-from-scratch`)
    expect(res).toMatchObject({ ok: false, reason: 'dash-leading-inline-prompt' })
  })

  it('D13: control-char-in-prompt covers BOTH newline and carriage return', () => {
    for (const ch of ['\n', '\r']) {
      const res = matchInvocation(`${CANONICAL_NODE} ${CANONICAL_LAUNCHER} -- "a${ch}b"`)
      expect(res).toMatchObject({ ok: false, reason: 'control-char-in-prompt' })
    }
  })

  it('byte-identity: this plugin\'s lexer.mjs is byte-equal to cc-codex-bridge\'s copy', () => {
    expect(readFileSync(GROK_LEXER)).toEqual(readFileSync(CODEX_LEXER))
  })
})
