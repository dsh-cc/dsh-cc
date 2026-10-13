/**
 * Read-back verification pins (§4.2): the four statuses and the whitelist
 * bounds checks, against a real temp workspace and an injected fs surface.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isWhitelistedRel, verifyClaim, verifySpec } from '../src/verify.ts'
import type { SourceSpec } from '../src/marker.ts'

function spec(sourceId: string, a = 1, b = 2): SourceSpec {
  return { sourceId, lineStart: a, lineEnd: b }
}

describe('whitelist (frozen §4.2)', () => {
  it('accepts docs/** and *.md/*.mdx', () => {
    expect(isWhitelistedRel('docs/guide.md')).toBe(true)
    expect(isWhitelistedRel('README.md')).toBe(true)
    expect(isWhitelistedRel('notes.mdx')).toBe(true)
  })
  it('rejects everything else', () => {
    expect(isWhitelistedRel('src/index.ts')).toBe(false)
    expect(isWhitelistedRel('docs.txt')).toBe(false)
  })
})

describe('verifySpec', () => {
  it('marked-ok for an existing whitelisted in-bounds file and line range', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vwa-verify-'))
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'docs', 'a.md'), 'one\ntwo\nthree\n')
    const outcome = await verifySpec(spec('ws:docs/a.md', 2, 3), root)
    expect(outcome.status).toBe('marked-ok')
    await rm(root, { recursive: true, force: true })
  })

  it('out-of-bounds when the realpath escapes the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vwa-verify-'))
    const outcome = await verifySpec(spec('ws:../x.md'), root)
    expect(outcome.status).toBe('out-of-bounds')
    expect(outcome.detail).toContain('not a relative in-workspace path')
    await rm(root, { recursive: true, force: true })
  })

  it('out-of-bounds for non-whitelisted in-workspace targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vwa-verify-'))
    const outcome = await verifySpec(spec('ws:src/index.ts'), root)
    expect(outcome.status).toBe('out-of-bounds')
    expect(outcome.detail).toContain('whitelist')
    await rm(root, { recursive: true, force: true })
  })

  it('invalid-marker (source does not verify) when the file is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vwa-verify-'))
    const outcome = await verifySpec(spec('ws:docs/ghost.md'), root)
    expect(outcome.status).toBe('invalid-marker')
    expect(outcome.detail).toContain('does not exist')
    await rm(root, { recursive: true, force: true })
  })

  it('invalid-marker with detail when the line range does not exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vwa-verify-'))
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'docs', 'a.md'), 'one\ntwo\n')
    const outcome = await verifySpec(spec('ws:docs/a.md', 2, 9), root)
    expect(outcome.status).toBe('invalid-marker')
    expect(outcome.detail).toContain('L2-L9')
    await rm(root, { recursive: true, force: true })
  })
})

describe('verifyClaim', () => {
  it('unmarked when there are no markers', async () => {
    const outcome = await verifyClaim([], [], '/tmp')
    expect(outcome).toEqual({ status: 'unmarked' })
  })
  it('invalid-marker for any malformed marker', async () => {
    const outcome = await verifyClaim([[spec('ws:docs/a.md')]], [false], '/tmp')
    expect(outcome.status).toBe('invalid-marker')
    expect(outcome.detail).toBeDefined()
  })
  it('marked-ok requires EVERY spec of EVERY marker to pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vwa-verify-'))
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'docs', 'a.md'), 'one\ntwo\n')
    const ok = await verifyClaim([[spec('ws:docs/a.md', 1, 2)]], [true], root)
    expect(ok.status).toBe('marked-ok')
    const bad = await verifyClaim([[spec('ws:docs/a.md', 1, 2)], [spec('ws:docs/b.md')]], [true, true], root)
    expect(bad.status).toBe('invalid-marker')
    await rm(root, { recursive: true, force: true })
  })
})
