import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { redact, resetForTests } from '../src/index.ts'

// Canary values matching each built-in pattern (≥ body floor).
const CANARIES = {
  anthropic: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJ',
  openai: 'sk-proj-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJKLMN',
  openaiPlain: 'sk-abcdefghijklmnopqrst1234567890ABCDEFGHIJKLMNOPQR',
  github: 'ghp_abcdefghijklmnopqrstuvwxyz1234567890ABCD',
  aws: 'AKIAIOSFODNN7EXAMPLE',
  bearer: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789._~+/=',
} as const

// Lookalike strings BELOW each floor: must never be redacted.
const BELOW_FLOOR = {
  shortKey: 'sk-short',
  shortGithub: 'ghp_short',
  shortBearer: 'Bearer short',
  shortAwsLike: 'AKIA123',
} as const

describe('redact built-in patterns', () => {
  beforeEach(() => { resetForTests() })
  afterEach(() => { resetForTests() })

  it.each([
    ['anthropic', CANARIES.anthropic],
    ['openai (proj)', CANARIES.openai],
    ['openai (plain)', CANARIES.openaiPlain],
    ['github', CANARIES.github],
    ['aws', CANARIES.aws],
    ['bearer', CANARIES.bearer],
  ])('redacts the %s canary', (_name, canary) => {
    const out = redact(`prefix ${canary} suffix`)
    expect(out.text).toBe('prefix [REDACTED] suffix')
    expect(out.matches).toBe(1)
  })

  it('does not eat sk-ant- with the OpenAI pattern (match order)', () => {
    const out = redact(CANARIES.anthropic)
    expect(out.text).toBe('[REDACTED]')
    expect(out.matches).toBe(1)
  })

  it.each(Object.entries(BELOW_FLOOR))('keeps the below-floor lookalike %s', (_name, lookalike) => {
    const out = redact(`value ${lookalike} end`)
    expect(out.text).toBe(`value ${lookalike} end`)
    expect(out.matches).toBe(0)
  })
})

describe('redact env-name patterns', () => {
  const ENV_NAME = 'TS_TEST_SECRET_TOKEN'
  const VALUE = 'supersecretvalue99'

  beforeEach(() => {
    resetForTests()
    process.env[ENV_NAME] = VALUE
  })
  afterEach(() => {
    delete process.env[ENV_NAME]
    resetForTests()
  })

  it('redacts an env value at or above the 8-char floor and reports only the name', () => {
    const out = redact(`token is ${VALUE} ok`)
    expect(out.text).toBe('token is [REDACTED] ok')
    expect(out.matches).toBe(1)
    expect(out.envNames).toEqual([ENV_NAME])
    expect(out.text).not.toContain(VALUE)
  })

  it('keeps env values below the 8-char floor', () => {
    const short = 'short7x'
    process.env.TS_TEST_SHORT_KEY = short
    resetForTests() // re-capture the snapshot including the short value
    // Below-floor values are filtered at snapshot time, so never redacted.
    const out = redact(`value ${short} end`)
    expect(out.text).toBe(`value ${short} end`)
    expect(out.envNames).toEqual([])
    delete process.env.TS_TEST_SHORT_KEY
  })

  it('ignores env names without a secret-ish suffix', () => {
    const value = 'unrelatedvalue1'
    process.env.TS_TEST_HARMLESS_NAME = value
    resetForTests()
    const out = redact(`value ${value} end`)
    expect(out.text).toBe(`value ${value} end`)
    delete process.env.TS_TEST_HARMLESS_NAME
  })
})

describe('redact extraPatterns', () => {
  beforeEach(() => { resetForTests() })
  afterEach(() => { resetForTests() })

  it('applies caller-supplied regex sources', () => {
    const out = redact('id x-cust-abcdefghij end', { extraPatterns: ['x-cust-[a-j]{10}'] })
    expect(out.text).toBe('id [REDACTED] end')
  })

  it('skips invalid sources with a log, never throws', () => {
    const logged: string[] = []
    const out = redact('text [unclosed end', {
      extraPatterns: ['[unclosed'],
      log: (m) => logged.push(m),
    })
    expect(out.text).toBe('text [unclosed end')
    expect(logged).toHaveLength(1)
  })

  it('multibyte content survives untouched around a redaction', () => {
    const out = redact(`世界 ${CANARIES.github} 你好`)
    expect(out.text).toBe('世界 [REDACTED] 你好')
  })
})
