import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { formatVersionLabel, readBuildInfo } from '../bootstrap.mjs'

let dir: string | null = null
afterEach(() => {
  if (dir !== null) rmSync(dir, { recursive: true, force: true })
  dir = null
})

function tmp(): string {
  dir ??= mkdtempSync(join(tmpdir(), 'dsh-cc-build-info-'))
  return dir
}

describe('formatVersionLabel', () => {
  it('returns the bare version without stamp info', () => {
    expect(formatVersionLabel('0.6.3', null)).toBe('0.6.3')
  })

  it('renders a clean dev build', () => {
    expect(formatVersionLabel('0.6.3', { channel: 'dev', version: '0.6.3', commit: 'abc1234def56', dirty: false })).toBe('0.6.3-dev+abc1234def56')
  })

  it('appends .dirty for a dirty tree', () => {
    expect(formatVersionLabel('0.6.3', { channel: 'dev', version: '0.6.3', commit: 'abc1234def56', dirty: true })).toBe('0.6.3-dev+abc1234def56.dirty')
  })

  it('falls back to unknown when the stamp has no commit', () => {
    expect(formatVersionLabel('0.6.3', { channel: 'dev', version: '0.6.3', commit: null, dirty: false })).toBe('0.6.3-dev+unknown')
  })

  it('returns the bare version when the channel is not dev', () => {
    expect(formatVersionLabel('0.6.3', { version: '0.6.3', commit: 'abc' })).toBe('0.6.3')
  })

  it('prefers the stamp version over the launcher version', () => {
    expect(formatVersionLabel('0.6.3', { channel: 'dev', version: '0.7.0', commit: 'abc1234def56', dirty: false })).toBe('0.7.0-dev+abc1234def56')
  })
})

describe('readBuildInfo', () => {
  it('returns null for a nonexistent path', () => {
    expect(readBuildInfo(join(tmp(), 'nope', 'dsh-cc-build.json'))).toBe(null)
  })

  it('returns null for garbage bytes', () => {
    const path = join(tmp(), 'dsh-cc-build.json')
    writeFileSync(path, '\x00\xffnot json{')
    expect(readBuildInfo(path)).toBe(null)
  })

  it('parses a valid stamp', () => {
    const path = join(tmp(), 'dsh-cc-build.json')
    writeFileSync(path, JSON.stringify({ channel: 'dev', version: '0.6.3' }))
    expect(readBuildInfo(path)).toEqual({ channel: 'dev', version: '0.6.3' })
  })
})
