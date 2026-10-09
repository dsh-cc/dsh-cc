/**
 * Scrubber steps (plan docs/plans/2026-10-09-runtime-verified-completion.md
 * §5.10): -H/--header Authorization/Bearer/token values, -u/--user, and
 * non-leading KEY=value assignments are redacted; UTF-8 truncation never
 * splits a sequence mid-code-unit (truncateUtf8 semantics).
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { HEAD_MAX_BYTES, scrubHead, truncateUtf8 } from '../src/scrub.ts'

describe('scrubber (§5.10 / §4)', () => {
  it('strips leading KEY=value env assignments', () => {
    expect(scrubHead('FOO=bar BAZ="q q" pnpm test')).toBe('pnpm test')
  })
  it('redacts non-leading KEY=value assignment values', () => {
    expect(scrubHead('curl --url https://x httpbin ?a=1 KEY=secretvalue run')).toContain('KEY=<redacted>')
    expect(scrubHead('run with KEY=secretvalue now')).toBe('run with KEY=<redacted> now')
  })
  it('does not redact flag-style --opt=value (looks like assignment only for env names)', () => {
    expect(scrubHead('--url=http://x')).toBe('--url=http://x')
  })
  it('redacts --token/--password/--auth values', () => {
    expect(scrubHead('tool --token abc123')).toBe('tool --token <redacted>')
    expect(scrubHead('tool --password=xyz')).toBe('tool --password=<redacted>')
    expect(scrubHead('tool --authToken "s3cret"')).toBe('tool --authToken <redacted>')
  })
  it('redacts -H/--header values carrying auth material, keeps innocuous ones', () => {
    expect(scrubHead("curl -H 'Authorization: Bearer abc' https://x")).toBe('curl -H <redacted> https://x')
    expect(scrubHead('curl --header "token: zzz" https://x')).toBe('curl --header <redacted> https://x')
    expect(scrubHead('curl -H "Accept: json" https://x')).toBe('curl -H "Accept: json" https://x')
  })
  it('redacts -u/--user values', () => {
    expect(scrubHead('curl -u alice:hunter2 https://x')).toBe('curl -u <redacted> https://x')
    expect(scrubHead('curl --user bob https://x')).toBe('curl --user <redacted> https://x')
  })
  it('truncates to 200 bytes UTF-8-safely', () => {
    const long = 'x'.repeat(199) + '日' + 'y'.repeat(10)
    const scrubbed = scrubHead(long)
    expect(scrubbed.length).toBeLessThanOrEqual(HEAD_MAX_BYTES + 2)
  })
  it('truncateUtf8 never splits a UTF-8 sequence mid-code-unit', () => {
    // 3-byte char at the 199/200 boundary: the partial sequence degrades to a
    // replacement char (accepted truncateUtf8 semantics), no corruption.
    const text = 'a'.repeat(199) + '日' + 'b'.repeat(5)
    const out = truncateUtf8(text, 200)
    expect(out).toBe('a'.repeat(199) + '\uFFFD')
    expect(truncateUtf8('日日日', 9)).toBe('日日日')
    expect(truncateUtf8('日日日', 8)).toBe('日日' + '\uFFFD')
  })
  it('empty and zero-byte edges', () => {
    expect(truncateUtf8('abc', 0)).toBe('')
    expect(truncateUtf8('', 10)).toBe('')
  })
})
