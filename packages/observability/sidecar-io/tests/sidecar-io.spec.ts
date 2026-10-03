/**
 * Happy-path tests for the shared sidecar IO primitives: hash width, JSONL
 * append/read roundtrip, and swallow-on-error semantics.
 */

import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendJsonl, jsonlPath, projectKeyOf, readJsonl, shortHash } from '../src/index.ts'

let dir: string
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined as unknown as string
})

describe('shortHash / projectKeyOf', () => {
  it('hashes to 16 hex chars by default and honors the width param', () => {
    expect(shortHash('/project')).toMatch(/^[0-9a-f]{16}$/)
    expect(shortHash('/project', 8)).toMatch(/^[0-9a-f]{8}$/)
    expect(shortHash('/project', 8)).toBe(shortHash('/project').slice(0, 8))
    expect(projectKeyOf('/project')).toBe(shortHash('/project'))
    expect(projectKeyOf('/project', 8)).toBe(shortHash('/project', 8))
  })
})

describe('jsonlPath', () => {
  it('joins under the root', () => {
    expect(jsonlPath('/home', 'pkg', 'a.jsonl')).toBe(join('/home', 'pkg', 'a.jsonl'))
  })
})

describe('appendJsonl + readJsonl', () => {
  it('roundtrips rows, creating parent dirs', async () => {
    dir = await mkdtemp(join(tmpdir(), 'sidecar-io-'))
    const file = jsonlPath(dir, 'sub', 'ledger.jsonl')
    await appendJsonl(file, { a: 1 })
    await appendJsonl(file, { a: 2 })
    expect(await readJsonl<{ a: number }>(file)).toEqual([{ a: 1 }, { a: 2 }])
  })

  it('append swallows errors on an unwritable path; read swallows a missing file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'sidecar-io-'))
    const file = jsonlPath(dir, 'blocked', 'ledger.jsonl')
    await writeFile(join(dir, 'blocked'), 'not a dir')
    await chmod(join(dir, 'blocked'), 0o444)
    await expect(appendJsonl(file, { a: 1 })).resolves.toBeUndefined()
    await expect(readJsonl(file)).resolves.toEqual([])
  })

  it('skips malformed and blank lines', async () => {
    dir = await mkdtemp(join(tmpdir(), 'sidecar-io-'))
    const file = jsonlPath(dir, 'ledger.jsonl')
    await writeFile(file, '{"a":1}\n\nnot json\n{"a":2}\n{"a":')
    expect(await readJsonl<{ a: number }>(file)).toEqual([{ a: 1 }, { a: 2 }])
  })
})
